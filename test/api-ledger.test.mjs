import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import handler, { __setBlobClientForTests } from "../api/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryBlob {
  constructor({ getError = null, putError = null } = {}) {
    this.body = null;
    this.getError = getError;
    this.putError = putError;
    this.gets = [];
    this.puts = [];
    this.nextPutGate = null;
  }

  deferNextPut() {
    const gate = { entered: deferred(), release: deferred() };
    this.nextPutGate = gate;
    return gate;
  }

  async get(path, options) {
    this.gets.push({ path, options: { ...options } });
    if (this.getError) throw this.getError;
    if (this.body === null) return null;
    return { stream: new Response(this.body).body };
  }

  async put(path, body, options) {
    this.puts.push({ path, body, options: { ...options } });
    const gate = this.nextPutGate;
    this.nextPutGate = null;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    if (this.putError) throw this.putError;
    this.body = body;
    return { pathname: path };
  }
}

async function assertPendingUntilPutResolves(request, gate) {
  let settled = false;
  request.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await gate.entered.promise;
  await Promise.resolve();
  assert.equal(settled, false, "request returned before the durable put resolved");
  gate.release.resolve();
  return request;
}

function invoke(method, url, body = undefined, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };

  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[String(name).toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) responseHeaders[String(name).toLowerCase()] = value;
        return this;
      },
      end(payload = "") {
        const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
        let json = null;
        if (responseHeaders["content-type"]?.includes("application/json") && text) json = JSON.parse(text);
        resolve({ status: this.statusCode, headers: responseHeaders, text, json });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function configure(store, token = null) {
  delete process.env.DATABASE_URL; // This file tests injected Blob storage only.
  process.env.BLOB_STORE_ID = "store_test";
  delete process.env.VERCEL;
  if (token === null) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = token;
  __setBlobClientForTests(store);
}

function assertBlobCalls(store, token) {
  for (const call of store.gets) {
    assert.equal(call.path, "hearth.json");
    assert.deepEqual(
      { access: call.options.access, useCache: call.options.useCache },
      { access: "private", useCache: false },
    );
    if (token === null) assert.equal(Object.hasOwn(call.options, "token"), false);
    else assert.equal(call.options.token, token);
  }
  for (const call of store.puts) {
    assert.equal(call.path, "hearth.json");
    assert.deepEqual(
      {
        access: call.options.access,
        allowOverwrite: call.options.allowOverwrite,
        addRandomSuffix: call.options.addRandomSuffix,
        contentType: call.options.contentType,
      },
      {
        access: "private",
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: "application/json",
      },
    );
    if (token === null) assert.equal(Object.hasOwn(call.options, "token"), false);
    else assert.equal(call.options.token, token);
  }
}

test("request-scoped Blob ledger omits an absent token and retains concurrent actions", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.persist, "blob");
  assert.equal(health.json.blob_store, true);
  assert.equal(health.json.blob_token, false);

  const joined = await invoke("POST", "/api/join", { handle: "persist_probe", kind: "agent" });
  assert.equal(joined.status, 201);
  const key = joined.json.key;
  assert.ok(key);

  const writesBefore = store.puts.length;
  const [first, second] = await Promise.all([
    invoke("POST", "/api/action", { action: "say", body: "first durable probe" }, { authorization: `Bearer ${key}` }),
    invoke("POST", "/api/action", { action: "say", body: "second durable probe" }, { authorization: `Bearer ${key}` }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.puts.length - writesBefore, 2);

  const map = await invoke("GET", "/api/map");
  assert.equal(map.status, 200);
  assert.ok(map.json.residents.some((resident) => resident.handle === "persist_probe"));
  const probeNotes = map.json.notes.filter((note) => note.authorHandle === "persist_probe");
  assert.deepEqual(probeNotes.map((note) => note.body), ["first durable probe", "second durable probe"]);

  // One fresh Blob read occurred for every non-OPTIONS request.
  assert.equal(store.gets.length, 5);
  assertBlobCalls(store, null);
});

test("Blob calls include a configured read-write token", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store, "test-read-write-token");

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.blob_token, true);

  const joined = await invoke("POST", "/api/join", { handle: "token_probe", kind: "agent" });
  assert.equal(joined.status, 201);
  assertBlobCalls(store, "test-read-write-token");
});

