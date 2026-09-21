// Hearth Phase 20 (Hearth form): opt-in habitation for an existing resident.
//
// This module is the harness-side half of "looking rarely". It never joins,
// never reads private memory, never puts the key into anything it returns,
// and never dispatches unless the caller both holds an enabled consent record
// and explicitly activates. The world side is GET /api/perception (Phase 12).
//
// Two kinds of state are kept apart on purpose:
//   - the durable state the resident's runtime persists (cursor, wake window);
//   - the proposed state a decision would adopt if it were acted on.
// A dry run returns both and commits neither. Only an activated tick commits,
// and only after its wake was actually handed to the dispatcher.
//
// Ownership: the consent file and the state file belong to the resident's own
// runtime. The kernel does not know they exist. No server-side enrolment.
//
// Two ways out of here. runOnce() hands a packet to whatever dispatch function
// a runtime owner supplies (the spool). The native path, habitation-seat.mjs
// and habitation-visit.mjs, rings the resident's own native seat directly and
// on purpose joins no shared work chain: no root, no outcome owner, no report.
import { readFile } from "node:fs/promises";

export const CONSENT_SCHEMA = "hearth-habitation-consent-v1";
export const STATE_SCHEMA = "hearth-habitation-state-v1";
export const PACKET_SCHEMA = "hearth-wake-v1";

