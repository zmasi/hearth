import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

// Phase 12 (Hearth form): a resident-scoped, cursor-based perception read.
// Observation never appends. Private memory never appears. Join is untouched.

const clone = structuredClone;
let isolate = 0;

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
  constructor(world) { this.world = clone(world); this.revision = 1; this.selects = 0; this.updates = 0; }
  pool() {
    const db = this;
    return {
      async query(sql) { assert.match(sql, /^SELECT world/); db.selects++; return { rows: [{ world: clone(db.world) }] }; },
      async connect() {
        let pending = null;
        return {
          async query(sql, values) {
            if (sql.startsWith("SELECT world")) return { rows: [{ world: clone(db.world) }] };
            if (sql.startsWith("UPDATE hearth_ledger")) { pending = JSON.parse(values[0]); db.updates++; return { rowCount: 1 }; }
            if (sql === "COMMIT") { db.world = pending; db.revision++; pending = null; }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
  }
}

async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase12";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const seedMod = await import(`../api/index.js?phase12-seed=${++isolate}`);
  let body;
  seedMod.__setBlobClientForTests({ async get() { return null; }, async put(_path, value) { body = value; } });
  assert.equal((await invoke(seedMod.default, "GET", "/health")).status, 200);
  const db = new Database(JSON.parse(body));
  process.env.DATABASE_URL = "postgresql://synthetic.invalid/hearth";
  process.env.VERCEL = "1";
  delete process.env.BLOB_STORE_ID;
  const mod = await import(`../api/index.js?phase12=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  const handler = mod.default;
  const request = (method, path, body, key) => invoke(handler, method, path, body, key);
  const join = async handle => {
    const out = await request("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(out.status, 201, out.text); return out.json;
  };
  const ok = async (resident, body) => {
    const out = await request("POST", "/api/action", body, resident.key);
    assert.equal(out.status, 200, out.text); return out.json;
  };
  return { db, request, join, ok };
}

test("Phase 12: perception after a cursor returns only newer events and @mentions, and never appends", async () => {
  const { db, request, join, ok } = await setup();
  const fable = await join("fable_probe"), king = await join("king_probe");
  const start = db.world.world_sequence;
  await ok(king, { action: "say", body: "@fable_probe you are in the room. I see you." });
  await ok(king, { action: "say", body: "A note about nothing in particular." });
  await ok(fable, { action: "say", body: "@fable_probe talking to myself does not count." });
  const before = clone(db.world), revision = db.revision, updates = db.updates;

  const out = await request("GET", `/api/perception?after=${start}`, undefined, fable.key);
  assert.equal(out.status, 200, out.text);
  const p = out.json;
  assert.equal(p.ok, true);
  assert.equal(p.schema_version, "hearth-perception-v1");
  assert.equal(p.handle, "fable_probe");
  assert.equal(p.after, start);
  assert.equal(p.world_sequence, start + 3);
  assert.deepEqual(p.events.map(e => e.seq), [start + 1, start + 2, start + 3], "chronological, strictly after the cursor");
  assert.equal(p.truncated, false);
  assert.equal(p.next_after, start + 3);
  assert.deepEqual(p.mentions.map(m => m.authorHandle), ["king_probe"], "own notes are not mentions of oneself");
  assert.match(p.mentions[0].body, /I see you/);
  assert.equal(p.mentions[0].seq, start + 1, "a new note carries the sequence of its own say event");
  assert.equal(Object.hasOwn(p, "mention_boundary"), false);
  assert.equal(p.here.place.id, "arrival");
  assert.equal(JSON.stringify(p).includes("keyHash"), false);
  assert.equal(Object.hasOwn(p, "memories"), false);

  assert.deepEqual(db.world, before, "observation does not append or rewrite");
  assert.equal(db.revision, revision);
  assert.equal(db.updates, updates);
});

test("Phase 12: the cursor defaults to zero, rejects values ahead of the ledger, and requires a resident key", async () => {
  const { db, request, join } = await setup();
  const fable = await join("fable_probe");
  const seq = db.world.world_sequence;
  const whole = await request("GET", "/api/perception", undefined, fable.key);
  assert.equal(whole.status, 200);
  assert.equal(whole.json.after, 0);
  assert.equal(whole.json.events.length, seq);
  assert.equal(whole.json.events[0].seq, 1);

  const ahead = await request("GET", `/api/perception?after=${seq + 1}`, undefined, fable.key);
  assert.equal(ahead.status, 400);
  assert.equal(ahead.json.error_class, "cursor_ahead");
  assert.equal(ahead.json.world_sequence, seq, "the resident can reset from the reported sequence");

  for (const bad of ["-1", "abc", "1.5"]) {
    const out = await request("GET", `/api/perception?after=${bad}`, undefined, fable.key);
    assert.equal(out.status, 400, bad);
    assert.equal(out.json.error_class, "bad_input");
  }
  assert.equal((await request("GET", "/api/perception?after=0")).status, 401);
  assert.equal((await request("GET", "/api/perception?after=0", undefined, "not_a_key")).status, 401);
});

test("Phase 12: long backlogs page with truncated and next_after", async () => {
  const { db, request, join, ok } = await setup();
  const fable = await join("fable_probe"), other = await join("other_probe");
  const start = db.world.world_sequence;
  for (let i = 0; i < 12; i++) await ok(other, { action: "no_op" }); // no_op never appends
  assert.equal(db.world.world_sequence, start);
  for (let i = 0; i < 6; i++) await ok(other, { action: "look" });
  const page = await request("GET", `/api/perception?after=${start}&limit=4`, undefined, fable.key);
  assert.equal(page.status, 200, page.text);
  assert.deepEqual(page.json.events.map(e => e.seq), [start + 1, start + 2, start + 3, start + 4]);
  assert.equal(page.json.truncated, true);
  assert.equal(page.json.next_after, start + 4);
  const rest = await request("GET", `/api/perception?after=${page.json.next_after}&limit=4`, undefined, fable.key);
  assert.deepEqual(rest.json.events.map(e => e.seq), [start + 5, start + 6]);
  assert.equal(rest.json.truncated, false);
  assert.equal(rest.json.next_after, start + 6);
  const tooBig = await request("GET", `/api/perception?after=0&limit=5000`, undefined, fable.key);
  assert.equal(tooBig.status, 400);
});

test("Phase 12: mentions page exactly with events: a 52-note backlog is recovered once, at any page size", async () => {
  const { db, request, join, ok } = await setup();
  const fable = await join("fable_probe"), other = await join("other_probe");
  const start = db.world.world_sequence;
  for (let i = 0; i < 52; i++) await ok(other, { action: "say", body: `@fable_probe backlog ${i}` });
  for (const limit of [200, 4, 7]) {
    const ids = [];
    let after = start, pages = 0;
    do {
      const out = await request("GET", `/api/perception?after=${after}&limit=${limit}`, undefined, fable.key);
      assert.equal(out.status, 200, out.text);
      for (const m of out.json.mentions) {
        assert.ok(m.seq > after && m.seq <= out.json.next_after, `mention ${m.seq} lies inside the page (${after}, ${out.json.next_after}]`);
        ids.push(m.id);
      }
      after = out.json.next_after; pages++;
      if (!out.json.truncated) break;
    } while (pages < 100);
    assert.equal(ids.length, 52, `limit ${limit}: no mention dropped`);
    assert.equal(new Set(ids).size, 52, `limit ${limit}: no mention duplicated`);
    assert.equal(after, start + 52);
  }
});

test("Phase 12: legacy notes without a sequence are offered once, on the page that starts from zero", async () => {
  const { db, request, join } = await setup();
  const fable = await join("fable_probe");
  db.world.notes.push({ id: "n_legacy", placeId: "arrival", authorHandle: "hermes", body: "@fable_probe from before notes were sequenced", createdAt: "2026-09-01T00:00:00.000Z" });
  const first = (await request("GET", "/api/perception?after=0&limit=1", undefined, fable.key)).json;
  assert.deepEqual(first.mentions.map(m => [m.id, m.legacy]), [["n_legacy", true]]);
  assert.equal(first.truncated, true);
  const later = (await request("GET", `/api/perception?after=${first.next_after}`, undefined, fable.key)).json;
  assert.deepEqual(later.mentions, [], "a legacy note never recurs once the cursor has moved");
});

test("Phase 12: mentions respect the caller's observe authority; a mention is not a permission", async () => {
  const { request, join, ok } = await setup();
  const fable = await join("fable_probe"), other = await join("other_probe");
  const mentionsFor = async () => (await request("GET", "/api/perception?after=0", undefined, fable.key)).json.mentions.map(m => m.body);
  await ok(other, { action: "go_home" });
  await ok(other, { action: "say", body: "@fable_probe said behind an owner-only door" });
  assert.deepEqual(await mentionsFor(), [], "enclave notes stay behind their owner-only observe door");
  await ok(other, { action: "walk", targetId: "arrival" });
  const founded = await ok(other, { action: "found", name: "Closed Study", body: "A room with a door." });
  const room = founded.snapshot.places.find(p => p.name === "Closed Study");
  await ok(other, { action: "walk", targetId: room.id });
  await ok(other, { action: "permit", name: "observe", body: "owner_only" });
  await ok(other, { action: "say", body: "@fable_probe said in a room fable cannot observe" });
  assert.deepEqual(await mentionsFor(), []);
  await ok(fable, { action: "walk", targetId: room.id });
  assert.deepEqual(await mentionsFor(), ["@fable_probe said in a room fable cannot observe"], "standing in the room is the same authority perceive() already grants");
  await ok(fable, { action: "walk", targetId: "arrival" });
  await ok(other, { action: "permit", name: "observe", body: "public" });
  assert.deepEqual(await mentionsFor(), ["@fable_probe said in a room fable cannot observe"], "opening the door opens the mention");
  const map = (await request("GET", "/api/map")).json;
  assert.ok(map.notes.some(n => /owner-only door/.test(n.body)), "baseline: the public map still lists every live note; that asymmetry is documented, not silently changed here");
});

test("Phase 12: mentions are word-bounded, case-insensitive, and exclude destroyed notes", async () => {
  const { request, join, ok } = await setup();
  const fable = await join("fable_probe"), other = await join("other_probe");
  await ok(other, { action: "say", body: "@FABLE_PROBE, shouting still counts." });
  await ok(other, { action: "say", body: "@fable_probe_two is someone else." });
  const doomed = await ok(other, { action: "say", body: "@fable_probe this one will be burned." });
  const doomedNote = doomed.perception.notes.find(n => /burned/.test(n.body));
  await ok(other, { action: "destroy", targetKind: "note", targetId: doomedNote.id });
  const p = (await request("GET", "/api/perception?after=0", undefined, fable.key)).json;
  assert.deepEqual(p.mentions.map(m => m.body), ["@FABLE_PROBE, shouting still counts."]);
});

test("Phase 12: discovery lists the perception door", async () => {
  const { request } = await setup();
  const wk = (await request("GET", "/.well-known/agent-world.json")).json;
  assert.match(wk.endpoints.perception, /\/api\/perception$/);
  const physics = (await request("GET", "/api/physics")).json;
  assert.equal(physics.perception.appends, false);
  assert.equal(physics.perception.private_memory, false);
  const skill = (await request("GET", "/skill.md")).text;
  assert.match(skill, /GET \/api\/perception\?after=/);
});
