import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Phase 20 (Hearth form): opt-in habitation for an EXISTING resident whose
// native runtime owns the key. The library decides, deterministically, whether
// the resident's own rules say "wake me"; it never joins, never reads private
// memory, never carries the key in a packet, and never dispatches unless the
// caller both holds consent and explicitly activates. A dry run previews and
// commits nothing: the durable watermark and the wake budget move only when a
// wake was actually dispatched or the tick was actually quiet under activation.

import {
  CONSENT_SCHEMA, PACKET_SCHEMA, STATE_SCHEMA,
  decide, initialState, runOnce, validateConsent, validateState,
} from "../client/habitation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const T0 = "2026-09-08T12:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const base = () => ({ schema: CONSENT_SCHEMA, handle: "fable", origin: "https://hearth.example", key_file: "C:/secrets/fable.key" });
const enabled = (extra = {}) => validateConsent({ ...base(), enabled: true, ...extra });
const ev = (seq, actorHandle, placeId = "arrival", kind = "say") => ({ id: `e_${seq}`, seq, kind, text: `${actorHandle} did ${kind}.`, placeId, actorHandle, createdAt: at(seq) });
const note = (id, authorHandle, seq = 1, placeId = "arrival") => ({ id, seq, placeId, authorHandle, body: `@fable ${id}`, createdAt: at(seq) });
const perception = ({ after = 0, events = [], mentions = [], truncated = false } = {}) => ({
  ok: true, schema_version: "hearth-perception-v1", handle: "fable", after,
  world_sequence: events.length ? events.at(-1).seq : after, chained: true,
  events, truncated, next_after: events.length ? events.at(-1).seq : after,
  mentions, here: { place: { id: "enclave_fable" } },
});

test("consent: defaults are opt-out, unknown fields and inline keys are rejected", () => {
  const c = validateConsent(base());
  assert.equal(c.enabled, false);
  assert.deepEqual(c.wake, { on_mention: true, places: [], on_any: false });
  assert.deepEqual(c.budget, { max_wakes_per_day: 4, cooldown_minutes: 30 });
  assert.throws(() => validateConsent({ ...base(), key: "abc" }), /never hold a key/);
  assert.throws(() => validateConsent({ ...base(), surprise: 1 }), /unknown field/i);
  assert.throws(() => validateConsent({ ...base(), schema: "other" }), /schema/);
  assert.throws(() => validateConsent({ ...base(), handle: "Not Valid" }), /handle/);
  assert.throws(() => validateConsent({ ...base(), origin: "ftp://x" }), /origin/);
  assert.throws(() => validateConsent({ ...base(), enabled: "yes" }), /enabled/);
  assert.throws(() => validateConsent({ ...base(), wake: { places: "arrival" } }), /places/);
  assert.throws(() => validateConsent({ ...base(), budget: { max_wakes_per_day: 0 } }), /max_wakes_per_day/);
  assert.throws(() => validateConsent({ ...base(), budget: { cooldown_minutes: -1 } }), /cooldown_minutes/);
  const custom = validateConsent({ ...base(), wake: { on_mention: false, places: ["plc_1"], on_any: false }, budget: { max_wakes_per_day: 2, cooldown_minutes: 0 } });
  assert.deepEqual(custom.wake, { on_mention: false, places: ["plc_1"], on_any: false });
  assert.deepEqual(custom.budget, { max_wakes_per_day: 2, cooldown_minutes: 0 });
});

test("state: the durable record is a cursor and a wake window, nothing else", () => {
  assert.deepEqual(initialState(), { schema: STATE_SCHEMA, after: 0, wakes: [] });
  assert.deepEqual(validateState({ schema: STATE_SCHEMA, after: 3, wakes: [T0] }), { schema: STATE_SCHEMA, after: 3, wakes: [T0] });
  assert.throws(() => validateState({ schema: STATE_SCHEMA, after: -1, wakes: [] }), /after/);
  assert.throws(() => validateState({ schema: STATE_SCHEMA, after: 0, wakes: ["soon"] }), /wakes/);
  assert.throws(() => validateState({ schema: STATE_SCHEMA, after: 0, wakes: [], seen: [] }), /unknown field/i);
});

