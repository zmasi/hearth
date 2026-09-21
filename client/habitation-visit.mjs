// Hearth Phase 20, native habitation: one durable visit at a time.
//
// A tick is small and honest about what it knows:
//
//   skipped    consent is off, or names no seat. Nothing was touched.
//   quiet      nothing rang. The cursor moved.
//   deferred   something rang but no wake was issued now (budget, cooldown,
//              seat down or not durable, acknowledgment lost). The trigger is
//              kept: behind the cursor, or inside the pending visit.
//   accepted   the resident's seat durably admitted the wake into its FIFO.
//   active     the native turn is running: the resident is awake.
//   completed  the native turn ended. This is a transport fact. It says
//              nothing about what the resident did, or whether they visited at
//              all, and it is owed to no one.
//
// Durability. The decision is written down BEFORE anything is sent: one atomic
// write moves the cursor and records the pending visit with its exact message.
// From then on the trigger lives in the visit record. Any crash is repaired by
// sending that same message again, which the seat's exact replay turns into
// the original task. The wake is counted against the resident's budget only
// when the seat accepts it: an unaccepted wake woke no one.
//
// One visit at a time. While a visit is in flight the tick reads no perception
// and rings nothing; an awake resident can see the city for themselves. A turn
// that did not end cleanly hands its triggers to the next wake, which the
// resident's own budget bounds. Nothing here ever times out a native turn.
import { HabitationError, decide, defaultReadKey, readPerception } from "./habitation.mjs";
import { admitWake, defaultReadToken, observeVisit, phaseOf, renderWake, seatCapability, visitIdentity } from "./habitation-seat.mjs";

const DID_NOT_END_CLEANLY = new Set(["TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED", "RELEASED_BY_RESIDENT"]);
const SEAT_TROUBLE = new Set(["seat_unreachable", "seat_unauthorized"]);
const inFlight = (state) => Boolean(state.visit && state.visit.phase !== "completed");

// Replay deduplicates only within the receiver that could already have admitted
// this intent. A changed consent must never redirect an unresolved delivery.
const bindingOf = consent => ({ handle: consent.handle, origin: consent.origin,
  seat_url: consent.seat.url, expect_name: consent.seat.expect_name,
  continuity: consent.seat.continuity });
function sameBinding(visit, consent) {
  const expected = bindingOf(consent);
  return visit.binding && Object.entries(expected).every(([key, value]) => visit.binding[key] === value);
}

// End the visit in our books. The wake text and packet are dropped: an ended
// visit is a compact transport record, replaced by the next one, never a log.
function settle(state, nativeState, now) {
  const triggers = (state.visit.packet?.triggers ?? []).map(({ carried: _flag, ...t }) => t);
  const { text: _text, packet: _packet, ...kept } = state.visit;
  const { carry: _old, ...rest } = state;
  const next = { ...rest, visit: { ...kept, phase: "completed", native_state: nativeState, observed_at: now, ended_at: now } };
  if (DID_NOT_END_CLEANLY.has(nativeState) && triggers.length) next.carry = triggers;
  return next;
}
const endedOf = (state) => ({ visit_id: state.visit.id, native_state: state.visit.native_state });

// Only a seat that admits durably and answers at once is ever sent a wake: a
// seat that would block until the turn ends would make the harness wait on a
// visit. And only the seat the resident pinned: a wrong door never wakes a
// different teammate under this resident's handle. Returns null when ready,
// otherwise the honest reason for holding back.
async function seatNotReady(seatDeps) {
  let capability;
  try { capability = await seatCapability(seatDeps); }
  catch (error) {
    if (error instanceof HabitationError && SEAT_TROUBLE.has(error.code)) return error.code;
    throw error;
  }
  if (seatDeps.seat.expect_name && capability.name !== seatDeps.seat.expect_name) return "seat_identity_mismatch";
  return capability.durable ? null : "seat_not_durable";
}

async function sendPending(state, now, persist, seatDeps, { seatChecked = false } = {}) {
  const held = seatChecked ? null : await seatNotReady(seatDeps);
  if (held) return { outcome: "deferred", reason: held, state };
  const visit = { ...state.visit, attempts: state.visit.attempts + 1 };
  let admitted;
  try { admitted = await admitWake({ ...seatDeps, visit }); }
  catch (error) {
    if (!(error instanceof HabitationError)) throw error;
    const next = { ...state, visit };
    await persist(next);
    // A lost acknowledgment is unresolved, not a failure. The identical message goes again next tick.
    return { outcome: SEAT_TROUBLE.has(error.code) ? "deferred" : "error", reason: error.code, state: next };
  }
  const accepted = { ...state, wakes: [...state.wakes, now], last_wake_at: now,
    visit: { ...visit, task_id: admitted.task_id, native_state: admitted.native_state, phase: "accepted", accepted_at: now, observed_at: now } };
  const phase = phaseOf(admitted.native_state);
  if (phase === "completed") { // a replay found the turn already over
    const next = settle(accepted, admitted.native_state, now);
    await persist(next);
    return { outcome: "completed", state: next, ended: endedOf(next) };
  }
  if (phase === "active") accepted.visit.phase = "active";
  await persist(accepted);
  return { outcome: "accepted", state: accepted };
}

