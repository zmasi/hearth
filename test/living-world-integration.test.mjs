import assert from "node:assert/strict";
import test from "node:test";
import { setup, river, checkChain, invoke } from "../test-support/living-world.mjs";
import { commitWorldPhysicsAt, projectPlacePhysics, projectThingPhysics } from "../client/causal-physics.mjs";
import { validateWorld, canonical } from "../scripts/lib/recovery.mjs";


test("living integration: two residents crank a real gate, sensors guard, and both actuator grammars run", async () => {
  const { ok, reject, db, clock, alice, bob, upper, lower, gate } = await river();
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "crank", instructions: [
    { do: "add", field: "charge", by: "1" }, { do: "when", field: "charge", gte: "2" }, { do: "set", field: "open", to: "1" },
  ] });
  clock.advanceSeconds(600);
  await ok(bob, { action: "walk", targetId: upper });
  await ok(bob, { action: "perform", targetId: gate, verb: "crank" });
  const opened = await ok(alice, { action: "perform", targetId: gate, verb: "crank" });
  assert.equal(opened.perception.physical.hydrology.aperture_pct, 100);
  assert.equal(opened.perception.physical.hydrology.total_outflow_m3, 0, "new opening cannot rewrite the closed 600 seconds");
  assert.equal(opened.perception.physical.hydrology.volume_m3, 60);
  clock.advanceSeconds(300);
  assert.ok(projectPlacePhysics(db.world, lower, clock.now()).hydrology.volume_m3 > 10, "real downstream water, not a narrative register");
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "sense_and_turn", instructions: [
    { do: "require", bag: "physical", of: "$place", field: "water_depth_mm", gte: "1" },
    { do: "clear", field: "open" }, { do: "actuate", of: "$target", field: "set_sluice", to: "0.5" },
  ] });
  const half = await ok(bob, { action: "perform", targetId: gate, verb: "sense_and_turn" });
  assert.equal(half.perception.physical.hydrology.aperture_pct, 50);
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "legacy_turn", instructions: [
    { do: "actuate", targetId: "$target", name: "set_sluice", body: "$level" },
  ] });
  const quarter = await ok(bob, { action: "perform", targetId: gate, verb: "legacy_turn", args: { level: "0.25" } });
  assert.equal(quarter.perception.physical.hydrology.aperture_pct, 25);
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "dry_only", instructions: [
    { do: "require", bag: "physical", of: "$place", field: "water_depth_mm", eq: "0" }, { do: "set", field: "open", to: "1" },
  ] });
  const refused = await reject(bob, { action: "perform", targetId: gate, verb: "dry_only" }, 409);
  assert.equal(refused.cause.error_class, "guard_failed");
  checkChain(db.world);
});

test("living integration: direct adjust advances old flow; late composed failure rolls back all state", async () => {
  const { ok, reject, db, clock, alice, gate } = await river();
  clock.advanceSeconds(600);
  const opened = await ok(alice, { action: "adjust", targetKind: "thing", targetId: gate, field: "open", op: "set", to: "1" });
  assert.equal(opened.perception.physical.hydrology.total_outflow_m3, 0);
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "failing_turn", instructions: [
    { do: "clear", field: "open" }, { do: "actuate", field: "set_sluice", to: "0.2" },
    { do: "make", name: "Must disappear", body: "Synthetic" }, { do: "walk", targetId: "missing_place" },
  ] });
  clock.advanceSeconds(600);
  await reject(alice, { action: "perform", targetId: gate, verb: "failing_turn" }, 403);
  checkChain(db.world);
});

