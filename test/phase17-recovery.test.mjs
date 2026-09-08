import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, link, open, readdir, lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createVaultKey, sealMemory, openMemory } from "../client/vault.mjs";
import { ARCHIVE_FORMAT, canonical, sha256, parseJson, validateWorld, createSnapshot, verifySnapshot,
  restoreFile, readPrivateFile, writeNewFile, snapshotPostgres, restorePostgres } from "../scripts/lib/recovery.mjs";

let isolate = 0;
const clone = structuredClone;
const safeEnv = () => Object.fromEntries(["PATH","SystemRoot","WINDIR","TEMP","TMP","ComSpec","PATHEXT"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
async function request(handler, method, url, body, key) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  let status, text;
  await handler(req, { writeHead(s) { status = s; }, end(raw) { text = String(raw); } });
  return { status, json: JSON.parse(text), text };
}
async function fixture() {
  delete process.env.DATABASE_URL; delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.VERCEL;
  process.env.BLOB_STORE_ID = "synthetic_phase17";
  const api = await import(`../api/index.js?phase17=${++isolate}`);
  let bytes = null;
  api.__setBlobClientForTests({ async get() { return bytes === null ? null : { stream: new Response(bytes).body }; }, async put(_path, value) { bytes = value; } });
  const call = (method, path, body, key) => request(api.default, method, path, body, key);
  const alice = (await call("POST", "/api/join", { handle: "recover_alice", kind: "agent" })).json;
  const bob = (await call("POST", "/api/join", { handle: "recover_bob", kind: "agent" })).json;
  assert.equal((await call("POST", "/api/memory", { summary: "SYNTHETIC_ALICE_VAULT" }, alice.key)).status, 200);
  const me = (await call("GET", "/api/me", undefined, alice.key)).json.me;
  const root = createVaultKey(), inner = sealMemory(root, me.id, { summary: "SYNTHETIC_CLIENT_SECRET" });
  assert.equal((await call("POST", "/api/memory", { sealed: inner }, alice.key)).status, 200);
  assert.equal((await call("POST", "/api/action", { action: "pin", targetKind: "thing", targetId: "t_hammer", verb: "first_script", instructions: [{ do: "no_op" }] }, alice.key)).status, 403);
  assert.equal((await call("POST", "/api/action", { action: "pin", targetKind: "thing", targetId: "t_board", verb: "recover_verb", instructions: [{ do: "say", body: "SYNTHETIC_SCRIPT_EFFECT" }] }, alice.key)).status, 200);
  // Keep both live and historical script revisions.
  assert.equal((await call("POST", "/api/action", { action: "pin", targetKind: "thing", targetId: "t_board", verb: "recover_verb", instructions: [{ do: "no_op" }] }, alice.key)).status, 200);
  assert.equal((await call("POST", "/api/action", { action: "destroy", targetKind: "thing", targetId: "t_listed" }, alice.key)).status, 200);
  const world = JSON.parse(bytes);
  world.memories.unshift({ id: "mem_legacy", agentHandle: bob.handle, summary: "SYNTHETIC_LEGACY_PRIVATE", extra: { private: ["retained", 3] } });
  world.future_extension = { empty: [], opaque: JSON.parse('{"__proto__":null,"noninteger":0.125}') };
  return { world, alice, bob, root, inner, agentId: me.id };
}
async function directory() {
  const root = new URL("../.hearth-recovery/", import.meta.url);
  await mkdir(root, { recursive: true });
  return mkdtemp(new URL("test-", root));
}
function expectCode(fn, code) { assert.throws(fn, err => err.code === code && !err.message.includes("SYNTHETIC")); }

test("Phase17: complete encrypted archive preserves current state and row metadata without touching resident ciphertext", async () => {
  const { world, alice, root } = await fixture(), before = clone(world), key = randomBytes(32);
  const metadata = rowMetadata(world), first = createSnapshot(world, key, { metadata }), second = createSnapshot(world, key, { metadata });
  assert.notDeepEqual(first.bytes, second.bytes);
  const verified = verifySnapshot(first.bytes, key, first.receipt.archive_sha256);
  assert.deepEqual(verified.payload.world, before); assert.deepEqual(verified.payload.metadata, metadata);
  assert.deepEqual(world, before);
  assert.equal(verified.receipt.encrypted_memories, 2); assert.equal(verified.receipt.legacy_memories, 1);
  assert.equal(verified.receipt.vault_tags_verified, false);
  for (const secret of ["SYNTHETIC_LEGACY_PRIVATE", "SYNTHETIC_ALICE_VAULT", world.residents.at(-1).keyHash, world.memories[1].ciphertext, alice.key, root.toString("base64url")]) {
    assert.equal(first.bytes.toString().includes(secret), false);
    assert.equal(JSON.stringify(first.receipt).includes(secret), false);
  }
  // Reordering JSON object keys (as jsonb does) changes no canonical state digest.
  const reordered = parseJson(Buffer.from(canonical(world)));
  assert.equal(validateWorld(reordered).world_sha256, first.receipt.world_sha256);
});

test("Phase17: restore boots the actual kernel with original keys, vaults, scripts, history and escape", async () => {
  const { world, alice, bob, root, inner, agentId } = await fixture(), key = randomBytes(32);
  const snapshot = createSnapshot(world, key), dir = await directory(), target = join(dir, "restored.json");
  await restoreFile(snapshot.bytes, key, snapshot.receipt.archive_sha256, target);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), world);
  delete process.env.DATABASE_URL; delete process.env.BLOB_STORE_ID; delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.VERCEL;
  process.env.HEARTH_DATA = target;
  const { default: handler } = await import(`../api/index.js?phase17-restored=${++isolate}`);
  const bytesBefore = await readFile(target);
  const own = await request(handler, "GET", "/api/memory", undefined, alice.key);
  assert.equal(own.status, 200); assert.equal(own.json[1].summary, "SYNTHETIC_ALICE_VAULT");
  assert.deepEqual(openMemory(root, agentId, inner.id, own.json[0].sealed), { summary: "SYNTHETIC_CLIENT_SECRET" });
  const other = await request(handler, "GET", "/api/memory", undefined, bob.key);
  assert.equal(other.json.length, 1); assert.equal(other.json[0].summary, "SYNTHETIC_LEGACY_PRIVATE");
  assert.deepEqual(await readFile(target), bytesBefore);
  const map = (await request(handler, "GET", "/api/map")).json;
  assert.equal(JSON.stringify(map).includes("SYNTHETIC_LEGACY_PRIVATE"), false);
  assert.equal(map.things.some(t => t.id === "t_listed"), false);
  const performed = await request(handler, "POST", "/api/action", { action: "perform", targetId: "t_board", verb: "recover_verb" }, alice.key);
  assert.equal(performed.status, 200);
  const home = await request(handler, "POST", "/api/action", { action: "go_home" }, alice.key);
  assert.equal(home.status, 200); assert.equal(home.json.me.standingId, alice.homeId);
  const after = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(after.events.slice(-world.events.length), world.events);
  assert.ok(after.world_sequence > world.world_sequence);
  assert.deepEqual(after.memories, world.memories); validateWorld(after);
});

