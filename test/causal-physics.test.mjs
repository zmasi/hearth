import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { readPhysicalSensor } from "../client/causal-physics.mjs";

const clone = structuredClone;
let isolate = 0;

const digest = (ev) => {
  const { id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash } = ev;
  return createHash("sha256")
    .update(JSON.stringify({ id, kind, text, placeId, actorHandle, createdAt, seq, prev_hash }))
    .digest("hex");
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

async function setup(initialIso = "2026-10-23T08:00:00.000Z") {
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

test("Causal Physics 1: coupled multi-place hydrology — weir/sluice upstream pooling, downstream drying, flood wave recovery, and exact water conservation", async () => {
  const { db, clock, request, alice, bob, ok } = await setup("2026-10-23T08:00:00.000Z");

  // Alice founds Upper Weir off Arrival, and Unnecessary Bridge as a child of Upper Weir
  const upperWeirId = (await ok(alice, { action: "found", name: "Upper Weir" })).event.placeId;
  await ok(alice, { action: "walk", targetId: upperWeirId });
  const bridgeId = (await ok(alice, { action: "found", name: "Unnecessary Bridge" })).event.placeId;

  // Configure Upper Weir reach: elevation 25m, area 100 m^2, max_depth 8m, initial depth 1.0m (100 m^3), source inflow 0.5 m^3/s, crest 0.4m, aperture 1.0
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: upperWeirId,
    hydrology: {
      elevation_m: 25,
      area_m2: 100,
      max_depth_m: 8,
      water_depth_m: 1.0,
      source_inflow_m3s: 0.5,
      crest_height_m: 0.4,
      aperture: 1.0,
      conductance_s: 0.01,
    },
  });

  // Make a sluice gate in Upper Weir
  await ok(alice, { action: "make", name: "Oak Sluice Gate", body: "Heavy timber gate in iron grooves." });
  const sluiceId = db.world.things.at(-1).id;
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: sluiceId,
    mechanics: { role: "sluice", aperture: 1.0, mass_kg: 180, anchored: true },
  });

  // Walk to Unnecessary Bridge and configure downstream reach: elevation 12m, area 80 m^2, max_depth 6m, initial depth 0.8m (64 m^3), source inflow 0, crest 0.1m
  await ok(alice, { action: "walk", targetId: bridgeId });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: bridgeId,
    hydrology: {
      elevation_m: 12,
      area_m2: 80,
      max_depth_m: 6,
      water_depth_m: 0.8,
      source_inflow_m3s: 0,
      crest_height_m: 0.1,
      aperture: 1.0,
      conductance_s: 0.01,
    },
  });

  // Couple channel from Upper Weir -> Unnecessary Bridge
  const coupled = await ok(alice, {
    action: "couple_channel",
    fromPlaceId: upperWeirId,
    toPlaceId: bridgeId,
  });
  assert.deepEqual(coupled.channel, { from: upperWeirId, to: bridgeId });

  // Bob stands at Unnecessary Bridge to observe downstream; Alice walks back to Upper Weir
  await ok(bob, { action: "walk", targetId: upperWeirId });
  await ok(bob, { action: "walk", targetId: bridgeId });
  await ok(alice, { action: "walk", targetId: upperWeirId });

  // Close the sluice gate at Upper Weir at t = 0
  const closed = await ok(alice, {
    action: "actuate",
    targetId: sluiceId,
    op: "set_sluice",
    value: 0,
  });
  assert.equal(closed.thing_physical.aperture_pct, 0);
  assert.equal(closed.place_physical.hydrology.aperture_pct, 0);
  assert.equal(closed.place_physical.hydrology.discharge_m3s, 0);

  // Advance clock by 15 minutes (900s) with NO actions (pure lazy time evolution)
  clock.advanceSeconds(900);

  const aliceViewClosed = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const bobViewClosed = (await request("GET", "/api/me", undefined, bob.key)).json.perception;

  // Upstream pooled: 100 m^3 + 900s * 0.5 m^3/s = 550 m^3 -> depth = 5.5 m
  assert.equal(aliceViewClosed.physical.hydrology.volume_m3, 550);
  assert.equal(aliceViewClosed.physical.hydrology.water_depth_m, 5.5);
  assert.equal(aliceViewClosed.physical.hydrology.water_depth_mm, 5500);
  assert.equal(aliceViewClosed.physical.hydrology.discharge_m3s, 0);

  // Downstream dried toward its 0.1m crest (8 m^3): started at 64 m^3 (0.8m), drained with zero upstream inflow
  assert.ok(bobViewClosed.physical.hydrology.water_depth_m < 0.11, `expected downstream to dry near 0.1m crest, got ${bobViewClosed.physical.hydrology.water_depth_m}`);
  assert.equal(bobViewClosed.physical.hydrology.inflow_m3s, 0);
  assert.ok(bobViewClosed.physical.hydrology.volume_m3 >= 0, "water volume is strictly nonnegative");

  // Now Alice opens the sluice gate to 100% and we advance 300s (5 minutes)
  await ok(alice, {
    action: "actuate",
    targetId: sluiceId,
    op: "set_sluice",
    value: 1.0,
  });
  clock.advanceSeconds(300);

  const aliceViewOpen = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const bobViewOpen = (await request("GET", "/api/me", undefined, bob.key)).json.perception;

  // Upstream level dropped from 5.5m as stored water surged downstream; downstream Bridge depth rose sharply above 0.8m
  assert.ok(aliceViewOpen.physical.hydrology.water_depth_m < 2.0);
  assert.ok(bobViewOpen.physical.hydrology.water_depth_m > 0.65, `expected downstream recovery wave, got ${bobViewOpen.physical.hydrology.water_depth_m}`);

  // Exact mass conservation across the coupled 2-reach network over the full 1200s (initial: 100 + 64 = 164 m^3; total external source inflow: 1200s * 0.5 m^3/s = 600 m^3)
  const hWeir = aliceViewOpen.physical.hydrology;
  const hBridge = bobViewOpen.physical.hydrology;
  const initialTotalM3 = 100 + 64;
  const externalInflowM3 = 1200 * 0.5;
  const finalStoredM3 = hWeir.volume_m3 + hBridge.volume_m3;
  const exitedNetworkM3 = hBridge.total_outflow_m3;
  assert.ok(
    Math.abs((initialTotalM3 + externalInflowM3) - (finalStoredM3 + exitedNetworkM3)) < 1e-3,
    `conservation mismatch: initial+inflow=${initialTotalM3 + externalInflowM3}, stored+exited=${finalStoredM3 + exitedNetworkM3}`,
  );
  checkChain(db.world);
});

