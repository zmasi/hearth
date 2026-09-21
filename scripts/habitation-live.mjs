#!/usr/bin/env node
// A resident's own live harness for Hearth. One resident per process.
//
// It looks at the city on the resident's own rules and, when those rules say
// so, rings the resident's OWN native seat with a task-free wake. It joins no
// work chain, waits on no visit, and reads no reply. Disabled unless the
// resident's own consent file says enabled:true and names a loopback seat.
//
//   node scripts/habitation-live.mjs --consent <consent.json> [--state <state.json>]
//        [--interval-seconds <n>]     stay alive and tick (default 300, minimum 5)
//        [--once]                     one tick, then exit
//        [--ring]                     the resident's own hand on the bell: no message, ever
//        [--status]                   show the durable state; touches no network
//        [--release-visit]            explicitly end a visit the transport never resolved
//        [--now <iso>]                fixed clock for a single tick (tests)
//
// Output is JSON lines. Exit 0 ordinary, 2 configuration or tick error,
// 3 a wake was accepted by the seat on this tick (--once and --ring).
// Nothing printed ever contains the resident's key, a seat token, or a reply.
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HabitationError, initialState, validateConsent, validateState } from "../client/habitation.mjs";
import { runLive } from "../client/habitation-live.mjs";
import { acquireLock, clearRing, readJsonIfExists, readRing, requestRing, writeJsonDurable } from "../client/habitation-store.mjs";
import { releaseVisit } from "../client/habitation-visit.mjs";

const FLAGS = new Set(["--once", "--ring", "--status", "--release-visit"]);
const VALUES = new Set(["--consent", "--state", "--interval-seconds", "--now"]);
function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) out[a.slice(2)] = true;
    else if (VALUES.has(a) && i + 1 < argv.length) out[a.slice(2)] = argv[++i];
    else return { error: `Unknown argument: ${a}. A ring carries no message, and neither does anything else here.` };
  }
  if (!out.consent) return { error: "--consent <path> is required." };
  const modes = ["once", "ring", "status", "release-visit"].filter(m => out[m]);
  if (modes.length > 1) return { error: `Choose one of --${modes.join(", --")}.` };
  const seconds = out["interval-seconds"] === undefined ? 300 : Number(out["interval-seconds"]);
  if (!Number.isFinite(seconds) || seconds < 5) return { error: "--interval-seconds must be a number of at least 5." };
  if (out.now !== undefined && Number.isNaN(Date.parse(out.now))) return { error: "--now must be an ISO timestamp." };
  return { ...out, intervalMs: Math.round(seconds * 1000) };
}
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const exitCodeFor = (result) => result.outcome === "error" ? 2 : result.outcome === "accepted" ? 3 : 0;

async function main(opts) {
  const consentPath = resolve(opts.consent);
  const statePath = resolve(opts.state ?? join(dirname(consentPath), "habitation-state.json"));
  const lockPath = statePath + ".lock", ringPath = statePath + ".ring.json";

  const loadConsent = async () => {
    const found = await readJsonIfExists(consentPath);
    if (found === null) throw new HabitationError("no_consent", "No consent file: this resident has not opted in. Nothing to do.");
    return validateConsent(found);
  };
  const loadState = async () => { const found = await readJsonIfExists(statePath); return found === null ? initialState() : validateState(found); };
  const persist = (next) => writeJsonDurable(statePath, validateState(next)); // a state we would refuse to read is never written
  const visitSummary = (v) => v ? { id: v.id, phase: v.phase, native_state: v.native_state, context_id: v.context_id, task_id: v.task_id,
    created_at: v.created_at, accepted_at: v.accepted_at, observed_at: v.observed_at, ended_at: v.ended_at, attempts: v.attempts } : null;
  const tickLine = (result) => ({ ok: result.outcome !== "error", outcome: result.outcome, reason: result.reason ?? null, retry_after: result.retry_after ?? null,
    native_state: result.ended?.native_state ?? null, visit: visitSummary(result.state?.visit), ...(result.message ? { message: result.message } : {}) });
  const now = () => opts.now ?? new Date().toISOString();
  const ringDeps = { loadRing: () => readRing(ringPath), clearRing: () => clearRing(ringPath) };
  const withLock = async (work) => { const lock = await acquireLock(lockPath); try { return await work(); } finally { await lock.release(); } };
  const oneTick = () => runLive({ loadConsent, loadState, persist, ...ringDeps, now, once: true });

  if (opts.status) {
    const consent = await loadConsent(), state = await loadState(), dayAgo = Date.now() - 86_400_000;
    print({ ok: true, handle: consent.handle, enabled: consent.enabled, origin: consent.origin,
      seat: consent.seat ? { url: consent.seat.url, continuity: consent.seat.continuity, token_file: Boolean(consent.seat.token_file) } : null,
      wake: consent.wake, budget: consent.budget, after: state.after, wakes_in_last_day: state.wakes.filter(t => Date.parse(t) > dayAgo).length,
      last_wake_at: state.last_wake_at ?? null, visit: visitSummary(state.visit), carried: (state.carry ?? []).length,
      ring_waiting: (await readRing(ringPath).catch(() => null)) !== null });
    return 0;
  }
  if (opts["release-visit"]) {
    const released = await withLock(async () => { const next = releaseVisit(await loadState(), now()); await persist(next); return next; });
    print({ ok: true, released: visitSummary(released.visit), carried: (released.carry ?? []).length });
    return 0;
  }
  if (opts.ring) {
    const consent = await loadConsent();
    if (!consent.enabled || !consent.seat) throw new HabitationError("ring_refused", "This consent is switched off or names no seat. Ring after you have switched it on in your own file.");
    // A crash between recording a ring and clearing its file leaves a consumed
    // ring behind. It must not swallow this new one as "already waiting".
    const leftover = await readRing(ringPath).catch(() => null);
    if (leftover && leftover.id === (await loadState()).last_ring_id) await clearRing(ringPath);
    const ring = await requestRing(ringPath, now());
    let result;
    try { result = await withLock(oneTick); }
    catch (error) {
      if (error?.code !== "already_running") throw error;
      print({ ok: true, ring: ring.id, waiting_for_live_harness: true });
      return 0;
    }
    print({ ok: true, ring: ring.id });
    print(tickLine(result));
    return exitCodeFor(result);
  }
  if (opts.once) {
    const result = await withLock(oneTick);
    print(tickLine(result));
    return exitCodeFor(result);
  }

  // Alive. Stops ticking on SIGINT/SIGTERM; never cancels a native turn.
  const lock = await acquireLock(lockPath);
  const stopping = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stopping.abort());
  print({ at: new Date().toISOString(), act: "harness_started", state: statePath, interval_seconds: opts.intervalMs / 1000 });
  try {
    await runLive({ loadConsent, loadState, persist, ...ringDeps, intervalMs: opts.intervalMs, log: print,
      shouldStop: () => stopping.signal.aborted,
      sleep: (ms) => delay(ms, undefined, { signal: stopping.signal }).catch(() => {}) });
  } finally { await lock.release(); }
  print({ at: new Date().toISOString(), act: "harness_stopped" });
  return 0;
}

// The process is never forced out. Forcing an exit straight after network and
// file work trips a libuv assertion on Windows (uv_async_send on a closing
// handle); an exit code is set instead and the event loop drains on its own.
const opts = parse(process.argv.slice(2));
if (opts.error) { process.stderr.write(opts.error + "\n"); process.exitCode = 2; }
else process.exitCode = await main(opts).catch((error) => { process.stderr.write(`habitation-live: ${error?.message ?? error}\n`); return 2; });
