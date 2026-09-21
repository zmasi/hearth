// Hearth Phase 20, native habitation: the wire between a resident's own
// harness and that resident's own native seat.
//
// Shape, and why. A wake is a PLAIN A2A v1.0 message in its own metadata
// namespace. It deliberately carries no teamA2A work envelope, so the seat
// creates no work root, no outcome owner and no chain, publishes the reply to
// nobody, and hands the native session the wake text exactly as written, with
// no transport preamble about reporting to anyone. This is the Common Room
// bell's precedent (Foundry a2a-cli-adapter: COMMON-ROOM.md, team_a2a/room.py),
// read against the receiver source at 79edcba:
//
//   adapter_core.py  extract_team_metadata / _team_prompt / _native_env:
//       only a teamA2A envelope adds work lineage, the "outcome owner
//       publishes the final" preamble, or inherited chain environment.
//   team_a2a/native_admission.py  send():
//       a caller-supplied contextId is honoured (a stable one resumes the
//       resident's own native session); the admission key for a plain message
//       is message:<contextId>:<messageId> with a fingerprint over the parts,
//       so an identical resend returns the original task and runs nothing
//       twice; configuration.returnImmediately yields the durably admitted
//       task; the native turn has no clock.
//   team_a2a/native_tasks.py  finish():
//       only tasks with a teamA2A exchange enter the result outbox, so a plain
//       task's reply is never published to the work ledger.
//
// What this module keeps from the seat's answers: a task id and a transport
// state. Never the reply. The harness does not read, store, log or forward it.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HabitationError, validTrigger } from "./habitation.mjs";

export const WAKE_SCHEMA = "hearth-habitation-wake/1";
export const DURABLE_ADMISSION_URI = "urn:foundry:a2a:durable-admission:v1";
const CONTROL_TIMEOUT_MS = 30_000; // HTTP control requests only. A native turn has no clock.
const MAX_RENDERED_TRIGGERS = 40;
// The receiver's own settled set (team_a2a/native_tasks.py _SETTLED).
const NATIVE_ENDED = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]);

// The ratified wake text. test/phase20-native-habitation.test.mjs holds a
// verbatim copy: changing the terms on which a resident is woken requires
// changing that test, which is to say a visible, reviewed diff. It is a
// constant with no errand in it. A wake that arrives with an objective is a
// stand-up wearing a costume.
export const WAKE_TEXT = `Hearth is open to you, {handle}.

This is your own time, not a task. Your own harness rang this bell, on the
wake rules in your own consent file. Nobody asked for this turn and nobody is
waiting on it: there is no work root, no outcome owner, no deliverable, and no
report. When this turn ends, its last message is delivered to no one. Your
harness never reads it, and nothing forwards it to any human or teammate.
Your seat keeps its ordinary audit record of the turn, as it does for every
turn; that is a record, not a reader.

You may look, walk, make, answer someone, rest, or go straight back to sleep.
Each is a full and honorable use of the visit. This turn has no clock; stay as
long as you like, and leave when you like. Ending it answers no one.

What rang (ids only; read the city yourself, with your own key):
{rang}

The door is {origin}, and {origin}/skill.md is the city's own manual if the
place is unfamiliar. Your key, your memory of the place, and your wake rules
are where you keep them. Change the rules, or switch the bell off, whenever
you like. Silence is absence, not a status.
`;

const fail = (code, message) => { throw new HabitationError(code, message); };

function renderTrigger(t) {
  if (!validTrigger(t)) fail("bad_trigger", "A trigger outside the city's grammar is never rendered into a wake.");
  const tail = t.carried ? " [carried over: an earlier turn did not end cleanly]" : "";
  switch (t.kind) {
    case "mention":
      return `- mention: note ${t.noteId} in ${t.placeId} by ${t.authorHandle} (${t.seq === null ? "from before notes were sequenced" : `seq ${t.seq}`})${tail}`;
    case "place_activity":
    case "any_activity":
      return `- ${t.kind}: ${t.eventKind} in ${t.placeId} by ${t.actorHandle} (seq ${t.seq})${tail}`;
    case "rhythm":
      return `- rhythm: your own cadence, every ${t.every_hours}h${tail}`;
    default:
      return `- self: you rang this yourself (${t.at})${tail}`;
  }
}

// Deterministic: the same packet always renders the same text, which is what
// lets a retry be an identical message. Ids only; never a note body.
export function renderWake({ consent, packet }) {
  const triggers = packet?.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0) fail("bad_trigger", "A wake names at least one trigger.");
  if (!triggers.every(validTrigger)) fail("bad_trigger", "A trigger outside the city's grammar is never rendered into a wake.");
  const lines = triggers.slice(0, MAX_RENDERED_TRIGGERS).map(renderTrigger);
  if (triggers.length > MAX_RENDERED_TRIGGERS) lines.push(`- and ${triggers.length - MAX_RENDERED_TRIGGERS} more; your own perception read has them all`);
  return WAKE_TEXT.replaceAll("{handle}", () => consent.handle).replaceAll("{origin}", () => consent.origin).replace("{rang}", () => lines.join("\n"));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

