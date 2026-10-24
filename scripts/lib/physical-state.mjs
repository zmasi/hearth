// Recovery validates persisted physics without evaluating time or plaintext.
import { MAX_COUPLED_REACHES } from "../../client/hydrology-solver.mjs";
import { MECHANISM_BOUNDS, FIELD_NAME_RE } from "../../client/pin-machines.mjs";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const number = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const timestamp = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));

export function validatePhysicalState(w, need) {
  function scalar(v) {
    return typeof v === "boolean" || (typeof v === "string" && Buffer.byteLength(v) <= MECHANISM_BOUNDS.max_string_bytes)
      || (Number.isSafeInteger(v) && number(v, MECHANISM_BOUNDS.int_min, MECHANISM_BOUNDS.int_max));
  }
  const places = new Map(w.places.map(p => [p.id, p]));
  for (const item of [...w.places, ...w.things]) if (Object.hasOwn(item, "fields")) {
    need(object(item.fields) && Object.keys(item.fields).length <= MECHANISM_BOUNDS.max_fields);
    need(Buffer.byteLength(JSON.stringify(item.fields)) <= MECHANISM_BOUNDS.max_bag_bytes);
    for (const [name, value] of Object.entries(item.fields)) need(FIELD_NAME_RE.test(name)
      && (scalar(value) || (Array.isArray(value) && value.length <= MECHANISM_BOUNDS.max_list_items && value.every(scalar))));
  }
  for (const p of w.places) if (Object.hasOwn(p, "physics_config")) {
    const c = p.physics_config; need(object(c));
    if (Object.hasOwn(c, "exposure")) need(["open","canopy","sheltered"].includes(c.exposure));
    if (Object.hasOwn(c, "bounds")) need(Array.isArray(c.bounds) && c.bounds.length === 3 && c.bounds.every(v => number(v, 2, 500)));
    if (Object.hasOwn(c, "soil_moisture")) need(number(c.soil_moisture, 0, 1));
    if (Object.hasOwn(c, "moisture_updated_at")) need(timestamp(c.moisture_updated_at));
    if (Object.hasOwn(c, "soil_epoch")) need(object(c.soil_epoch) && Number.isSafeInteger(c.soil_epoch.index) && number(c.soil_epoch.seepage, 0, 0.45));
    if (Object.hasOwn(c, "history_approximation")) need(typeof c.history_approximation === "boolean");
  }
  for (const t of w.things) if (Object.hasOwn(t, "mechanics")) {
    const m = t.mechanics; need(object(m));
    need(["body","support","sluice","weir","anvil","flora"].includes(m.role));
    if (Object.hasOwn(m, "updated_at")) need(timestamp(m.updated_at));
    if (Object.hasOwn(m, "last_struck_at")) need(timestamp(m.last_struck_at));
    for (const key of ["pos", "size"]) if (Object.hasOwn(m, key)) need(Array.isArray(m[key]) && m[key].length === 3
      && m[key].every(v => number(v, key === "size" ? 0.05 : -100000, 100000)));
    for (const key of ["mass_kg","stiffness_nm","latch_threshold_mm","natural_hz","ring_tau_s","crest_height_m","biomass_kg","max_biomass_kg","growth_rate_day","work_j","last_rebound_ms"]) {
      if (Object.hasOwn(m, key)) need(number(m[key], key === "last_rebound_ms" ? -1e12 : 0, 1e18));
    }
    for (const key of ["aperture","restitution","ring_amplitude","ring_amp_0"]) if (Object.hasOwn(m, key)) need(number(m[key], 0, 1));
    for (const key of ["resting_on","coupled_support_id"]) if (Object.hasOwn(m, key)) need(m[key] === null || typeof m[key] === "string");
  }
  if (!Object.hasOwn(w, "hydrology")) return;
  const h = w.hydrology; need(object(h) && object(h.reaches) && Array.isArray(h.channels));
  for (const [id, r] of Object.entries(h.reaches)) {
    need(places.has(id) && object(r) && timestamp(r.updated_at));
    need(number(r.area_m2, 1, 100000) && number(r.max_depth_m, 0.5, 100) && number(r.elevation_m, -100, 5000));
    need(number(r.volume_m3, 0, r.area_m2 * r.max_depth_m) && number(r.source_inflow_m3s, 0, 1000)
      && number(r.aperture, 0, 1) && number(r.crest_height_m, 0, 100) && number(r.conductance_s, 0, 1));
    for (const key of ["total_inflow_m3", "total_outflow_m3"]) need(number(r[key], 0, Number.MAX_SAFE_INTEGER));
  }
  const edges = new Set(), adj = new Map(Object.keys(h.reaches).map(id => [id, []])), indegree = new Map([...adj.keys()].map(id => [id, 0]));
  for (const ch of h.channels) {
    need(object(ch) && adj.has(ch.from) && adj.has(ch.to) && ch.from !== ch.to);
    const key = JSON.stringify([ch.from, ch.to]); need(!edges.has(key)); edges.add(key);
    adj.get(ch.from).push(ch.to); indegree.set(ch.to, indegree.get(ch.to) + 1);
    need(timestamp(ch.createdAt) && w.residents.some(r => r.handle === ch.authorHandle));
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let count = 0;
  while (queue.length) { const id = queue.pop(); count++; for (const to of adj.get(id)) { indegree.set(to, indegree.get(to) - 1); if (indegree.get(to) === 0) queue.push(to); } }
  need(count === adj.size);
  const seen = new Set();
  for (const id of adj.keys()) {
    if (seen.has(id)) continue;
    const stack = [id]; let size = 0;
    while (stack.length) {
      const at = stack.pop(); if (seen.has(at)) continue; seen.add(at); size++;
      for (const ch of h.channels) { if (ch.from === at) stack.push(ch.to); if (ch.to === at) stack.push(ch.from); }
    }
    need(size <= MAX_COUPLED_REACHES);
  }
}
