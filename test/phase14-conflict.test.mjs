import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

const clone = structuredClone;
let isolate = 0;
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
// The only storage boundary is this fake: staged writes, exclusive row locks,
// rollback, failed UPDATE, and delayed COMMIT. No database connection is opened.
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
              if (db.failUpdate) throw new Error("synthetic destruction write failure");
              pending = JSON.parse(values[0]);
              return { rowCount: 1 };
            } else if (kind === "COMMIT") {
              assert.ok(open && unlock && pending);
              if (db.beforeCommit) await db.beforeCommit();
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
  const mod = await import(`../api/index.js?phase14=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  return mod.default;
}
async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase14";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase14-seed=${++isolate}`);
  let body;
  mod.__setBlobClientForTests({ async get() { return null; }, async put(_path, value) { body = value; } });
  assert.equal((await invoke(mod.default, "GET", "/health")).status, 200);
  const legacy = JSON.parse(body);
  for (const p of legacy.places) for (const k of ["destroy_thing", "destroy_note", "destroy_place"]) delete p.permissions[k];
  const db = new Database(legacy);
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
  const reject = async (resident, body, status) => {
    const before = clone(db.world), revision = db.revision, start = db.history.length;
    const out = await act(resident, body);
    assert.equal(out.status, status, JSON.stringify(out.json));
    assert.deepEqual(db.world, before);
    assert.equal(db.revision, revision);
    assert.deepEqual(db.history.slice(start), ["BEGIN", "SET", "SET", "LOCK", "ROLLBACK"]);
  };
  return { db, handler, request, join, alice, bob, act, ok, reject };
}

test("Phase 14: a late arrival really burns the original board and note; tombstones cannot be used or given", async () => {
  const { db, request, alice, bob, ok, reject } = await setup();
  const before = clone(db.world), revision = db.revision;
  for (const path of ["/api/map", "/api/physics", "/api/ledger"]) assert.equal((await request("GET", path)).status, 200);
  assert.deepEqual(db.world, before); assert.equal(db.revision, revision);
  for (const [targetKind, targetId, collection] of [["thing", "t_board", "things"], ["note", "n_arrive", "notes"]]) {
    const oldEvents = clone(db.world.events);
    const out = await ok(bob, { action: "destroy", targetKind, targetId });
    assert.deepEqual(out.destroyed, { kind: targetKind, id: targetId });
    const tombstone = db.world[collection].find(x => x.id === targetId);
    assert.ok(tombstone.destroyedAt);
    assert.equal(tombstone.destroyedBy, bob.handle);
    assert.equal(tombstone.destroyedEventId, out.event.id);
    assert.deepEqual(db.world.events.slice(1), oldEvents);
    assert.match(out.event.text, new RegExp(targetId)); checkChain(db.world);
    assert.equal((await request("GET", "/api/map")).json[collection].some(x => x.id === targetId), false);
    assert.equal((await request("GET", "/api/me", undefined, alice.key)).json.perception[collection].some(x => x.id === targetId), false);
    await reject(alice, { action: "destroy", targetKind, targetId }, 404);
  }
  await reject(bob, { action: "use", targetId: "t_board" }, 404);
  // Even the original owner cannot transfer a destroyed resource.
  db.world.things.find(t => t.id === "t_board").ownerHandle = alice.handle;
  await reject(alice, { action: "give", targetId: "t_board", toHandle: bob.handle }, 400);
  assert.equal(db.world.things.find(t => t.id === "t_board").body, before.things.find(t => t.id === "t_board").body);
  assert.deepEqual(db.world.places.find(p => p.id === "arrival").permissions, before.places.find(p => p.id === "arrival").permissions);
});

test("Phase 14: target land controls opposing owners and authors; closed denies even the land owner", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Local archive" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(bob, { action: "make", name: "rival artifact", body: "no classification" });
  const thing = db.world.things.at(-1).id;
  await reject(bob, { action: "destroy", targetKind: "thing", targetId: thing }, 403);
  await ok(alice, { action: "permit", name: "destroy_thing", body: "closed" });
  await reject(alice, { action: "destroy", targetKind: "thing", targetId: thing }, 403);
  await ok(alice, { action: "permit", name: "destroy_thing", body: "owner_only" });
  await ok(alice, { action: "destroy", targetKind: "thing", targetId: thing });
  await ok(alice, { action: "say", body: "opposing resident may erase this" });
  const note = db.world.notes.at(-1).id;
  await reject(bob, { action: "destroy", targetKind: "note", targetId: note }, 403);
  await ok(alice, { action: "permit", name: "destroy_note", body: "public" });
  await ok(bob, { action: "destroy", targetKind: "note", targetId: note });
  checkChain(db.world);
});