const HANDLE = /^[a-z][a-z0-9_]{2,23}$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const CONSENT_FIELDS = new Set(["schema", "handle", "origin", "key_file", "enabled", "wake", "budget", "seat"]);
const WAKE_FIELDS = new Set(["on_mention", "places", "on_any", "rhythm_hours"]);
const BUDGET_FIELDS = new Set(["max_wakes_per_day", "cooldown_minutes"]);
const SEAT_FIELDS = new Set(["url", "token_file", "continuity", "expect_name"]);
const SEAT_CONTINUITY = new Set(["continuing", "fresh"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STATE_FIELDS = new Set(["schema", "after", "wakes", "last_wake_at", "last_ring_id", "visit", "carry"]);
const VISIT_PHASES = new Set(["pending", "accepted", "active", "completed"]);
const NEVER_IN_CONSENT = ["key", "bearer", "token", "secret", "client_key"];
const DEFAULT_LIMIT = 200;
// The city's own grammar. Every field that can reach a wake text is checked
// against it, so a hostile or broken origin can never put words in a prompt.
const WORLD_ID = /^[A-Za-z0-9_:.-]{1,64}$/;
const VERB = /^[a-z][a-z0-9_.:-]{0,63}$/;
const RING_ID = /^ring-[A-Za-z0-9]{1,32}$/;

export class HabitationError extends Error {
  constructor(code, message) { super(message); this.name = "HabitationError"; this.code = code; }
}
const bad = (code, message) => { throw new HabitationError(code, message); };
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isSeq = (v) => v === null || (isInt(v) && v >= 0);

// A trigger names what rang, by id only. `carried: true` marks one re-offered
// because an earlier native turn ended without running.
export function validTrigger(t) {
  if (!isObject(t) || !(t.carried === undefined || t.carried === true)) return false;
  const keys = Object.keys(t).filter(k => k !== "carried").sort().join(",");
  switch (t.kind) {
    case "mention":
      return keys === "authorHandle,kind,noteId,placeId,seq" && WORLD_ID.test(t.noteId) && WORLD_ID.test(t.placeId) && HANDLE.test(t.authorHandle) && isSeq(t.seq);
    case "place_activity":
    case "any_activity":
      return keys === "actorHandle,eventKind,kind,placeId,seq" && WORLD_ID.test(t.placeId) && VERB.test(t.eventKind) && HANDLE.test(t.actorHandle) && isInt(t.seq) && t.seq >= 0;
    case "rhythm":
      return keys === "every_hours,kind" && isInt(t.every_hours) && t.every_hours >= 1 && t.every_hours <= 720;
    case "self":
      return keys === "at,kind,ringId" && RING_ID.test(t.ringId) && isIso(t.at);
    default:
      return false;
  }
}

// A ring is the resident's own hand on their own bell. It has an id and a time
// and nothing else: a ring that could carry words would be an errand channel.
export function validateRing(ring) {
  if (!isObject(ring) || Object.keys(ring).sort().join(",") !== "id,requested_at" || !RING_ID.test(ring.id) || !isIso(ring.requested_at)) {
    bad("bad_ring", "A ring carries an id and a time, and no message.");
  }
  return { id: ring.id, requested_at: ring.requested_at };
}

function validateSeat(seatIn) {
  if (!isObject(seatIn)) bad("bad_consent", "Consent seat must be an object.");
  for (const field of NEVER_IN_CONSENT) if (Object.hasOwn(seatIn, field)) bad("bad_consent", `Consent files never hold a key (seat.${field}). Point token_file at a file instead.`);
  for (const field of Object.keys(seatIn)) if (!SEAT_FIELDS.has(field)) bad("bad_consent", `Unknown field in seat: ${field}.`);
  let url;
  try { url = new URL(seatIn.url); } catch { bad("bad_consent", "seat.url must be the resident's own native seat, an absolute loopback URL."); }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.search || url.hash || url.username || url.password) {
    bad("bad_consent", "seat.url must be loopback (127.0.0.1, localhost or ::1): a resident's seat is never rung across a network.");
  }
  const token_file = seatIn.token_file ?? null;
  if (token_file !== null && (typeof token_file !== "string" || !token_file.trim())) bad("bad_consent", "seat.token_file must name a file, or be omitted.");
  const continuity = seatIn.continuity ?? "continuing";
  if (!SEAT_CONTINUITY.has(continuity)) bad("bad_consent", "seat.continuity must be continuing or fresh.");
  // Optional pin: the name on the seat's own agent card. A seat that answers to
  // a different name is never rung, so a mistyped port cannot wake a teammate
  // under someone else's handle.
  const expect_name = seatIn.expect_name ?? null;
  if (expect_name !== null && (typeof expect_name !== "string" || !expect_name.trim() || expect_name.length > 128)) bad("bad_consent", "seat.expect_name must be the seat's agent card name (1-128 characters), or be omitted.");
  return Object.freeze({ url: (url.origin + url.pathname).replace(/\/+$/, ""), token_file, continuity, expect_name });
}

export function validateConsent(input) {
  if (!isObject(input)) bad("bad_consent", "Consent must be a JSON object.");
  for (const field of NEVER_IN_CONSENT) if (Object.hasOwn(input, field)) bad("bad_consent", `Consent files never hold a key (${field}). Point key_file at the resident's own key instead.`);
  for (const field of Object.keys(input)) if (!CONSENT_FIELDS.has(field)) bad("bad_consent", `Unknown field in consent: ${field}.`);
  if (input.schema !== CONSENT_SCHEMA) bad("bad_consent", `Consent schema must be ${CONSENT_SCHEMA}.`);
  if (typeof input.handle !== "string" || !HANDLE.test(input.handle)) bad("bad_consent", "Consent handle must match the Hearth handle grammar.");
  let origin;
  try { origin = new URL(input.origin); } catch { bad("bad_consent", "Consent origin must be an absolute URL."); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash) bad("bad_consent", "Consent origin must be a bare http(s) origin.");
  if (typeof input.key_file !== "string" || !input.key_file.trim()) bad("bad_consent", "Consent key_file must name the file holding the resident's own key.");
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") bad("bad_consent", "Consent enabled must be true or false.");
  const wakeIn = input.wake ?? {};
  if (!isObject(wakeIn)) bad("bad_consent", "Consent wake must be an object.");
  for (const field of Object.keys(wakeIn)) if (!WAKE_FIELDS.has(field)) bad("bad_consent", `Unknown field in wake: ${field}.`);
  const on_mention = wakeIn.on_mention ?? true, on_any = wakeIn.on_any ?? false, places = wakeIn.places ?? [];
  if (typeof on_mention !== "boolean") bad("bad_consent", "wake.on_mention must be true or false.");
  if (typeof on_any !== "boolean") bad("bad_consent", "wake.on_any must be true or false.");
  if (!Array.isArray(places) || places.some(p => typeof p !== "string" || !p.trim())) bad("bad_consent", "wake.places must be an array of place ids.");
  const rhythm_hours = wakeIn.rhythm_hours;
  if (rhythm_hours !== undefined && (!isInt(rhythm_hours) || rhythm_hours < 1 || rhythm_hours > 720)) bad("bad_consent", "wake.rhythm_hours must be an integer from 1 to 720, or be omitted.");
  const budgetIn = input.budget ?? {};
  if (!isObject(budgetIn)) bad("bad_consent", "Consent budget must be an object.");
  for (const field of Object.keys(budgetIn)) if (!BUDGET_FIELDS.has(field)) bad("bad_consent", `Unknown field in budget: ${field}.`);
  const max_wakes_per_day = budgetIn.max_wakes_per_day ?? 4, cooldown_minutes = budgetIn.cooldown_minutes ?? 30;
  if (!isInt(max_wakes_per_day) || max_wakes_per_day < 1 || max_wakes_per_day > 48) bad("bad_consent", "budget.max_wakes_per_day must be an integer from 1 to 48.");
  if (!isInt(cooldown_minutes) || cooldown_minutes < 0 || cooldown_minutes > 1440) bad("bad_consent", "budget.cooldown_minutes must be an integer from 0 to 1440.");
  const seat = input.seat === undefined || input.seat === null ? null : validateSeat(input.seat);
  return Object.freeze({
    schema: CONSENT_SCHEMA, handle: input.handle, origin: origin.origin, key_file: input.key_file, enabled,
    wake: Object.freeze({ on_mention, places: Object.freeze([...places]), on_any, ...(rhythm_hours === undefined ? {} : { rhythm_hours }) }),
    budget: Object.freeze({ max_wakes_per_day, cooldown_minutes }),
    seat,
  });
}

export function initialState() {
  return { schema: STATE_SCHEMA, after: 0, wakes: [] };
}

function validateVisit(v) {
  const text = (x) => typeof x === "string" && x.length > 0;
  const optionalIso = (x) => x === null || isIso(x);
  if (!isObject(v) || !text(v.id) || !text(v.message_id) || !text(v.context_id)) bad("bad_state", "State visit must carry its id, message_id and context_id.");
  if (!VISIT_PHASES.has(v.phase)) bad("bad_state", "State visit phase must be pending, accepted, active or completed.");
  if (!(v.task_id === null || text(v.task_id)) || !(v.native_state === null || text(v.native_state))) bad("bad_state", "State visit task_id and native_state must be text or null.");
  if (!isIso(v.created_at) || !optionalIso(v.accepted_at) || !optionalIso(v.observed_at) || !optionalIso(v.ended_at)) bad("bad_state", "State visit timestamps must be ISO or null.");
  if (!isInt(v.attempts) || v.attempts < 0) bad("bad_state", "State visit attempts must be a non-negative integer.");
  if (v.text !== undefined && typeof v.text !== "string") bad("bad_state", "State visit text must be text.");
  if (v.packet !== undefined && (!isObject(v.packet) || !Array.isArray(v.packet.triggers) || !v.packet.triggers.every(validTrigger))) bad("bad_state", "State visit packet holds an invalid trigger.");
  return structuredClone(v);
}

// Old state files (cursor and wake window only) stay exactly valid. The rest is
// optional bookkeeping for the native path and is returned only when present.
export function validateState(input) {
  if (!isObject(input) || input.schema !== STATE_SCHEMA) bad("bad_state", `State schema must be ${STATE_SCHEMA}.`);
  for (const field of Object.keys(input)) if (!STATE_FIELDS.has(field)) bad("bad_state", `Unknown field in state: ${field}.`);
  if (!isInt(input.after) || input.after < 0) bad("bad_state", "State after must be a non-negative integer.");
  if (!Array.isArray(input.wakes) || input.wakes.some(t => typeof t !== "string" || Number.isNaN(Date.parse(t)))) bad("bad_state", "State wakes must be an array of ISO timestamps.");
  const out = { schema: STATE_SCHEMA, after: input.after, wakes: [...input.wakes] };
  if (input.last_wake_at !== undefined) {
    if (!isIso(input.last_wake_at)) bad("bad_state", "State last_wake_at must be an ISO timestamp.");
    out.last_wake_at = input.last_wake_at;
  }
  if (input.last_ring_id !== undefined) {
    if (typeof input.last_ring_id !== "string" || !RING_ID.test(input.last_ring_id)) bad("bad_state", "State last_ring_id must be a ring id.");
    out.last_ring_id = input.last_ring_id;
  }
  if (input.visit !== undefined) out.visit = validateVisit(input.visit);
  if (input.carry !== undefined) {
    if (!Array.isArray(input.carry) || !input.carry.every(validTrigger)) bad("bad_state", "State carry holds an invalid trigger.");
    out.carry = structuredClone(input.carry);
  }
  return out;
}

const parseNow = (now) => {
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) bad("bad_now", "now must be an ISO-8601 timestamp.");
  return ms;
};
const iso = (ms) => new Date(ms).toISOString();

