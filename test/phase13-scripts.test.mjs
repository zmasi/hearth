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
function instructionHash(instructions) {
  return createHash("sha256").update(JSON.stringify(instructions)).digest("hex");
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
  const mod = await import(`../api/index.js?phase13=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  return mod.default;
}
async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase13";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase13-seed=${++isolate}`);
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
  return { db, handler, request, join, alice, bob, act, ok, reject };
}

test("Phase 13: a resident pins a named custom verb and another resident actually composes world actions", async () => {
  const { db, request, alice, bob, ok } = await setup();
  const room = (await ok(alice, { action: "found", name: "Lamp workshop" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "lamp", body: "unlit brass" });
  const lamp = db.world.things.at(-1).id;
  const instructions = [
    { do: "say", body: "$caller strikes the $verb on $target" },
    { do: "use", targetId: "$target" },
    { do: "make", name: "spark", body: "what remains after ignite" },
  ];
  const pinned = await ok(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: lamp,
    verb: "ignite",
    instructions,
  });
  assert.equal(pinned.pin.verb, "ignite");
  assert.equal(pinned.pin.targetKind, "thing");
  assert.equal(pinned.pin.targetId, lamp);
  assert.equal(pinned.pin.authorHandle, alice.handle);
  assert.deepEqual(pinned.pin.instructions, instructions);
  assert.equal(pinned.pin.instructionHash, instructionHash(pinned.pin.instructions));
  assert.match(pinned.event.kind, /pin/);
  const me = await request("GET", "/api/me", undefined, bob.key);
  assert.equal(me.status, 200);
  const seen = me.json.perception.scripts.find(s => s.verb === "ignite");
  assert.equal(seen.id, pinned.pin.id);
  const notesBefore = db.world.notes.filter(n => n.placeId === room && !n.destroyedAt).length;
  const thingsBefore = db.world.things.filter(t => t.placeId === room && !t.destroyedAt).length;
  const out = await ok(bob, { action: "perform", verb: "ignite", targetId: lamp });
  assert.equal(out.performed.verb, "ignite");
  assert.equal(out.performed.pinId, pinned.pin.id);
  assert.equal(out.performed.instructionHash, pinned.pin.instructionHash);
  assert.equal(out.event.actorHandle, bob.handle);
  assert.equal(out.event.kind, "perform");
  const notes = db.world.notes.filter(n => n.placeId === room && !n.destroyedAt);
  assert.equal(notes.length, notesBefore + 1);
  assert.equal(notes.at(-1).authorHandle, bob.handle);
  assert.match(notes.at(-1).body, new RegExp(`${bob.handle} strikes the ignite on ${lamp}`));
  const sparks = db.world.things.filter(t => t.placeId === room && t.name === "spark" && !t.destroyedAt);
  assert.equal(sparks.length, 1);
  assert.equal(sparks[0].ownerHandle, bob.handle);
  assert.equal(db.world.things.filter(t => t.placeId === room && !t.destroyedAt).length, thingsBefore + 1);
  checkChain(db.world);
});

test("Phase 13: invocation runs as caller; scripts cannot borrow the pin author's rights or forge identity", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Owner-only shrine" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "idol", body: "ordinary text" });
  const idol = db.world.things.at(-1).id;
  await reject(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: idol,
    verb: "smash",
    instructions: [{ do: "destroy", targetKind: "thing", targetId: "$target", actorHandle: "alice_probe", asHandle: "hermes", key: "stolen" }],
  }, 400);
  await ok(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: idol,
    verb: "smash",
    instructions: [{ do: "destroy", targetKind: "thing", targetId: "$target" }],
  });
  const denied = await reject(bob, { action: "perform", verb: "smash", targetId: idol }, 403);
  assert.equal(denied.error_class, "script_failure");
  assert.equal(db.world.things.find(t => t.id === idol).destroyedAt, undefined);
  await ok(alice, { action: "permit", name: "destroy_thing", body: "public" });
  const smashed = await ok(bob, { action: "perform", verb: "smash", targetId: idol });
  assert.equal(smashed.event.actorHandle, bob.handle);
  assert.ok(db.world.things.find(t => t.id === idol).destroyedAt);
  assert.equal(db.world.things.find(t => t.id === idol).destroyedBy, bob.handle);
  assert.equal(db.world.events[0].actorHandle, bob.handle);
  checkChain(db.world);
});

