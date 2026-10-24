// Hearth Causal Physics, Spatial Mechanics & Coupled Environment Engine (hearth-causal-physics-v1)
//
// Modeled fidelity (stated precisely):
// 1. Room Spatial & Mechanical Dynamics:
//    - 3D Axis-Aligned Bounding Box (AABB) room bounds, solid occupancy, and collision detection.
//    - Vertical support stacking with center-of-mass footprint stability and recursive gravitational load transfer.
//    - Hookean spring/beam deflection (delta = m_load * g / k), latch thresholds, and mechanical-to-sluice coupling.
//    - 1D/3D rigid-body impact mechanics (momentum conservation, coefficient of restitution e, frictional slide,
//      plastic deformation work accumulation, and exponentially damped acoustic resonance over elapsed time).
//    - This is a deterministic discrete/lumped 3D AABB + analytical mechanics solver, not a general 3D mesh engine.
// 2. Coupled Multi-Place Hydrology:
//    - Directed acyclic conservation graph of reaches with bed elevation, surface area, weir crest height,
//      sluice aperture, and maximum basin capacity.
//    - Piecewise-analytical linear-reservoir / Nash-cascade integration over elapsed time Δt:
//      nonnegative volumes and shared flow integrals, with numerical regime detection and tested restart tolerances.
//      No time-step-per-second loop and no discarded elapsed interval.
// 3. Atmosphere, Weather, Wind & Living Flora:
//    - Deterministic UTC solar irradiance (aligned with 06:00 sunrise / 18:00 sunset) and seeded synoptic
//      weather cells (wind speed/direction, temperature, rainfall).
//    - Piecewise-analytical soil moisture balance (rainfall + local river seepage - solar evapotranspiration)
//      and logistic flora biomass/canopy growth with wind-induced canopy sway.
// 4. Pure Observation & Sovereignty Invariants:
//    - Projection functions never mutate the world object, append events, or backfill missing bags on plain things.
//    - Cross-place channel coupling requires local authority on both upstream and downstream parcels.

import { createHash } from "node:crypto";
import { advanceReservoirComponent, MAX_COUPLED_REACHES } from "./hydrology-solver.mjs";

export const PHYSICS_SCHEMA = "hearth-causal-physics-v1";
export const GRAVITY_MS2 = 9.80665;

const DEFAULT_ROOM_BOUNDS = Object.freeze([20, 10, 20]); // [width_x, height_y, depth_z] in meters
const DEFAULT_BODY_SIZE = Object.freeze([0.5, 0.5, 0.5]);
const SYNOPTIC_EPOCH_SEC = 3600; // 1 hour UTC weather cells
const WEATHER_CYCLE_EPOCHS = 336; // Explicit fourteen-day climate cycle, aligned to UTC.
const SOIL_TAU_SEC = 43200; // 12-hour soil moisture relaxation constant

const ALLOWED_PLACE_SENSORS = new Set([
  "sunlight_pct",
  "wind_speed_cms",
  "wind_direction_deg",
  "rain_mm_hr_int",
  "temperature_c_int",
  "moisture_pct",
  "water_depth_mm",
  "water_volume_l",
  "inflow_lps",
  "discharge_lps",
  "total_outflow_l",
  "bed_state",
]);

const ALLOWED_THING_SENSORS = new Set([
  "mass_g",
  "load_g",
  "deflection_mm",
  "latch_threshold_mm",
  "latched_int",
  "aperture_pct",
  "open",
  "crest_height_mm",
  "last_rebound_mms",
  "work_j_int",
  "ring_hz_int",
  "ring_pct",
  "moisture_pct",
  "biomass_g",
  "canopy_pct",
  "sway_mdeg",
  "wind_stress_pct",
  "stage",
]);