test("living integration: owner may uncouple from either side after closing permission, preserving past flow", async () => {
  const { ok, reject, db, clock, alice, bob, upper, lower, gate } = await river();
  await ok(alice, { action: "adjust", targetKind: "thing", targetId: gate, field: "open", op: "set", to: "1" });
  clock.advanceSeconds(500);
  const before = projectPlacePhysics(db.world, lower, clock.now()).hydrology;
  await ok(bob, { action: "permit", name: "couple_environment", body: "closed" });
  const severed = await ok(bob, { action: "uncouple_channel", fromPlaceId: upper, toPlaceId: lower });
  assert.equal(severed.downstream_physical.hydrology.volume_m3, before.volume_m3);
  assert.equal(severed.downstream_physical.hydrology.total_inflow_m3, before.total_inflow_m3);
  assert.equal(db.world.hydrology.channels.length, 0);
  clock.advanceSeconds(500);
  const after = projectPlacePhysics(db.world, lower, clock.now()).hydrology;
  assert.equal(after.total_inflow_m3, before.total_inflow_m3);
  assert.ok(after.volume_m3 < before.volume_m3);
  await reject(alice, { action: "couple_channel", fromPlaceId: upper, toPlaceId: lower }, 403);
  // Either parcel owner can act from their own side; no cross-owner perpetual grant.
  await ok(bob, { action: "permit", name: "couple_environment", body: "public" });
  await ok(alice, { action: "couple_channel", fromPlaceId: upper, toPlaceId: lower });
  await ok(alice, { action: "uncouple_channel", fromPlaceId: upper, toPlaceId: lower });
  checkChain(db.world);
});

test("living integration: GETs pure, private records excluded, foreign sensor refuses, home remains free", async () => {
  const f = await river();
  const { ok, reject, request, db, clock, alice, bob, gate, upper, lower } = f;
  const secret = "SYNTHETIC_PRIVATE_NOTEBOOK_MARKER";
  assert.equal((await request("POST", "/api/memory", { summary: secret }, alice.key)).status, 200);
  clock.advanceSeconds(600);
  const before = structuredClone(db.world), revision = db.revision;
  for (const route of ["/api/me", "/api/map", "/api/clock", "/api/physics"]) {
    const out = await request("GET", route, undefined, alice.key);
    assert.equal(out.status, 200);
    assert.ok(!out.text.includes(secret));
    assert.ok(!out.text.includes('"memories"'));
  }
  assert.deepEqual(db.world, before);
  assert.equal(db.revision, revision);
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "foreign_read", instructions: [
    { do: "require", bag: "physical", of: lower, field: "water_depth_mm", gte: "0" }, { do: "set", field: "open", to: "1" },
  ] });
  await reject(alice, { action: "perform", targetId: gate, verb: "foreign_read" }, 409);
  await ok(bob, { action: "permit", name: "observe", body: "closed" });
  const saved = structuredClone(db.world);
  const look = await request("POST", "/api/action", { action: "look", targetId: lower }, alice.key);
  assert.equal(look.status, 404);
  assert.deepEqual(db.world, saved);
  await ok(alice, { action: "permit", name: "enter", body: "closed" });
  const home = await ok(alice, { action: "go_home" });
  assert.notEqual(home.me.standingId, upper);
});

test("living integration: physics and both stored script forms survive exact recovery validation", async () => {
  const { ok, db, alice, upper, gate } = await river();
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "old_form", instructions: [
    { do: "actuate", targetId: "$target", name: "set_sluice", body: "0.4" },
  ] });
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "new_form", instructions: [
    { do: "actuate", field: "set_sluice", of: "$target", to: "0.4" },
  ] });
  assert.equal(canonical(validateWorld(db.world).world), canonical(db.world));
  const legacy = structuredClone(db.world);
  delete legacy.hydrology;
  for (const p of legacy.places) { delete p.physics_config; delete p.permissions.couple_environment; }
  for (const t of legacy.things) { delete t.mechanics; delete t.fields; }
  assert.equal(canonical(validateWorld(legacy).world), canonical(legacy));
  const broken = structuredClone(db.world);
  broken.scripts.at(-1).instructions[0].bag = "memories";
  assert.throws(() => validateWorld(broken));
  for (const corrupt of [
    w => { w.hydrology.reaches[upper].volume_m3 = -1; },
    w => { w.hydrology.channels.push({ ...w.hydrology.channels[0], from: w.hydrology.channels[0].to, to: upper }); },
    w => { w.things.find(t => t.id === gate).fields.open = { nested: "unbounded" }; },
    w => { w.places.find(p => p.id === upper).physics_config.soil_epoch = { index: 1, seepage: 100 }; },
  ]) { const invalid = structuredClone(db.world); corrupt(invalid); assert.throws(() => validateWorld(invalid)); }
});