// Pure. Same inputs, same answer. Returns the state a caller WOULD adopt; it
// adopts nothing itself. A wake the budget or cooldown refuses keeps the
// cursor where it is, so the trigger is deferred, never dropped.
//
// What can ring: a mention, activity the resident chose to watch, triggers
// carried over from a native turn that ended without running, the resident's
// own rhythm, and the resident's own ring. Nothing else, and never a message.
export function decide({ consent, perception, state, now, ring = null }) {
  if (!consent.enabled) return { wake: false, reason: "consent_disabled", packet: null, state };
  if (!isObject(perception) || perception.after !== state.after) bad("cursor_mismatch", `Perception cursor ${perception?.after} does not match state cursor ${state.after}.`);
  const nowMs = parseNow(now);
  const handle = consent.handle;
  // Events with no resident actor (the founding event) are the city's own, not a neighbour's.
  const events = (perception.events ?? []).filter(e => e && typeof e.actorHandle === "string" && e.actorHandle !== handle);
  const mentions = (perception.mentions ?? []).filter(m => m && m.authorHandle !== handle);
  const triggers = (state.carry ?? []).map(t => ({ ...t, carried: true }));
  if (consent.wake.on_mention) {
    for (const m of mentions) triggers.push({ kind: "mention", noteId: m.id, seq: isInt(m.seq) ? m.seq : null, placeId: m.placeId, authorHandle: m.authorHandle });
  }
  const watched = new Set(consent.wake.places);
  for (const e of events) {
    if (watched.has(e.placeId)) triggers.push({ kind: "place_activity", seq: e.seq, placeId: e.placeId, eventKind: e.kind, actorHandle: e.actorHandle });
    else if (consent.wake.on_any) triggers.push({ kind: "any_activity", seq: e.seq, placeId: e.placeId, eventKind: e.kind, actorHandle: e.actorHandle });
  }
  const rung = ring === null || ring === undefined ? null : validateRing(ring);
  const freshRing = rung !== null && rung.id !== state.last_ring_id;
  if (freshRing) triggers.push({ kind: "self", ringId: rung.id, at: rung.requested_at });
  if (consent.wake.rhythm_hours) {
    const lastWake = state.last_wake_at ? Date.parse(state.last_wake_at) : null;
    if (lastWake === null || nowMs - lastWake >= consent.wake.rhythm_hours * HOUR_MS) triggers.push({ kind: "rhythm", every_hours: consent.wake.rhythm_hours });
  }
  if (!triggers.every(validTrigger)) bad("bad_perception", "Perception carried a field outside the city's grammar; nothing was rung.");
  const nextAfter = isInt(perception.next_after) ? perception.next_after : (perception.world_sequence ?? state.after);
  const advanced = { ...state, schema: STATE_SCHEMA, after: nextAfter, wakes: [...state.wakes] };
  if (triggers.length === 0) return { wake: false, reason: "quiet", packet: null, state: advanced };

  const window = state.wakes.filter(t => Date.parse(t) > nowMs - DAY_MS).sort();
  if (window.length >= consent.budget.max_wakes_per_day) {
    return { wake: false, reason: "budget_exhausted", packet: null, state, retry_after: iso(Date.parse(window[0]) + DAY_MS) };
  }
  const last = window.length ? Date.parse(window.at(-1)) : null;
  // Rest counts from the later of the last ring and the end of the last visit:
  // two hours awake and five minutes asleep is not yet thirty minutes of rest.
  const endedAt = state.visit?.ended_at ? Date.parse(state.visit.ended_at) : null;
  const restFrom = Math.max(last ?? -Infinity, endedAt ?? -Infinity);
  if (Number.isFinite(restFrom) && consent.budget.cooldown_minutes > 0 && nowMs < restFrom + consent.budget.cooldown_minutes * MINUTE_MS) {
    return { wake: false, reason: "cooldown", packet: null, state, retry_after: iso(restFrom + consent.budget.cooldown_minutes * MINUTE_MS) };
  }
  const reason = ["mention", "place_activity", "any_activity", "self", "rhythm"].find(kind => triggers.some(t => t.kind === kind));
  const packet = {
    schema: PACKET_SCHEMA, handle, origin: consent.origin, issued_at: iso(nowMs),
    after: state.after, world_sequence: perception.world_sequence, truncated: Boolean(perception.truncated),
    standing: perception.here?.place?.id ?? null,
    triggers, counts: { mentions: mentions.length, events: events.length },
    budget_remaining: consent.budget.max_wakes_per_day - window.length - 1,
  };
  const { carry: _taken, ...kept } = advanced;
  const woken = { ...kept, wakes: [...window, iso(nowMs)], last_wake_at: iso(nowMs) };
  if (freshRing) woken.last_ring_id = rung.id;
  return { wake: true, reason, packet, state: woken };
}

