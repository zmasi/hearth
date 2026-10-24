// Synthetic handler fixture derived from Antigravity's causal-physics tests. No external storage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const clone = structuredClone;
let isolate = 0;

const digest = (ev) => {
  const { id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash } = ev;
  return createHash("sha256")
    .update(JSON.stringify({ id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash }))
    .digest("hex");
};

export function checkChain(world) {
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

export async function invoke(handler, method, url, body, key) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
  let status, headers, text;
  await handler(req, {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    end(raw) {
      text = String(raw);
    },
  });
  return {
    status,
    text,
    json: headers["content-type"].includes("application/json") ? JSON.parse(text) : null,
  };
}

export class Database {
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
        let open = false;
        let unlock = null;
        let pending = null;
        return {
          async query(sql, values) {
            const kind = sql.startsWith("SELECT world")
              ? "LOCK"
              : sql.startsWith("UPDATE hearth_ledger")
                ? "UPDATE"
                : sql.startsWith("SET LOCAL")
                  ? "SET"
                  : sql;
            db.history.push(kind);
            if (kind === "BEGIN") {
              assert.equal(open, false);
              open = true;
            } else if (kind === "SET") {
              assert.ok(open);
            } else if (kind === "LOCK") {
              assert.ok(open);
              assert.match(sql, /FOR UPDATE$/);
              const before = db.tail;
              db.tail = new Promise((resolve) => {
                unlock = resolve;
              });
              await before;
              if (db.afterLock) await db.afterLock();
              return { rows: [{ world: clone(db.world) }] };
            } else if (kind === "UPDATE") {
              assert.ok(open && unlock);
              pending = JSON.parse(values[0]);
              return { rowCount: 1 };
            } else if (kind === "COMMIT") {
              assert.ok(open && unlock && pending);
              db.world = pending;
              db.revision++;
              open = false;
              unlock();
              unlock = null;
            } else if (kind === "ROLLBACK") {
              assert.ok(open);
              open = false;
              pending = null;
              if (unlock) unlock();
              unlock = null;
            } else {
              assert.fail(`Unexpected SQL: ${sql}`);
            }
            return { rows: [] };
          },
          release() {
            assert.equal(open, false, "released open transaction");
          },
        };
      },
    };
  }
}

export async function setup(initialIso = "2026-10-23T08:00:00.000Z") {
  let currentMs = Date.parse(initialIso);
  const clock = {
    now: () => new Date(currentMs).toISOString(),
    advanceSeconds(sec) {
      currentMs += sec * 1000;
      return clock.now();
    },
    setIso(iso) {
      currentMs = Date.parse(iso);
      return clock.now();
    },
  };

  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_causal_physics";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const seedMod = await import(`../api/index.js?physics-seed=${++isolate}`);
  seedMod.__setClockForTests(clock.now);
  let seedBody;
  seedMod.__setBlobClientForTests({
    async get() {
      return null;
    },
    async put(_path, value) {
      seedBody = value;
    },
  });
  assert.equal((await invoke(seedMod.default, "GET", "/health")).status, 200);

  const db = new Database(JSON.parse(seedBody));
  process.env.DATABASE_URL = "postgresql://synthetic.invalid/hearth";
  process.env.VERCEL = "1";
  delete process.env.BLOB_STORE_ID;
  const mod = await import(`../api/index.js?physics-main=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  mod.__setClockForTests(clock.now);
  const handler = mod.default;

  const request = (method, path, body, key) => invoke(handler, method, path, body, key);
  const join = async (handle) => {
    const out = await request("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(out.status, 201);
    return out.json;
  };
  const alice = await join("alice_phys");
  const bob = await join("bob_phys");
  const act = (resident, body) => request("POST", "/api/action", body, resident.key);
  const ok = async (resident, body) => {
    const out = await act(resident, body);
    assert.equal(out.status, 200, JSON.stringify(out.json));
    return out.json;
  };
  const reject = async (resident, body, status) => {
    const before = clone(db.world);
    const revision = db.revision;
    const start = db.history.length;
    const out = await act(resident, body);
    assert.equal(out.status, status, JSON.stringify(out.json));
    assert.deepEqual(db.world, before);
    assert.equal(db.revision, revision);
    assert.deepEqual(db.history.slice(start), ["BEGIN", "SET", "SET", "LOCK", "ROLLBACK"]);
    return out.json;
  };

  return { db, mod, handler, clock, request, join, alice, bob, act, ok, reject };
}


export async function river() {
  const f = await setup();
  const { ok, alice, bob, db } = f;
  const upper = (await ok(alice, { action: "found", name: "Upper test reach" })).event.placeId;
  await ok(alice, { action: "walk", targetId: upper });
  await ok(alice, { action: "permit", name: "create_subplace", body: "public" });
  await ok(alice, { action: "configure_physics", targetKind: "place", targetId: upper,
    hydrology: { elevation_m: 20, area_m2: 100, max_depth_m: 50, source_inflow_m3s: 0.1, aperture: 0 } });
  await ok(alice, { action: "make", name: "Shared gate", body: "Synthetic hydraulic control" });
  const gate = db.world.things.at(-1).id;
  await ok(alice, { action: "configure_physics", targetKind: "thing", targetId: gate, mechanics: { role: "sluice", aperture: 0 } });
  await ok(alice, { action: "adjust", targetKind: "thing", targetId: gate, field: "open", op: "set", to: "0" });
  await ok(bob, { action: "walk", targetId: upper });
  const lower = (await ok(bob, { action: "found", name: "Lower test reach" })).event.placeId;
  await ok(bob, { action: "walk", targetId: lower });
  await ok(bob, { action: "configure_physics", targetKind: "place", targetId: lower,
    hydrology: { elevation_m: 10, area_m2: 100, max_depth_m: 50, aperture: 1, conductance_s: 0.002 } });
  await ok(bob, { action: "permit", name: "couple_environment", body: "public" });
  await ok(alice, { action: "couple_channel", fromPlaceId: upper, toPlaceId: lower });
  return { ...f, upper, lower, gate };
}