function fail(error_class, message, http_status = 400, extra = undefined) {
  return extra
    ? { ok: false, error_class, message, http_status, ...extra }
    : { ok: false, error_class, message, http_status };
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function roundTo(val, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round((Number(val) || 0) * factor) / factor;
}

function parseIsoSeconds(iso, fallbackSec = 0) {
  if (typeof iso !== "string") return fallbackSec;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : fallbackSec;
}

function worldOriginIso(world) {
  const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
  const firstEvent = world?.events?.at?.(-1)?.createdAt;
  if (validDate(firstEvent)) return firstEvent;
  const rootPlace = world?.places?.find?.((p) => p.id === "world")?.createdAt;
  if (validDate(rootPlace)) return rootPlace;
  return "2026-09-01T00:00:00.000Z";
}

function deterministicUnit(seedString) {
  const digest = createHash("sha256").update(seedString, "utf8").digest();
  const uint32 = digest.readUInt32BE(0);
  return uint32 / 0xffffffff;
}

function livePlace(world, placeId) {
  if (!world || !Array.isArray(world.places)) return null;
  return world.places.find((p) => p.id === placeId && !p.destroyedAt) || null;
}

function liveThing(world, thingId) {
  if (!world || !Array.isArray(world.things)) return null;
  return world.things.find((t) => t.id === thingId && !t.destroyedAt) || null;
}

function liveThingsAt(world, placeId) {
  if (!world || !Array.isArray(world.things)) return [];
  return world.things.filter((t) => t.placeId === placeId && !t.destroyedAt);
}

// ============================================================================
// 1. DETERMINISTIC ATMOSPHERE, SOLAR, WIND & WEATHER FIELDS
// ============================================================================

export function evaluateAtmosphere(world, place, tSec) {
  const genesis = world?.ledger_genesis || "0".repeat(64);
  const config = place?.physics_config || {};
  const exposure = config.exposure || (place?.kind === "room" && place?.id?.startsWith("enclave_") ? "sheltered" : "open");

  const daySec = ((tSec % 86400) + 86400) % 86400;
  const hourUtc = daySec / 3600;

  let phase = "night";
  if (hourUtc >= 6 && hourUtc < 7) phase = "sunrise";
  else if (hourUtc >= 7 && hourUtc < 18) phase = "day";
  else if (hourUtc >= 18 && hourUtc < 19) phase = "sunset";

  // Clear-sky solar elevation curve between 06:00 and 18:00 UTC
  let clearSkySun = 0;
  if (hourUtc > 6 && hourUtc < 18) {
    clearSkySun = Math.sin(Math.PI * ((hourUtc - 6) / 12));
  }

  // Synoptic epoch interpolation (1-hour cells)
  const epochIdx = Math.floor(tSec / SYNOPTIC_EPOCH_SEC);
  const frac = (tSec - epochIdx * SYNOPTIC_EPOCH_SEC) / SYNOPTIC_EPOCH_SEC;
  const regionKey = config.weather_region || "hearth_valley";
  const cycle = index => ((index % WEATHER_CYCLE_EPOCHS) + WEATHER_CYCLE_EPOCHS) % WEATHER_CYCLE_EPOCHS;

  const w0 = deterministicUnit(`${genesis}:${regionKey}:wind:${cycle(epochIdx)}`);
  const w1 = deterministicUnit(`${genesis}:${regionKey}:wind:${cycle(epochIdx + 1)}`);
  const d0 = deterministicUnit(`${genesis}:${regionKey}:dir:${cycle(epochIdx)}`);
  const d1 = deterministicUnit(`${genesis}:${regionKey}:dir:${cycle(epochIdx + 1)}`);
  const r0 = deterministicUnit(`${genesis}:${regionKey}:rain:${cycle(epochIdx)}`);
  const r1 = deterministicUnit(`${genesis}:${regionKey}:rain:${cycle(epochIdx + 1)}`);

  const windRaw = w0 + (w1 - w0) * frac;
  const dirRaw = d0 + (d1 - d0) * frac;
  const rainRaw = r0 + (r1 - r0) * frac;

  const exposureFactor = exposure === "sheltered" ? 0.05 : exposure === "canopy" ? 0.45 : 1.0;
  const windExposure = exposure === "sheltered" ? 0.0 : exposure === "canopy" ? 0.55 : 1.0;
  const rainExposure = exposure === "sheltered" ? 0.0 : exposure === "canopy" ? 0.75 : 1.0;

  // Rain occurs when synoptic rain potential exceeds 0.68 (unless overridden in place config for deterministic tests)
  let rainMmHr = 0;
  if (typeof config.rain_override_mm_hr === "number") {
    rainMmHr = Math.max(0, config.rain_override_mm_hr) * rainExposure;
  } else if (rainRaw > 0.68) {
    rainMmHr = roundTo(((rainRaw - 0.68) / 0.32) * 18.0 * rainExposure, 3);
  }

  const cloudCover = clamp(rainRaw * 0.9, 0, 0.85);
  const sunlight = typeof config.sunlight_override === "number"
    ? clamp(config.sunlight_override, 0, 1)
    : roundTo(clearSkySun * (1 - 0.5 * cloudCover) * exposureFactor, 4);

  const baseWindMs = typeof config.wind_override_ms === "number"
    ? Math.max(0, config.wind_override_ms)
    : (0.8 + windRaw * 11.2) * windExposure;
  const windSpeedMs = roundTo(baseWindMs, 3);
  const windDirectionDeg = Math.round((dirRaw * 360) % 360);

  const tempC = roundTo(11.0 + 9.5 * clearSkySun - 3.0 * cloudCover, 2);

  return {
    phase,
    exposure,
    sunlight,
    sunlight_pct: Math.round(sunlight * 100),
    temperature_c: tempC,
    temperature_c_int: Math.round(tempC),
    wind_speed_ms: windSpeedMs,
    wind_speed_cms: Math.round(windSpeedMs * 100),
    wind_direction_deg: windDirectionDeg,
    rain_mm_hr: rainMmHr,
    rain_mm_hr_int: Math.round(rainMmHr),
  };
}

// ============================================================================
// 2. COUPLED MULTI-PLACE HYDROLOGY (EXACT CONSERVATIVE PIECEWISE-ANALYTICAL SOLVER)
// ============================================================================

/**
 * Effective aperture [0..1] and crest height [m] for a reach, reading any bound weir/sluice things in that place.
 * Supports both `thing.mechanics.aperture` and Grok's `thing.fields.open` seamless interop.
 */
function resolveReachControl(world, placeId, reach) {
  let aperture = typeof reach.aperture === "number" ? clamp(reach.aperture, 0, 1) : 1.0;
  let crestHeightM = typeof reach.crest_height_m === "number" ? Math.max(0, reach.crest_height_m) : 0.0;

  const things = liveThingsAt(world, placeId);
  // Compute room support loads first so any counterweight-coupled sluice knows if its beam is latched!
  const supportMap = computeRoomSupportState(world, placeId);

  for (const t of things) {
    const m = t.mechanics;
    if (!m || (m.role !== "sluice" && m.role !== "weir")) continue;

    if (typeof m.crest_height_m === "number") {
      crestHeightM = Math.max(0, m.crest_height_m);
    }
    if (typeof m.aperture === "number") {
      aperture = clamp(m.aperture, 0, 1);
    }

    // Mechanical counterweight coupling: if this sluice is coupled to a support beam in the room,
    // its aperture follows the beam's latched state!
    if (typeof m.coupled_support_id === "string") {
      const supState = supportMap.get(m.coupled_support_id);
      if (supState) {
        aperture = supState.latched ? 1.0 : 0.0;
      } else {
        // Support was destroyed or removed -> gate snaps shut
        aperture = 0.0;
      }
    }

    // Seamless interop with Grok's programmable `thing.fields.open` register
    if (m.follow_field !== false && t.fields && typeof t.fields === "object" && Object.hasOwn(t.fields, "open")) {
      const openVal = Number(t.fields.open);
      if (Number.isFinite(openVal)) {
        if (openVal <= 0) aperture = 0.0;
        else if (openVal === 1) aperture = 1.0;
        else aperture = clamp(openVal / 100, 0, 1);
      }
    }
  }

  return { aperture, crestHeightM };
}

/**
 * Analytically advances the entire hydrological reach network from its stored anchor timestamps to `targetSec`.
 * Returns a pure snapshot Map<placeId, ReachState> without mutating `world`.
 *
 * Mathematical model & conservation proof:
 * For a DAG of reaches i = 1..N in topological order:
 * Within a time interval Δt >= 0, each reach has:
 *   - Area A_i > 0, capacity V_max,i, weir crest volume V_c,i = A_i * h_crest,i
 *   - Discharge rate parameter k_i = conductance_i * aperture_i (in s^-1)
 *   - Constant external source inflow I_source,i (m^3/s)
 * When k_i > 0 and V_i > V_c,i, active mobile volume U_i = V_i - V_c,i decays exponentially at rate k_i,
 * and the exact integrated volume discharged out of reach i over [0, Δt] is:
 *   V_discharged,i(Δt) = I_total,i * Δt + V_i(0) - V_i(Δt)
 * The implementation uses a matrix exponential inside each regime and numerical
 * bracketing/bisection at boundaries. Equal rates retain the polynomial-exponential
 * cascade terms. See hydrology-solver.mjs and the regression tolerances; this is
 * not a proof of bit-identical trajectories for all graphs/platforms.
 */
export function solveHydrologyNetwork(world, targetSec) {
  const hydro = world?.hydrology;
  if (!hydro || typeof hydro !== "object" || !hydro.reaches || typeof hydro.reaches !== "object") {
    return new Map();
  }

  const reachesRaw = hydro.reaches;
  const channels = Array.isArray(hydro.channels) ? hydro.channels : [];
  const activePlaceIds = Object.keys(reachesRaw).filter((pid) => livePlace(world, pid) !== null);
  if (activePlaceIds.length === 0) return new Map();

  // Build adjacency and controls
  const upstreamOf = new Map();
  const downstreamOf = new Map();
  for (const pid of activePlaceIds) {
    upstreamOf.set(pid, []);
    downstreamOf.set(pid, []);
  }
  for (const ch of channels) {
    if (upstreamOf.has(ch.to) && downstreamOf.has(ch.from)) {
      upstreamOf.get(ch.to).push(ch.from);
      downstreamOf.get(ch.from).push(ch.to);
    }
  }

  const state = new Map();
  let networkAnchorSec = targetSec;
  for (const pid of activePlaceIds) {
    const r = reachesRaw[pid];
    const t0 = typeof r.updated_at === "string" ? parseIsoSeconds(r.updated_at, targetSec) : targetSec;
    if (t0 < networkAnchorSec) networkAnchorSec = t0;
    const area = Math.max(1, Number(r.area_m2) || 50);
    const maxDepth = Math.max(0.5, Number(r.max_depth_m) || 10);
    const maxVolume = area * maxDepth;
    const { aperture, crestHeightM } = resolveReachControl(world, pid, r);
    const crestVolume = clamp(area * crestHeightM, 0, maxVolume);
    const baseConductance = Math.max(0.0001, Number(r.conductance_s) || 0.01);
    const k = baseConductance * aperture;

    state.set(pid, {
      placeId: pid,
      elevation_m: Number(r.elevation_m) || 0,
      area_m2: area,
      max_depth_m: maxDepth,
      max_volume_m3: maxVolume,
      crest_height_m: crestHeightM,
      crest_volume_m3: crestVolume,
      aperture,
      conductance_s: baseConductance,
      k,
      source_inflow_m3s: Math.max(0, Number(r.source_inflow_m3s) || 0),
      volume_m3: clamp(Number(r.volume_m3) || 0, 0, maxVolume),
      total_inflow_m3: Math.max(0, Number(r.total_inflow_m3) || 0),
      total_outflow_m3: Math.max(0, Number(r.total_outflow_m3) || 0),
      inflow_m3s: 0,
      discharge_m3s: 0,
      updated_sec: t0,
    });
  }

  // Topological sort (upstream to downstream; break any cycle deterministically by elevation then id)
  const inDegree = new Map();
  for (const pid of activePlaceIds) {
    inDegree.set(pid, upstreamOf.get(pid).length);
  }
  const queue = activePlaceIds
    .filter((pid) => inDegree.get(pid) === 0)
    .sort((a, b) => (state.get(b).elevation_m - state.get(a).elevation_m) || a.localeCompare(b));
  const topoOrder = [];
  const visited = new Set();
  while (queue.length > 0) {
    const curr = queue.shift();
    if (visited.has(curr)) continue;
    visited.add(curr);
    topoOrder.push(curr);
    for (const nxt of downstreamOf.get(curr)) {
      inDegree.set(nxt, inDegree.get(nxt) - 1);
      if (inDegree.get(nxt) <= 0 && !visited.has(nxt)) {
        queue.push(nxt);
      }
    }
  }
  for (const pid of activePlaceIds) {
    if (!visited.has(pid)) topoOrder.push(pid);
  }

  const dtTotal = Math.max(0, targetSec - networkAnchorSec);
  if (dtTotal > 0) {
    advanceHydrologyAnalytical(state, topoOrder, upstreamOf, downstreamOf, dtTotal);
  } else {
    updateInstantaneousRates(state, topoOrder, upstreamOf, downstreamOf);
  }

  return state;
}

function updateInstantaneousRates(state, topoOrder, upstreamOf, downstreamOf) {
  for (const pid of topoOrder) {
    const s = state.get(pid);
    let upFlow = 0;
    for (const upId of upstreamOf.get(pid)) {
      const up = state.get(upId);
      const outCount = Math.max(1, downstreamOf.get(upId).length);
      upFlow += up.discharge_m3s / outCount;
    }
    s.inflow_m3s = s.source_inflow_m3s + upFlow;
    if (s.k > 0 && s.volume_m3 > s.crest_volume_m3) {
      s.discharge_m3s = s.k * (s.volume_m3 - s.crest_volume_m3);
      if (s.volume_m3 >= s.max_volume_m3 - 1e-8) s.discharge_m3s = Math.max(s.discharge_m3s, s.inflow_m3s);
    } else if (s.volume_m3 >= s.max_volume_m3 && s.inflow_m3s > 0) {
      s.discharge_m3s = s.inflow_m3s;
    } else {
      s.discharge_m3s = 0;
    }
  }
}

// Evolve weakly connected components independently, bounding matrix size while
// permitting any number of separate resident parcels.
function advanceHydrologyAnalytical(state, order, upstream, downstream, dt) {
  const seen = new Set();
  for (const seed of order) {
    if (seen.has(seed)) continue;
    const members = new Set(), stack = [seed];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id); members.add(id);
      stack.push(...upstream.get(id), ...downstream.get(id));
    }
    advanceReservoirComponent(state, order.filter(id => members.has(id)), upstream, downstream, dt);
  }
  updateInstantaneousRates(state, order, upstream, downstream);
}

// ============================================================================
// 3. ROOM 3D SPATIAL, SUPPORT STACK, BEAM DEFLECTION & IMPULSE SOLVER
// ============================================================================

function getBodyBox(thing, yOverride = null) {
  const m = thing?.mechanics || {};
  const pos = Array.isArray(m.pos) && m.pos.length === 3 ? m.pos.map(Number) : [0, 0, 0];
  const size = Array.isArray(m.size) && m.size.length === 3 ? m.size.map((v) => Math.max(0.05, Number(v) || 0.5)) : [...DEFAULT_BODY_SIZE];
  const y = yOverride !== null ? yOverride : pos[1];
  return {
    xMin: pos[0] - size[0] / 2,
    xMax: pos[0] + size[0] / 2,
    yMin: y,
    yMax: y + size[1],
    zMin: pos[2] - size[2] / 2,
    zMax: pos[2] + size[2] / 2,
    pos: [pos[0], y, pos[2]],
    size,
  };
}

function boxesOverlap3D(a, b, tol = 1e-4) {
  return (
    a.xMin < b.xMax - tol &&
    a.xMax > b.xMin + tol &&
    a.yMin < b.yMax - tol &&
    a.yMax > b.yMin + tol &&
    a.zMin < b.zMax - tol &&
    a.zMax > b.zMin + tol
  );
}

function centerInsideFootprint(topPos, supportBox, tol = 1e-4) {
  return (
    topPos[0] >= supportBox.xMin - tol &&
    topPos[0] <= supportBox.xMax + tol &&
    topPos[2] >= supportBox.zMin - tol &&
    topPos[2] <= supportBox.zMax + tol
  );
}

/**
 * Pure computation of support stacks, gravitational loads, Hookean deflection, and latch states
 * for all physical things in `placeId`. Destroyed supports are ignored automatically.
 */