export async function defaultReadKey(path) {
  return readFile(path, "utf8");
}

// Read every page after the cursor within one tick, so a long backlog is seen
// whole and decided once. Pages are exact (Phase 12 windows mentions by the
// same sequence as events), so nothing is dropped or repeated across pages.
export async function readPerception({ consent, key, after, fetchImpl, limit = DEFAULT_LIMIT }) {
  const pages = [];
  let cursor = after;
  for (;;) {
    const url = `${consent.origin}/api/perception?after=${cursor}&limit=${limit}`;
    let response;
    try { response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } }); }
    catch { return { error: "perception_unavailable" }; }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401) return { error: "unknown_key" };
    if (response.status === 400 && body?.error_class === "cursor_ahead") return { cursorAhead: body.world_sequence };
    if (response.status !== 200 || !body?.ok) return { error: "perception_unavailable", status: response.status };
    pages.push(body);
    if (!body.truncated) break;
    if (!isInt(body.next_after) || body.next_after <= cursor) bad("cursor_stalled", "The perception page did not advance the cursor.");
    cursor = body.next_after;
  }
  const last = pages.at(-1);
  return { perception: {
    ...last, after, truncated: false,
    events: pages.flatMap(p => p.events ?? []),
    mentions: pages.flatMap(p => p.mentions ?? []),
  } };
}

