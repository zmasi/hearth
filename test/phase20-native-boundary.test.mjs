import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// THE LOCAL TRANSPORT BOUNDARY, labelled honestly.
//
//   REAL:    the Foundry receiver code from a local a2a-cli-adapter checkout
//            (adapter_core.AdapterServer, its HTTP handler, NativeAdmission's
//            durable FIFO admission and exact replay, NativeTaskStore's session
//            mapping and SQLite state), reached over loopback HTTP; and the real
//            Hearth kernel (scripts/serve.mjs) for perception.
//   FIXTURE: the native DRIVER. No model and no CLI runs. This is NOT a named
//            teammate's native turn, and proves nothing about one.
//   NOT HERE: any live seat, roster, work ledger, scheduler or resident key.
//
// The adapter checkout is only read (bytecode writes are disabled and all state
// goes to a temp directory). Set HEARTH_A2A_ADAPTER_ROOT to point elsewhere.
// Without the checkout or a real Python interpreter the test is skipped, and
// says so. HEARTH_TEST_PYTHON may name an interpreter directly.
//
// The receiver child is started from the REAL interpreter, resolved once, never
// from whatever `python` is on PATH. On Windows that name can be the Python
// install manager's shim, and the shim, run without LOCALAPPDATA (which the
// child's deliberately sparse environment lacks), downloads and installs an
// entire runtime into ./Python of its working directory: some 2,700 files,
// fetched over the network, and not the machine's validated interpreter. An
// earlier revision of this test did exactly that on every run.

import { CONSENT_SCHEMA, initialState, validateConsent, validateState } from "../client/habitation.mjs";
import { admitWake, seatCapability } from "../client/habitation-seat.mjs";
import { readJsonIfExists, writeJsonDurable } from "../client/habitation-store.mjs";
import { nativeTick } from "../client/habitation-visit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const adapterRoot = process.env.HEARTH_A2A_ADAPTER_ROOT ?? "C:/Dev/a2a-cli-adapter";
const python = process.env.HEARTH_TEST_PYTHON ?? "python";

// Ask `python` for its real executable, from a scratch directory that is removed
// afterwards, so even a bootstrapping shim can litter nothing that survives. An
// interpreter that only exists inside that scratch directory is a bootstrap, not
// an installed Python, and is refused.
function resolveInterpreter() {
  const scratch = mkdtempSync(join(tmpdir(), "hearth-python-probe-"));
  try {
    const probe = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { cwd: scratch, encoding: "utf8" });
    const found = probe.status === 0 ? String(probe.stdout).trim().split(/\r?\n/).at(-1) : "";
    if (!found || !existsSync(found)) return { reason: `no usable ${python} on PATH` };
    if (found.toLowerCase().startsWith(scratch.toLowerCase())) return { reason: `${python} is a bootstrapping shim in this environment; set HEARTH_TEST_PYTHON to a real interpreter` };
    return { interpreter: found };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
const adapterPresent = existsSync(join(adapterRoot, "adapter_core.py"));
const resolved = adapterPresent ? resolveInterpreter() : {};
const interpreter = resolved.interpreter ?? null;
const unavailable = !adapterPresent ? `no a2a-cli-adapter checkout at ${adapterRoot}` : resolved.reason ?? null;

const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "SYSTEMDRIVE"]);
const cleanEnv = (extra = {}) => Object.assign(Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.has(k.toUpperCase()))), extra);
function startJsonChild(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", c => { stderr += c; });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      const line = output.split(/\r?\n/).find(v => v.startsWith("{"));
      if (line && output.includes("\n")) { try { const s = JSON.parse(line); s.ready ? resolve(s) : reject(new Error("not ready")); } catch (e) { reject(e); } }
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`exited early (${code}): ${stderr.slice(-800)}`)));
  });
  return { child, ready };
}
async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill(); await exited; }

