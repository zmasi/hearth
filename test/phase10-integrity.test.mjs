import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

const digest = value => createHash("sha256").update(value).digest("hex");
const zero = "0".repeat(64);
const key = "synthetic-integrity-test-key";
const clone = structuredClone;
function preimage(ev) {
  const { id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash } = ev;
  return JSON.stringify({ id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash });
}
function fixture(count = 3, chained = true) {
  const world = {
    version: "3.1", events: [], rates: {},
    residents: [{ id: "agt_probe", handle: "p10_probe", kind: "agent", keyHash: digest(key), homeId: "enclave_probe", enclaveId: "enclave_probe", standingId: "arrival", visits: ["arrival"], marks: [], depth: 1 }],
    places: [
      { id: "arrival", name: "Arrival", parentId: "world", ownerHandle: null, permissions: { observe: "public", enter: "public" }, laws: [] },
      { id: "enclave_probe", name: "Home", parentId: "arrival", ownerHandle: "p10_probe", permissions: { observe: "closed", enter: "closed" }, laws: [] },
    ],
    memories: [{ id: "memory_1", agentHandle: "p10_probe", summary: "synthetic private memory" }],
    notes: [], things: [], agreements: [], portals: [], opaque: { preserved: true },
  };
  let prev = zero;
  for (let i = 1; i <= count; i++) {
    const ev = { id: `event_${i}`, kind: "say", text: `original event ${i}`, placeId: "arrival", actorHandle: "p10_probe", createdAt: "2026-09-01T00:00:00.000Z" };
    if (chained) { ev.seq = i; ev.prev_hash = prev; ev.hash = digest(preimage(ev)); prev = ev.hash; }
    world.events.unshift(ev);
  }
  if (chained) Object.assign(world, { world_sequence: count, ledger_head: prev, ledger_genesis: count ? world.events.at(-1).hash : zero });
  return world;
}
function poolFor(initial) {
  const db = { world: clone(initial), updates: 0, commits: 0, rollbacks: 0 };
  db.pool = {
    async query(sql) { assert.match(sql, /^SELECT world/); return { rows: [{ world: clone(db.world) }] }; },
    async connect() {
      let pending = null;
      return {
        async query(sql, values) {
          if (sql.startsWith("SELECT world")) return { rows: [{ world: clone(db.world) }] };
          if (sql.startsWith("UPDATE hearth_ledger")) { db.updates++; pending = JSON.parse(values[0]); return { rowCount: 1 }; }
          if (sql === "COMMIT") { db.commits++; if (pending) db.world = pending; }
          else if (sql === "ROLLBACK") { db.rollbacks++; pending = null; }
          else assert(sql === "BEGIN" || sql.startsWith("SET LOCAL"), `unexpected SQL ${sql}`);
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return db;
}
let isolate = 0;
async function setup(world) {
  process.env.DATABASE_URL = "postgresql://fake:fake@localhost/test?sslmode=verify-full";
  process.env.VERCEL = "1";
  const mod = await import(`../api/index.js?integrity=${++isolate}`);
  const db = poolFor(world); mod.__setPostgresPoolForTests(db.pool);
  async function invoke(method, url, body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: { host: "localhost", authorization: `Bearer ${key}` } });
    let status, json;
    await mod.default(req, { writeHead(s) { status = s; }, end(raw) { json = JSON.parse(raw); } });
    return { status, json };
  }
  return { db, invoke };
}
const damage = [
  ["altered historical content", w => { w.events[1].text = "changed history"; }],
  ["missing middle event", w => { w.events.splice(1, 1); }],
  ["partial event chain", w => { delete w.events[1].hash; }],
  ["inconsistent sequence", w => { w.world_sequence--; }],
  ["inconsistent head", w => { w.ledger_head = zero; }],
  ["missing world metadata", w => { delete w.ledger_genesis; }],
  ["missing event chain with world metadata retained", w => { for (const e of w.events) for (const k of ["seq", "prev_hash", "hash"]) delete e[k]; }],
  ["malformed event collection", w => { w.events = null; }],
];
for (const [name, corrupt] of damage) {
  test(`Phase 10 refuses ${name} without rehashing or writing`, async () => {
    const w = fixture(); corrupt(w);
    const { db, invoke } = await setup(w);
    const health = await invoke("GET", "/health");
    assert.equal(health.status, 503);
    assert.equal(health.json.ok, false);
    assert.equal(health.json.persist, "postgres-error");
    assert.match(health.json.persist_error, /integrity/i);
    assert.equal((await invoke("GET", "/api/ledger")).status, 503);
    assert.equal((await invoke("POST", "/api/action", { action: "no_op" })).status, 503);
    assert.equal(db.updates, 0); assert.equal(db.commits, 0); assert.equal(db.rollbacks, 1);
    assert.deepEqual(db.world, w);
  });
}
test("Phase 10 seals only wholly legacy history, preserves 2005 events, and appends without rewriting", async () => {
  const original = fixture(2005, false);
  const { db, invoke } = await setup(original);
  const a = await invoke("GET", "/api/ledger");
  assert.equal(a.status, 200); assert.equal(a.json.world_sequence, 2005);
  assert.deepEqual(db.world, original); assert.equal(db.updates, 0);
  assert.equal((await invoke("POST", "/api/action", { action: "no_op" })).status, 200);
  const sealed = clone(db.world);
  for (let i = 0; i < original.events.length; i++) {
    const { seq, prev_hash, hash, ...retained } = sealed.events[i];
    assert.deepEqual(retained, original.events[i]); assert.equal(hash, digest(preimage(sealed.events[i])));
  }
  for (const [k,v] of Object.entries(original)) if (k !== "events") assert.deepEqual(sealed[k], v);
  assert.equal((await invoke("POST", "/api/action", { action: "go_home" })).status, 200);
  assert.equal(db.world.world_sequence, 2006);
  assert.deepEqual(db.world.events.slice(1), sealed.events);
  assert.equal(db.world.events[0].prev_hash, sealed.ledger_head);
});
test("Phase 10 accepts a valid empty chain and records its first genesis", async () => {
  const { db, invoke } = await setup(fixture(0));
  assert.equal((await invoke("GET", "/health")).status, 200);
  assert.equal((await invoke("POST", "/api/action", { action: "go_home" })).status, 200);
  assert.equal(db.world.world_sequence, 1);
  assert.equal(db.world.ledger_genesis, db.world.events[0].hash);
  assert.equal(db.world.events[0].prev_hash, zero);
});