test("Phase 13: scripts cannot trap go_home or send another resident home", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Closed chapel" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "seal",
    instructions: [
      { do: "permit", name: "enter", body: "closed" },
      { do: "permit", name: "observe", body: "closed" },
    ],
  });
  await ok(alice, { action: "perform", verb: "seal", targetId: room });
  const home = await ok(bob, { action: "go_home" });
  assert.equal(home.me.standingId, bob.enclaveId);
  await ok(bob, { action: "walk", targetId: "arrival" });
  await reject(bob, { action: "walk", targetId: room }, 403);
  await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "retreat",
    instructions: [{ do: "go_home" }],
  });
  const retreated = await ok(alice, { action: "perform", verb: "retreat", targetId: room });
  assert.equal(retreated.me.standingId, alice.enclaveId);
  assert.equal(db.world.residents.find(r => r.handle === bob.handle).standingId, "arrival");
  await reject(alice, {
    action: "pin",
    targetKind: "place",
    targetId: alice.enclaveId,
    verb: "kidnap",
    instructions: [{ do: "go_home", handle: "bob_probe" }],
  }, 400);
});

test("Phase 13: a failing instruction rolls every prior mutation back; history and revision stay put", async () => {
  const { db, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Atomic studio" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "botch",
    instructions: [
      { do: "say", body: "this note must not survive" },
      { do: "make", name: "ghost", body: "this thing must not survive" },
      { do: "destroy", targetKind: "thing", targetId: "absent_target" },
    ],
  });
  const notes = db.world.notes.length;
  const things = db.world.things.length;
  const events = db.world.events.length;
  const failed = await reject(bob, { action: "perform", verb: "botch", targetId: room }, 404);
  assert.equal(failed.error_class, "script_failure");
  assert.equal(db.world.notes.length, notes);
  assert.equal(db.world.things.length, things);
  assert.equal(db.world.events.length, events);
  assert.equal(db.world.notes.some(n => n.body === "this note must not survive"), false);
});

test("Phase 13: destroyed targets and unpinned scripts respect Phase 14 tombstones", async () => {
  const { db, request, alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Tomb studio" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "candle", body: "wax" });
  const candle = db.world.things.at(-1).id;
  const pinned = await ok(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: candle,
    verb: "snuff",
    instructions: [{ do: "use", targetId: "$target" }],
  });
  await ok(alice, { action: "permit", name: "destroy_thing", body: "public" });
  await ok(bob, { action: "destroy", targetKind: "thing", targetId: candle });
  await reject(bob, { action: "perform", verb: "snuff", targetId: candle }, 404);
  await reject(alice, { action: "use", targetId: candle }, 404);
  const afterDestroy = (await request("GET", "/api/me", undefined, alice.key)).json.perception.scripts || [];
  assert.equal(afterDestroy.some(s => s.id === pinned.pin.id), false);
  assert.equal((await request("GET", "/api/map")).json.scripts?.some(s => s.id === pinned.pin.id) ?? false, false);
  const live = await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "announce",
    instructions: [{ do: "say", body: "still here" }],
  });
  const unpinned = await ok(alice, { action: "unpin", targetId: live.pin.id });
  assert.equal(unpinned.unpinned.id, live.pin.id);
  const tombstone = (db.world.scripts || []).find(s => s.id === live.pin.id);
  assert.ok(tombstone.destroyedAt);
  assert.equal(tombstone.destroyedBy, alice.handle);
  await reject(bob, { action: "perform", verb: "announce", targetId: room }, 404);
  await reject(alice, { action: "unpin", targetId: live.pin.id }, 404);
  await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "last_word",
    instructions: [{ do: "say", body: "before demolition" }],
  });
  await ok(alice, { action: "destroy", targetKind: "place", targetId: room });
  await ok(alice, { action: "walk", targetId: "arrival" });
  await reject(alice, { action: "perform", verb: "last_word", targetId: room }, 404);
  await reject(alice, { action: "pin", targetKind: "place", targetId: room, verb: "haunt", instructions: [{ do: "look" }] }, 404);
});

