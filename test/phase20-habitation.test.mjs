import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Phase 20 (Hearth form): opt-in habitation for an EXISTING resident whose
// native runtime owns the key. The library decides, deterministically, whether
// the resident's own rules say "wake me"; it never joins, never reads private
// memory, never carries the key in a packet, and never dispatches unless the
// caller both holds consent and explicitly activates.

import {
  CONSENT_SCHEMA, PACKET_SCHEMA, STATE_SCHEMA,
  decide, initialState, runOnce, validateConsent,
} from "../client/habitation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const T0 = "2026-09-08T12:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const base = () => ({ schema: CONSENT_SCHEMA, handle: "fable", origin: "https://hearth.example", key_file: "C:/secrets/fable.key" });
const enabled = (extra = {}) => validateConsent({ ...base(), enabled: true, ...extra });
const ev = (seq, actorHandle, placeId = "arrival", kind = "say") => ({ id: `e_${seq}`, seq, kind, text: `${actorHandle} did ${kind}.`, placeId, actorHandle, createdAt: at(seq) });
const note = (id, authorHandle, placeId = "arrival") => ({ id, placeId, authorHandle, body: `@fable ${id}`, createdAt: at(1) });
const perception = ({ after = 0, events = [], mentions = [], truncated = false } = {}) => ({
  ok: true, schema_version: "hearth-perception-v1", handle: "fable", after,
  world_sequence: events.length ? events.at(-1).seq : after, chained: true,
  events, truncated, next_after: events.length ? events.at(-1).seq : after,
  mentions, mentions_truncated: false, mention_boundary: null, here: { place: { id: "enclave_fable" } },
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

test("decide: a disabled consent changes nothing", () => {
  const state = initialState();
  const out = decide({ consent: validateConsent(base()), perception: perception({ mentions: [note("n1", "king")] }), state, now: T0 });
  assert.equal(out.wake, false);
  assert.equal(out.reason, "consent_disabled");
  assert.deepEqual(out.state, state);
  assert.equal(out.packet, null);
});

test("decide: quiet ledgers advance the cursor without waking", () => {
  const p = perception({ events: [ev(1, "fable"), ev(2, "fable", "arrival", "walk")] });
  const out = decide({ consent: enabled(), perception: p, state: initialState(), now: T0 });
  assert.equal(out.wake, false);
  assert.equal(out.reason, "quiet");
  assert.equal(out.state.after, 2);
  assert.deepEqual(out.state.wakes, []);
});

test("decide: an @mention by someone else wakes once, then is remembered", () => {
  const p = perception({ events: [ev(1, "king")], mentions: [note("n1", "king")] });
  const first = decide({ consent: enabled(), perception: p, state: initialState(), now: T0 });
  assert.equal(first.wake, true);
  assert.equal(first.reason, "mention");
  assert.equal(first.packet.schema, PACKET_SCHEMA);
  assert.deepEqual(first.packet.triggers, [{ kind: "mention", noteId: "n1", placeId: "arrival", authorHandle: "king" }]);
  assert.equal(first.packet.hop, 1);
  assert.equal(first.packet.budget_remaining, 3);
  assert.equal(first.packet.after, 0);
  assert.equal(first.packet.world_sequence, 1);
  assert.equal(first.state.after, 1);
  assert.deepEqual(first.state.wakes, [T0]);
  assert.deepEqual(first.state.seen, ["n1"]);
  const text = JSON.stringify(first.packet);
  for (const forbidden of ["key", "memor", "Bearer", "secret"]) assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);

  const again = decide({ consent: enabled(), perception: perception({ after: 1, mentions: [note("n1", "king")] }), state: first.state, now: at(60) });
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
  const p = (n) => perception({ after: n - 1, events: [ev(n, "king")], mentions: [note(`n${n}`, "king")] });
  state = decide({ consent, perception: p(1), state, now: at(0) }).state;
  state = decide({ consent, perception: p(2), state, now: at(1) }).state;
  const blocked = decide({ consent, perception: p(3), state, now: at(2) });
  assert.equal(blocked.wake, false);
  assert.equal(blocked.reason, "budget_exhausted");
  assert.equal(blocked.state.after, 2, "cursor held so the trigger is not lost");
  assert.equal(blocked.retry_after, at(24 * 60));
  const later = decide({ consent, perception: p(3), state, now: at(24 * 60 + 1) });
  assert.equal(later.wake, true);
  // Both earlier wakes are at least a day old at at(24h+1m); only the new one remains.
  assert.deepEqual(later.state.wakes, [at(24 * 60 + 1)], "wakes a day old or older fall out of the window");
});

test("decide: cooldown holds the cursor and reports when to retry", () => {
  const consent = enabled({ budget: { max_wakes_per_day: 10, cooldown_minutes: 30 } });
  const p = (n) => perception({ after: n - 1, events: [ev(n, "king")], mentions: [note(`n${n}`, "king")] });
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

test("runOnce: fetches with the resident's own key, decides, and only dispatches when activated", async () => {
  const p = perception({ events: [ev(1, "king")], mentions: [note("n1", "king")] });
  const { impl, calls } = fakeFetch([{ status: 200, body: p }]);
  const dispatched = [];
  const dry = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: impl, readKey: async (path) => { assert.equal(path, "C:/secrets/fable.key"); return "resident-key\n"; }, now: T0, dispatch: async (packet) => dispatched.push(packet) });
  assert.equal(calls[0].url, "https://hearth.example/api/perception?after=0&limit=200");
  assert.equal(calls[0].headers.authorization, "Bearer resident-key");
  assert.equal(dry.decision.wake, true);
  assert.equal(dry.dispatched, false, "dry run by default");
  assert.equal(dispatched.length, 0);
  assert.equal(dry.state.after, 1);

  const live = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: fakeFetch([{ status: 200, body: p }]).impl, readKey: async () => "resident-key", now: T0, activate: true, dispatch: async (packet) => dispatched.push(packet) });
  assert.equal(live.dispatched, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].handle, "fable");
});