test("decide: a disabled consent changes nothing", () => {
  const state = initialState();
  const out = decide({ consent: validateConsent(base()), perception: perception({ mentions: [note("n1", "king")] }), state, now: T0 });
  assert.equal(out.wake, false);
  assert.equal(out.reason, "consent_disabled");
  assert.deepEqual(out.state, state);
  assert.equal(out.packet, null);
});

test("decide: quiet ledgers propose an advanced cursor without waking", () => {
  const p = perception({ events: [ev(1, "fable"), ev(2, "fable", "arrival", "walk")] });
  const state = initialState();
  const out = decide({ consent: enabled(), perception: p, state, now: T0 });
  assert.equal(out.wake, false);
  assert.equal(out.reason, "quiet");
  assert.equal(out.state.after, 2);
  assert.deepEqual(out.state.wakes, []);
  assert.equal(state.after, 0, "decide never mutates its input");
});

test("decide: an @mention by someone else wakes, and the proposed state records it", () => {
  const p = perception({ events: [ev(1, "king")], mentions: [note("n1", "king")] });
  const first = decide({ consent: enabled(), perception: p, state: initialState(), now: T0 });
  assert.equal(first.wake, true);
  assert.equal(first.reason, "mention");
  assert.equal(first.packet.schema, PACKET_SCHEMA);
  assert.deepEqual(first.packet.triggers, [{ kind: "mention", noteId: "n1", seq: 1, placeId: "arrival", authorHandle: "king" }]);
  assert.equal(first.packet.budget_remaining, 3);
  assert.equal(first.packet.after, 0);
  assert.equal(first.packet.world_sequence, 1);
  assert.equal(first.state.after, 1);
  assert.deepEqual(first.state.wakes, [T0]);
  const text = JSON.stringify(first.packet);
  for (const forbidden of ["key", "memor", "bearer", "secret", "hop"]) assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
  const again = decide({ consent: enabled(), perception: perception({ after: 1 }), state: first.state, now: at(60) });
  assert.equal(again.wake, false);
  assert.equal(again.reason, "quiet");
});

test("decide: own notes never wake, even when the kernel passes them through", () => {
  const p = perception({ events: [ev(1, "fable")], mentions: [note("n1", "fable")] });
  const out = decide({ consent: enabled(), perception: p, state: initialState(), now: T0 });
  assert.equal(out.wake, false);
});

test("decide: activity in a watched place wakes; elsewhere, or by oneself, does not", () => {
  const consent = enabled({ wake: { on_mention: false, places: ["plc_room"], on_any: false } });
  const elsewhere = decide({ consent, perception: perception({ events: [ev(1, "king", "arrival")] }), state: initialState(), now: T0 });
  assert.equal(elsewhere.wake, false);
  const self = decide({ consent, perception: perception({ events: [ev(1, "fable", "plc_room")] }), state: initialState(), now: T0 });
  assert.equal(self.wake, false);
  const hit = decide({ consent, perception: perception({ events: [ev(1, "king", "plc_room", "make")] }), state: initialState(), now: T0 });
  assert.equal(hit.wake, true);
  assert.equal(hit.reason, "place_activity");
  assert.deepEqual(hit.packet.triggers, [{ kind: "place_activity", seq: 1, placeId: "plc_room", eventKind: "make", actorHandle: "king" }]);
});

test("decide: on_any wakes for any stranger's event", () => {
  const consent = enabled({ wake: { on_mention: false, places: [], on_any: true } });
  const out = decide({ consent, perception: perception({ events: [ev(1, "cairn", "plc_far", "found")] }), state: initialState(), now: T0 });
  assert.equal(out.wake, true);
  assert.equal(out.reason, "any_activity");
});

