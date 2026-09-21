// Hearth Phase 20, native habitation: the resident's own small durable files.
// State is written whole, flushed, then renamed into place. One lock file
// keeps it to one live harness per resident. A ring is a request file with an
// id and a time in it and no words.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { HabitationError, validateRing } from "./habitation.mjs";

export async function readJsonIfExists(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeJsonDurable(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(tmp, path); }
  catch (error) { await rm(tmp, { force: true }); throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// One live harness per resident. A lock whose owner is gone is taken over.
export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); }
      finally { await handle.close(); }
      return { release: () => rm(path, { force: true }) };
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    let owner = null;
    try { owner = JSON.parse(await readFile(path, "utf8")); } catch { owner = null; }
    if (owner && Number.isInteger(owner.pid) && alive(owner.pid)) break;
    await rm(path, { force: true });
  }
  throw new HabitationError("already_running", "This resident's live harness is already running.");
}

export async function readRing(path) {
  const found = await readJsonIfExists(path);
  return found === null ? null : validateRing(found);
}

// An unconsumed ring is not stacked: asking twice is still one ring.
export async function requestRing(path, now = new Date().toISOString()) {
  const waiting = await readRing(path).catch(() => null);
  if (waiting) return waiting;
  const ring = { id: "ring-" + randomBytes(8).toString("hex"), requested_at: now };
  await writeJsonDurable(path, ring);
  return ring;
}

export function clearRing(path) {
  return rm(path, { force: true });
}
