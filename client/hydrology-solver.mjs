// Piecewise linear reservoir evolution. A matrix exponential retains repeated
// and nearly repeated rates without unstable division by their difference.
// No clock, storage or resident data; inputs are the derived reach component.
export const MAX_COUPLED_REACHES = 32;
const EPS = 1e-8;
const matrix = n => Array.from({ length: n }, () => new Float64Array(n));
const identity = n => { const m = matrix(n); for (let i = 0; i < n; i++) m[i][i] = 1; return m; };
function multiply(a, b) {
  const n = a.length, out = matrix(n);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
    if (a[i][k] === 0) continue;
    for (let j = 0; j < n; j++) out[i][j] += a[i][k] * b[k][j];
  }
  return out;
}
function exponential(a, dt, rate) {
  const n = a.length, squarings = Math.max(0, Math.ceil(Math.log2(Math.max(1, dt * rate))));
  const h = dt / 2 ** squarings;
  const scaled = a.map(row => Float64Array.from(row, v => v * h));
  let sum = identity(n), term = identity(n);
  // The graph is triangular apart from its constant/integral coordinates;
  // eigenvalues are 0 or -k, scaled to [-1,0]. Include the nilpotent depth.
  for (let j = 1; j <= n + 32; j++) {
    term = multiply(term, scaled);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      term[i][k] /= j;
      sum[i][k] += term[i][k];
    }
  }
  for (let j = 0; j < squarings; j++) sum = multiply(sum, sum);
  return sum;
}
const dot = (row, vector) => row.reduce((sum, v, i) => sum + v * vector[i], 0);

function trajectory(state, order, upstream, downstream, forced) {
  const count = order.length, n = count * 2 + 1, constant = count;
  const a = matrix(n), x = new Float64Array(n), plans = new Map();
  x[constant] = 1;
  let rate = 0;
  for (let i = 0; i < count; i++) {
    const id = order[i], s = state.get(id), incoming = new Float64Array(n);
    incoming[constant] = s.source_inflow_m3s;
    let maxIn = s.source_inflow_m3s, minIn = s.source_inflow_m3s;
    for (const parent of upstream.get(id)) {
      const parentPlan = plans.get(parent), flow = parentPlan.flow, fraction = 1 / downstream.get(parent).length;
      for (let j = 0; j < n; j++) incoming[j] += flow[j] * fraction;
      maxIn += parentPlan.maxOut * fraction;
      minIn += parentPlan.minOut * fraction;
    }
    const inflow = dot(incoming, x), capFlow = s.k * (s.max_volume_m3 - s.crest_volume_m3);
    let mode = forced.get(id) || (s.volume_m3 >= s.max_volume_m3 - EPS && inflow >= capFlow
      ? "capped" : (s.k === 0 || s.volume_m3 < s.crest_volume_m3 - EPS ? "filling" : "linear"));
    const offset = mode === "linear" ? s.crest_volume_m3 : 0;
    x[i] = mode === "capped" ? 0 : Math.max(0, s.volume_m3 - offset);
    const flow = new Float64Array(n);
    if (mode === "capped") flow.set(incoming);
    else {
      a[i].set(incoming);
      if (mode === "linear") { a[i][i] -= s.k; flow[i] = s.k; rate = Math.max(rate, s.k); }
    }
    a[count + 1 + i].set(flow);
    // Positive linear reservoirs stay between their initial mobile volume and
    // the equilibria of bounded incoming flow. This proves many regimes cannot
    // cross a threshold, avoiding event searches through an already-safe DAG.
    const maxValue = mode === "linear" ? offset + Math.max(x[i], maxIn / s.k) : Infinity;
    const maxOut = mode === "capped" ? maxIn : mode === "linear" ? s.k * (maxValue - offset) : 0;
    const minOut = mode === "capped" ? minIn : mode === "linear" ? Math.min(s.k * x[i], minIn) : 0;
    plans.set(id, { i, mode, offset, incoming, flow, capFlow, maxValue, maxOut, minOut, maxIn, minIn });
  }
  const cache = new Map([[0, x]]);
  const at = t => {
    if (!cache.has(t)) cache.set(t, Float64Array.from(exponential(a, t, rate), row => dot(row, x)));
    return cache.get(t);
  };
  return { plans, at, rate, count };
}