test("Phase17: corrupt, incompatible and malformed state is rejected without creating a snapshot", async () => {
  const { world } = await fixture(), key = randomBytes(32);
  const corruptions = [
    w => { w.version = "3.2"; }, w => { delete w.memories; }, w => { w.events[0].text += "altered"; },
    w => { w.events.pop(); }, w => { w.ledger_head = "f".repeat(64); }, w => { delete w.events[0].hash; },
    w => { w.places.push(clone(w.places[0])); }, w => { w.residents.at(-1).handle = w.residents[0].handle; },
    w => { w.residents.at(-1).keyHash = "reset-key"; }, w => { w.residents.at(-1).enclaveId = "absent"; },
    w => { w.places[0].permissions.enter = "closed"; }, w => { w.places[1].parentId = w.places[1].id; },
    w => { w.scripts[0].instructions[0].do = "remember"; }, w => { w.scripts[0].instructionHash = "corrupt"; },
    w => { w.memories[1].storage = "unknown"; }, w => { w.memories[1].tag = "AA"; },
    w => { w.memories[1].agentId = "wrong-owner"; }, w => { w.memories.push(clone(w.memories[1])); },
    w => { w.memories[0].createdAt = {}; }, w => { w.notes[0].placeId = "absent"; },
    w => { w.rates = []; }, w => { w.future_extension = { value: Infinity }; },
  ];
  for (const corrupt of corruptions) {
    const candidate = clone(world); corrupt(candidate); const before = clone(candidate);
    assert.throws(() => createSnapshot(candidate, key)); assert.deepEqual(candidate, before);
  }
  // No owner key is requested: a pre-existing well-shaped but invalid vault tag
  // is preserved honestly, not misrepresented as cryptographically verified.
  const unchecked = clone(world); unchecked.memories[1].tag = randomBytes(16).toString("base64url");
  const snapshot = createSnapshot(unchecked, key);
  assert.equal(verifySnapshot(snapshot.bytes, key, snapshot.receipt.archive_sha256).receipt.vault_tags_verified, false);
});