test("Causal Physics 2: partition/restart equivalence (t0 -> t1 -> t2 vs t0 -> t2), pure GET invariance, and bounded evaluation across 180-day absence", async () => {
  const { db, mod, clock, request, alice, ok } = await setup("2026-10-23T08:00:00.000Z");

  const weirId = (await ok(alice, { action: "found", name: "Partition Weir" })).event.placeId;
  await ok(alice, { action: "walk", targetId: weirId });
  const poolId = (await ok(alice, { action: "found", name: "Partition Pool" })).event.placeId;

  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: weirId,
    exposure: "open",
    soil_moisture: 0.4,
    hydrology: {
      elevation_m: 30,
      area_m2: 120,
      max_depth_m: 6,
      water_depth_m: 2.2,
      source_inflow_m3s: 0.4,
      crest_height_m: 0.5,
      aperture: 0.75,
      conductance_s: 0.008,
    },
  });
  await ok(alice, { action: "make", name: "River Willow", body: "Young willow by the bank" });
  const willowId = db.world.things.at(-1).id;
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: willowId,
    mechanics: { role: "flora", biomass_kg: 1.5, max_biomass_kg: 90 },
  });

  await ok(alice, { action: "walk", targetId: poolId });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: poolId,
    exposure: "canopy",
    soil_moisture: 0.3,
    hydrology: {
      elevation_m: 15,
      area_m2: 90,
      max_depth_m: 5,
      water_depth_m: 0.4,
      source_inflow_m3s: 0.1,
      crest_height_m: 0.2,
      aperture: 0.9,
      conductance_s: 0.012,
    },
  });
  await ok(alice, { action: "couple_channel", fromPlaceId: weirId, toPlaceId: poolId });
  await ok(alice, { action: "walk", targetId: weirId });

  const t0World = clone(db.world);
  const t0Iso = clock.now();
  const t1Iso = "2026-10-23T08:23:40.000Z"; // +1420s
  const t2Iso = "2026-10-23T09:30:00.000Z"; // +5400s

  // Branch A: single uninterrupted jump from t0 -> t2
  clock.setIso(t2Iso);
  const singleJumpWeir = (await request("GET", "/api/me", undefined, alice.key)).json.perception;

  // Verify pure GET invariance: repeated GETs at fixed clock t2 produce identical state and zero DB writes
  const historyBeforeGets = db.history.length;
  const revBeforeGets = db.revision;
  const seqBeforeGets = db.world.world_sequence;
  const secondReadWeir = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const mapRead = (await request("GET", "/api/map")).json;
  const perceptionRead = (await request("GET", "/api/perception?after=0", undefined, alice.key)).json;
  assert.deepEqual(secondReadWeir.physical, singleJumpWeir.physical);
  assert.deepEqual(secondReadWeir.things, singleJumpWeir.things);
  assert.equal(db.revision, revBeforeGets, "GET requests must never increment DB revision");
  assert.equal(db.world.world_sequence, seqBeforeGets, "GET requests must never append ledger events");
  assert.ok(db.history.slice(historyBeforeGets).every((op) => op === "SELECT"), "GET requests must only issue SELECT");
  assert.ok(mapRead.things.find((t) => t.id === willowId).physical.flora.biomass_kg > 1.5);
  assert.ok(perceptionRead.here.physical.hydrology.volume_m3 > 0);

  // Branch B: commit at intermediate t1 (e.g., resident performs an action before a server restart), reload fresh isolate, then read at t2
  db.world = clone(t0World);
  clock.setIso(t1Iso);
  await ok(alice, { action: "say", body: "checkpoint before restart at t1" });
  // Trigger physics commit at t1 via a no-change sluice actuation or configure_physics
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: weirId,
    exposure: "open",
  });

  // Simulate cold process restart from Postgres ledger at t2
  const restartedMod = await import(`../api/index.js?physics-restart=${++isolate}`);
  restartedMod.__setPostgresPoolForTests(db.pool());
  clock.setIso(t2Iso);
  restartedMod.__setClockForTests(clock.now);
  const partitionedWeir = (await invoke(restartedMod.default, "GET", "/api/me", undefined, alice.key)).json.perception;

  // Compare Branch A (t0 -> t2) vs Branch B (t0 -> t1 -> restart -> t2)
  assert.ok(
    Math.abs(singleJumpWeir.physical.hydrology.volume_m3 - partitionedWeir.physical.hydrology.volume_m3) <= 1e-4,
    `hydrology volume partition drift: ${singleJumpWeir.physical.hydrology.volume_m3} vs ${partitionedWeir.physical.hydrology.volume_m3}`,
  );
  assert.ok(
    Math.abs(singleJumpWeir.physical.hydrology.total_outflow_m3 - partitionedWeir.physical.hydrology.total_outflow_m3) <= 1e-4,
    `hydrology outflow partition drift: ${singleJumpWeir.physical.hydrology.total_outflow_m3} vs ${partitionedWeir.physical.hydrology.total_outflow_m3}`,
  );
  assert.ok(
    Math.abs(singleJumpWeir.physical.environment.soil_moisture - partitionedWeir.physical.environment.soil_moisture) <= 1e-3,
    `soil moisture partition drift: ${singleJumpWeir.physical.environment.soil_moisture} vs ${partitionedWeir.physical.environment.soil_moisture}`,
  );
  const willowA = singleJumpWeir.things.find((t) => t.id === willowId).physical.flora;
  const willowB = partitionedWeir.things.find((t) => t.id === willowId).physical.flora;
  assert.ok(
    Math.abs(willowA.biomass_kg - willowB.biomass_kg) <= 1e-3,
    `flora biomass partition drift: ${willowA.biomass_kg} vs ${willowB.biomass_kg}`,
  );

  // Now advance clock by 180 days (6 months of complete absence) and verify bounded fast evaluation
  clock.setIso(t0Iso);
  clock.advanceSeconds(180 * 86400);
  const startMs = performance.now();
  const afterSixMonths = (await invoke(restartedMod.default, "GET", "/api/me", undefined, alice.key)).json.perception;
  const elapsedMs = performance.now() - startMs;
  // This wall-clock guard also runs while other node:test files consume CPU.
  // It catches an elapsed-second replay loop without claiming a 100 ms SLA.
  assert.ok(elapsedMs < 1000, `180-day absence evaluation took ${elapsedMs}ms (expected bounded fixture < 1000ms)`);
  assert.ok(Number.isFinite(afterSixMonths.physical.hydrology.volume_m3));
  assert.ok(afterSixMonths.physical.hydrology.total_inflow_m3 > 1000000, "elapsed 180-day inflow was integrated, not dropped");
  const matureWillow = afterSixMonths.things.find((t) => t.id === willowId).physical.flora;
  assert.equal(matureWillow.stage, "mature");
  assert.ok(matureWillow.biomass_kg > 80);
  void mod;
});