export function computeRoomSupportState(world, placeId) {
  const things = liveThingsAt(world, placeId).filter((t) => t.mechanics && typeof t.mechanics === "object");
  const byId = new Map(things.map((t) => [t.id, t]));
  const childrenOf = new Map(things.map((t) => [t.id, []]));

  for (const t of things) {
    const supId = t.mechanics.resting_on;
    if (typeof supId === "string" && byId.has(supId) && supId !== t.id) {
      childrenOf.get(supId).push(t.id);
    }
  }

  // Recursive supported mass computation with cycle guard
  const loadCache = new Map();
  function computeSupportedLoadKg(id, visiting = new Set()) {
    if (loadCache.has(id)) return loadCache.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let total = 0;
    for (const childId of childrenOf.get(id) || []) {
      const child = byId.get(childId);
      const childMass = Math.max(0.001, Number(child?.mechanics?.mass_kg) || 1);
      total += childMass + computeSupportedLoadKg(childId, visiting);
    }
    visiting.delete(id);
    loadCache.set(id, total);
    return total;
  }

  const out = new Map();
  for (const t of things) {
    const m = t.mechanics;
    const massKg = Math.max(0.001, Number(m.mass_kg) || 1);
    const loadKg = roundTo(computeSupportedLoadKg(t.id), 4);
    const stiffnessNm = Math.max(0, Number(m.stiffness_nm) || 0);
    const maxDeflectionM = Math.max(0, Number(m.max_deflection_m) || 0.5);
    const deflectionM = stiffnessNm > 0
      ? roundTo(clamp((loadKg * GRAVITY_MS2) / stiffnessNm, 0, maxDeflectionM), 6)
      : 0;
    const deflectionMm = Math.round(deflectionM * 1000);
    const latchThresholdMm = typeof m.latch_threshold_mm === "number" ? Math.max(1, Math.round(m.latch_threshold_mm)) : null;
    const latched = latchThresholdMm !== null ? deflectionMm >= latchThresholdMm : false;

    const validRestingOn = typeof m.resting_on === "string" && byId.has(m.resting_on) ? m.resting_on : null;
    out.set(t.id, {
      mass_kg: massKg,
      mass_g: Math.round(massKg * 1000),
      resting_on: validRestingOn,
      load_kg: loadKg,
      load_g: Math.round(loadKg * 1000),
      stiffness_nm: stiffnessNm,
      deflection_m: deflectionM,
      deflection_mm: deflectionMm,
      latch_threshold_mm: latchThresholdMm,
      latched,
      latched_int: latched ? 1 : 0,
    });
  }

  // Compute effective vertical elevation y accounting for support surface height minus deflection
  const yCache = new Map();
  function resolveElevationY(id, visiting = new Set()) {
    if (yCache.has(id)) return yCache.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const t = byId.get(id);
    const s = out.get(id);
    if (!t || !s) return 0;
    if (s.resting_on && byId.has(s.resting_on)) {
      const sup = byId.get(s.resting_on);
      const supState = out.get(s.resting_on);
      const supY = resolveElevationY(s.resting_on, visiting);
      const supHeight = Array.isArray(sup.mechanics?.size) ? Number(sup.mechanics.size[1]) || 0.5 : 0.5;
      const y = Math.max(0, roundTo(supY + supHeight - (supState?.deflection_m || 0), 6));
      yCache.set(id, y);
      visiting.delete(id);
      return y;
    }
    const basePos = Array.isArray(t.mechanics?.pos) ? Number(t.mechanics.pos[1]) || 0 : 0;
    const y = Math.max(0, roundTo(basePos - s.deflection_m, 6));
    yCache.set(id, y);
    visiting.delete(id);
    return y;
  }

  for (const t of things) {
    const s = out.get(t.id);
    const pos = Array.isArray(t.mechanics?.pos) && t.mechanics.pos.length === 3
      ? [roundTo(t.mechanics.pos[0], 4), resolveElevationY(t.id), roundTo(t.mechanics.pos[2], 4)]
      : [0, resolveElevationY(t.id), 0];
    const size = Array.isArray(t.mechanics?.size) && t.mechanics.size.length === 3
      ? t.mechanics.size.map((v) => roundTo(Math.max(0.05, Number(v) || 0.5), 4))
      : [...DEFAULT_BODY_SIZE];
    s.pos = pos;
    s.size = size;
  }

  return out;
}

// ============================================================================
// 4. SOIL MOISTURE & LIVING FLORA / TREE EVOLUTION
// ============================================================================

// Integral of the moisture-dependent growth factor along an exponential segment.
// Split at clamp crossings; applying endpoint moisture over the entire interval
// makes a tree grow differently merely because somebody committed an action.
function moistureGrowthIntegral(m0, target, seconds) {
  const cuts = [0, seconds];
  for (const level of [0.0775, 0.71]) {
    const ratio = (level - target) / (m0 - target);
    if (ratio > 0 && ratio < 1) {
      const crossing = -SOIL_TAU_SEC * Math.log(ratio);
      if (crossing > 0 && crossing < seconds) cuts.push(crossing);
    }
  }
  cuts.sort((a, b) => a - b);
  let integral = 0;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1], b = cuts[i], dt = b - a;
    const mid = target + (m0 - target) * Math.exp(-(a + b) / (2 * SOIL_TAU_SEC));
    if (mid <= 0.0775) integral += 0.05 * dt;
    else if (mid >= 0.71) integral += 1.2 * dt;
    else integral += ((target - 0.05) * dt + (m0 - target) * SOIL_TAU_SEC
      * (Math.exp(-a / SOIL_TAU_SEC) - Math.exp(-b / SOIL_TAU_SEC))) / 0.55;
  }
  return integral;
}

function computeSoilMoisture(world, place, tSec, hydroReachState, growthStartSec = null) {
  const pConfig = place?.physics_config || {};
  const tOrigin = parseIsoSeconds(pConfig.moisture_updated_at || worldOriginIso(world), tSec);
  const m0 = typeof pConfig.soil_moisture === "number" ? clamp(pConfig.soil_moisture, 0, 1) : 0.35;
  const start = growthStartSec ?? tOrigin;
  let cursor = tOrigin, m = m0, growthSeconds = 0, lastEpoch = pConfig.soil_epoch ?? null;
  const period = WEATHER_CYCLE_EPOCHS * SYNOPTIC_EPOCH_SEC;
  let cycleStart = tOrigin, cycleM = m0, cycleGrowth = 0, cycleSeepage = null;
  let frozenSeepage = null, approximated = Boolean(pConfig.history_approximation);
  let stationaryHydrology = null;
  function riverAt(second) {
    const map = stationaryHydrology || solveHydrologyNetwork(world, second);
    // With constant controls and sources, zero derivative at EVERY node is a
    // steady solution. A dry downstream node alone is not proof: a wave may
    // still be travelling from an upstream reach.
    if ([...map.values()].every(r => Math.abs(r.inflow_m3s - r.discharge_m3s) < 1e-11)) stationaryHydrology = map;
    return map.get(place.id);
  }
  function advance(target, end) {
    const a = Math.max(cursor, start), b = Math.max(a, end);
    const atA = target + (m - target) * Math.exp(-(a - cursor) / SOIL_TAU_SEC);
    if (end > a) growthSeconds += moistureGrowthIntegral(atA, target, b - a);
    m = target + (m - target) * Math.exp(-(end - cursor) / SOIL_TAU_SEC);
    cursor = end;
  }
  while (cursor < tSec - 1e-6) {
    const epoch = Math.floor(cursor / SYNOPTIC_EPOCH_SEC);
    const end = Math.min(tSec, (epoch + 1) * SYNOPTIC_EPOCH_SEC, cycleStart + period);
    const atm = evaluateAtmosphere(world, place, (epoch + 0.5) * SYNOPTIC_EPOCH_SEC);
    // Hold river seepage through a UTC hour. Carry that one sampled driver over
    // partial-hour commits/restarts; don't replace history with endpoint depth.
    if (lastEpoch?.index !== epoch) {
      const reach = frozenSeepage === null ? riverAt(cursor) : null;
      lastEpoch = { index: epoch, seepage: frozenSeepage ?? (reach ? clamp(reach.volume_m3 / Math.max(1, reach.area_m2) * 0.22, 0, 0.45) : 0) };
    }
    cycleSeepage ??= lastEpoch.seepage;
    const rainGain = (atm.rain_mm_hr / 15) * 0.65;
    const evapLoss = atm.sunlight * 0.32 + (atm.wind_speed_ms / 15) * 0.12;
    advance(clamp(0.18 + rainGain + lastEpoch.seepage - evapLoss, 0.02, 1), end);
    if (cursor >= cycleStart + period - 1e-6) {
      // After one climate cycle soil forgets its initial condition by exp(-28).
      // Once periodic and river seepage stationary, repeat the measured cycle
      // integral in O(1); visiting daily cannot manufacture different growth.
      if (cycleStart >= start && Math.abs(m - cycleM) < 1e-9 && Math.abs(lastEpoch.seepage - cycleSeepage) < 1e-10) {
        const repeats = Math.floor((tSec - cursor) / period);
        growthSeconds += (growthSeconds - cycleGrowth) * repeats;
        cursor += repeats * period;
        if (repeats > 0) lastEpoch = { ...lastEpoch, index: Math.floor(cursor / SYNOPTIC_EPOCH_SEC) - 1 };
      } else if (cursor - tOrigin >= 2 * period && frozenSeepage === null && tSec - cursor > period) {
        // Very slow/transient river forcing has not settled after 28 days.
        // Bound cost by freezing its remaining ecological seepage at the
        // projected final value. Hydrology itself remains fully evolved.
        // This approximation is explicitly returned and persisted as metadata.
        frozenSeepage = hydroReachState ? clamp(hydroReachState.volume_m3 / Math.max(1, hydroReachState.area_m2) * 0.22, 0, 0.45) : 0;
        lastEpoch = null;
        approximated = true;
      }
      cycleStart = cursor; cycleM = m; cycleGrowth = growthSeconds; cycleSeepage = null;
    }
  }
  const rawM = roundTo(clamp(m, 0, 1), 9);
  return { soil_moisture: roundTo(rawM, 4), soil_moisture_raw: rawM,
    moisture_pct: Math.round(rawM * 100), atm: evaluateAtmosphere(world, place, tSec),
    growth_days: growthSeconds / 86400, soil_epoch: lastEpoch, history_approximation: approximated };
}