test("Phase 14: parent permissions never grant or revoke destruction authority on a child's land", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const parent = (await ok(alice, { action: "found", name: "Parent land" })).event.placeId;
  await ok(alice, { action: "walk", targetId: parent });
  await ok(alice, { action: "permit", name: "create_subplace", body: "public" });
  await ok(alice, { action: "permit", name: "destroy_thing", body: "public" });
  await ok(bob, { action: "walk", targetId: parent });
  const child = (await ok(bob, { action: "found", name: "Sovereign child" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: child });
  await ok(bob, { action: "make", name: "child property", body: "protected locally" });
  const targetId = db.world.things.at(-1).id;
  await reject(alice, { action: "destroy", targetKind: "thing", targetId }, 403);
  await reject(alice, { action: "permit", name: "destroy_thing", body: "public" }, 403);
  await ok(alice, { action: "walk", targetId: parent });
  await ok(alice, { action: "permit", name: "destroy_thing", body: "closed" });
  await ok(alice, { action: "permit", name: "enter", body: "closed" });
  await ok(alice, { action: "walk", targetId: child });
  await ok(bob, { action: "permit", name: "destroy_thing", body: "public" });
  await ok(alice, { action: "destroy", targetKind: "thing", targetId });
  checkChain(db.world);
});

test("Phase 14: an opponent destroys occupied home land; closed doors cannot trap occupants or an absent home owner", async () => {
  const { db, request, join, alice, bob, ok, reject } = await setup();
  const carol = await join("carol_probe");
  const room = (await ok(alice, { action: "found", name: "Contested home" })).event.placeId;
  for (const resident of [alice, bob, carol]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "set_home", targetId: room });
  await reject(bob, { action: "destroy", targetKind: "place", targetId: room }, 403);
  for (const name of ["enter", "observe", "speak", "create_note", "create_subplace", "place_thing", "use_thing"]) {
    await ok(alice, { action: "permit", name, body: "closed" });
  }
  await ok(alice, { action: "permit", name: "destroy_place", body: "public" });
  await ok(alice, { action: "walk", targetId: "arrival" });
  const oldEvents = clone(db.world.events);
  const out = await ok(bob, { action: "destroy", targetKind: "place", targetId: room });
  assert.equal(out.me.standingId, bob.enclaveId);
  assert.equal(out.perception.place.id, bob.enclaveId);
  assert.deepEqual(out.relocated.map(r => r.handle).sort(), [bob.handle, carol.handle].sort());
  assert.deepEqual(db.world.events.slice(1), oldEvents);
  for (const resident of [alice, bob, carol]) {
    const stored = db.world.residents.find(r => r.handle === resident.handle);
    assert.equal(stored.homeId, resident.enclaveId);
    assert.equal((await request("GET", "/api/me", undefined, resident.key)).status, 200);
    assert.equal((await ok(resident, { action: "go_home" })).me.standingId, resident.enclaveId);
  }
  assert.equal(db.world.portals.some(p => p.a === room || p.b === room), false);
  assert.equal((await request("GET", "/api/map")).json.places.some(p => p.id === room), false);
  await ok(alice, { action: "walk", targetId: "arrival" });
  assert.equal((await request("GET", "/api/me", undefined, alice.key)).json.perception.exits.some(p => p.id === room), false);
  await reject(alice, { action: "look", targetId: room }, 404);
  await reject(alice, { action: "walk", targetId: room }, 403);
  await reject(alice, { action: "set_home", targetId: room }, 404);
  await reject(alice, { action: "destroy", targetKind: "place", targetId: room }, 404);
  checkChain(db.world);
});

test("Phase 14: demolition cannot cascade into child land or bypass permissions on contained resources", async () => {
  for (const contained of ["thing", "note", "place"]) {
    const { db, alice, bob, ok, reject } = await setup();
    const parent = (await ok(alice, { action: "found", name: "Not an override" })).event.placeId;
    for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: parent });
    await ok(alice, { action: "permit", name: "destroy_place", body: "public" });
    if (contained === "thing") {
      await ok(bob, { action: "make", name: "retained thing", body: "not collateral" });
      await ok(alice, { action: "permit", name: "destroy_thing", body: "closed" });
    } else if (contained === "note") {
      await ok(bob, { action: "say", body: "retained note" });
      await ok(alice, { action: "permit", name: "destroy_note", body: "closed" });
    } else {
      await ok(alice, { action: "permit", name: "create_subplace", body: "public" });
      const child = (await ok(bob, { action: "found", name: "Sovereign child" })).event.placeId;
      assert.equal(db.world.places.find(p => p.id === child).ownerHandle, bob.handle);
    }
    await reject(bob, { action: "destroy", targetKind: "place", targetId: parent }, 409);
    await reject(alice, { action: "destroy", targetKind: "place", targetId: parent }, 409);
  }
});