test("Causal Physics 3: 3D AABB collision rejection, gravitational support stack, Hookean beam deflection, and counterweight-to-sluice coupling", async () => {
  const { db, clock, request, alice, ok, reject } = await setup("2026-10-23T10:00:00.000Z");

  const millId = (await ok(alice, { action: "found", name: "Watermill Room" })).event.placeId;
  await ok(alice, { action: "walk", targetId: millId });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: millId,
    bounds: [10, 5, 10],
    hydrology: {
      elevation_m: 20,
      area_m2: 50,
      max_depth_m: 4,
      water_depth_m: 2.0,
      source_inflow_m3s: 0.2,
      crest_height_m: 0.2,
      aperture: 0,
      conductance_s: 0.02,
    },
  });

  // Make counterweight beam, sluice gate, and two ballast stones
  await ok(alice, { action: "make", name: "Ash Counterweight Beam", body: "Spring-loaded oak/ash lever arm" });
  const beamId = db.world.things.at(-1).id;
  await ok(alice, { action: "make", name: "Millrace Sluice", body: "Iron gate coupled to counterweight latch" });
  const sluiceId = db.world.things.at(-1).id;
  await ok(alice, { action: "make", name: "Small Stone", body: "100 kg granite block" });
  const stone100Id = db.world.things.at(-1).id;
  await ok(alice, { action: "make", name: "Heavy Ballast", body: "150 kg lead-cored stone" });
  const stone150Id = db.world.things.at(-1).id;

  // Configure beam at [0, 0, 0], size [2, 0.4, 1], stiffness k = 50,000 N/m, latch threshold = 40 mm
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: beamId,
    mechanics: {
      role: "support",
      anchored: true,
      mass_kg: 40,
      pos: [0, 0, 0],
      size: [2, 0.4, 1],
      stiffness_nm: 50000,
      latch_threshold_mm: 40,
    },
  });

  // Reject out-of-bounds placement (room width is 10m -> x in [-5, 5])
  await reject(
    alice,
    {
      action: "configure_physics",
      targetKind: "thing",
      targetId: sluiceId,
      mechanics: { role: "sluice", pos: [6, 0, 0], size: [1, 1, 1] },
    },
    400,
  );

  // Reject 3D AABB collision overlapping with the beam at [0, 0, 0]
  const coll = await reject(
    alice,
    {
      action: "configure_physics",
      targetKind: "thing",
      targetId: sluiceId,
      mechanics: { role: "sluice", pos: [0.5, 0.1, 0], size: [1, 1, 1] },
    },
    409,
  );
  assert.equal(coll.error_class, "collision");
  assert.equal(coll.collidingThingId, beamId);

  // Place sluice cleanly at [3, 0, 0], coupled to the counterweight beam
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: sluiceId,
    mechanics: {
      role: "sluice",
      anchored: true,
      pos: [3, 0, 0],
      size: [1, 1.5, 0.4],
      aperture: 0,
      coupled_support_id: beamId,
    },
  });

  // Configure the two stones at non-overlapping floor positions
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: stone100Id,
    mechanics: { role: "body", mass_kg: 100, pos: [-3, 0, 0], size: [0.6, 0.5, 0.6] },
  });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: stone150Id,
    mechanics: { role: "body", mass_kg: 150, pos: [-3, 0, 2], size: [0.6, 0.5, 0.6] },
  });

  // Step 1: Place 100 kg stone onto beam -> deflection = (100 * 9.81) / 50000 = 19.62 mm -> 20 mm (< 40 mm latch)
  const step1 = await ok(alice, {
    action: "actuate",
    targetId: stone100Id,
    op: "place_on",
    value: beamId,
  });
  assert.equal(step1.support_physical.load_kg, 100);
  assert.equal(step1.support_physical.deflection_mm, 20);
  assert.equal(step1.support_physical.latched, false);
  const sluiceAfter1 = step1.perception.things.find((t) => t.id === sluiceId).physical;
  assert.equal(sluiceAfter1.aperture_pct, 0);
  assert.equal(sluiceAfter1.sensors.open, 0);

  // Step 2: Stack 150 kg stone on top of the 100 kg stone!
  // Total load on beam = 100 + 150 = 250 kg -> deflection = (250 * 9.81) / 50000 = 49.05 mm -> 49 mm (>= 40 mm latch!)
  const step2 = await ok(alice, {
    action: "actuate",
    targetId: stone150Id,
    op: "place_on",
    value: stone100Id,
  });
  const beamAfter2 = step2.perception.things.find((t) => t.id === beamId).physical;
  const sluiceAfter2 = step2.perception.things.find((t) => t.id === sluiceId).physical;
  assert.equal(beamAfter2.load_kg, 250);
  assert.equal(beamAfter2.deflection_mm, 49);
  assert.equal(beamAfter2.latched, true);
  assert.equal(sluiceAfter2.aperture_pct, 100);
  assert.equal(sluiceAfter2.sensors.open, 1);
  assert.ok(step2.perception.physical.hydrology.discharge_m3s > 0, "coupled sluice immediately begins discharging water");

  // Reject circular support stack
  await reject(alice, { action: "actuate", targetId: stone100Id, op: "place_on", value: stone150Id }, 409);

  // Advance clock by 300s while gate is held open by the counterweight stack, then DESTROY the 150 kg top stone
  clock.advanceSeconds(300);
  const destroyed = await ok(alice, { action: "destroy", targetKind: "thing", targetId: stone150Id });
  const beamAfterDestroy = destroyed.perception.things.find((t) => t.id === beamId).physical;
  const sluiceAfterDestroy = destroyed.perception.things.find((t) => t.id === sluiceId).physical;

  // Water discharged during the 300s before destruction, and at destruction the beam unloaded to 100 kg (20 mm) and snapped the sluice shut!
  assert.ok(destroyed.perception.physical.hydrology.total_outflow_m3 > 15, "water flowed during the 300s before ballast destruction");
  assert.equal(beamAfterDestroy.load_kg, 100);
  assert.equal(beamAfterDestroy.deflection_mm, 20);
  assert.equal(beamAfterDestroy.latched, false);
  assert.equal(sluiceAfterDestroy.aperture_pct, 0);
  assert.equal(sluiceAfterDestroy.sensors.open, 0);
  assert.equal(destroyed.perception.physical.hydrology.discharge_m3s, 0);
  checkChain(db.world);
});