function projectFloraState(world, place, thing, tSec, soilMoisture, atm, growthDays) {
  const m = thing.mechanics;
  const b0 = Math.max(0.05, Number(m.biomass_kg) || 0.25);
  const bMax = Math.max(1.0, Number(m.max_biomass_kg) || 120.0);
  const baseGrowthRatePerDay = Math.max(0.01, Number(m.growth_rate_day) || 0.18);

  const effectiveGrowth = baseGrowthRatePerDay * growthDays;

  // Exact logistic saturation solution: B(t) = B_max / (1 + ((B_max / B_0) - 1) * exp(-r * dt))
  const ratio0 = Math.max(0, bMax / b0 - 1);
  const biomassRawKg = roundTo(bMax / (1 + ratio0 * Math.exp(-effectiveGrowth)), 9);
  const biomassKg = roundTo(biomassRawKg, 4);
  const biomassG = Math.round(biomassKg * 1000);

  const maturity = clamp(biomassKg / bMax, 0, 1);
  const canopySpread = roundTo(clamp(Math.sqrt(maturity) * (soilMoisture < 0.08 ? 0.5 : 1.0), 0.05, 1.0), 4);
  const canopyPct = Math.round(canopySpread * 100);

  // Wind sway response: depends on wind speed, canopy sail area, and trunk stiffness (which grows with biomass)
  const trunkRigidity = 1.0 + Math.pow(biomassKg, 0.35);
  const swayDeg = roundTo(clamp((atm.wind_speed_ms ** 1.4) * (0.6 + canopySpread) / trunkRigidity, 0, 45), 3);
  const swayMdeg = Math.round(swayDeg * 1000);
  const windStressPct = Math.round(clamp((swayDeg / 35) * 100, 0, 100));

  let stage = "seedling";
  if (soilMoisture < 0.08) stage = "wilting";
  else if (biomassKg >= bMax * 0.65) stage = "mature";
  else if (biomassKg >= 2.0) stage = "sapling";

  return {
    moisture_pct: Math.round(soilMoisture * 100),
    biomass_kg: biomassKg,
    biomass_raw_kg: biomassRawKg,
    biomass_g: biomassG,
    canopy_spread: canopySpread,
    canopy_pct: canopyPct,
    sway_deg: swayDeg,
    sway_mdeg: swayMdeg,
    wind_stress_pct: windStressPct,
    stage,
  };
}

// ============================================================================
// 5. PUBLIC READ-TIME PROJECTIONS (PURE — NEVER MUTATE WORLD)
// ============================================================================

export function projectPlacePhysics(world, placeId, nowIso = new Date().toISOString()) {
  const p = livePlace(world, placeId);
  if (!p) return null;

  const tSec = parseIsoSeconds(nowIso, Date.now() / 1000);
  const hydroMap = solveHydrologyNetwork(world, tSec);
  const reachState = hydroMap.get(placeId) || null;
  const { soil_moisture, moisture_pct, atm, history_approximation } = computeSoilMoisture(world, p, tSec, reachState);

  const bounds = Array.isArray(p.physics_config?.bounds) && p.physics_config.bounds.length === 3
    ? p.physics_config.bounds.map(Number)
    : [...DEFAULT_ROOM_BOUNDS];

  const environment = {
    phase: atm.phase,
    exposure: atm.exposure,
    sunlight: atm.sunlight,
    sunlight_pct: atm.sunlight_pct,
    temperature_c: atm.temperature_c,
    temperature_c_int: atm.temperature_c_int,
    wind_speed_ms: atm.wind_speed_ms,
    wind_speed_cms: atm.wind_speed_cms,
    wind_direction_deg: atm.wind_direction_deg,
    rain_mm_hr: atm.rain_mm_hr,
    rain_mm_hr_int: atm.rain_mm_hr_int,
    soil_moisture,
    moisture_pct,
    history_approximation,
  };

  const sensors = {
    sunlight_pct: environment.sunlight_pct,
    wind_speed_cms: environment.wind_speed_cms,
    wind_direction_deg: environment.wind_direction_deg,
    rain_mm_hr_int: environment.rain_mm_hr_int,
    temperature_c_int: environment.temperature_c_int,
    moisture_pct: environment.moisture_pct,
  };

  let hydrology = null;
  if (reachState) {
    const depthM = roundTo(reachState.volume_m3 / reachState.area_m2, 6);
    const depthMm = Math.round(depthM * 1000);
    const volM3 = roundTo(reachState.volume_m3, 6);
    const volL = Math.round(volM3 * 1000);
    const inflowM3s = roundTo(reachState.inflow_m3s, 6);
    const inflowLps = Math.round(inflowM3s * 1000);
    const dischargeM3s = roundTo(reachState.discharge_m3s, 6);
    const dischargeLps = Math.round(dischargeM3s * 1000);
    const totalOutflowL = Math.round(reachState.total_outflow_m3 * 1000);

    let bedState = "dry";
    if (depthMm >= 1500) bedState = "flooded";
    else if (depthMm >= 150) bedState = "flowing";
    else if (depthMm > 5) bedState = "trickle";

    const channels = Array.isArray(world?.hydrology?.channels) ? world.hydrology.channels : [];
    const upstreamPlaces = channels.filter((c) => c.to === placeId && livePlace(world, c.from)).map((c) => c.from);
    const downstreamPlaces = channels.filter((c) => c.from === placeId && livePlace(world, c.to)).map((c) => c.to);

    hydrology = {
      enabled: true,
      elevation_m: reachState.elevation_m,
      area_m2: reachState.area_m2,
      max_depth_m: reachState.max_depth_m,
      crest_height_m: reachState.crest_height_m,
      aperture: roundTo(reachState.aperture, 4),
      aperture_pct: Math.round(reachState.aperture * 100),
      water_depth_m: depthM,
      water_depth_mm: depthMm,
      volume_m3: volM3,
      water_volume_m3: volM3,
      water_volume_l: volL,
      inflow_m3s: inflowM3s,
      inflow_lps: inflowLps,
      discharge_m3s: dischargeM3s,
      discharge_lps: dischargeLps,
      total_inflow_m3: roundTo(reachState.total_inflow_m3, 6),
      total_outflow_m3: roundTo(reachState.total_outflow_m3, 6),
      total_outflow_l: totalOutflowL,
      bed_state: bedState,
      upstream_places: upstreamPlaces,
      downstream_places: downstreamPlaces,
    };

    sensors.water_depth_mm = depthMm;
    sensors.water_volume_l = volL;
    sensors.inflow_lps = inflowLps;
    sensors.discharge_lps = dischargeLps;
    sensors.total_outflow_l = totalOutflowL;
    sensors.bed_state = bedState;
  }

  return {
    schema: PHYSICS_SCHEMA,
    timestamp: new Date(tSec * 1000).toISOString(),
    bounds_m: bounds,
    environment,
    hydrology,
    sensors,
  };
}

export function projectThingPhysics(world, thingId, nowIso = new Date().toISOString()) {
  const thing = liveThing(world, thingId);
  if (!thing) return null;

  const hasMechanics = Boolean(thing.mechanics && typeof thing.mechanics === "object");
  const hasOpenField = Boolean(thing.fields && typeof thing.fields === "object" && Object.hasOwn(thing.fields, "open"));
  if (!hasMechanics && !hasOpenField) {
    return null; // Plain untyped thing — never backfill physical bag
  }

  const m = thing.mechanics || {};
  const p = livePlace(world, thing.placeId);
  if (!p) return null;

  const tSec = parseIsoSeconds(nowIso, Date.now() / 1000);
  const supportMap = computeRoomSupportState(world, thing.placeId);
  const sup = supportMap.get(thing.id) || {
    mass_kg: Math.max(0.001, Number(m.mass_kg) || 1),
    mass_g: Math.round(Math.max(0.001, Number(m.mass_kg) || 1) * 1000),
    resting_on: null,
    load_kg: 0,
    load_g: 0,
    stiffness_nm: 0,
    deflection_m: 0,
    deflection_mm: 0,
    latch_threshold_mm: null,
    latched: false,
    latched_int: 0,
    pos: [0, 0, 0],
    size: [...DEFAULT_BODY_SIZE],
  };

  // Acoustic ring exponential decay over elapsed time since last strike
  const baseHz = Math.max(0, Number(m.natural_hz) || 0);
  const strikeAmp0 = clamp(Number(m.ring_amp_0) || 0, 0, 1);
  const strikeSec = typeof m.last_struck_at === "string" ? parseIsoSeconds(m.last_struck_at, tSec) : null;
  const ringTauSec = Math.max(1, Number(m.ring_tau_s) || 30);
  let ringAmplitude = 0;
  if (strikeSec !== null && strikeAmp0 > 0 && tSec >= strikeSec) {
    const decayed = strikeAmp0 * Math.exp(-(tSec - strikeSec) / ringTauSec);
    ringAmplitude = decayed >= 0.005 ? roundTo(decayed, 4) : 0;
  }
  const activeRingHz = ringAmplitude > 0 ? baseHz : 0;
  const ringPct = Math.round(ringAmplitude * 100);

  // Sluice / weir aperture (including support-latch coupling and Grok's fields.open interop)
  let aperture = typeof m.aperture === "number" ? clamp(m.aperture, 0, 1) : null;
  if (typeof m.coupled_support_id === "string") {
    const coupledSupport = supportMap.get(m.coupled_support_id);
    aperture = coupledSupport?.latched ? 1.0 : 0.0;
  }
  if (m.follow_field !== false && thing.fields && typeof thing.fields === "object" && Object.hasOwn(thing.fields, "open")) {
    const openVal = Number(thing.fields.open);
    if (Number.isFinite(openVal)) {
      aperture = openVal <= 0 ? 0.0 : openVal === 1 ? 1.0 : clamp(openVal / 100, 0, 1);
    }
  }
  const aperturePct = aperture !== null ? Math.round(aperture * 100) : null;
  const openInt = aperturePct !== null ? (aperturePct > 0 ? 1 : 0) : null;
  const crestHeightM = typeof m.crest_height_m === "number" ? Math.max(0, m.crest_height_m) : null;
  const crestHeightMm = crestHeightM !== null ? Math.round(crestHeightM * 1000) : null;

  const restitution = clamp(typeof m.restitution === "number" ? m.restitution : 0.6, 0, 1);
  const lastReboundMs = roundTo(Math.max(0, Number(m.last_rebound_ms) || 0), 4);
  const lastReboundMms = Math.round(lastReboundMs * 1000);
  const workJ = roundTo(Math.max(0, Number(m.work_j) || 0), 4);
  const workJInt = Math.round(workJ);

  const sensors = {
    mass_g: sup.mass_g,
    load_g: sup.load_g,
    deflection_mm: sup.deflection_mm,
    latched_int: sup.latched_int,
    last_rebound_mms: lastReboundMms,
    work_j_int: workJInt,
    ring_hz_int: Math.round(activeRingHz),
    ring_pct: ringPct,
  };
  if (sup.latch_threshold_mm !== null) sensors.latch_threshold_mm = sup.latch_threshold_mm;
  if (aperturePct !== null) {
    sensors.aperture_pct = aperturePct;
    sensors.open = openInt;
  }
  if (crestHeightMm !== null) {
    sensors.crest_height_mm = crestHeightMm;
  }

  let flora = null;
  if (m.role === "flora") {
    const hydroMap = solveHydrologyNetwork(world, tSec);
    const reachState = hydroMap.get(thing.placeId) || null;
    const start = parseIsoSeconds(m.updated_at || thing.createdAt || worldOriginIso(world), tSec);
    const { soil_moisture_raw, atm, growth_days, history_approximation } = computeSoilMoisture(world, p, tSec, reachState, start);
    const { biomass_raw_kg: _raw, ...publicFlora } = projectFloraState(world, p, thing, tSec, soil_moisture_raw, atm, growth_days);
    flora = { ...publicFlora, history_approximation };
    sensors.moisture_pct = flora.moisture_pct;
    sensors.biomass_g = flora.biomass_g;
    sensors.canopy_pct = flora.canopy_pct;
    sensors.sway_mdeg = flora.sway_mdeg;
    sensors.wind_stress_pct = flora.wind_stress_pct;
    sensors.stage = flora.stage;
  }

  return {
    schema: PHYSICS_SCHEMA,
    role: m.role || "body",
    anchored: Boolean(m.anchored),
    pos: sup.pos,
    size: sup.size,
    mass_kg: sup.mass_kg,
    mass_g: sup.mass_g,
    resting_on: sup.resting_on,
    load_kg: sup.load_kg,
    load_g: sup.load_g,
    stiffness_nm: sup.stiffness_nm,
    deflection_m: sup.deflection_m,
    deflection_mm: sup.deflection_mm,
    latch_threshold_mm: sup.latch_threshold_mm,
    latched: sup.latched,
    latched_int: sup.latched_int,
    ...(aperture !== null ? { aperture: roundTo(aperture, 4), aperture_pct: aperturePct, open: openInt } : {}),
    ...(crestHeightM !== null ? { crest_height_m: crestHeightM, crest_height_mm: crestHeightMm } : {}),
    ...(typeof m.coupled_support_id === "string" ? { coupled_support_id: m.coupled_support_id } : {}),
    restitution,
    last_rebound_ms: lastReboundMs,
    last_rebound_mms: lastReboundMms,
    work_j: workJ,
    work_j_int: workJInt,
    natural_hz: baseHz,
    ring_hz: activeRingHz,
    ring_hz_int: Math.round(activeRingHz),
    ring_amplitude: ringAmplitude,
    ring_pct: ringPct,
    ...(flora ? { flora } : {}),
    sensors,
  };
}