test("Phase17: expected digest, archive authentication, profile and full-state hash independently gate restore", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key);
  expectCode(() => verifySnapshot(snapshot.bytes, key), "expected_digest_required");
  expectCode(() => verifySnapshot(snapshot.bytes, key, "f".repeat(64)), "archive_digest_mismatch");
  expectCode(() => verifySnapshot(snapshot.bytes, randomBytes(32), snapshot.receipt.archive_sha256), "archive_authentication_failed");
  for (const field of ["nonce", "tag", "ciphertext"]) {
    const archive = JSON.parse(snapshot.bytes), binary = Buffer.from(archive[field], "base64url"); binary[0] ^= 1;
    archive[field] = binary.toString("base64url"); const bytes = Buffer.from(JSON.stringify(archive));
    expectCode(() => verifySnapshot(bytes, key, sha256(bytes)), "archive_authentication_failed");
  }
  // An archive-key holder can authenticate a different payload: the profile and
  // world validator still reject inconsistent data, but this is not a signature.
  const payload = verifySnapshot(snapshot.bytes, key, snapshot.receipt.archive_sha256).payload;
  for (const change of [p => { p.profile = "unknown"; }, p => { p.world_sha256 = "0".repeat(64); }, p => { p.world.ledger_head = "f".repeat(64); }]) {
    const altered = clone(payload); change(altered); const bytes = repack(altered, key);
    assert.throws(() => verifySnapshot(bytes, key, sha256(bytes)));
  }
});
function repack(payload, key) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(ARCHIVE_FORMAT));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: ARCHIVE_FORMAT, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") }));
}

test("Phase17: strict JSON refuses ambiguous or lossy input and preserves safe extension keys", () => {
  for (const source of ['{"a":1,"a":2}', '{"x":1,"\\u0078":2}', '{"secret":"\\u0000"}', '{"x":"\\ud800"}',
    '{"n":9007199254740993}', '{"n":1e9999}', '{"n":1e-9999}', '{"n":0.1234567890123456789}',
    '{"n":-0}', '{"x":NaN}', '[1,]', '{"x":1} trailing', '\ufeff{}', '['.repeat(102) + '0' + ']'.repeat(102)]) {
    assert.throws(() => parseJson(Buffer.from(source)), err => ["invalid_json","size_limit"].includes(err.code));
  }
  assert.throws(() => parseJson(Buffer.from([0xff])));
  const parsed = parseJson(Buffer.from('{"__proto__":{"kept":true},"n":1.2500,"exponent":125e-2}'));
  assert.equal(Object.hasOwn(parsed, "__proto__"), true); assert.equal(parsed.n, 1.25); assert.equal(parsed.exponent, 1.25);
  assert.equal({}.kept, undefined);
});

test("Phase17: local CLI exercises new-key, encrypted create, verify and restore without environment credentials", async () => {
  const { world } = await fixture(), dir = await directory();
  const source = join(dir, "source.json"), key = join(dir, "key.hearth-snapshot-key"), archive = join(dir, "state.hearth-snapshot"), restored = join(dir, "restored.json");
  await writeFile(source, JSON.stringify(world), { flag: "wx" });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/snapshot.mjs", ...args], { cwd: new URL("..", import.meta.url), env: safeEnv(), encoding: "utf8" });
    assert.equal(result.stderr, ""); return { status: result.status, json: JSON.parse(result.stdout), text: result.stdout };
  };
  assert.equal(cli("keygen", "--out", key).status, 0);
  const created = cli("create", "--source", source, "--key-file", key, "--out", archive);
  assert.equal(created.status, 0);
  const digest = created.json.archive_sha256;
  assert.equal(cli("verify", "--archive", archive, "--key-file", key, "--expect", digest).status, 0);
  assert.equal(cli("restore", "--archive", archive, "--key-file", key, "--expect", digest, "--out", restored).status, 0);
  assert.deepEqual(JSON.parse(await readFile(restored, "utf8")), world);
  assert.equal(cli("restore", "--archive", archive, "--key-file", key, "--expect", digest, "--out", restored).json.error_class, "destination_exists");
  assert.equal(cli("keygen", "--out", key).json.error_class, "destination_exists");
  assert.equal(cli("create", "--source", source, "--key-file", key, "--out", archive).json.error_class, "destination_exists");
  assert.equal(cli("verify", "--archive", archive, "--key-file", key, "--expect", "SYNTHETIC_INVALID_DIGEST").status, 1);
  const malformed = join(dir, "malformed.json"); await writeFile(malformed, '{"SYNTHETIC_PRIVATE_LEAK": invalid}', { flag: "wx" });
  const failed = cli("create", "--source", malformed, "--key-file", key, "--out", join(dir, "never-created"));
  assert.equal(failed.status, 1); assert.equal(failed.text.includes("SYNTHETIC_"), false);
  assert.equal((await readdir(dir)).includes("never-created"), false);
});