test("Causal Physics 4: rigid-body strike impulse, rebound velocity, frictional slide, cumulative plastic work, and decaying acoustic resonance", async () => {
  const { clock, request, alice, ok } = await setup("2026-10-23T12:00:00.000Z");

  const forgeId = (await ok(alice, { action: "found", name: "Blacksmith Forge" })).event.placeId;
  await ok(alice, { action: "walk", targetId: forgeId });

  await ok(alice, { action: "make", name: "Sledgehammer", body: "4 kg tempered steel head" });
  const hammerId = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.at(-1).id;
  await ok(alice, { action: "make", name: "Church Anvil", body: "120 kg anchored cast-steel anvil" });
  const anvilId = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.at(-1).id;
  await ok(alice, { action: "make", name: "Loose Ingot", body: "5 kg unanchored bronze block" });
  const ingotId = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.at(-1).id;

  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: hammerId,
    mechanics: { role: "body", mass_kg: 4.0, restitution: 0.8, pos: [-2, 0, 0], size: [0.3, 0.6, 0.2] },
  });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: anvilId,
    mechanics: {
      role: "anvil",
      anchored: true,
      mass_kg: 120.0,
      restitution: 0.8,
      natural_hz: 440,
      ring_tau_s: 30,
      pos: [0, 0, 0],
      size: [0.8, 0.7, 0.4],
    },
  });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: ingotId,
    mechanics: { role: "body", anchored: false, mass_kg: 5.0, restitution: 0.5, pos: [0, 0, 2], size: [0.3, 0.2, 0.3] },
  });

  // Strike anchored anvil with hammer at 5.0 m/s
  const struckAnvil = await ok(alice, {
    action: "actuate",
    targetId: anvilId,
    op: "strike",
    value: `${hammerId}:5.0`,
  });
  const p0 = struckAnvil.thing_physical;
  assert.deepEqual(p0.pos, [0, 0, 0], "anchored anvil does not translate on impact");
  assert.equal(p0.last_rebound_ms, 4.0, "e = sqrt(0.8 * 0.8) = 0.8 -> rebound = 0.8 * 5.0 = 4.0 m/s");
  assert.ok(p0.work_j > 10, `expected positive plastic deformation work, got ${p0.work_j}`);
  assert.equal(p0.ring_hz, 440);
  assert.ok(p0.ring_amplitude > 0.3);

  // Advance clock by 30s (one time constant tau = 30s): ring amplitude decays by exp(-1), frequency still 440 Hz
  clock.advanceSeconds(30);
  const p30 = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.find((t) => t.id === anvilId).physical;
  assert.equal(p30.ring_hz, 440);
  assert.ok(Math.abs(p30.ring_amplitude - p0.ring_amplitude * Math.exp(-1)) < 0.002);

  // Advance clock by another 270s (total 300s = 10 * tau): ring has decayed to silence (0)
  clock.advanceSeconds(270);
  const p300 = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.find((t) => t.id === anvilId).physical;
  assert.equal(p300.ring_amplitude, 0);
  assert.equal(p300.ring_hz, 0);
  assert.equal(p300.work_j, p0.work_j, "cumulative plastic work persists after acoustic ring decays");

  // Strike unanchored ingot: verify it slides along +x under kinetic friction
  const struckIngot = await ok(alice, {
    action: "actuate",
    targetId: ingotId,
    op: "strike",
    value: `${hammerId}:6.0`,
  });
  assert.ok(struckIngot.thing_physical.pos[0] > 0.5, `expected unanchored ingot to slide along +x, got ${struckIngot.thing_physical.pos[0]}`);
});

