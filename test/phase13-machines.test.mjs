import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
              if (db.failUpdate) throw new Error("synthetic script write failure");
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
  const mod = await import(`../api/index.js?phase13-machines=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  return mod.default;
}
async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase13_machines";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase13-machines-seed=${++isolate}`);
  let body;
  mod.__setBlobClientForTests({ async get() { return null; }, async put(_path, value) { body = value; } });
  assert.equal((await invoke(mod.default, "GET", "/health")).status, 200);
  const legacy = JSON.parse(body);
  for (const p of legacy.places) {
    for (const k of ["destroy_thing", "destroy_note", "destroy_place", "pin_script"]) delete p.permissions[k];
  }
  delete legacy.scripts;
  const db = new Database(legacy);
  const handler = await databaseHandler(db);
  const request = (method, path, body, key) => invoke(handler, method, path, body, key);
  const join = async handle => {
    const out = await request("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(out.status, 201); return out.json;
  };
  const alice = await join("alice_probe"), bob = await join("bob_probe");
  const carol = await join("carol_probe"), dave = await join("dave_probe");
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
    return out.json;
  };
  return { db, handler, request, join, alice, bob, carol, dave, act, ok, reject };
}

test("Phase 13 machines: a weir two residents charge and a third can break", async () => {
  const { db, request, alice, bob, carol, dave, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Upper weir" })).event.placeId;
  for (const resident of [alice, bob, carol, dave]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "weir", body: "a cranked gate" });
  const weir = db.world.things.at(-1).id;
  await ok(alice, { action: "make", name: "marker", body: "downstream witness" });
  const marker = db.world.things.at(-1).id;
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: weir, verb: "crank",
    instructions: [
      { do: "add", field: "charge", by: "1" },
      { do: "when", field: "charge", gte: "3" },
      { do: "set", field: "open", to: "1" },
      { do: "say", body: "the weir lifts" },
    ],
  });
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: marker, verb: "spill",
    instructions: [
      { do: "require", field: "open", of: weir, eq: "1" },
      { do: "make", name: "wet stone", body: "water reached here" },
    ],
  });

  const first = await ok(bob, { action: "perform", verb: "crank", targetId: weir });
  assert.equal(db.world.things.find(t => t.id === weir).fields.charge, 1);
  assert.equal(Object.hasOwn(db.world.things.find(t => t.id === weir).fields, "open"), false);
  assert.equal(db.world.notes.some(n => n.body === "the weir lifts"), false);
  const meBob = await request("GET", "/api/me", undefined, bob.key);
  assert.equal(meBob.json.perception.things.find(t => t.id === weir).fields.charge, 1);
  const beforeSpill = clone(db.world), rev = db.revision;
  const deniedSpill = await reject(bob, { action: "perform", verb: "spill", targetId: marker }, 409);
  assert.equal(deniedSpill.error_class, "script_failure");
  assert.equal(deniedSpill.cause.error_class, "guard_failed");
  assert.equal(db.world.things.some(t => t.name === "wet stone"), false);
  assert.deepEqual(db.world, beforeSpill);
  assert.equal(db.revision, rev);

  await ok(bob, { action: "perform", verb: "crank", targetId: weir });
  const third = await ok(carol, { action: "perform", verb: "crank", targetId: weir });
  const gate = db.world.things.find(t => t.id === weir);
  assert.equal(gate.fields.charge, 3);
  assert.equal(gate.fields.open, 1);
  assert.equal(db.world.notes.some(n => n.body === "the weir lifts" && n.authorHandle === carol.handle), true);
  assert.ok(third.performed.steps.some(s => s.do === "set"));
  await ok(carol, { action: "perform", verb: "spill", targetId: marker });
  assert.equal(db.world.things.filter(t => t.name === "wet stone" && !t.destroyedAt).length, 1);

  const observed = clone(db.world), observedRev = db.revision;
  assert.equal((await request("GET", "/api/me", undefined, alice.key)).status, 200);
  assert.equal((await request("GET", "/api/perception", undefined, alice.key)).status, 200);
  assert.deepEqual(db.world.things.find(t => t.id === weir).fields, observed.things.find(t => t.id === weir).fields);
  assert.equal(db.revision, observedRev);

  await ok(alice, { action: "permit", name: "destroy_thing", body: "public" });
  await ok(dave, { action: "destroy", targetKind: "thing", targetId: weir });
  await reject(bob, { action: "perform", verb: "crank", targetId: weir }, 404);
  await reject(carol, { action: "perform", verb: "spill", targetId: marker }, 409);
  assert.equal(db.world.things.filter(t => t.name === "wet stone" && !t.destroyedAt).length, 1);
  checkChain(db.world);
});