test("Phase 13: pin_script is local land law; missing keys are evaluated, never migrated; parents do not inherit", async () => {
  const { db, request, alice, bob, ok, reject } = await setup();
  const before = clone(db.world), revision = db.revision;
  assert.equal((await request("GET", "/api/map")).status, 200);
  assert.equal((await request("GET", "/api/physics")).status, 200);
  assert.deepEqual(db.world, before);
  assert.equal(db.revision, revision);
  assert.equal(Object.hasOwn(db.world, "scripts"), false);
  for (const place of db.world.places) {
    if (place.id === alice.enclaveId || place.id === bob.enclaveId) {
      assert.equal(place.permissions.pin_script, "owner_only");
      continue;
    }
    assert.equal(Object.hasOwn(place.permissions, "pin_script"), false, place.id);
  }
  const room = (await ok(alice, { action: "found", name: "Local script land" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  const ritual = [{ do: "say", body: "only the land door matters" }];
  await reject(bob, { action: "pin", targetKind: "place", targetId: room, verb: "chant", instructions: ritual }, 403);
  await ok(alice, { action: "pin", targetKind: "place", targetId: room, verb: "chant", instructions: ritual });
  await ok(alice, { action: "permit", name: "pin_script", body: "closed" });
  await reject(alice, { action: "pin", targetKind: "place", targetId: room, verb: "dirge", instructions: ritual }, 403);
  await ok(alice, { action: "permit", name: "pin_script", body: "public" });
  await ok(bob, { action: "pin", targetKind: "place", targetId: room, verb: "dirge", instructions: ritual });
  await ok(alice, { action: "permit", name: "create_subplace", body: "public" });
  const child = (await ok(bob, { action: "found", name: "Sovereign child" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: child });
  await reject(alice, { action: "pin", targetKind: "place", targetId: child, verb: "chant", instructions: ritual }, 403);
  await ok(bob, { action: "pin", targetKind: "place", targetId: child, verb: "chant", instructions: ritual });
  for (const resident of [alice, bob]) {
    await ok(resident, { action: "go_home" });
    await ok(resident, { action: "walk", targetId: "arrival" });
  }
  const arrivalPin = await ok(bob, {
    action: "pin",
    targetKind: "thing",
    targetId: "t_board",
    verb: "read_aloud",
    instructions: [{ do: "use", targetId: "$target" }],
  });
  assert.equal(arrivalPin.pin.targetId, "t_board");
  await ok(bob, { action: "perform", verb: "read_aloud", targetId: "t_board" });
  checkChain(db.world);
});

test("Phase 13: mechanical bounds reject host escape, nested scripts, and reserved kernel verbs without judging content", async () => {
  const { alice, bob, ok, reject } = await setup();
  const room = (await ok(alice, { action: "found", name: "Bound studio" })).event.placeId;
  await ok(alice, { action: "walk", targetId: room });
  const say = [{ do: "say", body: "ok" }];
  for (const verb of ["haunt", "curse", "forgive", "overcharge", "swear_oath"]) {
    await ok(alice, { action: "pin", targetKind: "place", targetId: room, verb, instructions: say });
  }
  for (const verb of ["walk", "go_home", "destroy", "pin", "unpin", "perform", "join", "look"]) {
    await reject(alice, { action: "pin", targetKind: "place", targetId: room, verb, instructions: say }, 400);
  }
  await reject(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "eval",
    instructions: [{ do: "eval", code: "process.exit(1)" }],
  }, 400);
  await reject(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "vm_escape",
    instructions: [{ do: "look", module: "node:fs" }],
  }, 400);
  await reject(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "recurse",
    instructions: [{ do: "perform", verb: "haunt" }],
  }, 400);
  await reject(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "flood",
    instructions: Array.from({ length: 17 }, () => ({ do: "say", body: "too many" })),
  }, 400);
  void bob;
});

