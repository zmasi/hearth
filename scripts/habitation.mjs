#!/usr/bin/env node
// One habitation tick for one existing resident. Dry run unless --activate,
// and --activate only spools the wake packet to a file the runtime owner
// consumes; this script carries no transport, cron, seat, or gateway.
//
//   node scripts/habitation.mjs --consent <consent.json> [--state <state.json>]
//                               [--activate --spool <packets.jsonl>] [--now <iso>]
//
// A dry run previews: it writes no state and consumes no trigger or budget,
// so it can be repeated. Only an activated tick persists state, and only
// after its packet was spooled (or the tick was quiet).
//
// Exit codes: 0 quiet or skipped, 2 configuration or resident error,
// 3 a wake packet was emitted (printed, and spooled when activated).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { initialState, runOnce, validateConsent, validateState } from "../client/habitation.mjs";

function args(argv) {
  const out = { activate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--activate") out.activate = true;
    else if (["--consent", "--state", "--spool", "--now"].includes(a)) out[a.slice(2)] = argv[++i];
    else return { error: `Unknown argument: ${a}` };
  }
  if (!out.consent) return { error: "--consent <path> is required." };
  return out;
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const opts = args(process.argv.slice(2));
if (opts.error) { process.stderr.write(opts.error + "\n"); process.exit(2); }
let consent;
try { consent = validateConsent(await readJson(resolve(opts.consent))); }
catch (error) { process.stderr.write(`consent: ${error.message}\n`); process.exit(2); }
const statePath = resolve(opts.state ?? join(dirname(resolve(opts.consent)), "habitation-state.json"));
let state;
try { state = validateState(await readJson(statePath)); }
catch (error) {
  if (error.code !== "ENOENT") { process.stderr.write(`state: ${error.message}\n`); process.exit(2); }
  state = initialState();
}
if (opts.activate && !opts.spool) { process.stderr.write("--activate requires --spool <file> so the runtime owner's transport can consume packets.\n"); process.exit(2); }
const dispatch = opts.activate ? async (packet) => {
  const spool = resolve(opts.spool);
  await mkdir(dirname(spool), { recursive: true });
  await writeFile(spool, JSON.stringify(packet) + "\n", { flag: "a" });
} : null;

let result;
try { result = await runOnce({ consent, state, now: opts.now, activate: opts.activate, dispatch }); }
catch (error) { process.stderr.write(`habitation: ${error.message}\n`); process.exit(2); }
if (result.committed) await writeJsonAtomic(statePath, result.state);
if (result.skipped) { print({ ok: true, skipped: result.skipped, committed: false }); process.exit(0); }
if (result.error) { print({ ok: false, error: result.error, status: result.status ?? null, committed: false }); process.exit(2); }
if (result.reason === "cursor_reset") { print({ ok: true, reason: "cursor_reset", world_sequence: result.world_sequence, proposed: result.proposed, committed: result.committed }); process.exit(0); }
const { decision } = result;
print({ ok: true, decision: { wake: decision.wake, reason: decision.reason, retry_after: decision.retry_after ?? null, state: result.proposed }, packet: result.packet, dispatched: result.dispatched, committed: result.committed, activated: opts.activate });
process.exit(decision.wake ? 3 : 0);
