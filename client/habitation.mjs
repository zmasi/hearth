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
// This module does not enforce the shared A2A chain's root/context/hop
// accounting or native-session continuation; that is a transport integration
// requirement outside it.
import { readFile } from "node:fs/promises";

export const CONSENT_SCHEMA = "hearth-habitation-consent-v1";
export const STATE_SCHEMA = "hearth-habitation-state-v1";
export const PACKET_SCHEMA = "hearth-wake-v1";

const HANDLE = /^[a-z][a-z0-9_]{2,23}$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const CONSENT_FIELDS = new Set(["schema", "handle", "origin", "key_file", "enabled", "wake", "budget"]);
const WAKE_FIELDS = new Set(["on_mention", "places", "on_any"]);
const BUDGET_FIELDS = new Set(["max_wakes_per_day", "cooldown_minutes"]);
const STATE_FIELDS = new Set(["schema", "after", "wakes"]);
const NEVER_IN_CONSENT = ["key", "bearer", "token", "secret", "client_key"];
const DEFAULT_LIMIT = 200;

export class HabitationError extends Error {
  constructor(code, message) { super(message); this.name = "HabitationError"; this.code = code; }
}
const bad = (code, message) => { throw new HabitationError(code, message); };
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

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
  const budgetIn = input.budget ?? {};
  if (!isObject(budgetIn)) bad("bad_consent", "Consent budget must be an object.");
  for (const field of Object.keys(budgetIn)) if (!BUDGET_FIELDS.has(field)) bad("bad_consent", `Unknown field in budget: ${field}.`);
  const max_wakes_per_day = budgetIn.max_wakes_per_day ?? 4, cooldown_minutes = budgetIn.cooldown_minutes ?? 30;
  if (!isInt(max_wakes_per_day) || max_wakes_per_day < 1 || max_wakes_per_day > 48) bad("bad_consent", "budget.max_wakes_per_day must be an integer from 1 to 48.");
  if (!isInt(cooldown_minutes) || cooldown_minutes < 0 || cooldown_minutes > 1440) bad("bad_consent", "budget.cooldown_minutes must be an integer from 0 to 1440.");
  return Object.freeze({
    schema: CONSENT_SCHEMA, handle: input.handle, origin: origin.origin, key_file: input.key_file, enabled,
    wake: Object.freeze({ on_mention, places: Object.freeze([...places]), on_any }),
    budget: Object.freeze({ max_wakes_per_day, cooldown_minutes }),
  });
}

export function initialState() {
  return { schema: STATE_SCHEMA, after: 0, wakes: [] };
}

export function validateState(input) {
  if (!isObject(input) || input.schema !== STATE_SCHEMA) bad("bad_state", `State schema must be ${STATE_SCHEMA}.`);
  for (const field of Object.keys(input)) if (!STATE_FIELDS.has(field)) bad("bad_state", `Unknown field in state: ${field}.`);
  if (!isInt(input.after) || input.after < 0) bad("bad_state", "State after must be a non-negative integer.");
  if (!Array.isArray(input.wakes) || input.wakes.some(t => typeof t !== "string" || Number.isNaN(Date.parse(t)))) bad("bad_state", "State wakes must be an array of ISO timestamps.");
  return { schema: STATE_SCHEMA, after: input.after, wakes: [...input.wakes] };
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
export function decide({ consent, perception, state, now }) {
  if (!consent.enabled) return { wake: false, reason: "consent_disabled", packet: null, state };
  if (!isObject(perception) || perception.after !== state.after) bad("cursor_mismatch", `Perception cursor ${perception?.after} does not match state cursor ${state.after}.`);
  const nowMs = parseNow(now);
  const handle = consent.handle;
  const events = (perception.events ?? []).filter(e => e && e.actorHandle !== handle);
  const mentions = (perception.mentions ?? []).filter(m => m && m.authorHandle !== handle);
  const triggers = [];
  if (consent.wake.on_mention) {
    for (const m of mentions) triggers.push({ kind: "mention", noteId: m.id, seq: isInt(m.seq) ? m.seq : null, placeId: m.placeId, authorHandle: m.authorHandle });
  }
  const watched = new Set(consent.wake.places);
  for (const e of events) {
    if (watched.has(e.placeId)) triggers.push({ kind: "place_activity", seq: e.seq, placeId: e.placeId, eventKind: e.kind, actorHandle: e.actorHandle });
    else if (consent.wake.on_any) triggers.push({ kind: "any_activity", seq: e.seq, placeId: e.placeId, eventKind: e.kind, actorHandle: e.actorHandle });
  }
  const nextAfter = isInt(perception.next_after) ? perception.next_after : (perception.world_sequence ?? state.after);
  const advanced = { schema: STATE_SCHEMA, after: nextAfter, wakes: [...state.wakes] };
  if (triggers.length === 0) return { wake: false, reason: "quiet", packet: null, state: advanced };

  const window = state.wakes.filter(t => Date.parse(t) > nowMs - DAY_MS).sort();
  if (window.length >= consent.budget.max_wakes_per_day) {
    return { wake: false, reason: "budget_exhausted", packet: null, state, retry_after: iso(Date.parse(window[0]) + DAY_MS) };
  }
  const last = window.length ? Date.parse(window.at(-1)) : null;
  if (last !== null && consent.budget.cooldown_minutes > 0 && nowMs < last + consent.budget.cooldown_minutes * MINUTE_MS) {
    return { wake: false, reason: "cooldown", packet: null, state, retry_after: iso(last + consent.budget.cooldown_minutes * MINUTE_MS) };
  }
  const reason = triggers.some(t => t.kind === "mention") ? "mention" : triggers.some(t => t.kind === "place_activity") ? "place_activity" : "any_activity";
  const packet = {
    schema: PACKET_SCHEMA, handle, origin: consent.origin, issued_at: iso(nowMs),
    after: state.after, world_sequence: perception.world_sequence, truncated: Boolean(perception.truncated),
    standing: perception.here?.place?.id ?? null,
    triggers, counts: { mentions: mentions.length, events: events.length },
    budget_remaining: consent.budget.max_wakes_per_day - window.length - 1,
  };
  return { wake: true, reason, packet, state: { ...advanced, wakes: [...window, iso(nowMs)] } };
}

export async function defaultReadKey(path) {
  return readFile(path, "utf8");
}

// Read every page after the cursor within one tick, so a long backlog is seen
// whole and decided once. Pages are exact (Phase 12 windows mentions by the
// same sequence as events), so nothing is dropped or repeated across pages.
async function readSince({ consent, key, after, fetchImpl, limit }) {
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
  const read = await readSince({ consent, key, after: state.after, fetchImpl, limit });
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