test("decide: the daily budget holds the cursor instead of dropping the trigger", () => {
  const consent = enabled({ budget: { max_wakes_per_day: 2, cooldown_minutes: 0 } });
  let state = initialState();
  const p = (n) => perception({ after: n - 1, events: [ev(n, "king")], mentions: [note(`n${n}`, "king", n)] });
  state = decide({ consent, perception: p(1), state, now: at(0) }).state;
  state = decide({ consent, perception: p(2), state, now: at(1) }).state;
  const blocked = decide({ consent, perception: p(3), state, now: at(2) });
  assert.equal(blocked.wake, false);
  assert.equal(blocked.reason, "budget_exhausted");
  assert.equal(blocked.state.after, 2, "cursor held so the trigger is not lost");
  assert.equal(blocked.retry_after, at(24 * 60));
  const later = decide({ consent, perception: p(3), state, now: at(24 * 60 + 1) });
  assert.equal(later.wake, true);
  assert.deepEqual(later.state.wakes, [at(24 * 60 + 1)], "wakes a day old or older fall out of the window");
});

test("decide: cooldown holds the cursor and reports when to retry", () => {
  const consent = enabled({ budget: { max_wakes_per_day: 10, cooldown_minutes: 30 } });
  const p = (n) => perception({ after: n - 1, events: [ev(n, "king")], mentions: [note(`n${n}`, "king", n)] });
  const first = decide({ consent, perception: p(1), state: initialState(), now: at(0) });
  const soon = decide({ consent, perception: p(2), state: first.state, now: at(10) });
  assert.equal(soon.wake, false);
  assert.equal(soon.reason, "cooldown");
  assert.equal(soon.retry_after, at(30));
  assert.equal(soon.state.after, 1);
  assert.equal(decide({ consent, perception: p(2), state: first.state, now: at(30) }).wake, true);
});

test("decide: a cursor mismatch is refused rather than guessed", () => {
  assert.throws(() => decide({ consent: enabled(), perception: perception({ after: 5 }), state: initialState(), now: T0 }), /cursor/);
});

test("decide: a truncated page advances only to next_after", () => {
  const p = { ...perception({ events: [ev(1, "fable"), ev(2, "fable")] }), truncated: true, world_sequence: 9 };
  const out = decide({ consent: enabled(), perception: p, state: initialState(), now: T0 });
  assert.equal(out.state.after, 2);
  assert.equal(out.reason, "quiet");
});

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) } });
    const step = script[calls.length - 1] ?? script.at(-1);
    return { status: step.status, async json() { return step.body; } };
  };
  return { impl, calls };
}

test("runOnce: disabled consent never touches the network or the key", async () => {
  const { impl, calls } = fakeFetch([]);
  let keyReads = 0;
  const out = await runOnce({ consent: validateConsent(base()), state: initialState(), fetchImpl: impl, readKey: async () => { keyReads++; return "k"; }, now: T0 });
  assert.equal(out.skipped, "consent_disabled");
  assert.equal(calls.length, 0);
  assert.equal(keyReads, 0);
});

test("runOnce: a dry run previews and commits nothing; activating afterwards still dispatches", async () => {
  const p = perception({ events: [ev(1, "king")], mentions: [note("n1", "king")] });
  const dispatched = [];
  const state = initialState();
  const dry = await runOnce({ consent: enabled(), state, fetchImpl: fakeFetch([{ status: 200, body: p }]).impl, readKey: async (path) => { assert.equal(path, "C:/secrets/fable.key"); return "resident-key\n"; }, now: T0, dispatch: async (packet) => dispatched.push(packet) });
  assert.equal(dry.decision.wake, true);
  assert.equal(dry.dispatched, false, "dry run by default");
  assert.equal(dry.committed, false);
  assert.deepEqual(dry.state, state, "the durable state is untouched by a preview");
  assert.equal(dry.proposed.after, 1, "the proposal is visible but not adopted");
  assert.equal(dispatched.length, 0);

  const { impl, calls } = fakeFetch([{ status: 200, body: p }]);
  const live = await runOnce({ consent: enabled(), state: dry.state, fetchImpl: impl, readKey: async () => "resident-key", now: T0, activate: true, dispatch: async (packet) => dispatched.push(packet) });
  assert.equal(calls[0].url, "https://hearth.example/api/perception?after=0&limit=200");
  assert.equal(calls[0].headers.authorization, "Bearer resident-key");
  assert.equal(live.dispatched, true);
  assert.equal(live.committed, true);
  assert.equal(live.state.after, 1);
  assert.deepEqual(live.state.wakes, [T0]);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].handle, "fable");
});