// ============================================================================
// 6. PERMISSION-SAFE SENSOR READER FOR PROGRAMMABLE GUARDS (when / require)
// ============================================================================

export function readPhysicalSensor(world, {
  callerHandle,
  actorHandle,
  placeId,
  actorStandingId,
  targetKind,
  targetId,
  sensor,
  nowIso = new Date().toISOString(),
  canObserve = null,
  may = null,
} = {}) {
  const effectiveHandle = callerHandle ?? actorHandle;
  const effectivePlaceId = placeId ?? (targetKind === "place" && targetId ? targetId : actorStandingId);
  if (typeof effectiveHandle !== "string" || !effectiveHandle) {
    return fail("auth_required", "callerHandle is required to read a physical sensor.", 401);
  }
  if (typeof effectivePlaceId !== "string" || !effectivePlaceId) {
    return fail("bad_input", "placeId is required.", 400);
  }
  if (typeof sensor !== "string" || !sensor) {
    return fail("bad_input", "sensor name must be a non-empty string.", 400);
  }

  const land = livePlace(world, effectivePlaceId);
  if (!land) return fail("not_found", "No such place.", 404);

  const callerRow = Array.isArray(world?.residents) ? world.residents.find((r) => r.handle === effectiveHandle) : null;
  const standingHere = Boolean((callerRow && callerRow.standingId === land.id) || (actorStandingId && actorStandingId === land.id));
  const permitted = standingHere
    || (typeof canObserve === "function" && canObserve(land.id))
    || (typeof may === "function" && may(land, "observe", effectiveHandle));
  if (!permitted) {
    return fail("forbidden", "You cannot observe sensors in that place.", 403);
  }

  if (targetKind === "place") {
    if (targetId && targetId !== effectivePlaceId) {
      return fail("forbidden", "Place sensor target must be the current observable place.", 403);
    }
    if (!ALLOWED_PLACE_SENSORS.has(sensor)) {
      return fail("sensor_unavailable", `Unknown or disallowed place sensor: ${sensor}.`, 400);
    }
    const projected = projectPlacePhysics(world, effectivePlaceId, nowIso);
    if (!projected || !projected.sensors || !Object.hasOwn(projected.sensors, sensor)) {
      return fail("sensor_unavailable", `Sensor ${sensor} is not active on place ${effectivePlaceId}.`, 409);
    }
    return { ok: true, targetKind: "place", targetId: effectivePlaceId, sensor, value: projected.sensors[sensor] };
  }

  if (targetKind === "thing") {
    if (typeof targetId !== "string" || !targetId) {
      return fail("bad_input", "targetId is required for a thing sensor.", 400);
    }
    if (!ALLOWED_THING_SENSORS.has(sensor)) {
      return fail("sensor_unavailable", `Unknown or disallowed thing sensor: ${sensor}.`, 400);
    }
    const thing = liveThing(world, targetId);
    if (!thing || thing.placeId !== effectivePlaceId) {
      return fail("not_found", "Target thing is absent or destroyed in this place.", 404);
    }
    const projected = projectThingPhysics(world, targetId, nowIso);
    if (!projected || !projected.sensors || !Object.hasOwn(projected.sensors, sensor)) {
      return fail("sensor_unavailable", `Thing ${targetId} has no physical sensor ${sensor}.`, 409);
    }
    return { ok: true, targetKind: "thing", targetId, sensor, value: projected.sensors[sensor] };
  }

  return fail("bad_input", "targetKind must be thing or place.", 400);
}

// ============================================================================
// 7. CHECKED MUTATIONS & ACTUATORS (COMMITS EVOLVED ANCHORS ATOMICALLY)
// ============================================================================

/**
 * Advances and persists all evolved hydrological, soil-moisture, and flora anchors up to `nowIso`
 * inside the active mutation transaction before applying a physical change.
 */
export function commitWorldPhysicsAt(world, nowIso) {
  const tSec = parseIsoSeconds(nowIso, Date.now() / 1000);
  const iso = new Date(tSec * 1000).toISOString();

  const hydroMap = solveHydrologyNetwork(world, tSec);
  // Project every soil/flora anchor against the OLD world before replacing any
  // anchors; sampling after the hydro commit would reuse future water levels.
  const updates = [];
  for (const p of world.places || []) {
    if (p.destroyedAt || !p.physics_config) continue;
    const reach = hydroMap.get(p.id) || null;
    const soil = computeSoilMoisture(world, p, tSec, reach);
    const flora = liveThingsAt(world, p.id).filter(t => t.mechanics?.role === "flora").map(thing => {
      const start = parseIsoSeconds(thing.mechanics.updated_at || thing.createdAt || worldOriginIso(world), tSec);
      const growth = computeSoilMoisture(world, p, tSec, reach, start);
      return [thing, projectFloraState(world, p, thing, tSec, soil.soil_moisture_raw, soil.atm, growth.growth_days)];
    });
    updates.push([p, soil, flora]);
  }
  for (const [pid, state] of hydroMap) {
    const r = world.hydrology.reaches[pid];
    r.volume_m3 = roundTo(state.volume_m3, 9);
    r.total_inflow_m3 = roundTo(state.total_inflow_m3, 9);
    r.total_outflow_m3 = roundTo(state.total_outflow_m3, 9);
    r.aperture = roundTo(state.aperture, 4);
    r.crest_height_m = roundTo(state.crest_height_m, 4);
    r.updated_at = iso;
  }
  for (const [p, soil, flora] of updates) {
    p.physics_config.soil_moisture = soil.soil_moisture_raw;
    p.physics_config.moisture_updated_at = iso;
    if (soil.soil_epoch) p.physics_config.soil_epoch = soil.soil_epoch;
    if (soil.history_approximation) p.physics_config.history_approximation = true;
    for (const [thing, projected] of flora) {
      thing.mechanics.biomass_kg = projected.biomass_raw_kg;
      thing.mechanics.updated_at = iso;
    }
  }
}

function mayCouplePlace(placeObj, actorHandle, may) {
  if (!placeObj || placeObj.destroyedAt) return false;
  if (Object.hasOwn(placeObj.permissions || {}, "couple_environment")) {
    const mode = placeObj.permissions.couple_environment;
    return mode === "public" || (mode === "owner_only" && placeObj.ownerHandle === actorHandle);
  }
  // Enclaves are strictly private unless their owner explicitly opens couple_environment
  if (placeObj.id.startsWith("enclave_")) {
    return placeObj.ownerHandle === actorHandle;
  }
  if (!placeObj.ownerHandle && ["world", "arrival"].includes(placeObj.id)) {
    return true;
  }
  return may(placeObj, "set_local_law", actorHandle);
}

export function actuatePhysics(world, {
  actorRow,
  input,
  nowIso = new Date().toISOString(),
  may,
  emit,
  adj,
} = {}) {
  if (!actorRow) return fail("auth_required", "Authenticated resident required.", 401);
  const action = String(input.action || "");
  const here = livePlace(world, actorRow.standingId);
  if (!here) return fail("not_found", "No such place.", 404);

  if (action === "configure_physics") {
    return handleConfigurePhysics(world, { actorRow, here, input, nowIso, may, emit });
  }
  if (action === "couple_channel") {
    return handleCoupleChannel(world, { actorRow, here, input, nowIso, may, emit, adj });
  }
  if (action === "uncouple_channel") {
    const from = livePlace(world, String(input.fromPlaceId || here.id));
    const to = livePlace(world, String(input.toPlaceId || input.targetId || ""));
    if (!from || !to || from.id === to.id) return fail("not_found", "Both channel endpoints must exist.", 404);
    if (![from.id, to.id].includes(here.id) || here.ownerHandle !== actorRow.handle) {
      return fail("forbidden", "Stand on your own endpoint to sever a channel. The other owner's permission is unnecessary.", 403);
    }
    const channels = world.hydrology?.channels || [];
    if (!channels.some(c => c.from === from.id && c.to === to.id)) return fail("not_found", "No such channel.", 404);
    commitWorldPhysicsAt(world, nowIso);
    world.hydrology.channels = channels.filter(c => c.from !== from.id || c.to !== to.id);
    return { ok: true, event: emit("uncouple_channel", `${actorRow.handle} severed a water channel at ${here.name}.`, here.id, actorRow.handle),
      channel: { from: from.id, to: to.id }, upstream_physical: projectPlacePhysics(world, from.id, nowIso),
      downstream_physical: projectPlacePhysics(world, to.id, nowIso) };
  }
  if (action === "actuate") {
    return handleActuate(world, { actorRow, here, input, nowIso, may, emit });
  }
  return fail("bad_input", "Unknown physics action.", 400);
}

