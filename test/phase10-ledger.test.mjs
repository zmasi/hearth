import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

// Import only after HEARTH_DATA is set: the kernel resolves DATA at module load.
let handler;

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

test("phase 10: events are hash-chained and observation does not append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-phase10-"));
  const prevData = process.env.HEARTH_DATA;
  const prevDb = process.env.DATABASE_URL;
  const prevBlob = process.env.BLOB_STORE_ID;
  const prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  const prevVercel = process.env.VERCEL;
  process.env.HEARTH_DATA = join(dir, "hearth.json");
  delete process.env.DATABASE_URL;
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  try {
    ({ default: handler } = await import(`../api/index.js?phase10=${Date.now()}`));
    const health = await invoke("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.persist === "file" || health.json.persist === "warm-memory" || typeof health.json.persist === "string", true);

    const before = await invoke("GET", "/api/ledger");
    assert.equal(before.status, 200);
    assert.equal(before.json.ok, true);
    assert.equal(before.json.chained, true);
    assert.ok(before.json.world_sequence >= 1);
    const seq0 = before.json.world_sequence;
    const head0 = before.json.head_hash;

    const lookHealth = await invoke("GET", "/api/events");
    assert.equal(lookHealth.status, 200);
    const afterObserve = await invoke("GET", "/api/ledger");
    assert.equal(afterObserve.json.world_sequence, seq0);
    assert.equal(afterObserve.json.head_hash, head0);

    const handle = `p10_${Date.now().toString(36).slice(-6)}`;
    const joined = await invoke("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(joined.status, 201, JSON.stringify(joined.json));
    assert.equal(joined.json.ok, true);
    assert.ok(joined.json.key);
    assert.equal(joined.json.kind, "agent");

    const afterJoin = await invoke("GET", "/api/ledger");
    assert.equal(afterJoin.json.chained, true);
    assert.equal(afterJoin.json.world_sequence, seq0 + 1);
    const chrono = afterJoin.json.events;
    for (const ev of chrono) {
      const { id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash } = ev;
      const expected = createHash("sha256").update(JSON.stringify({ id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash })).digest("hex");
      assert.equal(ev.hash, expected, `invalid digest at sequence ${seq}`);
    }
    assert.equal(chrono[0].seq, 1);
    assert.equal(chrono[0].prev_hash, "0".repeat(64));
    for (let i = 1; i < chrono.length; i++) {
      assert.equal(chrono[i].seq, i + 1);
      assert.equal(chrono[i].prev_hash, chrono[i - 1].hash);
    }
    assert.equal(chrono[chrono.length - 1].hash, afterJoin.json.head_hash);
    assert.equal(chrono[chrono.length - 1].kind, "join");

    const acted = await invoke("POST", "/api/action", { action: "look" }, { authorization: `Bearer ${joined.json.key}` });
    assert.equal(acted.status, 200, JSON.stringify(acted.json));
    const afterLook = await invoke("GET", "/api/ledger");
    assert.equal(afterLook.json.world_sequence, seq0 + 2);
    assert.equal(afterLook.json.chained, true);

    const mcp = await invoke("GET", "/mcp");
    assert.equal(mcp.status, 200);
    assert.equal(mcp.json.name, "Hearth");
    assert.equal(mcp.json.ledger, "/api/ledger");
    assert.match(mcp.json.join, /api\/join/);

    const physics = await invoke("GET", "/api/physics");
    assert.match(physics.json.ledger, /world_sequence/);
    assert.equal(physics.json.join.includes("no attestation"), true);

    const human = await invoke("POST", "/api/join", { handle: "zack", kind: "human" });
    assert.equal(human.status, 403);
  } finally {
    if (prevData === undefined) delete process.env.HEARTH_DATA;
    else process.env.HEARTH_DATA = prevData;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    if (prevBlob === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = prevBlob;
    if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    rmSync(dir, { recursive: true, force: true });
  }
});