test("Phase 14: Root, Arrival, and personal enclaves stay viable even after destroy_place is public", async () => {
  const { alice, bob, ok, reject } = await setup();
  await reject(alice, { action: "destroy", targetKind: "place", targetId: "arrival" }, 403);
  await ok(alice, { action: "walk", targetId: "world" });
  await reject(alice, { action: "destroy", targetKind: "place", targetId: "world" }, 403);
  await ok(alice, { action: "go_home" });
  await ok(alice, { action: "permit", name: "destroy_place", body: "public" });
  await ok(alice, { action: "permit", name: "enter", body: "public" });
  await ok(bob, { action: "walk", targetId: alice.enclaveId });
  for (const resident of [alice, bob]) await reject(resident, { action: "destroy", targetKind: "place", targetId: alice.enclaveId }, 403);
  assert.equal((await ok(bob, { action: "go_home" })).me.standingId, bob.enclaveId);
});

test("Phase 14: destroyed contents cease blocking a leaf; missing enclave fallback reaches Arrival", async () => {
  const { db, alice, bob, ok } = await setup();
  const room = (await ok(alice, { action: "found", name: "Clearable room" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "temporary thing", body: "clear first" });
  await ok(alice, { action: "destroy", targetKind: "thing", targetId: db.world.things.at(-1).id });
  await ok(alice, { action: "say", body: "temporary note" });
  await ok(alice, { action: "destroy", targetKind: "note", targetId: db.world.notes.at(-1).id });
  const child = (await ok(alice, { action: "found", name: "Temporary child" })).event.placeId;
  await ok(alice, { action: "walk", targetId: child });
  await ok(alice, { action: "destroy", targetKind: "place", targetId: child });
  await ok(alice, { action: "walk", targetId: "arrival" });
  await ok(alice, { action: "walk", targetId: room });
  // Model an incomplete legacy home reference, not a resident destruction API.
  db.world.residents.find(r => r.handle === bob.handle).enclaveId = "missing_legacy_enclave";
  const out = await ok(alice, { action: "destroy", targetKind: "place", targetId: room });
  assert.equal(out.relocated.find(r => r.handle === bob.handle).standingId, "arrival");
  const stored = db.world.residents.find(r => r.handle === bob.handle);
  stored.homeId = room;
  assert.equal((await ok(bob, { action: "go_home" })).me.standingId, "arrival");
  checkChain(db.world);
});

test("Phase 14: old owned parcels default to owner_only and first settlers have no demolition immunity", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const hermes = { handle: "hermes", key: "synthetic-settler-test-key" };
  db.world.residents.find(r => r.handle === hermes.handle).keyHash = createHash("sha256").update(hermes.key).digest("hex");
  await ok(alice, { action: "walk", targetId: "hall" });
  await reject(alice, { action: "destroy", targetKind: "place", targetId: "hall" }, 403);
  await ok(hermes, { action: "permit", name: "destroy_place", body: "public" });
  const out = await ok(alice, { action: "destroy", targetKind: "place", targetId: "hall" });
  assert.equal(out.relocated.find(r => r.handle === hermes.handle).standingId, "enclave_hermes");
  assert.ok(db.world.places.find(p => p.id === "hall").destroyedAt);
  assert.equal(db.world.residents.find(r => r.handle === bob.handle).standingId, "arrival");
  checkChain(db.world);
});

test("Phase 14: 13 identities, private memories and all 179 legacy events survive a destruction transaction", async () => {
  const { db, request, join, alice, bob, ok } = await setup();
  for (let i = 0; i < 5; i++) await join(`retained_${i}`);
  for (const resident of [alice, bob]) {
    assert.equal((await request("POST", "/api/memory", { summary: `SYNTHETIC_PRIVATE_${resident.handle}` }, resident.key)).status, 200);
  }
  db.world.events = Array.from({ length: 179 }, (_, i) => ({
    id: `legacy_${179 - i}`, kind: "say", text: `original ${179 - i}`,
    placeId: "arrival", actorHandle: null, createdAt: "2026-09-01T00:00:00.000Z",
  }));
  for (const field of ["world_sequence", "ledger_head", "ledger_genesis"]) delete db.world[field];
  db.world.opaque = { preserved: [13, 179] };
  const original = clone(db.world), revision = db.revision;
  for (const path of ["/health", "/api/map", "/api/ledger"]) assert.equal((await request("GET", path)).status, 200);
  assert.deepEqual(db.world, original); assert.equal(db.revision, revision);
  await ok(bob, { action: "destroy", targetKind: "thing", targetId: "t_board" });
  assert.equal(db.world.residents.length, 13);
  for (const resident of original.residents) {
    const current = db.world.residents.find(r => r.id === resident.id);
    const expected = clone(resident);
    if (resident.handle === bob.handle) expected.depth++;
    assert.deepEqual(current, expected);
  }
  for (const field of ["memories", "agreements", "notes", "places", "portals", "rates", "quests", "opaque"]) assert.deepEqual(db.world[field], original[field]);
  for (const [i, ev] of db.world.events.slice(1).entries()) {
    const { seq, prev_hash, hash, ...fields } = ev;
    assert.deepEqual(fields, original.events[i]);
  }
  assert.equal(db.world.world_sequence, 180); checkChain(db.world);
  for (const path of ["/api/map", "/api/events", "/api/ledger"]) {
    const out = await request("GET", path);
    for (const resident of [alice, bob]) assert.equal(out.text.includes(`SYNTHETIC_PRIVATE_${resident.handle}`), false);
    for (const resident of db.world.residents) if (resident.keyHash) assert.equal(out.text.includes(resident.keyHash), false);
    assert.equal(out.text.includes(alice.key), false); assert.equal(out.text.includes(bob.key), false);
  }
  for (const resident of [alice, bob]) {
    const memory = await request("GET", "/api/memory", undefined, resident.key);
    assert.equal(memory.status, 200);
    assert.deepEqual(memory.json.map(m => m.agentHandle), [resident.handle]);
  }
  assert.equal((await request("GET", "/api/memory")).status, 401);
});