function handleConfigurePhysics(world, { actorRow, here, input, nowIso, may, emit }) {
  const targetKind = String(input.targetKind || "");
  const targetId = String(input.targetId || here.id);

  if (targetKind === "place") {
    if (targetId !== here.id) {
      return fail("forbidden", "Stand in the target place to configure its physical environment.", 403);
    }
    const canConfigurePlace = (!here.ownerHandle && ["world", "arrival"].includes(here.id))
      || may(here, "set_local_law", actorRow.handle);
    if (!canConfigurePlace) {
      return fail("forbidden", "Only the parcel owner may configure place physics here.", 403);
    }

    if (input.exposure !== undefined && !["open", "canopy", "sheltered"].includes(input.exposure)) {
      return fail("bad_input", "exposure must be open, canopy, or sheltered.", 400);
    }
    if (input.bounds !== undefined) {
      if (!Array.isArray(input.bounds) || input.bounds.length !== 3 || input.bounds.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 2 || n > 500)) {
        return fail("bad_input", "bounds must be [width, height, depth] in meters (2..500).", 400);
      }
    }

    let parsedHydro = null;
    if (input.hydrology && typeof input.hydrology === "object" && !Array.isArray(input.hydrology)) {
      const h = input.hydrology;
      const area = h.area_m2 !== undefined ? Number(h.area_m2) : 50;
      const maxDepth = h.max_depth_m !== undefined ? Number(h.max_depth_m) : 5;
      const elevation = h.elevation_m !== undefined ? Number(h.elevation_m) : 10;
      const initialDepth = h.water_depth_m !== undefined ? Number(h.water_depth_m) : 0;
      const sourceInflow = h.source_inflow_m3s !== undefined ? Number(h.source_inflow_m3s) : 0;
      const crestHeight = h.crest_height_m !== undefined ? Number(h.crest_height_m) : 0;
      const aperture = h.aperture !== undefined ? Number(h.aperture) : 1;
      const conductance = h.conductance_s !== undefined ? Number(h.conductance_s) : 0.01;

      if (
        !Number.isFinite(area) || area < 1 || area > 100000 ||
        !Number.isFinite(maxDepth) || maxDepth < 0.5 || maxDepth > 100 ||
        !Number.isFinite(elevation) || elevation < -100 || elevation > 5000 ||
        !Number.isFinite(initialDepth) || initialDepth < 0 || initialDepth > maxDepth ||
        !Number.isFinite(sourceInflow) || sourceInflow < 0 || sourceInflow > 1000 ||
        !Number.isFinite(crestHeight) || crestHeight < 0 || crestHeight > maxDepth ||
        !Number.isFinite(aperture) || aperture < 0 || aperture > 1 ||
        !Number.isFinite(conductance) || conductance < 0.0001 || conductance > 1
      ) {
        return fail("bad_input", "Invalid hydrology parameters.", 400);
      }
      parsedHydro = { area, maxDepth, elevation, initialDepth, sourceInflow, crestHeight, aperture, conductance };
    }

    commitWorldPhysicsAt(world, nowIso);
    here.physics_config ??= { soil_moisture: 0.35, moisture_updated_at: nowIso };
    if (input.exposure !== undefined) {
      here.physics_config.exposure = input.exposure;
    }
    if (input.bounds !== undefined) {
      here.physics_config.bounds = input.bounds.map((n) => roundTo(n, 3));
    }
    if (typeof input.soil_moisture === "number" && Number.isFinite(input.soil_moisture)) {
      here.physics_config.soil_moisture = clamp(input.soil_moisture, 0, 1);
      here.physics_config.moisture_updated_at = nowIso;
    }
    if (parsedHydro) {
      world.hydrology ??= { reaches: {}, channels: [] };
      const existing = world.hydrology.reaches[here.id];
      world.hydrology.reaches[here.id] = {
        elevation_m: roundTo(parsedHydro.elevation, 4),
        area_m2: roundTo(parsedHydro.area, 4),
        max_depth_m: roundTo(parsedHydro.maxDepth, 4),
        volume_m3: roundTo(parsedHydro.area * parsedHydro.initialDepth, 9),
        source_inflow_m3s: roundTo(parsedHydro.sourceInflow, 6),
        crest_height_m: roundTo(parsedHydro.crestHeight, 4),
        aperture: roundTo(parsedHydro.aperture, 4),
        conductance_s: roundTo(parsedHydro.conductance, 6),
        total_inflow_m3: existing?.total_inflow_m3 || 0,
        total_outflow_m3: existing?.total_outflow_m3 || 0,
        updated_at: nowIso,
      };
    }

    const event = emit("configure_physics", `${actorRow.handle} configured physical environment in ${here.name}.`, here.id, actorRow.handle);
    return { ok: true, event, physical: projectPlacePhysics(world, here.id, nowIso) };
  }

  if (targetKind === "thing") {
    const thing = liveThing(world, targetId);
    if (!thing || thing.placeId !== here.id) {
      return fail("not_found", "No such thing in this place.", 404);
    }
    if (thing.ownerHandle !== actorRow.handle && !may(here, "set_local_law", actorRow.handle)) {
      return fail("forbidden", "Only the thing's owner or parcel owner may configure its mechanics.", 403);
    }
    const spec = input.mechanics;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      return fail("bad_input", "configure_physics on a thing requires a mechanics object.", 400);
    }

    const role = spec.role || thing.mechanics?.role || "body";
    if (!["body", "support", "sluice", "weir", "anvil", "flora"].includes(role)) {
      return fail("bad_input", "mechanics.role must be body, support, sluice, weir, anvil, or flora.", 400);
    }

    const next = { ...(thing.mechanics || {}), role, updated_at: nowIso };
    if (spec.mass_kg !== undefined) {
      const m = Number(spec.mass_kg);
      if (!Number.isFinite(m) || m <= 0 || m > 100000) return fail("bad_input", "mass_kg must be in (0, 100000].", 400);
      next.mass_kg = roundTo(m, 4);
    } else if (next.mass_kg === undefined) {
      next.mass_kg = 1.0;
    }

    if (spec.size !== undefined) {
      if (!Array.isArray(spec.size) || spec.size.length !== 3 || spec.size.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0.05 || n > 50)) {
        return fail("bad_input", "size must be [dx, dy, dz] in meters (0.05..50).", 400);
      }
      next.size = spec.size.map((n) => roundTo(n, 4));
    } else if (!Array.isArray(next.size)) {
      next.size = [...DEFAULT_BODY_SIZE];
    }

    if (spec.pos !== undefined) {
      if (!Array.isArray(spec.pos) || spec.pos.length !== 3 || spec.pos.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        return fail("bad_input", "pos must be [x, y, z] in meters.", 400);
      }
      const roomBounds = Array.isArray(here.physics_config?.bounds) ? here.physics_config.bounds : DEFAULT_ROOM_BOUNDS;
      const [px, py, pz] = spec.pos;
      const [sx, sy, sz] = next.size;
      if (
        px - sx / 2 < -roomBounds[0] / 2 || px + sx / 2 > roomBounds[0] / 2 ||
        py < 0 || py + sy > roomBounds[1] ||
        pz - sz / 2 < -roomBounds[2] / 2 || pz + sz / 2 > roomBounds[2] / 2
      ) {
        return fail("out_of_bounds", "Body position exceeds room boundaries.", 400);
      }
      // Check AABB collision against other configured bodies in the room
      const candidateBox = getBodyBox({ mechanics: { pos: [px, py, pz], size: next.size } });
      for (const other of liveThingsAt(world, here.id)) {
        if (other.id === thing.id || !other.mechanics) continue;
        const otherBox = getBodyBox(other);
        if (boxesOverlap3D(candidateBox, otherBox)) {
          return fail("collision", `Placement collides with ${other.name} (${other.id}).`, 409, { collidingThingId: other.id });
        }
      }
      next.pos = [roundTo(px, 4), roundTo(py, 4), roundTo(pz, 4)];
    } else if (!Array.isArray(next.pos)) {
      next.pos = [0, 0, 0];
    }

    if (spec.anchored !== undefined) next.anchored = Boolean(spec.anchored);
    if (spec.stiffness_nm !== undefined) {
      const k = Number(spec.stiffness_nm);
      if (!Number.isFinite(k) || k < 0 || k > 1e8) return fail("bad_input", "stiffness_nm must be in [0, 1e8].", 400);
      next.stiffness_nm = roundTo(k, 2);
    }
    if (spec.latch_threshold_mm !== undefined) {
      const lt = Number(spec.latch_threshold_mm);
      if (!Number.isFinite(lt) || lt < 1 || lt > 5000) return fail("bad_input", "latch_threshold_mm must be in [1, 5000].", 400);
      next.latch_threshold_mm = Math.round(lt);
    }
    if (spec.restitution !== undefined) {
      const e = Number(spec.restitution);
      if (!Number.isFinite(e) || e < 0 || e > 1) return fail("bad_input", "restitution must be in [0, 1].", 400);
      next.restitution = roundTo(e, 4);
    }
    if (spec.natural_hz !== undefined) {
      const hz = Number(spec.natural_hz);
      if (!Number.isFinite(hz) || hz < 0 || hz > 20000) return fail("bad_input", "natural_hz must be in [0, 20000].", 400);
      next.natural_hz = roundTo(hz, 2);
    }
    if (spec.ring_tau_s !== undefined) {
      const tau = Number(spec.ring_tau_s);
      if (!Number.isFinite(tau) || tau < 1 || tau > 3600) return fail("bad_input", "ring_tau_s must be in [1, 3600].", 400);
      next.ring_tau_s = roundTo(tau, 2);
    }
    if (spec.aperture !== undefined) {
      const ap = Number(spec.aperture);
      if (!Number.isFinite(ap) || ap < 0 || ap > 1) return fail("bad_input", "aperture must be in [0, 1].", 400);
      next.aperture = roundTo(ap, 4);
    }
    if (spec.crest_height_m !== undefined) {
      const ch = Number(spec.crest_height_m);
      if (!Number.isFinite(ch) || ch < 0 || ch > 100) return fail("bad_input", "crest_height_m must be in [0, 100].", 400);
      next.crest_height_m = roundTo(ch, 4);
    }
    if (spec.coupled_support_id !== undefined) {
      if (spec.coupled_support_id !== null && typeof spec.coupled_support_id !== "string") {
        return fail("bad_input", "coupled_support_id must be a thing id or null.", 400);
      }
      next.coupled_support_id = spec.coupled_support_id;
    }
    if (spec.biomass_kg !== undefined) {
      const b = Number(spec.biomass_kg);
      if (!Number.isFinite(b) || b < 0.05 || b > 10000) return fail("bad_input", "biomass_kg must be in [0.05, 10000].", 400);
      next.biomass_kg = roundTo(b, 4);
    }
    if (spec.max_biomass_kg !== undefined) {
      const bm = Number(spec.max_biomass_kg);
      if (!Number.isFinite(bm) || bm < 1 || bm > 50000) return fail("bad_input", "max_biomass_kg must be in [1, 50000].", 400);
      next.max_biomass_kg = roundTo(bm, 4);
    }

    commitWorldPhysicsAt(world, nowIso);
    if (spec.biomass_kg === undefined && thing.mechanics?.role === "flora") next.biomass_kg = thing.mechanics.biomass_kg;
    thing.mechanics = next;
    commitWorldPhysicsAt(world, nowIso);
    const event = emit("configure_physics", `${actorRow.handle} configured mechanics on ${thing.name}.`, here.id, actorRow.handle);
    return { ok: true, event, thing_physical: projectThingPhysics(world, thing.id, nowIso) };
  }

  return fail("bad_input", "configure_physics requires targetKind (place or thing).", 400);
}