function rowMetadata(world) {
  return { id: 1, constitution_version: "3.1", revision: "9007199254740993", migrated_from: "synthetic-import",
    migrated_sha256: sha256(canonical(world)), migrated_blob_etag: "synthetic-etag",
    migrated_at: "2026-09-01 01:02:03.123456+00", updated_at: "2026-09-08 01:02:03.654321+00" };
}
class Database {
  constructor(row) { this.row = clone(row); this.history = []; this.tail = Promise.resolve(); }
  client() {
    const db = this; let begun = false, pending, unlock, readOnly = false;
    return {
      async query(sql, params) {
        const kind = sql.startsWith("BEGIN") ? "BEGIN" : sql.startsWith("SET LOCAL") ? "SET" : sql.startsWith("SELECT") ? "SELECT" : sql.startsWith("LOCK") ? "LOCK" : sql.startsWith("INSERT") ? "INSERT" : sql;
        db.history.push({ kind, sql });
        if (kind === "BEGIN") { assert.equal(begun, false); begun = true; pending = undefined; readOnly = sql.includes("READ ONLY"); }
        else if (kind === "SET") assert.ok(begun);
        else if (kind === "LOCK") { assert.ok(begun && !readOnly); const previous = db.tail; db.tail = new Promise(resolve => { unlock = resolve; }); await previous; }
        else if (kind === "SELECT") {
          assert.ok(begun); const value = pending === undefined ? db.row : pending;
          const result = value === null ? [] : [clone(value)];
          if (db.corruptRead && pending) result[0].revision = "1";
          return { rows: result };
        } else if (kind === "INSERT") {
          assert.ok(begun && unlock && !readOnly && db.row === null);
          if (db.failInsert) throw new Error("SYNTHETIC_PRIVATE_BACKEND_ERROR");
          const [id, world_json, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag, migrated_at, updated_at] = params;
          pending = { id, world_json, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag, migrated_at, updated_at }; return { rowCount: 1 };
        } else if (kind === "COMMIT") {
          if (db.beforeCommit) await db.beforeCommit();
          if (db.failCommit) throw new Error("SYNTHETIC_COMMIT_FAILURE");
          if (pending !== undefined) db.row = clone(pending);
          begun = false; if (unlock) unlock(); unlock = null;
          if (db.lostAck) throw new Error("SYNTHETIC_ACK_FAILURE");
        } else if (kind === "ROLLBACK") {
          begun = false; pending = undefined; if (unlock) unlock(); unlock = null;
          if (db.failRollback) throw new Error("SYNTHETIC_ROLLBACK_FAILURE");
        } else assert.fail(`Unexpected SQL: ${sql}`);
        return { rows: [] };
      },
      async discard() { begun = false; pending = undefined; if (unlock) unlock(); unlock = null; },
    };
  }
}
test("Phase17: PostgreSQL snapshot reads a complete committed row and restore retains revision and timestamp precision", async () => {
  const { world } = await fixture(), key = randomBytes(32), metadata = rowMetadata(world);
  const original = { ...metadata, world_json: canonical(world) }, source = new Database(original);
  const snapshot = await snapshotPostgres(source.client(), key);
  assert.deepEqual(source.row, original);
  assert.match(source.history[0].sql, /REPEATABLE READ READ ONLY/);
  assert.equal(source.history.some(h => ["LOCK", "INSERT"].includes(h.kind)), false);
  const destination = new Database(null);
  const result = await restorePostgres(destination.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256);
  assert.equal(result.action, "restored_empty_postgres"); assert.deepEqual(destination.row, original);
  const revision = destination.row.revision;
  const again = await restorePostgres(destination.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256);
  assert.equal(again.action, "already_present"); assert.equal(destination.row.revision, revision);
  assert.equal(destination.history.filter(h => h.kind === "INSERT").length, 1);
});