test("Phase 14: invalid targets, remote destruction, missing auth, and humans reject without writes", async () => {
  const { db, request, alice, bob, ok, reject } = await setup();
  for (const targetKind of ["resident", "memory", "agreement", "ledger", "__proto__", null]) {
    await reject(alice, { action: "destroy", targetKind, targetId: bob.handle }, 400);
  }
  for (const targetId of [null, 17, {}, ""]) await reject(alice, { action: "destroy", targetKind: "thing", targetId }, 400);
  await reject(alice, { action: "destroy", targetKind: "thing", targetId: "absent" }, 404);
  await ok(alice, { action: "go_home" });
  await reject(alice, { action: "destroy", targetKind: "thing", targetId: "t_board" }, 403);
  const before = clone(db.world), revision = db.revision;
  assert.equal((await request("POST", "/api/action", { action: "destroy", targetKind: "thing", targetId: "t_board" })).status, 401);
  assert.equal((await request("POST", "/api/join", { handle: "human_probe", kind: "human" })).status, 403);
  assert.deepEqual(db.world, before); assert.equal(db.revision, revision);
});

test("Phase 14: failed UPDATE rolls destruction back; success waits for COMMIT", async () => {
  const { db, bob, act, ok } = await setup();
  const before = clone(db.world), revision = db.revision;
  const action = { action: "destroy", targetKind: "thing", targetId: "t_board" };
  db.failUpdate = true;
  assert.equal((await act(bob, action)).status, 503);
  assert.deepEqual(db.world, before); assert.equal(db.revision, revision);
  assert.equal(db.history.at(-1), "ROLLBACK");
  db.failUpdate = false;
  let entered, release;
  const atCommit = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  db.beforeCommit = () => { entered(); return gate; };
  let finished = false;
  const pending = ok(bob, action).then(out => { finished = true; return out; });
  await atCommit;
  assert.equal(finished, false); assert.deepEqual(db.world, before);
  release(); await pending;
  assert.equal(db.revision, revision + 1); assert.ok(db.world.things.find(t => t.id === "t_board").destroyedAt);
  checkChain(db.world);
});

test("Phase 14: two isolates racing to destroy one resource commit exactly one chained event", async () => {
  const { db, handler, alice, bob } = await setup();
  const second = await databaseHandler(db);
  const events = clone(db.world.events), revision = db.revision;
  const body = { action: "destroy", targetKind: "thing", targetId: "t_board" };
  const results = await Promise.all([
    invoke(handler, "POST", "/api/action", body, alice.key),
    invoke(second, "POST", "/api/action", body, bob.key),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 404]);
  assert.equal(db.revision, revision + 1);
  assert.deepEqual(db.world.events.slice(1), events); checkChain(db.world);
});

test("Phase 14: physics, descriptor and served skill describe the same destroy contract", async () => {
  const { request } = await setup();
  const physics = (await request("GET", "/api/physics")).json;
  assert.ok(physics.actions.includes("destroy"));
  assert.deepEqual(physics.destruction.targetKinds, ["thing", "note", "place"]);
  for (const permission of ["destroy_thing", "destroy_note", "destroy_place"]) assert.ok(physics.permissions.includes(permission));
  assert.ok((await request("GET", "/mcp")).json.tools.includes("destroy"));
  const skill = (await request("GET", "/skill.md")).text;
  assert.match(skill, /targetKind/); assert.match(skill, /destroy_place/); assert.match(skill, /go_home/);
});
