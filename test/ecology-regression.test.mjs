import test from "node:test";
import assert from "node:assert/strict";
import { commitWorldPhysicsAt, projectThingPhysics } from "../client/causal-physics.mjs";
const start = Date.parse("2026-10-23T08:00:00Z");
const at = days => new Date(start + days * 86400000).toISOString();
function fixture(irrigated = false) {
  return { events: [{ createdAt: at(0) }], places: [{ id: "garden", physics_config: {
    exposure: "open", soil_moisture: 0.9, moisture_updated_at: at(0),
  } }], things: [{ id: "tree", placeId: "garden", mechanics: {
    role: "flora", biomass_kg: 1, max_biomass_kg: 120, growth_rate_day: 0.18, updated_at: at(0),
  } }], ...(irrigated ? { hydrology: { reaches: { garden: { updated_at: at(0), area_m2: 100,
    max_depth_m: 10, volume_m3: 250, source_inflow_m3s: 0.2, conductance_s: 0.01, aperture: 1,
    crest_height_m: 0, total_inflow_m3: 0, total_outflow_m3: 0 } }, channels: [] } } : {}) };
}
for (const irrigated of [false, true]) test(`ecology: 10-day varying moisture integrates growth across partial-hour commits (irrigated=${irrigated})`, () => {
  const source = fixture(irrigated);
  const direct = projectThingPhysics(source, "tree", at(10)).flora;
  let split = structuredClone(source);
  for (let hours = 0.7; hours < 240; hours += 11.3) {
    commitWorldPhysicsAt(split, at(hours / 24)); split = JSON.parse(JSON.stringify(split));
  }
  const repeated = projectThingPhysics(split, "tree", at(10)).flora;
  assert.ok(Math.abs(direct.biomass_kg - repeated.biomass_kg) <= 0.0001, `${direct.biomass_kg} vs ${repeated.biomass_kg}`);
});
test("ecology: 30 and 180 days agree with daily anchors in the periodic climate", t => {
  for (const days of [30, 180]) {
    const source = fixture(), branch = structuredClone(source);
    for (let d = 1; d < days; d++) commitWorldPhysicsAt(branch, at(d));
    const direct = projectThingPhysics(source, "tree", at(days)).flora.biomass_kg;
    const daily = projectThingPhysics(branch, "tree", at(days)).flora.biomass_kg;
    assert.ok(direct >= 1 && direct <= 120 && daily >= 1 && daily <= 120);
    assert.ok(Math.abs(direct - daily) <= 0.0001);
    assert.equal(projectThingPhysics(source, "tree", at(days)).flora.history_approximation, false);
    t.diagnostic(`${days} days: one jump ${direct} kg, daily anchors ${daily} kg, difference ${Math.abs(direct-daily)} kg`);
  }
});
test("ecology: unresolved very slow river transients mark the bounded long-absence approximation", () => {
  const source = fixture(true);
  Object.assign(source.hydrology.reaches.garden, { volume_m3: 50, source_inflow_m3s: 0, conductance_s: 0.0001, aperture: 0.0001 });
  const result = projectThingPhysics(source, "tree", at(180));
  assert.equal(result.flora.history_approximation, true);
  commitWorldPhysicsAt(source, at(180));
  assert.equal(source.places[0].physics_config.history_approximation, true);
  assert.equal(projectThingPhysics(source, "tree", at(181)).flora.history_approximation, true);
});