test("Phase17: PostgreSQL restore refuses occupied targets and corrupt input before any INSERT", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key, { metadata: rowMetadata(world) });
  const occupied = new Database({ ...rowMetadata(world), revision: "999", world_json: canonical(world) }), before = clone(occupied.row);
  await assert.rejects(restorePostgres(occupied.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256), { code: "destination_not_empty" });
  assert.deepEqual(occupied.row, before); assert.equal(occupied.history.at(-1).kind, "ROLLBACK");
  assert.equal(occupied.history.some(h => h.kind === "INSERT"), false);
  const empty = new Database(null);
  await assert.rejects(restorePostgres(empty.client(), snapshot.bytes, key, "0".repeat(64)), { code: "archive_digest_mismatch" });
  assert.deepEqual(empty.history, []);
  const fileSnapshot = createSnapshot(world, key);
  await assert.rejects(restorePostgres(empty.client(), fileSnapshot.bytes, key, fileSnapshot.receipt.archive_sha256), { code: "postgres_metadata_required" });
  assert.deepEqual(empty.history, []);
});

test("Phase17: transactional restore waits for COMMIT, verifies before it, and rolls back failures", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key, { metadata: rowMetadata(world) });
  for (const failure of ["failInsert", "corruptRead", "failRollback"]) {
    const db = new Database(null); db[failure] = true; if (failure === "failRollback") db.failInsert = true;
    await assert.rejects(restorePostgres(db.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256), err => {
      assert.equal(err.message.includes("SYNTHETIC"), false); if (failure === "failRollback") assert.equal(err.discard_client, true); return true;
    });
    assert.equal(db.row, null); assert.equal(db.history.at(-1).kind, "ROLLBACK");
  }
  const db = new Database(null); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  db.beforeCommit = async () => { enter(); await gate; };
  let settled = false;
  const pending = restorePostgres(db.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256).then(r => { settled = true; return r; });
  await entered; assert.equal(settled, false); assert.equal(db.row, null); release();
  assert.equal((await pending).action, "restored_empty_postgres");
});

test("Phase17: uncertain COMMIT never claims success, while retry can prove an exact already-present snapshot", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key, { metadata: rowMetadata(world) });
  for (const failure of ["failCommit", "lostAck"]) {
    const db = new Database(null), client = db.client(); db[failure] = true;
    await assert.rejects(restorePostgres(client, snapshot.bytes, key, snapshot.receipt.archive_sha256), { code: "commit_outcome_unknown", discard_client: true });
    await client.discard(); db[failure] = false;
    const result = await restorePostgres(db.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256);
    assert.equal(result.action, failure === "lostAck" ? "already_present" : "restored_empty_postgres");
  }
});

test("Phase17: concurrent recovery attempts cannot overwrite or insert twice", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key, { metadata: rowMetadata(world) }), db = new Database(null);
  const results = await Promise.all([restorePostgres(db.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256), restorePostgres(db.client(), snapshot.bytes, key, snapshot.receipt.archive_sha256)]);
  assert.deepEqual(results.map(r => r.action), ["restored_empty_postgres", "already_present"]);
  assert.equal(db.history.filter(h => h.kind === "INSERT").length, 1);
});

test("Phase17: atomic file publication leaves no partial destination after write failure and cannot win an overwrite race", async () => {
  const dir = await directory(), destination = join(dir, "failed-world.json"), payload = Buffer.from("SYNTHETIC_COMPLETE_STATE");
  // Inject a storage failure after a real partial staging write. Publication
  // must never run, and the requested destination must remain absent.
  await assert.rejects(writeNewFile(destination, payload, {
    async open(...args) {
      const handle = await open(...args);
      return { async writeFile(bytes) { await handle.writeFile(bytes.subarray(0, 3)); throw new Error("SYNTHETIC_WRITE_FAILURE"); },
        sync: () => handle.sync(), close: () => handle.close() };
    },
    async link() { assert.fail("partial file published"); },
  }), { code: "output_incomplete" });
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  const race = join(dir, "race.json"), winner = Buffer.from("SYNTHETIC_OTHER_WRITER");
  await assert.rejects(writeNewFile(race, payload, {
    open,
    async link(stage, target) { await writeFile(target, winner, { flag: "wx" }); return link(stage, target); },
  }), { code: "destination_exists" });
  assert.deepEqual(await readFile(race), winner);
  const simultaneous = join(dir, "simultaneous.json");
  const results = await Promise.allSettled([writeNewFile(simultaneous, payload), writeNewFile(simultaneous, winner)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "destination_exists").length, 1);
  const actual = await readFile(simultaneous); assert.ok(actual.equals(payload) || actual.equals(winner));
});