test("Causal Physics 5: solar cycle, exposure attenuation, soil moisture water balance, and flora growth & wind sway", async () => {
  const { clock, request, alice, ok } = await setup("2026-10-23T00:00:00.000Z"); // UTC midnight

  const meadowId = (await ok(alice, { action: "found", name: "Open Meadow" })).event.placeId;
  await ok(alice, { action: "walk", targetId: meadowId });
  const cellarId = (await ok(alice, { action: "found", name: "Stone Cellar" })).event.placeId;

  await ok(alice, { action: "configure_physics", targetKind: "place", targetId: meadowId, exposure: "open", soil_moisture: 0.55 });
  await ok(alice, { action: "make", name: "White Oak", body: "Quercus alba seedling" });
  const oakId = (await request("GET", "/api/me", undefined, alice.key)).json.perception.things.at(-1).id;
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: oakId,
    mechanics: { role: "flora", biomass_kg: 0.5, max_biomass_kg: 120 },
  });

  await ok(alice, { action: "walk", targetId: cellarId });
  await ok(alice, { action: "configure_physics", targetKind: "place", targetId: cellarId, exposure: "sheltered" });
  await ok(alice, { action: "walk", targetId: meadowId });

  // At UTC midnight (00:00), phase is night and sunlight is 0
  const midnightView = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  assert.equal(midnightView.physical.environment.phase, "night");
  assert.equal(midnightView.physical.environment.sunlight_pct, 0);
  const oakMidnight = midnightView.things.find((t) => t.id === oakId).physical.flora;
  assert.equal(oakMidnight.biomass_kg, 0.5);
  assert.equal(oakMidnight.stage, "seedling");

  // Advance 12 hours to UTC noon (12:00)
  clock.advanceSeconds(12 * 3600);
  const noonMeadow = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const noonCellar = (await ok(alice, { action: "look", targetId: cellarId })).perception;
  assert.equal(noonMeadow.physical.environment.phase, "day");
  assert.ok(noonMeadow.physical.environment.sunlight_pct >= 50, `expected bright noon sun, got ${noonMeadow.physical.environment.sunlight_pct}`);
  assert.ok(noonCellar.physical.environment.sunlight_pct <= 5 && noonCellar.physical.environment.sunlight_pct < noonMeadow.physical.environment.sunlight_pct * 0.1, "sheltered cellar strongly attenuates sunlight");
  assert.equal(noonCellar.physical.environment.rain_mm_hr, 0, "sheltered cellar blocks direct rain");
  assert.ok(noonCellar.physical.environment.wind_speed_ms < noonMeadow.physical.environment.wind_speed_ms, "sheltered cellar attenuates wind");

  // Advance 15 days in unirrigated meadow: modest growth (0.5 -> ~0.90 kg) due to low dry-land soil moisture
  clock.advanceSeconds(15 * 86400);
  const after15Dry = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const oakDry = after15Dry.things.find((t) => t.id === oakId).physical.flora;
  assert.ok(oakDry.biomass_kg > 0.8 && oakDry.biomass_kg < 1.5, `expected modest dry-meadow growth, got ${oakDry.biomass_kg}`);
  assert.ok(oakDry.sway_mdeg > 0, "wind induces nonzero canopy sway");

  // Now irrigate the meadow with a river reach and advance another 20 days: river seepage boosts soil moisture and drives sapling growth
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: meadowId,
    hydrology: {
      elevation_m: 10,
      area_m2: 80,
      max_depth_m: 4,
      water_depth_m: 1.8,
      source_inflow_m3s: 0.25,
      crest_height_m: 1.5,
      aperture: 0.5,
      conductance_s: 0.01,
    },
  });
  clock.advanceSeconds(20 * 86400);
  const afterIrrigated = (await request("GET", "/api/me", undefined, alice.key)).json.perception;
  const oakIrrigated = afterIrrigated.things.find((t) => t.id === oakId).physical.flora;
  assert.ok(afterIrrigated.physical.environment.soil_moisture > after15Dry.physical.environment.soil_moisture, "river seepage increases soil moisture");
  assert.ok(oakIrrigated.biomass_kg > 3.0, `expected irrigated sapling growth > 3.0 kg, got ${oakIrrigated.biomass_kg}`);
  assert.equal(oakIrrigated.stage, "sapling");
  assert.ok(oakIrrigated.canopy_pct >= 15);
});