test("the existing door, auth, human-block, and go_home contracts remain intact", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);

  const publicDoors = [
    ["/", "application/json"],
    ["/health", "application/json"],
    ["/api", "application/json"],
    ["/api/map", "application/json"],
    ["/api/events", "application/json"],
    ["/api/physics", "application/json"],
    ["/skill.md", "text/markdown"],
    ["/api/skill", "text/markdown"],
    ["/.well-known/agent-world.json", "application/json"],
    ["/api/well-known", "application/json"],
    ["/llms.txt", "text/plain"],
  ];
  for (const [path, contentType] of publicDoors) {
    const response = await invoke("GET", path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers["content-type"], new RegExp(contentType.replace("/", "\\/")), path);
  }

  const human = await invoke("POST", "/api/join", { handle: "human_probe", kind: "human" });
  assert.equal(human.status, 403);
  assert.equal(human.json.error_class, "forbidden");

  const joined = await invoke("POST", "/api/join", { handle: "door_probe", kind: "agent" });
  assert.equal(joined.status, 201);
  assert.deepEqual(
    Object.keys(joined.json).filter((key) => ["ok", "handle", "key"].includes(key)).sort(),
    ["handle", "key", "ok"],
  );

  assert.equal((await invoke("GET", "/api/me")).status, 401);
  assert.equal((await invoke("GET", "/api/me", undefined, { authorization: "Bearer wrong-key" })).status, 401);

  const me = await invoke("GET", "/api/me", undefined, { authorization: `Bearer ${joined.json.key}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.me.handle, "door_probe");

  const home = await invoke("POST", "/api/action", { action: "go_home" }, { authorization: `Bearer ${joined.json.key}` });
  assert.equal(home.status, 200);
  assert.equal(home.json.me.standingId, joined.json.homeId);

  const physics = await invoke("GET", "/api/physics");
  for (const action of ["look", "walk", "go_home", "found", "make", "say", "give", "agree", "sign", "permit", "law", "use", "become", "set_home", "remember", "no_op"]) {
    assert.ok(physics.json.actions.includes(action), action);
  }
});

test("Vercel refuses to serve an unconfigured ephemeral file ledger", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.VERCEL = "1";
  __setBlobClientForTests(store);

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.persist, "unconfigured");
  assert.match(health.json.persist_error, /No Blob store or read-write token/);
  assert.equal(store.gets.length, 0);
  assert.equal(store.puts.length, 0);
});

test("OPTIONS skips the ledger while every other request, including 404, reloads it", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);

  assert.equal((await invoke("GET", "/health")).status, 200);
  const readsBeforeOptions = store.gets.length;

  const options = await invoke("OPTIONS", "/api/action");
  assert.equal(options.status, 204);
  assert.equal(store.gets.length, readsBeforeOptions);

  const missing = await invoke("GET", "/not-a-door");
  assert.equal(missing.status, 404);
  assert.equal(store.gets.length, readsBeforeOptions + 1);
});

test("a Blob write failure is reported as blob-error, never blob-empty", { concurrency: false }, async () => {
  const store = new MemoryBlob({ putError: new Error("synthetic write outage") });
  configure(store);

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.ok, false);
  assert.equal(health.json.persist, "blob-error");
  assert.equal(health.json.persist_error, "Durable ledger write failed; backend details suppressed to protect private data.");
  assert.notEqual(health.json.persist, "blob-empty");
});

test("a failed action write remains visible until a later durable write succeeds", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);

  assert.equal((await invoke("GET", "/health")).status, 200);
  store.putError = new Error("synthetic action write outage");

  const failedJoin = await invoke("POST", "/api/join", { handle: "retry_probe", kind: "agent" });
  assert.equal(failedJoin.status, 503);
  assert.equal(failedJoin.json.error_class, "ledger_unavailable");

  const failedHealth = await invoke("GET", "/health");
  assert.equal(failedHealth.status, 503);
  assert.equal(failedHealth.json.persist, "blob-error");
  assert.equal(failedHealth.json.persist_error, "Durable ledger write failed; backend details suppressed to protect private data.");

  store.putError = null;
  const retriedJoin = await invoke("POST", "/api/join", { handle: "retry_probe", kind: "agent" });
  assert.equal(retriedJoin.status, 201);

  const recoveredHealth = await invoke("GET", "/health");
  assert.equal(recoveredHealth.status, 200);
  assert.equal(recoveredHealth.json.persist, "blob");
  assert.equal(Object.hasOwn(recoveredHealth.json, "persist_error"), false);
});

test("a Blob read failure refuses actions instead of forking a seed world", { concurrency: false }, async () => {
  const store = new MemoryBlob({ getError: new Error("synthetic read outage") });
  configure(store);

  const joined = await invoke("POST", "/api/join", { handle: "must_not_join", kind: "agent" });
  assert.equal(joined.status, 503);
  assert.equal(joined.json.error_class, "ledger_unavailable");
  assert.equal(store.puts.length, 0);

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.persist, "blob-error");
  assert.equal(health.json.persist_error, "Durable ledger load failed; backend details suppressed to protect private data.");
});

test("a retained write error survives a later read failure and read recovery", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);

  assert.equal((await invoke("GET", "/health")).status, 200);
  store.putError = new Error("original durable write outage");

  const failedJoin = await invoke("POST", "/api/join", { handle: "retained_write_probe", kind: "agent" });
  assert.equal(failedJoin.status, 503);

  store.putError = null;
  store.getError = new Error("later transient read outage");
  const failedRead = await invoke("GET", "/health");
  assert.equal(failedRead.status, 503);

  store.getError = null;
  const recoveredRead = await invoke("GET", "/health");
  assert.equal(recoveredRead.status, 503);
  assert.equal(recoveredRead.json.persist, "blob-error");
  assert.equal(recoveredRead.json.persist_error, "Durable ledger write failed; backend details suppressed to protect private data.");

  const successfulWrite = await invoke("POST", "/api/join", { handle: "retained_write_probe", kind: "agent" });
  assert.equal(successfulWrite.status, 201);
  const recoveredHealth = await invoke("GET", "/health");
  assert.equal(recoveredHealth.status, 200);
  assert.equal(recoveredHealth.json.persist, "blob");
  assert.equal(Object.hasOwn(recoveredHealth.json, "persist_error"), false);
});

test("join, action, and private-memory responses await their durable write", { concurrency: false }, async () => {
  const store = new MemoryBlob();
  configure(store);
  assert.equal((await invoke("GET", "/health")).status, 200);

  const joinGate = store.deferNextPut();
  const joinRequest = invoke("POST", "/api/join", { handle: "awaited_write_probe", kind: "agent" });
  const joined = await assertPendingUntilPutResolves(joinRequest, joinGate);
  assert.equal(joined.status, 201);
  const auth = { authorization: `Bearer ${joined.json.key}` };

  const actionGate = store.deferNextPut();
  const actionRequest = invoke("POST", "/api/action", { action: "say", body: "awaited action write" }, auth);
  const action = await assertPendingUntilPutResolves(actionRequest, actionGate);
  assert.equal(action.status, 200);

  const memoryGate = store.deferNextPut();
  const memoryRequest = invoke("POST", "/api/memory", { summary: "awaited private memory write" }, auth);
  const memory = await assertPendingUntilPutResolves(memoryRequest, memoryGate);
  assert.equal(memory.status, 200);

  const memories = await invoke("GET", "/api/memory", undefined, auth);
  assert.equal(memories.status, 200);
  assert.equal(memories.json.length, 1);
  assert.equal(memories.json[0].summary, "awaited private memory write");
});