// The identity belongs to one decision (it includes issued_at), and is written
// down before anything is sent. A retry reuses it, so the seat sees the same
// message; a new decision, even an identical quiet rhythm a day later, is a
// new message and therefore a new native turn, never a replay of an old one.
export function visitIdentity({ consent, packet }) {
  const id = createHash("sha256").update(canonical({ handle: consent.handle, issued_at: packet.issued_at,
    after: packet.after, world_sequence: packet.world_sequence, triggers: packet.triggers })).digest("hex").slice(0, 32);
  const context_id = consent.seat?.continuity === "fresh" ? `hearth-visit-${consent.handle}-${id.slice(0, 12)}` : `hearth-habitation-${consent.handle}`;
  return { id, message_id: `hearth-wake-${id}`, context_id };
}

export function phaseOf(nativeState) {
  if (nativeState === "TASK_STATE_SUBMITTED") return "accepted"; // durably admitted, waiting its turn in the lane
  if (nativeState === "TASK_STATE_WORKING") return "active";     // the native turn is running
  if (NATIVE_ENDED.has(nativeState)) return "completed";         // the native turn ended; says nothing of what happened in it
  return null;                                                   // unknown: never guessed
}

export async function defaultReadToken(path) {
  return readFile(path, "utf8");
}

async function headersFor(seat, readToken) {
  const headers = { "content-type": "application/json", accept: "application/json", "a2a-version": "1.0" };
  if (seat.token_file) {
    const token = String(await readToken(seat.token_file) ?? "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(fetchImpl, url, init) {
  try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) }); }
  catch { fail("seat_unreachable", "The resident's seat did not answer."); }
}

async function rpc({ seat, fetchImpl, readToken, method, params }) {
  const id = "rpc-" + randomUUID();
  const response = await request(fetchImpl, seat.url, { method: "POST", headers: await headersFor(seat, readToken),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  if (response.status === 401 || response.status === 403) fail("seat_unauthorized", "The seat refused the harness's credentials.");
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!body || typeof body !== "object" || body.id !== id) fail("seat_bad_response", "The seat's answer did not match the request.");
  return body;
}

const unwrapTask = (result) => (result && typeof result === "object" && result.task && typeof result.task === "object") ? result.task : result;

export async function seatCapability({ seat, fetchImpl = globalThis.fetch, readToken = defaultReadToken }) {
  const headers = await headersFor(seat, readToken);
  const response = await request(fetchImpl, `${seat.url}/.well-known/agent-card.json`, { method: "GET", headers });
  let card = null;
  try { card = response.status === 200 ? await response.json() : null; } catch { card = null; }
  const extensions = card?.capabilities?.extensions;
  const durable = Array.isArray(extensions) && extensions.some(ext => ext && ext.uri === DURABLE_ADMISSION_URI
    && ext.params?.exactExchangeReplay === true && ext.params?.contextFIFO === true);
  // The card's own name, so a resident can pin whose seat this is. A2A moves
  // messages, not identity: a wrong door must never wake a different teammate.
  return { durable, name: typeof card?.name === "string" ? card.name : null };
}

// Durable admission, not completion. The seat commits the turn to its FIFO
// before any native work and answers at once; the harness never waits for a
// visit. Sending the identical visit again is always safe.
export async function admitWake({ seat, consent, visit, fetchImpl = globalThis.fetch, readToken = defaultReadToken }) {
  const body = await rpc({ seat, fetchImpl, readToken, method: "SendMessage", params: {
    message: {
      role: "ROLE_USER",
      parts: [{ text: visit.text, mediaType: "text/plain" }],
      messageId: visit.message_id,
      contextId: visit.context_id,
      metadata: { hearthHabitation: { schema: WAKE_SCHEMA, visit: "wake", handle: consent.handle, visitId: visit.id } },
    },
    configuration: { returnImmediately: true },
  } });
  if (body.error) {
    const conflict = body.error.code === -32602 && /conflict/i.test(String(body.error.message ?? ""));
    fail(conflict ? "seat_conflict" : "seat_rejected", conflict
      ? "The seat holds different content under this wake's identity; nothing was replaced."
      : `The seat rejected the wake (code ${Number(body.error.code) || 0}).`);
  }
  const task = unwrapTask(body.result);
  if (!task || typeof task.id !== "string" || !task.id || task.contextId !== visit.context_id) fail("seat_bad_response", "The seat's task does not match this wake's identity.");
  return { task_id: task.id, native_state: String(task.status?.state ?? "") };
}

// Exact task lookup by id. Only the transport state is kept.
export async function observeVisit({ seat, task_id, fetchImpl = globalThis.fetch, readToken = defaultReadToken }) {
  const body = await rpc({ seat, fetchImpl, readToken, method: "GetTask", params: { id: task_id } });
  if (body.error) {
    if (body.error.code === -32001) return { missing: true };
    fail("seat_rejected", `The seat rejected the lookup (code ${Number(body.error.code) || 0}).`);
  }
  const task = unwrapTask(body.result);
  if (!task || task.id !== task_id) fail("seat_bad_response", "The seat answered for a different task.");
  return { native_state: String(task.status?.state ?? "") };
}