test("boundary: a resident's own harness rings the REAL receiver: plain message, durable admission, exact replay, a resumed native session, and nothing published to anyone",
  { skip: unavailable ?? false, timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-native-boundary-"));
  const seatState = join(dir, "seat-state"), record = join(dir, "driver-record.jsonl"), hold = record + ".hold";
  await writeFile(hold, "held");
  const receiver = startJsonChild(interpreter, [join(root, "test-support", "real_adapter_seat.py"), adapterRoot, seatState, record],
    { cwd: dir, env: cleanEnv({ PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" }) });
  const kernel = startJsonChild(process.execPath, ["scripts/serve.mjs"], { cwd: root, env: cleanEnv({ PORT: "0", HOST: "127.0.0.1", HEARTH_DATA: join(dir, "world.json") }) });
  t.after(async () => { await stop(receiver.child); await stop(kernel.child); await rm(dir, { recursive: true, force: true }); });
  const seatUrl = (await receiver.ready).url, origin = (await kernel.ready).origin;

  const post = async (path, body, key) => (await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })).json();
  const fable = await post("/api/join", { handle: "fable", kind: "agent" }), king = await post("/api/join", { handle: "king", kind: "agent" });
  const keyFile = join(dir, "fable.key"), stateFile = join(dir, "habitation-state.json");
  await writeFile(keyFile, fable.key + "\n");
  const consentFor = (continuity) => validateConsent({ schema: CONSENT_SCHEMA, handle: "fable", origin, key_file: keyFile, enabled: true,
    seat: { url: seatUrl, continuity, expect_name: "Deterministic fixture driver" }, budget: { max_wakes_per_day: 8, cooldown_minutes: 0 } });
  const consent = consentFor("continuing");
  const loadState = async () => { const found = await readJsonIfExists(stateFile); return found === null ? initialState() : validateState(found); };
  const persist = (next) => writeJsonDurable(stateFile, validateState(next));
  const tick = async (extra = {}) => nativeTick({ consent, state: await loadState(), persist, ...extra });
  const until = async (wanted, extra) => { for (let i = 0; i < 200; i++) { const r = await tick(extra); if (r.outcome === wanted || r.ended) return r; await delay(50); } throw new Error(`never reached ${wanted}`); };
  const driverCalls = async () => existsSync(record) ? (await readFile(record, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

  // The real agent card, from the real receiver code.
  assert.deepEqual(await seatCapability({ seat: consent.seat }), { durable: true, name: "Deterministic fixture driver" });

  // 1. A mention rings the resident's own seat. The real receiver admits durably and answers at once.
  assert.equal((await post("/api/action", { action: "say", body: "@fable you are in the room. I see you." }, king.key)).ok, true);
  const rung = await tick();
  assert.equal(rung.outcome, "accepted");
  const first = (await loadState()).visit;
  assert.match(first.task_id, /^task-[a-f0-9]{16}$/, "a task id minted by the real receiver");
  assert.equal(first.context_id, "hearth-habitation-fable");

  // 2. The native turn is running (the fixture driver is held): the resident is awake, and nothing else rings.
  const awake = await until("active");
  assert.equal(awake.outcome, "active");

  // 3. Exact replay at the real admission layer: the identical message is the same task, and the driver ran once.
  const replay = await admitWake({ seat: consent.seat, consent, visit: first });
  assert.equal(replay.task_id, first.task_id);
  const callsWhileHeld = await driverCalls();
  assert.equal(callsWhileHeld.length, 1);

  // 4. What the receiver handed the driver: exactly the wake, with no work lineage of any kind.
  const call1 = callsWhileHeld[0];
  assert.equal(call1.prompt, first.text.trim());
  assert.equal(call1.prompt.includes("TEAM A2A TRANSPORT CONTEXT"), false, "no work preamble, so no 'outcome owner publishes the final'");
  assert.deepEqual(call1.lineage_env, [], "no inherited root, owner or chain in the native environment");
  assert.equal(call1.session_in, "", "the first visit starts the resident's habitation session");
  assert.equal(call1.timeout, null, "the receiver puts no clock on the native turn");
  assert.match(call1.prompt, /- mention: note n_[a-f0-9]+ in arrival by king \(seq \d+\)/);
  assert.equal(call1.prompt.includes("I see you"), false, "ids only");

  // 5. The turn ends. That is a transport fact, and the reply is nowhere in the harness's books.
  await rm(hold, { force: true });
  const ended = await until("completed");
  assert.equal(ended.ended.native_state, "TASK_STATE_COMPLETED");

  // 6. Continuity: the next visit resumes the SAME native session through the receiver's own session mapping.
  assert.equal((await post("/api/action", { action: "say", body: "@fable still here, no hurry." }, king.key)).ok, true);
  assert.equal((await tick()).outcome, "accepted");
  await until("completed");
  const calls = await driverCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].session_in, call1.session, "the receiver resumed the session the first visit established");
  assert.ok(call1.prompt.includes("The next bell resumes this same session."), "and that is what the first wake told the resident would happen");
  assert.equal(calls[1].session, call1.session);

  // 7. A resident who prefers a fresh morning gets a new context and a new native session.
  const freshConsent = consentFor("fresh");
  const ringTick = await nativeTick({ consent: freshConsent, state: await loadState(), persist, ring: { id: "ring-boundary1", requested_at: new Date().toISOString() } });
  assert.equal(ringTick.outcome, "accepted");
  assert.match((await loadState()).visit.context_id, /^hearth-visit-fable-[a-f0-9]{12}$/);
  for (let i = 0; i < 200 && (await driverCalls()).length < 3; i++) await delay(50);
  const call3 = (await driverCalls())[2];
  assert.equal(call3.session_in, "", "fresh continuity never resumes");
  assert.ok(call3.prompt.includes("The next bell starts a fresh session, so keep what matters in your own memory."), "and the fresh wake says so, instead of promising resumption");
  assert.equal(call3.prompt.includes("resumes this same session"), false);
  assert.match(call3.prompt, /- self: you rang this yourself \(/);

  // 8. Nothing was published to anyone: the receiver's result outbox is empty and no work ledger exists.
  for (let i = 0; i < 100; i++) { const h = await (await fetch(seatUrl + "/health")).json(); if ((h.runtime.lanes.settled ?? 0) >= 3) break; await delay(50); }
  const health = await (await fetch(seatUrl + "/health")).json();
  assert.equal(health.runtime.admission, "durable-fifo-v1");
  assert.equal(health.runtime.pendingResults, 0, "a plain task never enters the native result outbox");
  assert.equal(health.runtime.lanes.settled, 3);
  const seatFiles = await readdir(seatState);
  assert.ok(seatFiles.includes("native-tasks.sqlite3"), "the receiver's own durable task store was really used");
  assert.equal(seatFiles.some(f => f.startsWith("chains.sqlite3")), false, "no team work ledger was created");
  assert.equal(existsSync(join(adapterRoot, "state", "fixture")), false, "nothing was written inside the adapter checkout");

  // 9. The reply and the key are nowhere in what the harness keeps.
  const kept = await readFile(stateFile, "utf8");
  assert.equal(kept.includes("REAL-RECEIVER-FIXTURE-REPLY"), false);
  assert.equal(kept.includes(fable.key), false);
  const events = await (await fetch(origin + "/api/events")).json();
  assert.equal(events.filter(e => e.actorHandle === "fable" && e.kind !== "join").length, 0, "the harness never acted in the city for the resident");
});
