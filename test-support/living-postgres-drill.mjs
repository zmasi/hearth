// Explicit disposable local drill. No DATABASE_URL, credential files or network
// host options are accepted. The caller supplies a NEW tmpfs PostgreSQL server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { river, invoke, checkChain } from "./living-world.mjs";
import { createNotebook } from "../client/notebook.mjs";
import { snapshotPostgres, restorePostgres, canonical, validateWorld } from "../scripts/lib/recovery.mjs";

const port = Number(process.argv[2]);
assert.ok(process.argv.length === 3 && Number.isInteger(port) && port > 1024 && port < 65536);
const options = { host: "127.0.0.1", port, user: "postgres", database: "hearth_synthetic", connectionTimeoutMillis: 5000, max: 5 };
const pool = new Pool(options), checks = [], pass = name => { checks.push(name); };
let destination;
try {
  assert.equal((await pool.query("SELECT current_database() name")).rows[0].name, "hearth_synthetic");
  assert.equal((await pool.query("SELECT to_regclass('public.hearth_ledger') present")).rows[0].present, null, "Drill requires an empty destination");
  const schema = await readFile(new URL("../db/migrations/001_hearth_ledger.sql", import.meta.url), "utf8");
  await pool.query(schema);
  const f = await river(), { db, alice, bob, gate, upper, clock } = f;
  await pool.query("INSERT INTO hearth_ledger (id,world,constitution_version,revision,migrated_from,migrated_sha256) VALUES (1,$1::jsonb,'3.1',1,'synthetic-disposable',$2)", [JSON.stringify(db.world), "0".repeat(64)]);
  const read = async () => (await pool.query("SELECT world,revision::text FROM hearth_ledger")).rows[0];
  const modules = await Promise.all([import("../api/index.js?pg-live-a"), import("../api/index.js?pg-live-b")]);
  for (const mod of modules) { mod.__setPostgresPoolForTests(pool); mod.__setClockForTests(clock.now); }
  const action = (index, resident, body) => invoke(modules[index].default, "POST", "/api/action", body, resident.key);
  const ok = async (index, resident, body) => { const r = await action(index, resident, body); assert.equal(r.status, 200); return r.json; };
  await Promise.all([0,1].map(i => ok(i, alice, { action: "adjust", targetKind: "thing", targetId: gate, field: "turns", op: "add", by: "1" })));
  assert.equal((await read()).world.things.find(t => t.id === gate).fields.turns, 2);
  pass("two independent kernel isolates serialize field writes through real FOR UPDATE");
  await ok(0, alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "turn_gate", instructions: [
    { do: "require", bag: "physical", of: "$place", field: "water_depth_mm", gte: "1" },
    { do: "clear", field: "open" }, { do: "actuate", field: "set_sluice", to: "0.5" },
  ] });
  clock.advanceSeconds(600);
  await ok(0, bob, { action: "walk", targetId: upper });
  const turn = await ok(1, bob, { action: "perform", verb: "turn_gate", targetId: gate });
  assert.equal(turn.perception.physical.hydrology.aperture_pct, 50);
  assert.equal(turn.perception.physical.hydrology.total_outflow_m3, 0);
  pass("JSONB-reordered stored machine, physical guard and real actuator preserve old flow");
  await ok(0, alice, { action: "pin", targetKind: "thing", targetId: gate, verb: "rollback_gate", instructions: [
    { do: "actuate", targetId: "$target", name: "set_sluice", body: "0" }, { do: "look", targetId: "missing" },
  ] });
  const before = await read(); clock.advanceSeconds(300);
  assert.equal((await action(1, bob, { action: "perform", targetId: gate, verb: "rollback_gate" })).status, 404);
  assert.deepEqual(await read(), before);
  pass("late script failure rolls back world, anchors, history and revision in PostgreSQL");
  await invoke(modules[0].default, "GET", "/api/me", undefined, alice.key);
  assert.deepEqual(await read(), before);
  pass("physical GET projection performs no durable write");
  const me = (await invoke(modules[0].default, "GET", "/api/me", undefined, alice.key)).json.me;
  const notebook = createNotebook({ origin: "http://127.0.0.1", bearer: alice.key, agentId: me.id,
    rootKey: randomBytes(32), fetchImpl: async (url, init) => {
      const r = await invoke(modules[0].default, init.method, new URL(url).pathname + new URL(url).search,
        init.body ? JSON.parse(init.body) : undefined, alice.key);
      return { status: r.status, json: async () => r.json };
    } });
  const draft = notebook.prepare({ title: "Synthetic local page", body: "Only a disposable test payload" });
  const first = await notebook.save(draft);
  const second = await notebook.save(notebook.prepare({ page_id: first.page_id, previous: first.id, title: "Second", body: "Synthetic revision" }));
  const pruning = notebook.prepareRetention({ action: "prune", page_id: first.page_id, expected_head: second.id });
  await notebook.retain(pruning);
  await assert.rejects(notebook.save(draft));
  pass("real PostgreSQL sealed prune retains head and refuses stale original draft");
  const forget = notebook.prepareRetention({ action: "forget", page_id: first.page_id, expected_head: second.id });
  let loseAck = true;
  modules[0].__setPostgresPoolForTests({ query: (...args) => pool.query(...args), connect: async () => {
    const c = await pool.connect();
    return { release: error => c.release(error), query: async (...args) => {
      const r = await c.query(...args);
      if (args[0] === "COMMIT" && loseAck) { loseAck = false; throw new Error("synthetic acknowledgement loss after real commit"); }
      return r;
    } };
  } });
  await notebook.retain(forget);
  await notebook.retain(forget);
  await assert.rejects(notebook.save(draft));
  pass("real committed forget with simulated lost ACK reconciles and exact retry cannot resurrect");
  const source = await read(); checkChain(source.world); validateWorld(source.world);
  const c = await pool.connect(), key = randomBytes(32);
  let archive;
  try { archive = await snapshotPostgres(c, key); } finally { c.release(); }
  await pool.query("CREATE DATABASE hearth_restore_synthetic");
  destination = new Pool({ ...options, database: "hearth_restore_synthetic" });
  await destination.query(schema);
  const d = await destination.connect();
  try {
    assert.equal((await restorePostgres(d, archive.bytes, key, archive.receipt.archive_sha256)).action, "restored_empty_postgres");
    assert.equal((await restorePostgres(d, archive.bytes, key, archive.receipt.archive_sha256)).action, "already_present");
    const damaged = Buffer.from(archive.bytes); damaged[damaged.length - 1] ^= 1;
    await assert.rejects(restorePostgres(d, damaged, key, archive.receipt.archive_sha256));
  } finally { d.release(); key.fill(0); }
  const restored = (await destination.query("SELECT world,revision::text FROM hearth_ledger")).rows[0];
  assert.equal(canonical(restored), canonical(source));
  pass("real PostgreSQL encrypted complete-state restore preserves physics, scripts, receipts, ciphertext and revision exactly");
  pass("identical real restore is no-op; corrupted archive refuses");
  const server = (await pool.query("SHOW server_version")).rows[0].server_version;
  console.log(JSON.stringify({ ok: true, checks, server, synthetic_only: true, archive_sha256: archive.receipt.archive_sha256,
    world_sha256: archive.receipt.world_sha256, world_sequence: source.world.world_sequence, resident_keys_printed: false }, null, 2));
} finally { await destination?.end(); await pool.end(); }