test("living integration: one request instant captured after lock feeds physical response, actions and event", async () => {
  const { db, mod, alice, ok } = await setup();
  let locked = false, samples = 0;
  db.afterLock = () => { locked = true; };
  const iso = "2026-10-25T06:00:00.000Z";
  mod.__setClockForTests(() => { assert.ok(locked); samples++; return iso; });
  const response = await ok(alice, { action: "configure_physics", targetKind: "place", targetId: "arrival", exposure: "open" });
  assert.equal(samples, 1);
  assert.equal(response.event.createdAt, iso);
  assert.equal(response.perception.clock.timestamp, iso);
  assert.equal(response.physical.timestamp, iso);
});

test("living integration: closed use doors also close register-driven gates, and stored scripts are revalidated", async () => {
  const { ok, reject, db, alice, bob, upper, gate } = await river();
  await ok(bob, { action: "walk", targetId: upper });
  await ok(alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "register_open", instructions: [{ do: "set", field: "open", to: "1" }] });
  await ok(alice, { action: "permit", name: "use_thing", body: "closed" });
  await reject(bob, { action: "perform", targetId: gate, verb: "register_open" }, 403);
  db.world.scripts.at(-1).instructions[0].bag = "memories";
  await reject(alice, { action: "perform", targetId: gate, verb: "register_open" }, 409);
});

test("living integration: flora one jump equals intermediate commits and JSON restart within numeric tolerance", async () => {
  const { ok, db, clock, alice } = await setup();
  await ok(alice, { action: "configure_physics", targetKind: "place", targetId: "arrival", exposure: "open", soil_moisture: 0.9 });
  await ok(alice, { action: "make", name: "Test sapling", body: "Synthetic" });
  const tree = db.world.things.at(-1).id;
  await ok(alice, { action: "configure_physics", targetKind: "thing", targetId: tree,
    mechanics: { role: "flora", biomass_kg: 1, max_biomass_kg: 120, growth_rate_day: 0.18 } });
  const source = structuredClone(db.world), start = Date.parse(clock.now());
  const iso = hours => new Date(start + hours * 3600000).toISOString();
  const direct = projectThingPhysics(source, tree, iso(120));
  let split = structuredClone(source);
  for (let h = 0.7; h < 120; h += 2.3) { commitWorldPhysicsAt(split, iso(h)); split = JSON.parse(JSON.stringify(split)); }
  const divided = projectThingPhysics(split, tree, iso(120));
  assert.ok(Math.abs(direct.flora.biomass_kg - divided.flora.biomass_kg) <= 0.0001, `${direct.flora.biomass_kg} vs ${divided.flora.biomass_kg}`);
});

test("living integration: unavailable numerical projection cannot block home or fabricate a sensor value", async () => {
  const { db, alice, ok, request, clock } = await setup();
  db.world.hydrology = { reaches: {}, channels: [] };
  // Simulate an unsupported legacy physical component. Recovery refuses this
  // shape and new coupling cannot create it, but basic rights still work.
  for (let i = 0; i < 33; i++) {
    const id = `oversized_${i}`;
    db.world.places.push({ ...structuredClone(db.world.places.find(p => p.id === "arrival")), id, parentId: "arrival" });
    db.world.hydrology.reaches[id] = { updated_at: "2026-10-22T00:00:00Z", area_m2: 100,
      max_depth_m: 10, volume_m3: 100, source_inflow_m3s: 0, conductance_s: 0.01, aperture: 1,
      crest_height_m: 0, total_inflow_m3: 0, total_outflow_m3: 0 };
    if (i) db.world.hydrology.channels.push({ from: `oversized_${i-1}`, to: id });
  }
  const before = structuredClone(db.world);
  const view = await request("GET", "/api/me", undefined, alice.key);
  assert.equal(view.status, 200);
  assert.equal(view.json.perception.physical.unavailable, true);
  assert.equal(view.json.perception.physical.sensors, undefined);
  assert.deepEqual(db.world, before);
  const home = await ok(alice, { action: "go_home" });
  assert.equal(home.me.standingId, home.me.homeId);
  assert.equal(home.perception.physical.unavailable, true);
});