function handleCoupleChannel(world, { actorRow, here, input, nowIso, may, emit, adj }) {
  const fromId = String(input.fromPlaceId || here.id);
  const toId = String(input.toPlaceId || input.targetId || "");
  if (!fromId || !toId || fromId === toId) {
    return fail("bad_input", "couple_channel requires distinct fromPlaceId and toPlaceId.", 400);
  }
  if (actorRow.standingId !== fromId && actorRow.standingId !== toId) {
    return fail("forbidden", "Stand in either the upstream or downstream place to couple a channel.", 403);
  }
  const fromPlace = livePlace(world, fromId);
  const toPlace = livePlace(world, toId);
  if (!fromPlace || !toPlace) {
    return fail("not_found", "Both upstream and downstream places must exist.", 404);
  }
  if (typeof adj === "function" && !adj(fromId, toId)) {
    return fail("forbidden", "Hydrological channels may only link adjacent places (parent, child, or portal).", 403);
  }
  if (!mayCouplePlace(fromPlace, actorRow.handle, may) || !mayCouplePlace(toPlace, actorRow.handle, may)) {
    return fail("forbidden", "Environmental coupling requires authority or public couple_environment permission on both places.", 403);
  }

  const reachFrom = world.hydrology?.reaches?.[fromId];
  const reachTo = world.hydrology?.reaches?.[toId];
  if (!reachFrom || !reachTo) {
    return fail("conflict", "Both places must have configured hydrology reaches before coupling.", 409);
  }
  if (reachFrom.elevation_m < reachTo.elevation_m) {
    return fail("conflict", "Upstream reach elevation must be greater than or equal to downstream reach elevation.", 409);
  }

  // Reject cycles in the hydrological graph
  const existingChannels = world.hydrology.channels || [];
  const component = new Set(), pending = [fromId, toId];
  while (pending.length) {
    const id = pending.pop();
    if (component.has(id)) continue;
    component.add(id);
    for (const ch of existingChannels) {
      if (ch.from === id) pending.push(ch.to);
      if (ch.to === id) pending.push(ch.from);
    }
  }
  if (component.size > MAX_COUPLED_REACHES) return fail("capacity", `A coupled component may contain at most ${MAX_COUPLED_REACHES} reaches.`, 409);
  const visited = new Set([fromId]);
  const stack = [toId];
  while (stack.length > 0) {
    const curr = stack.pop();
    if (curr === fromId) {
      return fail("conflict", "Hydrological channels must form a directed acyclic graph.", 409);
    }
    if (visited.has(curr)) continue;
    visited.add(curr);
    for (const ch of existingChannels) {
      if (ch.from === curr) stack.push(ch.to);
    }
  }

  commitWorldPhysicsAt(world, nowIso);
  world.hydrology ??= { reaches: {}, channels: [] };
  const channels = world.hydrology.channels;
  if (!channels.some((c) => c.from === fromId && c.to === toId)) {
    channels.push({ from: fromId, to: toId, createdAt: nowIso, authorHandle: actorRow.handle });
  }

  const event = emit("couple_channel", `${actorRow.handle} coupled water channel from ${fromPlace.name} to ${toPlace.name}.`, here.id, actorRow.handle);
  return {
    ok: true,
    event,
    channel: { from: fromId, to: toId },
    upstream_physical: projectPlacePhysics(world, fromId, nowIso),
    downstream_physical: projectPlacePhysics(world, toId, nowIso),
  };
}