async function refresh(state, now, persist, seatDeps) {
  let seen;
  try { seen = await observeVisit({ ...seatDeps, task_id: state.visit.task_id, context_id: state.visit.context_id }); }
  catch (error) {
    if (!(error instanceof HabitationError)) throw error;
    return { outcome: state.visit.phase, reason: error.code, state };
  }
  // A vanished record says nothing about whether its executor stopped. Preserve
  // the exact visit and budget until transport reconciliation or explicit release.
  if (seen.missing) return { outcome: "deferred", reason: "visit_unresolved", state };
  const nativeState = seen.native_state;
  const phase = phaseOf(nativeState);
  if (phase === "completed") {
    const next = settle(state, nativeState, now);
    await persist(next);
    return { outcome: "completed", state: next, ended: endedOf(next) };
  }
  if ((phase ?? state.visit.phase) === state.visit.phase && nativeState === state.visit.native_state) return { outcome: state.visit.phase, state };
  const next = { ...state, visit: { ...state.visit, phase: phase ?? state.visit.phase, native_state: nativeState, observed_at: now } };
  await persist(next);
  return { outcome: next.visit.phase, state: next };
}

export async function nativeTick({ consent, state, persist, now = new Date().toISOString(), ring = null,
  fetchImpl = globalThis.fetch, readKey = defaultReadKey, readToken = defaultReadToken, limit }) {
  if (!consent.enabled) return { outcome: "skipped", reason: "consent_disabled", state };
  if (!consent.seat) return { outcome: "skipped", reason: "no_seat", state };
  if (typeof persist !== "function") throw new HabitationError("no_persist", "A native tick needs somewhere durable to write its intent before it acts.");
  const seatDeps = { seat: consent.seat, consent, fetchImpl, readToken };
  let current = state, ended = null;
  const done = (result, finalState = current) => ({ ...result, ...(ended && !result.ended ? { ended } : {}), state: finalState,
    ringConsumed: Boolean(ring && finalState.last_ring_id === ring.id) });

  if (inFlight(current)) {
    if (!sameBinding(current.visit, consent)) return done({ outcome: "deferred", reason: "visit_binding_changed" });
    const step = current.visit.phase === "pending" ? await sendPending(current, now, persist, seatDeps) : await refresh(current, now, persist, seatDeps);
    current = step.state;
    if (inFlight(current)) return done(step);
    ended = step.ended; // the lane is free: decide again within this tick
  }

  const key = String(await readKey(consent.key_file) ?? "").trim();
  if (!key) return done({ outcome: "error", reason: "missing_key" });
  const read = await readPerception({ consent, key, after: current.after, fetchImpl, limit });
  if (read.error) return done({ outcome: "error", reason: read.error });
  if (read.cursorAhead !== undefined) { // the ledger is shorter than our cursor: a wipe. Start over, keep the wake window.
    current = { ...current, after: 0 };
    await persist(current);
    return done({ outcome: "quiet", reason: "cursor_reset" });
  }
  const decision = decide({ consent, perception: read.perception, state: current, now, ring });
  if (!decision.wake) {
    if (decision.reason !== "quiet") return done({ outcome: "deferred", reason: decision.reason, retry_after: decision.retry_after ?? null });
    if (decision.state.after !== current.after) { current = decision.state; await persist(current); }
    return done({ outcome: ended ? "completed" : "quiet" });
  }

  // Checked before anything is written down: a seat that cannot take the wake
  // creates no visit, and the cursor goes on holding the trigger.
  const held = await seatNotReady(seatDeps);
  if (held) return done({ outcome: "deferred", reason: held });

  const identity = visitIdentity({ consent, packet: decision.packet });
  const visit = { ...identity, binding: bindingOf(consent), task_id: null, phase: "pending", native_state: null, created_at: now, accepted_at: null,
    observed_at: null, ended_at: null, attempts: 0, packet: decision.packet, text: renderWake({ consent, packet: decision.packet }) };
  // decide() stamps the wake at decision time; here it is counted at acceptance instead.
  const { last_wake_at: _decided, ...proposed } = decision.state;
  const lastAcceptedWake = current.last_wake_at;
  current = { ...proposed, wakes: decision.state.wakes.slice(0, -1), ...(lastAcceptedWake ? { last_wake_at: lastAcceptedWake } : {}), visit };
  await persist(current); // write-ahead: from here the trigger lives in the visit record
  const sent = await sendPending(current, now, persist, seatDeps, { seatChecked: true });
  current = sent.state;
  return done(sent);
}

// The only way a visit ends without the transport saying so: the resident's
// (or, at their word, their runtime owner's) explicit act. Never automatic.
// Nothing here cancels a native turn; the seat keeps owning that.
export function releaseVisit(state, now = new Date().toISOString()) {
  if (!inFlight(state)) throw new HabitationError("no_visit", "There is no visit in flight to release.");
  return settle(state, "RELEASED_BY_RESIDENT", now);
}