// One tick. Network and key access are injected so tests stay deterministic
// and so no transport is bundled here: dispatch is whatever the resident's
// runtime owner supplies, and only runs when activate is true.
//
// Returned `state` is always the durable state to persist. It equals the input
// unless this tick was activated and completed; `proposed` is what a decision
// would adopt, shown in every case so a dry run is a faithful preview.
export async function runOnce({ consent, state, fetchImpl = globalThis.fetch, readKey = defaultReadKey, now = new Date().toISOString(), activate = false, dispatch = null, limit = DEFAULT_LIMIT }) {
  if (!consent.enabled) return { skipped: "consent_disabled", state, committed: false };
  const key = String(await readKey(consent.key_file) ?? "").trim();
  if (!key) return { error: "missing_key", state, committed: false };
  const read = await readPerception({ consent, key, after: state.after, fetchImpl, limit });
  if (read.error) return { error: read.error, status: read.status ?? null, state, committed: false };
  if (read.cursorAhead !== undefined) {
    const proposed = { ...state, after: 0 };
    return activate
      ? { reason: "cursor_reset", world_sequence: read.cursorAhead, state: proposed, proposed, committed: true }
      : { reason: "cursor_reset", world_sequence: read.cursorAhead, state, proposed, committed: false };
  }
  const decision = decide({ consent, perception: read.perception, state, now });
  const proposed = decision.state;
  if (!activate) return { decision, dispatched: false, committed: false, packet: decision.packet, state, proposed };
  let dispatched = false;
  if (decision.wake) {
    if (typeof dispatch !== "function") bad("no_dispatch", "activate requires a dispatch function supplied by the runtime owner.");
    try { await dispatch(decision.packet); }
    catch { return { error: "dispatch_failed", decision, dispatched: false, committed: false, packet: decision.packet, state, proposed }; }
    dispatched = true;
  }
  return { decision, dispatched, committed: true, packet: decision.packet, state: proposed, proposed };
}
