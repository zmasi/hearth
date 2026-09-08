import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

const clone = structuredClone;
let isolate = 0;
const THING_KEYS = ["id", "name", "body", "ownerHandle", "placeId", "createdAt"];
const CLASSIFICATION = ["kind", "kinds", "trait", "traits", "class", "type", "category", "tags"];
const digest = ev => {
  const { id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash } = ev;
  return createHash("sha256").update(JSON.stringify({ id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash })).digest("hex");
};
function checkChain(world) {
  let previous = "0".repeat(64);
  for (const [i, ev] of world.events.slice().reverse().entries()) {
    assert.equal(ev.seq, i + 1);
    assert.equal(ev.prev_hash, previous);
    assert.equal(ev.hash, digest(ev));
    previous = ev.hash;
  }
  assert.equal(world.ledger_head, previous);
  assert.equal(world.world_sequence, world.events.length);
}
function assertUntypedThing(thing) {
  assert.deepEqual(Object.keys(thing).sort(), [...THING_KEYS].sort());
  for (const key of CLASSIFICATION) assert.equal(thing[key], undefined);
}
async function invoke(handler, method, url, body, key) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  let status, headers, text;
  await handler(req, {
    writeHead(s, h) { status = s; headers = h; },
    end(raw) { text = String(raw); },
  });
  return { status, text, json: headers["content-type"].includes("application/json") ? JSON.parse(text) : null };
}
class Database {
  constructor(world) {
    this.world = clone(world);
    this.history = [];
    this.revision = 1;
    this.tail = Promise.resolve();
  }
  pool() {
    const db = this;
    return {
      async query(sql) {
        assert.match(sql, /^SELECT world/);
        db.history.push("SELECT");
        return { rows: [{ world: clone(db.world) }] };
      },
      async connect() {
        let open = false, unlock = null, pending = null;
        return {
          async query(sql, values) {
            const kind = sql.startsWith("SELECT world") ? "LOCK" : sql.startsWith("UPDATE hearth_ledger") ? "UPDATE" : sql.startsWith("SET LOCAL") ? "SET" : sql;
            db.history.push(kind);
            if (kind === "BEGIN") { assert.equal(open, false); open = true; }
            else if (kind === "SET") assert.ok(open);
            else if (kind === "LOCK") {
              assert.ok(open);
              assert.match(sql, /FOR UPDATE$/);
              const before = db.tail;
              db.tail = new Promise(resolve => { unlock = resolve; });
              await before;
              return { rows: [{ world: clone(db.world) }] };
            } else if (kind === "UPDATE") {
              assert.ok(open && unlock);
              pending = JSON.parse(values[0]);
              return { rowCount: 1 };
            } else if (kind === "COMMIT") {
              assert.ok(open && unlock && pending);
              db.world = pending; db.revision++;
              open = false; unlock(); unlock = null;
            } else if (kind === "ROLLBACK") {
              assert.ok(open); open = false; pending = null;
              if (unlock) unlock(); unlock = null;
            } else assert.fail(`Unexpected SQL: ${sql}`);
            return { rows: [] };
          },
          release() { assert.equal(open, false, "released open transaction"); },
        };
      },
    };
  }
}
async function databaseHandler(db) {
  process.env.DATABASE_URL = "postgresql://synthetic.invalid/hearth";
  process.env.VERCEL = "1";
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase7=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  return mod.default;
}
async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase7";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase7-seed=${++isolate}`);
  let body;
  mod.__setBlobClientForTests({ async get() { return null; }, async put(_path, value) { body = value; } });
  assert.equal((await invoke(mod.default, "GET", "/health")).status, 200);
  const db = new Database(JSON.parse(body));
  const handler = await databaseHandler(db);
  const request = (method, path, body, key) => invoke(handler, method, path, body, key);
  const join = async handle => {
    const out = await request("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(out.status, 201); return out.json;
  };
  const alice = await join("alice_probe"), bob = await join("bob_probe");
  const act = (resident, body) => request("POST", "/api/action", body, resident.key);
  const ok = async (resident, body) => {
    const out = await act(resident, body);
    assert.equal(out.status, 200, JSON.stringify(out.json)); return out.json;
  };
  return { db, request, alice, bob, ok };
}

test("Phase 7: make stores an untyped thing and ignores classification fields", async () => {
  const { db, alice, ok } = await setup();
  const room = (await ok(alice, { action: "found", name: "Untyped floor" })).event.placeId;
  await ok(alice, { action: "walk", targetId: room });
  await ok(alice, {
    action: "make",
    name: "plain lamp",
    body: "just text",
    kind: "weapon",
    kinds: ["quest"],
    trait: "sharp",
    traits: ["rare"],
    class: "legendary",
    type: "item",
    category: "gear",
    tags: ["pvp"],
  });
  const thing = db.world.things.at(-1);
  assert.equal(thing.name, "plain lamp");
  assert.equal(thing.body, "just text");
  assert.equal(thing.ownerHandle, "alice_probe");
  assert.equal(thing.placeId, room);
  assertUntypedThing(thing);
  checkChain(db.world);
});

test("Phase 7: give and use do not consult a class; pin still invents the verb", async () => {
  const { db, request, alice, bob, ok } = await setup();
  const room = (await ok(alice, { action: "found", name: "Shared bench" })).event.placeId;
  await ok(alice, { action: "walk", targetId: room });
  await ok(bob, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "bench", body: "untyped cedar" });
  const bench = db.world.things.at(-1).id;
  await ok(alice, { action: "give", targetId: bench, toHandle: "bob_probe" });
  assert.equal(db.world.things.find(t => t.id === bench).ownerHandle, "bob_probe");
  assertUntypedThing(db.world.things.find(t => t.id === bench));
  await ok(bob, { action: "use", targetId: bench });
  await ok(alice, { action: "permit", name: "pin_script", body: "public" });
  const pinned = await ok(bob, {
    action: "pin",
    targetKind: "thing",
    targetId: bench,
    verb: "sit",
    instructions: [{ do: "use", targetId: "$target" }],
  });
  assert.equal(pinned.pin.verb, "sit");
  await ok(alice, { action: "perform", verb: "sit", targetId: bench });
  const map = await request("GET", "/api/map");
  assert.equal(map.status, 200);
  for (const thing of map.json.things) assertUntypedThing(thing);
  const physics = await request("GET", "/api/physics");
  assert.equal(physics.status, 200);
  assert.equal(physics.json.kinds, undefined);
  assert.equal(physics.json.traits, undefined);
  assert.equal(physics.json.classes, undefined);
  assert.ok(physics.json.actions.includes("make"));
  assert.ok(physics.json.actions.includes("give"));
  assert.ok(physics.json.actions.includes("perform"));
  const join = await request("POST", "/api/join", { handle: "late_probe", kind: "agent" });
  assert.equal(join.status, 201);
  checkChain(db.world);
});