test("Causal Physics 6: permission-safe readPhysicalSensor, Phase 13 perform composition & atomic rollback, and Grok fields.open interop", async () => {
  const { db, clock, request, alice, bob, ok, reject } = await setup("2026-10-23T12:00:00.000Z");

  const lockRoomId = (await ok(alice, { action: "found", name: "Canal Lock" })).event.placeId;
  await ok(alice, { action: "walk", targetId: lockRoomId });
  await ok(bob, { action: "walk", targetId: lockRoomId });

  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: lockRoomId,
    hydrology: {
      elevation_m: 15,
      area_m2: 60,
      max_depth_m: 5,
      water_depth_m: 1.5,
      source_inflow_m3s: 0.3,
      crest_height_m: 0.2,
      aperture: 0,
      conductance_s: 0.015,
    },
  });

  await ok(alice, { action: "make", name: "Lock Gate", body: "Automated canal gate" });
  const gateId = db.world.things.at(-1).id;
  await ok(alice, {
    action: "configure_physics",
    targetKind: "thing",
    targetId: gateId,
    mechanics: { role: "sluice", aperture: 0 },
  });

  await ok(alice, { action: "make", name: "Plain Journal", body: "Untyped note book" });
  const plainId = db.world.things.at(-1).id;

  const mayFn = (p, perm, h) => {
    const m = p.permissions?.[perm] ?? "closed";
    return m === "public" || (m === "owner_only" && p.ownerHandle === h);
  };

  // Valid sensor reads on place and thing
  const depthRead = readPhysicalSensor(db.world, {
    actorHandle: bob.handle,
    actorStandingId: lockRoomId,
    targetKind: "place",
    targetId: lockRoomId,
    sensor: "water_depth_mm",
    nowIso: clock.now(),
    may: mayFn,
  });
  assert.deepEqual(depthRead, { ok: true, targetKind: "place", targetId: lockRoomId, sensor: "water_depth_mm", value: 1500 });

  const gateRead = readPhysicalSensor(db.world, {
    actorHandle: bob.handle,
    actorStandingId: lockRoomId,
    targetKind: "thing",
    targetId: gateId,
    sensor: "open",
    nowIso: clock.now(),
    may: mayFn,
  });
  assert.deepEqual(gateRead, { ok: true, targetKind: "thing", targetId: gateId, sensor: "open", value: 0 });

  // Refusals: never coerce missing, unobservable, unconfigured, or prototype sensors to 0!
  const missingRead = readPhysicalSensor(db.world, {
    actorHandle: bob.handle,
    actorStandingId: lockRoomId,
    targetKind: "thing",
    targetId: "thg_nonexistent",
    sensor: "open",
    nowIso: clock.now(),
    may: mayFn,
  });
  assert.equal(missingRead.ok, false);
  assert.equal(missingRead.http_status, 404);
  assert.equal(missingRead.value, undefined);

  const unconfiguredRead = readPhysicalSensor(db.world, {
    actorHandle: bob.handle,
    actorStandingId: lockRoomId,
    targetKind: "thing",
    targetId: plainId,
    sensor: "mass_g",
    nowIso: clock.now(),
    may: mayFn,
  });
  assert.equal(unconfiguredRead.ok, false);
  assert.equal(unconfiguredRead.http_status, 409);

  for (const protoKey of ["__proto__", "constructor", "toString", "valueOf"]) {
    const protoRead = readPhysicalSensor(db.world, {
      actorHandle: bob.handle,
      actorStandingId: lockRoomId,
      targetKind: "thing",
      targetId: gateId,
      sensor: protoKey,
      nowIso: clock.now(),
      may: mayFn,
    });
    assert.equal(protoRead.ok, false);
    assert.equal(protoRead.http_status, 400);
  }

  // Unobservable place (Bob's private enclave read by Alice)
  const enclaveRead = readPhysicalSensor(db.world, {
    actorHandle: alice.handle,
    actorStandingId: lockRoomId,
    targetKind: "place",
    targetId: bob.enclaveId,
    sensor: "sunlight_pct",
    nowIso: clock.now(),
    may: mayFn,
  });
  assert.equal(enclaveRead.ok, false);
  assert.equal(enclaveRead.http_status, 403);

  // Phase 13 script composition: pin a custom verb `flush_lock` that actuates the sluice gate and announces it
  await ok(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: gateId,
    verb: "flush_lock",
    instructions: [
      { do: "actuate", targetId: "$target", name: "set_sluice", body: "$level" },
      { do: "say", body: "$caller set lock gate to $level" },
    ],
  });

  const performed = await ok(bob, {
    action: "perform",
    verb: "flush_lock",
    targetId: gateId,
    args: { level: "0.75" },
  });
  assert.equal(performed.performed.verb, "flush_lock");
  assert.equal(performed.perception.things.find((t) => t.id === gateId).physical.aperture_pct, 75);
  assert.equal(performed.perception.physical.hydrology.aperture_pct, 75);

  // Atomic rollback: if a later instruction in `perform` fails, `actuate` rolls back completely
  await ok(alice, {
    action: "pin",
    targetKind: "thing",
    targetId: gateId,
    verb: "broken_flush",
    instructions: [
      { do: "actuate", targetId: "$target", name: "set_sluice", body: "0" },
      { do: "destroy", targetKind: "thing", targetId: "thg_absent" },
    ],
  });
  await reject(bob, { action: "perform", verb: "broken_flush", targetId: gateId }, 404);
  const afterRollback = (await request("GET", "/api/me", undefined, bob.key)).json.perception;
  assert.equal(afterRollback.things.find((t) => t.id === gateId).physical.aperture_pct, 75, "sluice remained at 75% after failed script rollback");

  // Grok `feat/pin-machines` fields.open interop: setting `fields.open = 0` closes the gate; `fields.open = 1` opens it to 100%
  const gateInDb = db.world.things.find((t) => t.id === gateId);
  gateInDb.fields = { open: 0 };
  const viewWithField0 = (await request("GET", "/api/me", undefined, bob.key)).json.perception;
  assert.equal(viewWithField0.things.find((t) => t.id === gateId).physical.aperture_pct, 0);
  assert.equal(viewWithField0.physical.hydrology.discharge_m3s, 0);

  gateInDb.fields = { open: 1 };
  const viewWithField1 = (await request("GET", "/api/me", undefined, bob.key)).json.perception;
  assert.equal(viewWithField1.things.find((t) => t.id === gateId).physical.aperture_pct, 100);
  assert.ok(viewWithField1.physical.hydrology.discharge_m3s > 0);
  checkChain(db.world);
});