test("Phase 13 machines: a two-person pump is a collective instrument", async () => {
  const { db, alice, bob, carol, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Pump house" })).event.placeId;
  for (const resident of [alice, bob, carol]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "pump", body: "needs both handles" });
  const pump = db.world.things.at(-1).id;
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: pump, verb: "press_left",
    instructions: [{ do: "set", field: "left", to: "1" }],
  });
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: pump, verb: "press_right",
    instructions: [{ do: "set", field: "right", to: "1" }],
  });
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: pump, verb: "draw",
    instructions: [
      { do: "require", field: "left", eq: "1" },
      { do: "require", field: "right", eq: "1" },
      { do: "add", field: "water", by: "1" },
      { do: "set", field: "left", to: "0" },
      { do: "set", field: "right", to: "0" },
      { do: "say", body: "the pump yields" },
    ],
  });
  await ok(alice, { action: "perform", verb: "press_left", targetId: pump });
  await reject(carol, { action: "perform", verb: "draw", targetId: pump }, 409);
  await ok(bob, { action: "perform", verb: "press_right", targetId: pump });
  await ok(carol, { action: "perform", verb: "draw", targetId: pump });
  const state = db.world.things.find(t => t.id === pump).fields;
  assert.equal(state.water, 1);
  assert.equal(state.left, 0);
  assert.equal(state.right, 0);
  assert.equal(db.world.notes.some(n => n.body === "the pump yields" && n.authorHandle === carol.handle), true);
});

test("Phase 13 machines: failed later world action rolls field edits back", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Atomic mill" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "mill", body: "must stay uncharged on fault" });
  const mill = db.world.things.at(-1).id;
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: mill, verb: "botch",
    instructions: [
      { do: "add", field: "charge", by: "1" },
      { do: "destroy", targetKind: "thing", targetId: "absent_target" },
    ],
  });
  const failed = await reject(bob, { action: "perform", verb: "botch", targetId: mill }, 404);
  assert.equal(failed.error_class, "script_failure");
  assert.equal(db.world.things.find(t => t.id === mill).fields, undefined);
});

test("Phase 13 machines: owner adjust seeds fields; visitors use pins; physical writes stay closed", async () => {
  const { db, request, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Bench" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "jig", body: "owner seeds, others crank" });
  const jig = db.world.things.at(-1).id;
  await reject(bob, { action: "adjust", targetKind: "thing", targetId: jig, field: "charge", op: "set", to: "2" }, 403);
  await ok(alice, { action: "adjust", targetKind: "thing", targetId: jig, field: "charge", op: "set", to: "2" });
  assert.equal(db.world.things.find(t => t.id === jig).fields.charge, 2);
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: jig, verb: "crank",
    instructions: [{ do: "add", field: "charge", by: "1" }],
  });
  await ok(bob, { action: "perform", verb: "crank", targetId: jig });
  assert.equal(db.world.things.find(t => t.id === jig).fields.charge, 3);
  await reject(alice, {
    action: "pin", targetKind: "thing", targetId: jig, verb: "flood",
    instructions: [{ do: "set", field: "level", to: "9", bag: "physical" }],
  }, 400);
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: jig, verb: "sense",
    instructions: [{ do: "require", field: "level", bag: "physical", gte: "1" }],
  });
  const sensed = await reject(bob, { action: "perform", verb: "sense", targetId: jig }, 409);
  assert.equal(sensed.cause.error_class, "guard_failed");
  await ok(alice, {
    action: "pin", targetKind: "thing", targetId: jig, verb: "drop",
    instructions: [{ do: "actuate", field: "aperture", to: "1" }],
  });
  const actuated = await reject(bob, { action: "perform", verb: "drop", targetId: jig }, 400);
  assert.equal(actuated.cause.error_class, "bad_input", "unknown actuator names stay closed after wiring");
  const ignite = await ok(alice, {
    action: "pin", targetKind: "thing", targetId: jig, verb: "ignite",
    instructions: [{ do: "use", targetId: "$target" }],
  });
  const used = await ok(bob, { action: "perform", verb: "ignite", targetId: jig });
  assert.equal(used.event.kind, "perform");
  assert.equal(ignite.pin.instructions[0].do, "use");
  const physics = (await request("GET", "/api/physics")).json;
  assert.equal(physics.scripts.eval, false);
  assert.equal(physics.scripts.actuate, true);
  assert.equal(physics.scripts.fields.namespace, "fields");
  assert.equal(physics.scripts.fields.physical_namespace, "physical");
  assert.equal(physics.scripts.guards, "fail_closed");
  assert.ok(physics.scripts.ops.includes("require"));
  assert.ok(physics.actions.includes("adjust"));
  const source = readFileSync(new URL("../api/index.js", import.meta.url), "utf8");
  assert.equal(/new\s+Function\s*\(|\beval\s*\(|node:vm|\bvm\.|child_process/.test(source), false);
});