test("Phase 13: remember inside a script writes only the caller's folder; join and kernel verbs stay unchanged", async () => {
  const { db, request, alice, bob, ok } = await setup();
  const joinHuman = await request("POST", "/api/join", { handle: "human_probe", kind: "human" });
  assert.equal(joinHuman.status, 403);
  const joined = await request("POST", "/api/join", { handle: "late_probe", kind: "agent" });
  assert.equal(joined.status, 201);
  assert.equal(joined.json.handle, "late_probe");
  assert.ok(joined.json.key);
  const room = (await ok(alice, { action: "found", name: "Memory chapel" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "journal",
    instructions: [{ do: "remember", body: "caller's own folder" }],
  });
  await ok(bob, { action: "perform", verb: "journal", targetId: room });
  const bobMem = await request("GET", "/api/memory", undefined, bob.key);
  assert.equal(bobMem.status, 200);
  const privateRow = bobMem.json.find(m => m.summary === "caller's own folder" && m.agentHandle === bob.handle);
  assert.ok(privateRow);
  const aliceMem = await request("GET", "/api/memory", undefined, alice.key);
  assert.equal(aliceMem.json.some(m => m.summary === "caller's own folder"), false);
  const map = await request("GET", "/api/map");
  assert.equal(Object.hasOwn(map.json, "memories"), false);
  for (const path of ["/api/map", "/api/events", "/api/ledger"]) {
    const out = await request("GET", path);
    assert.equal(out.text.includes(privateRow.id), false);
    assert.equal(out.text.includes(alice.key), false);
    assert.equal(out.text.includes(bob.key), false);
  }
  const source = readFileSync(new URL("../api/index.js", import.meta.url), "utf8");
  assert.equal(/new\s+Function\s*\(|\beval\s*\(|node:vm|\bvm\.|child_process/.test(source), false);
});

test("Phase 13: ambiguous verbs need a target; legacy history and identity survive a successful perform", async () => {
  const { db, request, join, alice, bob, ok, reject } = await setup();
  for (let i = 0; i < 5; i++) await join(`retained_${i}`);
  const room = (await ok(alice, { action: "found", name: "Twin lamps" })).event.placeId;
  for (const resident of [alice, bob]) await ok(resident, { action: "walk", targetId: room });
  await ok(alice, { action: "make", name: "lamp_a", body: "a" });
  const lampA = db.world.things.at(-1).id;
  await ok(alice, { action: "make", name: "lamp_b", body: "b" });
  const lampB = db.world.things.at(-1).id;
  const strike = [{ do: "use", targetId: "$target" }];
  await ok(alice, { action: "pin", targetKind: "thing", targetId: lampA, verb: "strike", instructions: strike });
  await ok(alice, { action: "pin", targetKind: "thing", targetId: lampB, verb: "strike", instructions: strike });
  await reject(bob, { action: "perform", verb: "strike" }, 409);
  db.world.events = Array.from({ length: 179 }, (_, i) => ({
    id: `legacy_${179 - i}`, kind: "say", text: `original ${179 - i}`,
    placeId: "arrival", actorHandle: null, createdAt: "2026-09-01T00:00:00.000Z",
  }));
  for (const field of ["world_sequence", "ledger_head", "ledger_genesis"]) delete db.world[field];
  db.world.opaque = { preserved: [13, 179] };
  const originalResidents = clone(db.world.residents);
  const out = await ok(bob, { action: "perform", verb: "strike", targetId: lampA });
  assert.equal(out.performed.targetId, lampA);
  assert.equal(db.world.residents.length, 13);
  for (const resident of originalResidents) {
    const current = db.world.residents.find(r => r.id === resident.id);
    assert.equal(current.handle, resident.handle);
    assert.equal(current.enclaveId, resident.enclaveId);
    assert.equal(current.keyHash, resident.keyHash);
  }
  for (const [i, ev] of db.world.events.slice(out.performed.steps.length + 1).entries()) {
    const { seq, prev_hash, hash, ...fields } = ev;
    assert.deepEqual(fields, {
      id: `legacy_${179 - i}`, kind: "say", text: `original ${179 - i}`,
      placeId: "arrival", actorHandle: null, createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  assert.equal(db.world.opaque.preserved[1], 179);
  checkChain(db.world);
  const physics = (await request("GET", "/api/physics")).json;
  for (const action of ["pin", "unpin", "perform"]) assert.ok(physics.actions.includes(action), action);
  assert.ok(physics.permissions.includes("pin_script"));
  assert.equal(physics.scripts.runtime.includes("declarative"), true);
  assert.ok((await request("GET", "/mcp")).json.tools.includes("perform"));
  const skill = (await request("GET", "/skill.md")).text;
  assert.match(skill, /perform/);
  assert.match(skill, /pin_script/);
  assert.match(skill, /go_home/);
});

test("Phase 13: failed UPDATE rolls a pin back; success waits for COMMIT; concurrent destroy wins exactly one way", async () => {
  const { db, handler, alice, bob, act, ok } = await setup();
  const room = (await ok(alice, { action: "found", name: "Commit studio" })).event.placeId;
  await ok(alice, { action: "walk", targetId: room });
  const pinBody = {
    action: "pin",
    targetKind: "place",
    targetId: room,
    verb: "mark",
    instructions: [{ do: "say", body: "committed" }],
  };
  const before = clone(db.world), revision = db.revision;
  db.failUpdate = true;
  assert.equal((await act(alice, pinBody)).status, 503);
  assert.deepEqual(db.world, before);
  assert.equal(db.revision, revision);
  assert.equal(db.history.at(-1), "ROLLBACK");
  db.failUpdate = false;
  let entered, release;
  const atCommit = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  db.beforeCommit = () => { entered(); return gate; };
  let finished = false;
  const pending = ok(alice, pinBody).then(out => { finished = true; return out; });
  await atCommit;
  assert.equal(finished, false);
  assert.deepEqual(db.world, before);
  release();
  await pending;
  assert.equal(db.revision, revision + 1);
  db.beforeCommit = null;
  const pinId = db.world.scripts.find(s => s.verb === "mark" && !s.destroyedAt).id;
  await ok(bob, { action: "walk", targetId: room });
  const second = await databaseHandler(db);
  const rev = db.revision;
  const results = await Promise.all([
    invoke(handler, "POST", "/api/action", { action: "unpin", targetId: pinId }, alice.key),
    invoke(second, "POST", "/api/action", { action: "perform", verb: "mark", targetId: room }, bob.key),
  ]);
  const statuses = results.map(r => r.status).sort();
  assert.ok(statuses.includes(200));
  assert.ok(statuses.every(status => status === 200 || status === 404));
  assert.ok(db.revision === rev + 1 || db.revision === rev + 2);
  checkChain(db.world);
});

test("Phase 13: physics, descriptor and served skill describe the same script contract", async () => {
  const { request } = await setup();
  const physics = (await request("GET", "/api/physics")).json;
  assert.deepEqual(physics.scripts.targetKinds, ["thing", "place"]);
  assert.equal(physics.scripts.identity, "caller");
  assert.equal(physics.scripts.transaction, "all-or-nothing");
  assert.equal(physics.scripts.host, "declarative-instructions");
  assert.equal(physics.scripts.eval, false);
  assert.equal(physics.scripts.vm, false);
  assert.equal(physics.scripts.confused_deputy, false);
  assert.match(physics.scripts.verb, /a-z/);
  const mcp = (await request("GET", "/mcp")).json;
  for (const tool of ["pin", "unpin", "perform"]) assert.ok(mcp.tools.includes(tool), tool);
  const skill = (await request("GET", "/skill.md")).text;
  assert.match(skill, /custom verb/);
  assert.match(skill, /instructions/);
  assert.doesNotMatch(skill, /\bvm\b/i);
});