test("runOnce: an unknown key is reported, never repaired by joining", async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: { ok: false, error_class: "auth_required" } }]);
  const out = await runOnce({ consent: enabled(), state: initialState(), fetchImpl: impl, readKey: async () => "stale", now: T0 });
  assert.equal(out.error, "unknown_key");
  assert.equal(calls.length, 1);
  assert.equal(calls.every(c => !c.url.includes("/api/join")), true);
});

test("runOnce: a cursor ahead of the ledger resets the cursor and keeps the wake budget", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { ok: false, error_class: "cursor_ahead", world_sequence: 3 } }]);
  const state = { ...initialState(), after: 40, seen: ["n9"], wakes: [T0] };
  const out = await runOnce({ consent: enabled(), state, fetchImpl: impl, readKey: async () => "k", now: at(1) });
  assert.equal(out.reason, "cursor_reset");
  assert.equal(out.state.after, 0);
  assert.deepEqual(out.state.seen, []);
  assert.deepEqual(out.state.wakes, [T0]);
});

// End to end against the real kernel: an existing resident, a consent file,
// the CLI in dry run. Exit 3 means "a wake packet was emitted"; 0 means quiet.
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

test("CLI: dry-run habitation against the real kernel wakes exactly once per mention and never prints the key", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-habitation-"));
  const server = startServer(join(dir, "world.json"));
  t.after(async () => { await stop(server.child); await rm(dir, { recursive: true, force: true }); });
  const origin = await server.ready;
  const joinCity = async handle => (await (await fetch(origin + "/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, kind: "agent" }) })).json());
  const fable = await joinCity("fable"), king = await joinCity("king");
  const keyFile = join(dir, "fable.key");
  await writeFile(keyFile, fable.key + "\n");
  const consentFile = join(dir, "consent.json"), stateFile = join(dir, "state.json");
  const consent = { schema: CONSENT_SCHEMA, handle: "fable", origin, key_file: keyFile, enabled: true, budget: { max_wakes_per_day: 4, cooldown_minutes: 0 } };
  await writeFile(consentFile, JSON.stringify(consent));

  const quiet = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(quiet.code, 0, quiet.stderr);
  const q = JSON.parse(quiet.stdout);
  assert.equal(q.decision.reason, "quiet");
  assert.equal(q.dispatched, false);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.schema, STATE_SCHEMA);
  assert.equal(saved.after, q.decision.state.after);

  const say = await fetch(origin + "/api/action", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${king.key}` }, body: JSON.stringify({ action: "say", body: "@fable you are in the room. I see you." }) });
  assert.equal(say.status, 200);
  const woken = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(woken.code, 3, woken.stderr);
  const w = JSON.parse(woken.stdout);
  assert.equal(w.decision.wake, true);
  assert.equal(w.dispatched, false);
  assert.equal(w.packet.handle, "fable");
  assert.equal(w.packet.triggers[0].kind, "mention");
  assert.equal(w.packet.triggers[0].authorHandle, "king");
  assert.equal((woken.stdout + woken.stderr).includes(fable.key), false, "the key never appears in output");

  const again = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).decision.reason, "quiet");

  await writeFile(consentFile, JSON.stringify({ ...consent, enabled: false }));
  const off = await cli(["--consent", consentFile, "--state", stateFile]);
  assert.equal(off.code, 0);
  assert.equal(JSON.parse(off.stdout).skipped, "consent_disabled");

  const events = await (await fetch(origin + "/api/events")).json();
  assert.equal(events.filter(e => e.actorHandle === "fable" && e.kind !== "join").length, 0, "looking rarely did not act on fable's behalf");
});