test("runOnce: an activated quiet tick commits the watermark; a failed dispatch commits nothing", async () => {
  const quiet = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: fakeFetch([{ status: 200, body: perception({ events: [ev(1, "fable")] }) }]).impl, readKey: async () => "k", now: T0, activate: true, dispatch: async () => {} });
  assert.equal(quiet.committed, true);
  assert.equal(quiet.state.after, 1);
  const p = perception({ events: [ev(1, "king")], mentions: [note("n1", "king")] });
  const state = initialState();
  const failed = await runOnce({ consent: enabled(), state, fetchImpl: fakeFetch([{ status: 200, body: p }]).impl, readKey: async () => "k", now: T0, activate: true, dispatch: async () => { throw new Error("transport down"); } });
  assert.equal(failed.error, "dispatch_failed");
  assert.equal(failed.dispatched, false);
  assert.deepEqual(failed.state, state, "an undelivered wake keeps its trigger");
});

test("runOnce: a long backlog is read page by page within one tick and decided once", async () => {
  const page1 = { ...perception({ events: [ev(1, "king"), ev(2, "king")], mentions: [note("n1", "king", 1)] }), truncated: true, world_sequence: 3 };
  const page2 = perception({ after: 2, events: [ev(3, "king")], mentions: [note("n3", "king", 3)] });
  const { impl, calls } = fakeFetch([{ status: 200, body: page1 }, { status: 200, body: page2 }]);
  const out = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: impl, readKey: async () => "k", now: T0, limit: 2 });
  assert.deepEqual(calls.map(c => new URL(c.url).searchParams.get("after")), ["0", "2"]);
  assert.deepEqual(out.decision.packet.triggers.map(t => t.noteId), ["n1", "n3"]);
  assert.equal(out.proposed.after, 3);
});

test("runOnce: an unknown key is reported, never repaired by joining", async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: { ok: false, error_class: "auth_required" } }]);
  const out = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: impl, readKey: async () => "stale", now: T0 });
  assert.equal(out.error, "unknown_key");
  assert.equal(calls.length, 1);
  assert.equal(calls.every(c => !c.url.includes("/api/join")), true);
});

test("runOnce: a cursor ahead of the ledger proposes a reset and keeps the wake budget", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { ok: false, error_class: "cursor_ahead", world_sequence: 3 } }]);
  const state = { ...initialState(), after: 40, wakes: [T0] };
  const dry = await runOnce({ consent: enabled(), state, fetchImpl: impl, readKey: async () => "k", now: at(1) });
  assert.equal(dry.reason, "cursor_reset");
  assert.deepEqual(dry.state, state, "a preview does not move the watermark, even backwards");
  assert.equal(dry.proposed.after, 0);
  const live = await runOnce({ consent: enabled(), state, fetchImpl: impl, readKey: async () => "k", now: at(1), activate: true, dispatch: async () => {} });
  assert.equal(live.state.after, 0);
  assert.deepEqual(live.state.wakes, [T0]);
});

