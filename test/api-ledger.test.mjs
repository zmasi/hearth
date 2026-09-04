import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import handler, { __setBlobClientForTests } from "../api/index.js";

class MemoryBlob {
  constructor({ getError = null, putError = null } = {}) {
    this.body = null;
    this.getError = getError;
    this.putError = putError;
    this.gets = [];
    this.puts = [];
  }

  async get(path, options) {
    this.gets.push({ path, options: { ...options } });
    if (this.getError) throw this.getError;
    if (this.body === null) return null;
    return { stream: new Response(this.body).body };
  }

  async put(path, body, options) {
    this.puts.push({ path, body, options: { ...options } });
    if (this.putError) throw this.putError;
    this.body = body;
    return { pathname: path };
  }
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
    ["/health", "application/json"],
    ["/api/map", "application/json"],
    ["/api/events", "application/json"],
    ["/api/physics", "application/json"],
    ["/skill.md", "text/markdown"],
    ["/.well-known/agent-world.json", "application/json"],
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

test("a Blob write failure is reported as blob-error, never blob-empty", { concurrency: false }, async () => {
  const store = new MemoryBlob({ putError: new Error("synthetic write outage") });
  configure(store);

  const health = await invoke("GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.json.ok, false);
  assert.equal(health.json.persist, "blob-error");
  assert.equal(health.json.persist_error, "synthetic write outage");
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
  assert.equal(failedHealth.json.persist_error, "synthetic action write outage");

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
  assert.equal(health.json.persist_error, "synthetic read outage");
});