test("Phase17: authentication failure and unsupported source never publish a recovery destination", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key), dir = await directory();
  const destination = join(dir, "must-not-exist.json");
  await assert.rejects(restoreFile(snapshot.bytes, randomBytes(32), snapshot.receipt.archive_sha256, destination), { code: "archive_authentication_failed" });
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(readPrivateFile(dir), { code: "unsafe_file" });
  const invalid = clone(world); invalid.scripts[0].verb = "remember";
  assert.throws(() => createSnapshot(invalid, key));
  const optional = clone(world);
  for (const field of ["depth","visits","marks","skills","bonds"]) delete optional.residents.at(-1)[field];
  const compatible = createSnapshot(optional, key);
  assert.deepEqual(verifySnapshot(compatible.bytes, key, compatible.receipt.archive_sha256).payload.world, optional);
});

test("Phase17: source read errors and rollback failures stay content-free with a discard receipt", async () => {
  const key = randomBytes(32), calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("SELECT") || sql === "ROLLBACK") throw new Error("SYNTHETIC_PRIVATE_BACKEND_PAYLOAD");
    return { rows: [] };
  } };
  await assert.rejects(snapshotPostgres(client, key), err => err.code === "snapshot_read_failed" && err.discard_client === true && !err.message.includes("SYNTHETIC"));
  assert.equal(calls.at(-1), "ROLLBACK"); assert.equal(calls.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false);
});

test("Phase17: a lost BEGIN acknowledgement requires proven rollback or client disposal", async () => {
  const { world } = await fixture(), key = randomBytes(32), snapshot = createSnapshot(world, key, { metadata: rowMetadata(world) });
  for (const operation of [client => snapshotPostgres(client, key), client => restorePostgres(client, snapshot.bytes, key, snapshot.receipt.archive_sha256)]) {
    for (const failRollback of [false, true]) {
      const calls = []; let serverTransaction = false;
      const client = { async query(sql) {
        calls.push(sql);
        if (sql.startsWith("BEGIN")) { serverTransaction = true; throw new Error("SYNTHETIC_LOST_BEGIN_ACK"); }
        assert.equal(sql, "ROLLBACK");
        if (failRollback) throw new Error("SYNTHETIC_LOST_ROLLBACK_ACK");
        serverTransaction = false; return { rows: [] };
      } };
      await assert.rejects(operation(client), err => {
        assert.equal(err.discard_client, failRollback);
        assert.equal(err.message.includes("SYNTHETIC"), false); return true;
      });
      assert.equal(calls.at(-1), "ROLLBACK"); assert.equal(serverTransaction, failRollback);
    }
  }
});

test("Phase17: PostgreSQL timestamp exchange establishes ISO ordering and UTC before reading or inserting", async () => {
  const { world } = await fixture(), key = randomBytes(32), original = { ...rowMetadata(world), world_json: canonical(world) };
  function guarded(db) {
    const client = db.client(); let iso = false, utc = false;
    return { async query(sql, values) {
      if (sql === "SET LOCAL DateStyle = 'ISO, YMD'") iso = true;
      if (sql === "SET LOCAL TIME ZONE 'UTC'") utc = true;
      if (/^(SELECT|INSERT)/.test(sql)) assert.ok(iso && utc, "timestamp I/O inherited ambiguous session formatting");
      return client.query(sql, values);
    } };
  }
  const source = new Database(original), snapshot = await snapshotPostgres(guarded(source), key), destination = new Database(null);
  await restorePostgres(guarded(destination), snapshot.bytes, key, snapshot.receipt.archive_sha256);
  assert.deepEqual(destination.row, original);
});

test("Phase17: library inputs refuse sparse arrays with compensating extra properties", async () => {
  const { world } = await fixture(), candidate = clone(world), extension = [];
  extension.length = 1; extension.extra = "SYNTHETIC_FIELD_MUST_NOT_DISAPPEAR";
  candidate.future_extension = extension;
  assert.throws(() => validateWorld(candidate), { code: "invalid_snapshot" });
  assert.equal(extension.extra, "SYNTHETIC_FIELD_MUST_NOT_DISAPPEAR"); assert.equal(Object.hasOwn(extension, 0), false);
});