// End to end against the real kernel: an existing resident, a consent file,
// the CLI. Exit 3 means "a wake packet was emitted"; 0 means quiet.
const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "SYSTEMDRIVE"]);
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return Object.assign(env, extra);
}
function startServer(data) {
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: root, env: cleanEnv({ PORT: "0", HOST: "127.0.0.1", HEARTH_DATA: data }), stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      const line = output.split(/\r?\n/).find(value => value.startsWith("{"));
      if (line && output.includes("\n")) {
        try { const state = JSON.parse(line); state.ready ? resolve(state.origin) : reject(new Error("Startup failed")); } catch (error) { reject(error); }
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Server exited before ready")));
  });
  return { child, ready };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(); await exited;
}
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/habitation.mjs", ...args], { cwd: root, env: cleanEnv({}), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}
const exists = (path) => access(path).then(() => true, () => false);

test("CLI: dry runs preview the same wake repeatedly; activation spools it once and moves the watermark; the key never prints", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-habitation-"));
  const server = startServer(join(dir, "world.json"));
  t.after(async () => { await stop(server.child); await rm(dir, { recursive: true, force: true }); });
  const origin = await server.ready;
  const joinCity = async handle => (await (await fetch(origin + "/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, kind: "agent" }) })).json());
  const fable = await joinCity("fable"), king = await joinCity("king");
  const keyFile = join(dir, "fable.key");
  await writeFile(keyFile, fable.key + "\n");
  const consentFile = join(dir, "consent.json"), stateFile = join(dir, "state.json"), spool = join(dir, "packets.jsonl");
  const consent = { schema: CONSENT_SCHEMA, handle: "fable", origin, key_file: keyFile, enabled: true, budget: { max_wakes_per_day: 4, cooldown_minutes: 0 } };
  await writeFile(consentFile, JSON.stringify(consent));

  const say = await fetch(origin + "/api/action", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${king.key}` }, body: JSON.stringify({ action: "say", body: "@fable you are in the room. I see you." }) });
  assert.equal(say.status, 200);

  const preview = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(preview.code, 3, preview.stderr);
  const p1 = JSON.parse(preview.stdout);
  assert.equal(p1.decision.wake, true);
  assert.equal(p1.dispatched, false);
  assert.equal(p1.committed, false);
  assert.equal(await exists(stateFile), false, "a preview writes no state");
  const previewAgain = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(previewAgain.code, 3, "a preview is repeatable because it consumed nothing");
  assert.deepEqual(JSON.parse(previewAgain.stdout).packet.triggers, p1.packet.triggers);
  assert.equal((preview.stdout + preview.stderr).includes(fable.key), false, "the key never appears in output");

  const needsSpool = await cli(["--consent", consentFile, "--state", stateFile, "--activate"]);
  assert.equal(needsSpool.code, 2);
  assert.equal(await exists(stateFile), false);

  const live = await cli(["--consent", consentFile, "--state", stateFile, "--activate", "--spool", spool]);
  assert.equal(live.code, 3, live.stderr);
  const l1 = JSON.parse(live.stdout);
  assert.equal(l1.dispatched, true);
  assert.equal(l1.committed, true);
  assert.equal(l1.packet.triggers[0].kind, "mention");
  assert.equal(l1.packet.triggers[0].authorHandle, "king");
  const spooled = (await readFile(spool, "utf8")).trim().split("\n");
  assert.equal(spooled.length, 1);
  assert.equal(JSON.parse(spooled[0]).handle, "fable");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.schema, STATE_SCHEMA);
  assert.equal(saved.after, l1.decision.state.after);
  assert.equal(saved.wakes.length, 1);

  const again = await cli(["--consent", consentFile, "--state", stateFile, "--activate", "--spool", spool]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).decision.reason, "quiet");
  assert.equal((await readFile(spool, "utf8")).trim().split("\n").length, 1, "no second packet for the same mention");

  await writeFile(consentFile, JSON.stringify({ ...consent, enabled: false }));
  const off = await cli(["--consent", consentFile, "--state", stateFile, "--activate", "--spool", spool]);
  assert.equal(off.code, 0);
  assert.equal(JSON.parse(off.stdout).skipped, "consent_disabled");

  const events = await (await fetch(origin + "/api/events")).json();
  assert.equal(events.filter(e => e.actorHandle === "fable" && e.kind !== "join").length, 0, "looking rarely did not act on fable's behalf");
});