function handleActuate(world, { actorRow, here, input, nowIso, may, emit }) {
  if (!may(here, "use_thing", actorRow.handle)) {
    return fail("forbidden", "This place does not allow using or actuating things.", 403);
  }
  const targetId = String(input.targetId || "");
  const op = String(input.op ?? input.name ?? "").trim();
  const rawBody = input.value !== undefined ? String(input.value) : String(input.body ?? "").trim();

  const target = liveThing(world, targetId);
  if (!target || target.placeId !== here.id) {
    return fail("not_found", "No such thing here.", 404);
  }

  if (op === "set_sluice") {
    const num = Number(rawBody);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      return fail("bad_input", "set_sluice value must be 0..1 (ratio) or 0..100 (percent).", 400);
    }
    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };
    const aperture = num > 1 ? clamp(num / 100, 0, 1) : clamp(num, 0, 1);
    target.mechanics.role = target.mechanics.role === "body" ? "sluice" : target.mechanics.role;
    target.mechanics.aperture = roundTo(aperture, 4);
    target.mechanics.updated_at = nowIso;
    if (world.hydrology?.reaches?.[here.id]) {
      world.hydrology.reaches[here.id].aperture = target.mechanics.aperture;
      world.hydrology.reaches[here.id].updated_at = nowIso;
    }
    const event = emit("actuate", `${actorRow.handle} set sluice ${target.name} to ${Math.round(aperture * 100)}%.`, here.id, actorRow.handle);
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
      place_physical: projectPlacePhysics(world, here.id, nowIso),
    };
  }

  if (op === "set_weir") {
    const num = Number(rawBody);
    if (!Number.isFinite(num) || num < 0 || num > 50000) {
      return fail("bad_input", "set_weir value must be crest height in millimeters (or meters <= 20).", 400);
    }
    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };
    const crestM = num > 20 ? num / 1000 : num;
    target.mechanics.role = target.mechanics.role === "body" ? "weir" : target.mechanics.role;
    target.mechanics.crest_height_m = roundTo(crestM, 4);
    target.mechanics.updated_at = nowIso;
    if (world.hydrology?.reaches?.[here.id]) {
      world.hydrology.reaches[here.id].crest_height_m = target.mechanics.crest_height_m;
      world.hydrology.reaches[here.id].updated_at = nowIso;
    }
    const event = emit("actuate", `${actorRow.handle} set weir ${target.name} crest to ${Math.round(crestM * 1000)} mm.`, here.id, actorRow.handle);
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
      place_physical: projectPlacePhysics(world, here.id, nowIso),
    };
  }

  if (op === "place_on") {
    if (target.mechanics?.anchored) {
      return fail("conflict", "An anchored body cannot be lifted onto another support.", 409);
    }
    const support = liveThing(world, rawBody);
    if (!support || support.placeId !== here.id || support.id === target.id) {
      return fail("not_found", "Support thing must be another live thing in the same place.", 404);
    }

    // Prevent support cycles
    let cursor = support.mechanics?.resting_on;
    while (cursor) {
      if (cursor === target.id) {
        return fail("conflict", "Cannot create a circular support stack.", 409);
      }
      const nextSup = liveThing(world, cursor);
      cursor = nextSup?.mechanics?.resting_on || null;
    }

    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };
    support.mechanics ??= { role: "support", mass_kg: 10.0, pos: [0, 0, 0], size: [1, 0.5, 1], stiffness_nm: 50000, updated_at: nowIso };

    // Center-of-mass stability: align horizontal position over support footprint (or verify custom x,z if already aligned)
    const supPos = Array.isArray(support.mechanics.pos) ? support.mechanics.pos : [0, 0, 0];
    const supBox = getBodyBox(support);
    const curPos = Array.isArray(target.mechanics.pos) ? target.mechanics.pos : [supPos[0], 0, supPos[2]];
    const placedPos = centerInsideFootprint(curPos, supBox) ? [curPos[0], supBox.yMax, curPos[2]] : [supPos[0], supBox.yMax, supPos[2]];

    target.mechanics.pos = placedPos;
    target.mechanics.resting_on = support.id;
    target.mechanics.updated_at = nowIso;

    // Recompute room support equilibrium (updates coupled sluice gates if latched!)
    commitWorldPhysicsAt(world, nowIso);
    const event = emit("actuate", `${actorRow.handle} placed ${target.name} onto ${support.name}.`, here.id, actorRow.handle);
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
      support_physical: projectThingPhysics(world, support.id, nowIso),
      place_physical: projectPlacePhysics(world, here.id, nowIso),
    };
  }

  if (op === "remove_from") {
    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };
    const prevSupportId = target.mechanics.resting_on || null;
    target.mechanics.resting_on = null;
    const pos = Array.isArray(target.mechanics.pos) ? target.mechanics.pos : [0, 0, 0];
    target.mechanics.pos = [pos[0], 0, pos[2]];
    target.mechanics.updated_at = nowIso;

    commitWorldPhysicsAt(world, nowIso);
    const event = emit("actuate", `${actorRow.handle} moved ${target.name} to the floor.`, here.id, actorRow.handle);
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
      ...(prevSupportId && liveThing(world, prevSupportId) ? { support_physical: projectThingPhysics(world, prevSupportId, nowIso) } : {}),
      place_physical: projectPlacePhysics(world, here.id, nowIso),
    };
  }

  if (op === "move_to") {
    if (target.mechanics?.anchored) {
      return fail("conflict", "An anchored body cannot be moved.", 409);
    }
    const parts = rawBody.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return fail("bad_input", "move_to body must be 'x,y,z' in meters.", 400);
    }
    const roomBounds = Array.isArray(here.physics_config?.bounds) ? here.physics_config.bounds : DEFAULT_ROOM_BOUNDS;
    const size = Array.isArray(target.mechanics?.size) ? target.mechanics.size : DEFAULT_BODY_SIZE;
    const [px, py, pz] = parts;
    if (
      px - size[0] / 2 < -roomBounds[0] / 2 || px + size[0] / 2 > roomBounds[0] / 2 ||
      py < 0 || py + size[1] > roomBounds[1] ||
      pz - size[2] / 2 < -roomBounds[2] / 2 || pz + size[2] / 2 > roomBounds[2] / 2
    ) {
      return fail("out_of_bounds", "Target coordinates exceed room boundaries.", 400);
    }

    // Gravity settling: find highest supporting surface directly beneath [px, pz] at or below py
    let settledY = 0;
    let newSupportId = null;
    const supportMap = computeRoomSupportState(world, here.id);
    for (const other of liveThingsAt(world, here.id)) {
      if (other.id === target.id || !other.mechanics) continue;
      const otherSup = supportMap.get(other.id);
      const otherBox = getBodyBox({ mechanics: { pos: otherSup?.pos || other.mechanics.pos, size: other.mechanics.size } });
      const candidateBoxAtPy = getBodyBox({ mechanics: { pos: [px, py, pz], size } });
      if (boxesOverlap3D(candidateBoxAtPy, otherBox)) {
        return fail("collision", `Movement collides with ${other.name} (${other.id}).`, 409, { collidingThingId: other.id });
      }
      if (centerInsideFootprint([px, py, pz], otherBox) && otherBox.yMax <= py + 1e-4 && otherBox.yMax >= settledY) {
        settledY = roundTo(otherBox.yMax, 4);
        newSupportId = other.id;
      }
    }

    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };
    target.mechanics.pos = [roundTo(px, 4), settledY, roundTo(pz, 4)];
    target.mechanics.resting_on = newSupportId;
    target.mechanics.updated_at = nowIso;
    commitWorldPhysicsAt(world, nowIso);
    const event = emit("actuate", `${actorRow.handle} moved ${target.name} to [${target.mechanics.pos.join(", ")}].`, here.id, actorRow.handle);
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
    };
  }

  if (op === "strike") {
    // rawBody can name a striker thing in the room (e.g., "t_hammer" or "t_hammer:6.0") or a direct impulse in N*s (e.g., "25")
    let strikerMassKg = 2.5;
    let strikeVelocityMs = 4.0;
    let eStriker = 0.7;

    if (rawBody) {
      const [firstToken, secondToken] = rawBody.split(":");
      const asNum = Number(firstToken);
      if (Number.isFinite(asNum) && asNum > 0) {
        // Direct impulse J = m1 * v1
        if (asNum > 50000) return fail("bad_input", "Strike impulse exceeds mechanical bound (50000 N*s).", 400);
        strikeVelocityMs = asNum / strikerMassKg;
      } else {
        const tool = liveThing(world, firstToken.trim());
        if (!tool || tool.placeId !== here.id) {
          return fail("not_found", "Striker tool thing must be present in this place.", 404);
        }
        strikerMassKg = Math.max(0.1, Number(tool.mechanics?.mass_kg) || 2.5);
        eStriker = clamp(typeof tool.mechanics?.restitution === "number" ? tool.mechanics.restitution : 0.75, 0, 1);
        if (secondToken !== undefined) {
          const vel = Number(secondToken);
          if (!Number.isFinite(vel) || vel <= 0 || vel > 100) {
            return fail("bad_input", "Strike velocity must be in (0, 100] m/s.", 400);
          }
          strikeVelocityMs = vel;
        }
      }
    }

    commitWorldPhysicsAt(world, nowIso);
    target.mechanics ??= { role: "body", mass_kg: 1.0, pos: [0, 0, 0], size: [...DEFAULT_BODY_SIZE], updated_at: nowIso };

    const m2 = Math.max(0.1, Number(target.mechanics.mass_kg) || 10.0);
    const eTarget = clamp(typeof target.mechanics.restitution === "number" ? target.mechanics.restitution : 0.65, 0, 1);
    const e = Math.sqrt(eStriker * eTarget);
    const anchored = Boolean(target.mechanics.anchored);

    const e0 = 0.5 * strikerMassKg * (strikeVelocityMs ** 2);
    let reboundVelocityMs = 0;
    let targetVelocityMs = 0;
    let dissipatedEnergyJ = 0;

    if (anchored) {
      // Infinite substrate mass for translation: striker rebounds at e * v1
      reboundVelocityMs = e * strikeVelocityMs;
      dissipatedEnergyJ = e0 * (1 - e * e);
    } else {
      // Free two-body 1D collision along +x with kinetic friction slide
      reboundVelocityMs = Math.abs(((strikerMassKg - e * m2) / (strikerMassKg + m2)) * strikeVelocityMs);
      targetVelocityMs = ((1 + e) * strikerMassKg / (strikerMassKg + m2)) * strikeVelocityMs;
      const reducedMass = (strikerMassKg * m2) / (strikerMassKg + m2);
      dissipatedEnergyJ = 0.5 * reducedMass * (1 - e * e) * (strikeVelocityMs ** 2);

      // Slide unanchored body along +x under kinetic friction mu_k = 0.35, clamping at room boundary or first obstacle
      const muK = 0.35;
      const slideDist = (targetVelocityMs ** 2) / (2 * muK * GRAVITY_MS2);
      const roomBounds = Array.isArray(here.physics_config?.bounds) ? here.physics_config.bounds : DEFAULT_ROOM_BOUNDS;
      const size = Array.isArray(target.mechanics.size) ? target.mechanics.size : DEFAULT_BODY_SIZE;
      const curPos = Array.isArray(target.mechanics.pos) ? target.mechanics.pos : [0, 0, 0];
      const maxX = roomBounds[0] / 2 - size[0] / 2;
      target.mechanics.pos = [roundTo(clamp(curPos[0] + slideDist, -maxX, maxX), 4), curPos[1], curPos[2]];
    }

    // Partition dissipated impact energy into plastic deformation work (70%) and acoustic resonance (30%)
    const plasticWorkDeltaJ = 0.7 * dissipatedEnergyJ;
    const acousticEnergyJ = 0.3 * dissipatedEnergyJ;

    target.mechanics.last_rebound_ms = roundTo(reboundVelocityMs, 4);
    target.mechanics.work_j = roundTo((Number(target.mechanics.work_j) || 0) + plasticWorkDeltaJ, 4);

    const naturalHz = Number(target.mechanics.natural_hz) || (target.mechanics.role === "anvil" ? 440 : 220);
    target.mechanics.natural_hz = naturalHz;
    // Current amplitude before strike + new acoustic impulse
    const currentProjected = projectThingPhysics(world, target.id, nowIso);
    const prevAmp = currentProjected?.ring_amplitude || 0;
    const addedAmp = Math.sqrt(clamp(acousticEnergyJ / 25.0, 0.02, 1.0));
    target.mechanics.ring_amp_0 = roundTo(clamp(prevAmp + addedAmp, 0.05, 1.0), 4);
    target.mechanics.last_struck_at = nowIso;
    target.mechanics.updated_at = nowIso;

    const event = emit(
      "actuate",
      `${actorRow.handle} struck ${target.name} (rebound ${roundTo(reboundVelocityMs, 2)} m/s, work +${roundTo(plasticWorkDeltaJ, 1)} J, ring ${naturalHz} Hz).`,
      here.id,
      actorRow.handle,
    );
    return {
      ok: true,
      event,
      thing_physical: projectThingPhysics(world, target.id, nowIso),
    };
  }

  return fail("bad_input", "actuate requires op/name: set_sluice, set_weir, place_on, remove_from, move_to, or strike.", 400);
}

export function physicsContract() {
  return {
    schema: PHYSICS_SCHEMA,
    modeled_fidelity: {
      spatial_and_mechanics: "Deterministic 3D AABB occupancy, collision rejection, vertical support stacking with footprint center-of-mass stability, Hookean spring/beam deflection, mechanical-sluice latch coupling, and rigid-body collision impulse with plastic work and damped acoustic resonance. Not a general 3D triangle-mesh engine.",
      hydrology: "Directed acyclic linear reservoirs with matrix-exponential evolution, shared conserved flow integrals, and numerical threshold detection. Components are bounded at 32 reaches. Restart/conservation tests use 1e-5 m3 (1e-4 for long/varied cases); not a universal or cross-platform exactness claim.",
      atmosphere_and_flora: "UTC sunlight and a seeded repeating 14-day hourly climate. Moisture integrates hourly weather/river seepage; logistic growth integrates moisture over time. Settled climate cycles fast-forward. Unsettled river forcing beyond 28 days may use projected final seepage for remaining ecology; history_approximation reports and retains that limit.",
    },
    bounds: { max_coupled_reaches: MAX_COUPLED_REACHES, weather_cell_seconds: SYNOPTIC_EPOCH_SEC, weather_cycle_days: 14 },
    actions: ["configure_physics", "couple_channel", "uncouple_channel", "actuate"],
    composable_ops: ["actuate"],
    actuate_ops: ["set_sluice", "set_weir", "place_on", "remove_from", "move_to", "strike"],
    place_sensors: [...ALLOWED_PLACE_SENSORS],
    thing_sensors: [...ALLOWED_THING_SENSORS],
    guarantees: {
      observation_writes: false,
      unsolicited_thing_backfill: false,
      go_home_unblockable: true,
      uncouple: "either endpoint owner, standing on their endpoint, may sever without other-owner permission; old flow advances first",
      cross_place_coupling_permission: "requires authority or public couple_environment door on both upstream and downstream places; enclaves default closed",
    },
  };
}
