// FIXTURE, not a teammate. A small in-process A2A v1.0 seat that mirrors the
// receiver behaviours Hearth's native habitation relies on, as verified in the
// Foundry adapter source (adapter_core.py, team_a2a/native_admission.py,
// team_a2a/native_tasks.py at 79edcba):
//
//   - Agent Card advertises urn:foundry:a2a:durable-admission:v1.
//   - SendMessage admits durably under the key message:<contextId>:<messageId>
//     with a fingerprint over {contextId, parts}. An identical replay returns
//     the original task; a conflicting payload is refused (-32602).
//   - configuration.returnImmediately=true returns the admitted task at once.
//   - One context runs FIFO, one native turn at a time.
//   - GetTask {id} returns the exact task or -32001.
//   - Plain (non-teamA2A) tasks never enter any work ledger or result outbox.
//
// Lives outside test/ because node --test runs every module under test/ as a
// test file. No model is invoked. The "native turn" ends only when the test says so.
// test/phase20-native-boundary.test.mjs proves the same flows against the real
// receiver code so this mirror cannot drift unnoticed on a machine that has it.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const DURABLE_URI = "urn:foundry:a2a:durable-admission:v1";
const ENDED = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);

export async function startFixtureSeat({ durable = true, token = "", autoFinish = null, replyMarker = "FIXTURE-REPLY-" + randomUUID() } = {}) {
  const seat = {
    durable, token, autoFinish, replyMarker,
    tasks: new Map(),          // task id -> task
    inbox: new Map(),          // request key -> { fingerprint, taskId }
    lanes: new Map(),          // context id -> [task ids, FIFO]
    prompts: [],               // texts that reached the "native turn", in start order
    sends: 0, admissions: 0, gets: 0, unauthorized: 0,
    methods: [], authHeaders: [], metadata: [], configurations: [],
    dropNextResponse: false,   // admit, then lose the acknowledgment
  };

  const publicTask = (t) => {
    const out = { id: t.id, contextId: t.contextId, status: { state: t.state, timestamp: t.timestamp } };
    if (t.reply) {
      out.status.message = { role: "ROLE_AGENT", parts: [{ text: t.reply, mediaType: "text/plain" }], messageId: randomUUID() };
      if (t.state === "TASK_STATE_COMPLETED") out.artifacts = [{ artifactId: randomUUID(), parts: [{ text: t.reply, mediaType: "text/plain" }] }];
    }
    return out;
  };
  const advance = (contextId) => {
    const lane = seat.lanes.get(contextId) ?? [];
    const head = lane.map(id => seat.tasks.get(id)).find(t => !ENDED.has(t.state));
    if (head && head.state === "TASK_STATE_SUBMITTED") {
      head.state = "TASK_STATE_WORKING"; head.timestamp = new Date().toISOString();
      seat.prompts.push(head.text);
      if (seat.autoFinish) seat.finish(head.id, seat.autoFinish);
    }
  };
  seat.finish = (taskId, state = "TASK_STATE_COMPLETED", reply = `${seat.replyMarker} a private reply nobody is assigned to read`) => {
    const t = seat.tasks.get(taskId);
    if (!t) throw new Error("unknown fixture task " + taskId);
    t.state = state; t.reply = reply; t.timestamp = new Date().toISOString();
    advance(t.contextId);
    return publicTask(t);
  };
  seat.forget = (taskId) => { // the seat lost its record of a turn (state wiped or restored)
    const t = seat.tasks.get(taskId);
    seat.tasks.delete(taskId);
    if (t) { seat.lanes.set(t.contextId, (seat.lanes.get(t.contextId) ?? []).filter(id => id !== taskId)); advance(t.contextId); }
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const handle = (request) => {
    const { id, method, params = {} } = request;
    seat.methods.push(method);
    const name = String(method || "").toLowerCase();
    if (name === "sendmessage" || name === "message/send") {
      seat.sends++;
      const message = params.message || {};
      const text = (message.parts || []).map(p => p?.text).filter(s => typeof s === "string").join("\n").trim();
      if (!text) return rpcError(id, -32602, "empty message text");
      const contextId = String(message.contextId || params.contextId || "") || "ctx-" + randomUUID().slice(0, 16);
      seat.metadata.push(message.metadata ?? null);
      seat.configurations.push(params.configuration ?? null);
      const key = message.messageId ? `message:${contextId}:${message.messageId}` : "task:" + randomUUID();
      const fingerprint = JSON.stringify({ contextId, parts: message.parts });
      const prior = seat.inbox.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) return rpcError(id, -32602, "Duplicate native exchange has conflicting request content");
        return { jsonrpc: "2.0", id, result: { task: publicTask(seat.tasks.get(prior.taskId)) } };
      }
      const task = { id: "task-" + randomUUID().replaceAll("-", "").slice(0, 16), contextId, text, state: "TASK_STATE_SUBMITTED", reply: "", timestamp: new Date().toISOString() };
      seat.tasks.set(task.id, task);
      seat.inbox.set(key, { fingerprint, taskId: task.id });
      seat.lanes.set(contextId, [...(seat.lanes.get(contextId) ?? []), task.id]);
      seat.admissions++;
      const admitted = publicTask(task); // what returnImmediately returns: SUBMITTED, before any native work
      advance(contextId);
      return { jsonrpc: "2.0", id, result: { task: params.configuration?.returnImmediately === true ? admitted : publicTask(task) } };
    }
    if (name === "gettask" || name === "tasks/get") {
      seat.gets++;
      const task = typeof params.id === "string" ? seat.tasks.get(params.id) : null;
      if (!task) return rpcError(id, -32001, "unknown task id or context/exchange");
      return { jsonrpc: "2.0", id, result: publicTask(task) };
    }
    return rpcError(id, -32601, "unknown method: " + method);
  };

  const server = createServer((req, res) => {
    const send = (status, body) => { const data = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) }); res.end(data); };
    if (req.method === "GET") {
      const path = (req.url || "").split("?")[0].replace(/\/+$/, "");
      if (path === "/.well-known/agent-card.json") {
        return send(200, { name: "fixture-seat", version: "fixture", capabilities: { streaming: false,
          extensions: seat.durable ? [{ uri: DURABLE_URI, params: { exactExchangeReplay: true, contextFIFO: true, nativeResultOutbox: true } }] : [] } });
      }
      return send(404, { error: "not found" });
    }
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      seat.authHeaders.push(req.headers.authorization ?? null);
      if (seat.token && req.headers.authorization !== `Bearer ${seat.token}`) { seat.unauthorized++; return send(401, rpcError(null, -32050, "unauthorized")); }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, rpcError(null, -32700, "parse error")); }
      const response = handle(request);
      if (seat.dropNextResponse && /sendmessage/i.test(String(request.method)) && response.result) {
        seat.dropNextResponse = false;
        return req.socket.destroy(); // durably admitted, acknowledgment lost
      }
      send(200, response);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  seat.url = `http://127.0.0.1:${server.address().port}`;
  seat.close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return seat;
}