export function advanceReservoirComponent(state, order, upstream, downstream, elapsed) {
  if (order.length > MAX_COUPLED_REACHES) throw new Error("Hydrology component exceeds the supported bound.");
  let remaining = elapsed, forced = new Map();
  for (let iteration = 0; remaining > 1e-7; iteration++) {
    if (iteration >= 256 * order.length) throw new Error("Hydrology regime convergence failed; elapsed time was not discarded.");
    const plan = trajectory(state, order, upstream, downstream, forced);
    forced = new Map();
    const violations = [];
    for (const id of order) {
      const s = state.get(id), p = plan.plans.get(id);
      if (p.mode === "capped") {
        if (p.minIn < p.capFlow) violations.push({ id, mode: s.k > 0 ? "linear" : "filling",
          fn: values => p.capFlow - dot(p.incoming, values) });
      }
      else {
        if ((p.mode === "linear" && p.maxValue <= s.max_volume_m3) || (p.mode === "filling" && p.maxIn === 0)) continue;
        const cap = p.mode === "filling" && s.k > 0 ? s.crest_volume_m3 : s.max_volume_m3;
        violations.push({ id, mode: cap === s.max_volume_m3 ? "capped" : "linear",
          fn: values => values[p.i] + p.offset - cap });
      }
    }
    // Resolve transitions on a logarithmic time grid with eight samples per
    // doubling, followed by bisection. Cost depends on graph/rate/time scales,
    // never one step per elapsed second. This is a numerical event locator,
    // not a proof of all possible trajectories or cross-platform bit identity.
    let step = remaining, event = null, previous = 0;
    const samples = [0];
    for (let edge = Math.min(remaining, 0.25 / Math.max(plan.rate, 1e-12)); edge < remaining; edge *= 2) {
      const start = samples.at(-1);
      for (let j = 1; j <= 8; j++) samples.push(start + (edge - start) * j / 8);
    }
    const last = samples.at(-1);
    for (let j = 1; j <= 8; j++) samples.push(last + (remaining - last) * j / 8);
    for (const t of violations.length ? samples.slice(1) : []) {
      const values = plan.at(t);
      for (const check of violations) {
        if (check.fn(values) <= EPS) continue;
        let lo = previous, hi = t;
        for (let j = 0; j < 55; j++) {
          const mid = (lo + hi) / 2;
          if (check.fn(plan.at(mid)) > 0) hi = mid; else lo = mid;
        }
        if (hi < step) { step = hi; event = check; }
      }
      if (event) break;
      previous = t;
    }
    const values = plan.at(step), outflows = new Map();
    for (const id of order) {
      const p = plan.plans.get(id);
      outflows.set(id, Math.max(0, values[plan.count + 1 + p.i]));
    }
    for (const id of order) {
      const s = state.get(id), out = outflows.get(id);
      let incoming = s.source_inflow_m3s * step;
      for (const parent of upstream.get(id)) incoming += outflows.get(parent) / downstream.get(parent).length;
      const end = s.volume_m3 + incoming - out;
      // Derive volume and cumulative flow from the same integrals. Snap only
      // numerical boundary noise; never rescale an upstream time waveform.
      s.volume_m3 = Math.max(0, Math.min(s.max_volume_m3, end));
      s.total_inflow_m3 += incoming;
      s.total_outflow_m3 += out;
    }
    if (event) {
      forced.set(event.id, event.mode);
      const s = state.get(event.id);
      if (event.mode === "capped") s.volume_m3 = s.max_volume_m3;
      if (event.mode === "linear" && plan.plans.get(event.id).mode === "filling") s.volume_m3 = s.crest_volume_m3;
    }
    remaining -= step;
  }
}
