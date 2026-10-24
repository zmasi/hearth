import assert from "node:assert/strict";
import test from "node:test";
import { solveHydrologyNetwork, commitWorldPhysicsAt } from "../client/causal-physics.mjs";

const epoch = Date.parse("2026-10-23T00:00:00Z") / 1000;
const world = (specs, links) => ({ places: specs.map((_, i) => ({ id: String(i) })), things: [],
  hydrology: { reaches: Object.fromEntries(specs.map((s, i) => [String(i), {
    elevation_m: 10 - i, area_m2: 100, max_depth_m: 10, crest_height_m: 0.5,
    aperture: 1, conductance_s: 0.01, volume_m3: 50, source_inflow_m3s: 0,
    total_inflow_m3: 0, total_outflow_m3: 0, updated_at: new Date(epoch * 1000).toISOString(), ...s,
  }])), channels: links.map(([a, b]) => ({ from: String(a), to: String(b) })) } });

function equivalent(source, end, cuts, tolerance = 1e-5) {
  const direct = solveHydrologyNetwork(source, epoch + end);
  let branch = structuredClone(source);
  for (const cut of cuts) { commitWorldPhysicsAt(branch, new Date((epoch + cut) * 1000).toISOString()); branch = JSON.parse(JSON.stringify(branch)); }
  const split = solveHydrologyNetwork(branch, epoch + end);
  for (const [id, a] of direct) {
    const b = split.get(id);
    for (const key of ["volume_m3", "total_inflow_m3", "total_outflow_m3"]) {
      assert.ok(Math.abs(a[key] - b[key]) < tolerance, `${id}.${key}: ${a[key]} vs ${b[key]}`);
    }
    const initial = source.hydrology.reaches[id].volume_m3;
    assert.ok(Math.abs(initial + a.total_inflow_m3 - a.total_outflow_m3 - a.volume_m3) < tolerance);
    assert.ok(a.volume_m3 >= 0 && a.volume_m3 <= a.max_volume_m3);
  }
  return direct;
}

test("hydrology regression: three equal rates retain the t squared exponential cascade term", () => {
  const w = world([{ volume_m3: 150 }, {}, {}], [[0, 1], [1, 2]]);
  const out = equivalent(w, 100, [20, 50, 70]);
  assert.ok(Math.abs(out.get("2").volume_m3 - (50 + 50 / Math.E)) < 1e-6);
});

test("hydrology regression: near-equal rates do not lose precision or invent water", () => {
  const w = world([{ volume_m3: 150 }, { conductance_s: 0.0100000001 }, { conductance_s: 0.0099999999 }], [[0, 1], [1, 2]]);
  const out = equivalent(w, 100, [13, 44, 91]);
  assert.ok(Math.abs(out.get("2").volume_m3 - (50 + 50 / Math.E)) < 1e-5);
});

test("hydrology regression: transient inflow fills to crest before discharge", () => {
  const w = world([{ volume_m3: 250 }, { volume_m3: 0 }, {}], [[0, 1], [1, 2]]);
  equivalent(w, 180, [7, 25, 41, 79, 111]);
});

test("hydrology regression: overflowing and draining capped reaches preserve downstream mass and partition", () => {
  const w = world([{ volume_m3: 500, source_inflow_m3s: 0.5 }, { max_depth_m: 0.6, volume_m3: 50 }, {}], [[0, 1], [1, 2]]);
  equivalent(w, 3600, [11, 31, 79, 219, 600, 1000]);
});

test("hydrology regression: long absence and a split channel conserve every shared outflow", () => {
  const w = world([{ volume_m3: 150, source_inflow_m3s: 0.5 }, { aperture: 0 }, {}], [[0, 1], [0, 2]]);
  const out = equivalent(w, 180 * 86400, [300, 7000, 7 * 86400, 31 * 86400], 1e-4);
  assert.ok(Math.abs(out.get("0").total_outflow_m3 / 2 - out.get("1").total_inflow_m3) < 1e-4);
});

test("hydrology regression: deterministic varied cascades retain volume across many restart partitions", () => {
  let seed = 547;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 12; trial++) {
    const specs = Array.from({ length: 4 }, () => ({ volume_m3: random() * 100,
      max_depth_m: 1 + random(), crest_height_m: Math.round(random() * 0.7 * 10000) / 10000,
      source_inflow_m3s: random() * 0.3, conductance_s: 0.002 + random() * 0.02 }));
    equivalent(world(specs, [[0, 1], [1, 2], [1, 3]]), 2000, [17, 103, 240, 501, 799, 1307, 1801], 1e-4);
  }
});