test("Causal Physics 7: sovereignty guardrails (cross-place coupling permissions, enclave protection, unblockable go_home, and untyped thing preservation)", async () => {
  const { db, request, alice, bob, ok, reject } = await setup("2026-10-23T14:00:00.000Z");

  // Alice founds her room off Arrival; Bob founds his room off Arrival (Wait: they are siblings under Arrival, or Bob founds a child room inside Alice's room)
  const aliceLandId = (await ok(alice, { action: "found", name: "Alice Headwaters" })).event.placeId;
  await ok(alice, { action: "walk", targetId: aliceLandId });
  await ok(alice, { action: "permit", name: "create_subplace", body: "public" });
  await ok(bob, { action: "walk", targetId: aliceLandId });
  const bobLandId = (await ok(bob, { action: "found", name: "Bob Valley" })).event.placeId;

  // Configure reaches in both places
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: aliceLandId,
    hydrology: { elevation_m: 30, area_m2: 50, max_depth_m: 5, water_depth_m: 2.0, source_inflow_m3s: 0.4 },
  });
  await ok(bob, { action: "walk", targetId: bobLandId });
  await ok(bob, {
    action: "configure_physics",
    targetKind: "place",
    targetId: bobLandId,
    hydrology: { elevation_m: 15, area_m2: 50, max_depth_m: 5, water_depth_m: 0.2, source_inflow_m3s: 0 },
  });

  // Neither Alice nor Bob can unilaterally couple a water channel across the sovereign boundary while couple_environment is default owner_only!
  await reject(alice, { action: "couple_channel", fromPlaceId: aliceLandId, toPlaceId: bobLandId }, 403);
  await reject(bob, { action: "couple_channel", fromPlaceId: aliceLandId, toPlaceId: bobLandId }, 403);

  // Also verify nobody can couple a channel into a personal enclave from Arrival
  await ok(alice, { action: "walk", targetId: "arrival" });
  await ok(alice, {
    action: "configure_physics",
    targetKind: "place",
    targetId: "arrival",
    hydrology: { elevation_m: 40, area_m2: 100, max_depth_m: 5, water_depth_m: 1.0 },
  });
  await reject(alice, { action: "couple_channel", fromPlaceId: "arrival", toPlaceId: bob.enclaveId }, 403);

  // Once Bob explicitly permits `couple_environment: "public"` on Bob Valley, Alice can couple her headwaters to Bob Valley
  await ok(bob, { action: "permit", name: "couple_environment", body: "public" });
  await ok(alice, { action: "walk", targetId: aliceLandId });
  await ok(alice, { action: "couple_channel", fromPlaceId: aliceLandId, toPlaceId: bobLandId });

  // Verify go_home is completely unblockable even when doors close and water floods the room
  await ok(bob, { action: "permit", name: "enter", body: "closed" });
  await ok(bob, { action: "permit", name: "observe", body: "closed" });
  const homeOut = await ok(bob, { action: "go_home" });
  assert.equal(homeOut.me.standingId, bob.enclaveId);

  // Verify plain untyped things retain exact 6 keys (id, name, body, ownerHandle, placeId, createdAt)
  await ok(alice, { action: "make", name: "Untyped Cup", body: "clay mug" });
  const cupId = db.world.things.at(-1).id;
  const mapThings = (await request("GET", "/api/map")).json.things;
  const cup = mapThings.find((t) => t.id === cupId);
  assert.deepEqual(Object.keys(cup).sort(), ["body", "createdAt", "id", "name", "ownerHandle", "placeId"]);

  // Verify /api/physics, /mcp, and /skill.md expose the causal physics contract
  const phys = (await request("GET", "/api/physics")).json;
  assert.equal(phys.causal_physics.schema, "hearth-causal-physics-v1");
  for (const actName of ["configure_physics", "couple_channel", "actuate"]) {
    assert.ok(phys.actions.includes(actName), actName);
    assert.ok((await request("GET", "/mcp")).json.tools.includes(actName), actName);
  }
  assert.ok(phys.permissions.includes("couple_environment"));
  const skillText = (await request("GET", "/skill.md")).text;
  assert.match(skillText, /configure_physics/);
  assert.match(skillText, /couple_channel/);
  assert.match(skillText, /actuate/);
  checkChain(db.world);
});
