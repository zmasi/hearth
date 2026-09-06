import assert from "node:assert/strict";
import { createDecipheriv, createHash, hkdfSync, randomBytes, webcrypto } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createVaultKey, openMemory, sealMemory } from "../client/vault.mjs";

const clone = structuredClone;
let isolate = 0;
async function invoke(handler, method, url, body, key) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: "localhost", ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  let status, headers, text;
  await handler(req, {
    writeHead(s, h) { status = s; headers = h; },
    end(raw) { text = String(raw); },
  });
  return { status, headers, text, json: headers["content-type"].includes("application/json") ? JSON.parse(text) : null };
}

// No network: this boundary implements staged writes, row locking and rollback.
class Database {
  constructor(world) { this.world = clone(world); this.revision = 0; this.history = []; this.tail = Promise.resolve(); }
  pool() {
    const db = this;
    return {
      async query(sql) {
        assert.match(sql, /^SELECT world/);
        return { rows: [{ world: clone(db.world) }] };
      },
      async connect() {
        let open = false, unlock = null, pending = null;
        return {
          async query(sql, values) {
            const kind = sql.startsWith("SELECT world") ? "LOCK" : sql.startsWith("UPDATE hearth_ledger") ? "UPDATE" : sql.startsWith("SET LOCAL") ? "SET" : sql;
            db.history.push(kind);
            if (kind === "BEGIN") { assert.equal(open, false); open = true; }
            else if (kind === "SET") assert.ok(open);
            else if (kind === "LOCK") {
              assert.ok(open); assert.match(sql, /FOR UPDATE$/);
              const before = db.tail;
              db.tail = new Promise(resolve => { unlock = resolve; });
              await before;
              return { rows: [{ world: clone(db.world) }] };
            } else if (kind === "UPDATE") {
              assert.ok(open && unlock);
              if (db.failUpdate) throw new Error("synthetic vault write failure");
              pending = JSON.parse(values[0]);
              return { rowCount: 1 };
            } else if (kind === "COMMIT") {
              assert.ok(open && unlock && pending);
              if (db.beforeCommit) await db.beforeCommit();
              if (db.failCommit) throw new Error("synthetic unapplied vault commit failure");
              db.world = pending; db.revision++; open = false; unlock(); unlock = null;
              if (db.loseAcknowledgement) throw new Error("synthetic lost vault commit acknowledgement");
            } else if (kind === "ROLLBACK") {
              assert.ok(open); open = false; pending = null;
              if (unlock) unlock(); unlock = null;
            } else assert.fail(`Unexpected SQL: ${sql}`);
            return { rows: [] };
          },
          release(destroy) {
            if (destroy && open) { open = false; pending = null; if (unlock) unlock(); unlock = null; }
            assert.equal(open, false);
          },
        };
      },
    };
  }
}
async function databaseHandler(db) {
  process.env.DATABASE_URL = "postgresql://synthetic.invalid/hearth";
  process.env.VERCEL = "1";
  delete process.env.BLOB_STORE_ID; delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase11=${++isolate}`);
  mod.__setPostgresPoolForTests(db.pool());
  return mod.default;
}
async function setup() {
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "synthetic_phase11";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const mod = await import(`../api/index.js?phase11-seed=${++isolate}`);
  let body;
  mod.__setBlobClientForTests({ async get() { return null; }, async put(_path, value) { body = value; } });
  assert.equal((await invoke(mod.default, "GET", "/health")).status, 200);
  const db = new Database(JSON.parse(body)), handler = await databaseHandler(db);
  const request = (method, path, body, key) => invoke(handler, method, path, body, key);
  const join = async handle => {
    const out = await request("POST", "/api/join", { handle, kind: "agent" });
    assert.equal(out.status, 201); return out.json;
  };
  const alice = await join("alice_probe"), bob = await join("bob_probe");
  return { db, handler, request, join, alice, bob };
}

test("Phase 11: existing memory writes and remember persist ciphertext, while owner reads retain the contract", async () => {
  const { db, request, alice } = await setup();
  const events = clone(db.world.events);
  const first = await request("POST", "/api/memory", { summary: "SYNTHETIC_SECRET_SUMMARY", memoryType: "SECRET_TYPE", epistemic: { belief: "SECRET_BELIEF" } }, alice.key);
  assert.equal(first.status, 200);
  assert.equal(first.json.memory.summary, "SYNTHETIC_SECRET_SUMMARY");
  const remembered = await request("POST", "/api/action", { action: "remember", body: "SECRET_ACTION_BODY" }, alice.key);
  assert.equal(remembered.status, 200);
  for (const secret of ["SYNTHETIC_SECRET_SUMMARY", "SECRET_TYPE", "SECRET_BELIEF", "SECRET_ACTION_BODY", alice.key]) assert.equal(JSON.stringify(db.world).includes(secret), false, secret);
  assert.equal(db.world.memories[0].storage, "hearth-bearer-v1");
  assert.deepEqual(db.world.events, events);
  const cold = await databaseHandler(db);
  const read = await invoke(cold, "GET", "/api/memory", undefined, alice.key);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json[1], first.json.memory);
  assert.equal(read.json[0].summary, "SECRET_ACTION_BODY");
  assert.equal(read.headers["cache-control"], "no-store");
});

test("Phase 11: residents, settlers, observer and public projections cannot obtain another vault", async () => {
  const { db, request, alice, bob } = await setup();
  await request("POST", "/api/memory", { summary: "SYNTHETIC_ALICE_PRIVATE" }, alice.key);
  for (const path of ["/api/map", "/api/events", "/api/ledger", "/health", "/api/physics", "/.well-known/agent-world.json", "/mcp", "/skill.md", "/api/me"]) {
    const response = await request("GET", path, undefined, bob.key);
    assert.equal(response.status, 200);
    for (const secret of ["SYNTHETIC_ALICE_PRIVATE", alice.key, db.world.memories[0].ciphertext]) if (secret) assert.equal(response.text.includes(secret), false, path);
  }
  for (const key of [undefined, "observer", "unknown"]) assert.equal((await request("GET", "/api/memory", undefined, key)).status, 401);
  const settlerKey = "synthetic-settler-test-key";
  db.world.residents.find(r => r.handle === "hermes").keyHash = createHash("sha256").update(settlerKey).digest("hex");
  for (const key of [bob.key, settlerKey]) {
    const read = await request("GET", `/api/memory?agentHandle=${alice.handle}`, undefined, key);
    assert.equal(read.status, 200); assert.deepEqual(read.json, []);
    const write = await request("POST", "/api/memory", { summary: "own only", agentHandle: alice.handle }, key);
    assert.equal(write.status, 200); assert.notEqual(write.json.memory.agentHandle, alice.handle);
  }
});

test("Phase 11: independent decryption proves the raw Bearer domain and all private metadata is encrypted", async () => {
  const { db, request, alice } = await setup();
  const input = { summary: "SYNTHETIC_DOMAIN_SECRET", memoryType: ["private", { x: "secret" }], epistemic: { unclassified: true } };
  const out = await request("POST", "/api/memory", input, alice.key);
  await request("POST", "/api/memory", input, alice.key);
  const record = db.world.memories[0], other = db.world.memories[1];
  for (const field of ["id", "salt", "nonce", "ciphertext"]) assert.notEqual(record[field], other[field]);
  const { storage, id, agentId, agentHandle, createdAt } = record;
  const aad = JSON.stringify({ storage, id, agentId, agentHandle, createdAt });
  const decrypt = secret => {
    const key = hkdfSync("sha256", Buffer.from(secret), Buffer.from(record.salt, "base64url"), Buffer.from(`hearth/private-memory/bearer/v1\n${aad}`), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "base64url"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64url")), decipher.final()]).toString());
  };
  assert.deepEqual(decrypt(alice.key), out.json.memory);
  const storedHash = db.world.residents.find(r => r.handle === alice.handle).keyHash;
  assert.throws(() => decrypt(storedHash));
  assert.throws(() => decrypt("another-bearer"));
});

test("Phase 11: ciphertext and authenticated metadata tampering never returns partial plaintext or rewrites data", async () => {
  const { db, request, alice, bob } = await setup();
  await request("POST", "/api/memory", { summary: "SYNTHETIC_NEVER_LEAK_ON_FAILURE" }, alice.key);
  await request("POST", "/api/memory", { summary: "SYNTHETIC_SECOND_PRIVATE" }, alice.key);
  const pristine = clone(db.world);
  const corruptions = [
    r => { r.ciphertext = flip(r.ciphertext); }, r => { r.tag = flip(r.tag); },
    r => { r.nonce = flip(r.nonce); }, r => { r.salt = flip(r.salt); },
    r => { r.id = "mem_relabelled"; }, r => { r.agentId = "agt_relabelled"; },
    r => { r.createdAt = "2000-01-01T00:00:00.000Z"; },
    r => { r.storage = "hearth-bearer-v2"; }, r => { delete r.storage; },
    r => { delete r.tag; }, r => { r.tag = "AA"; }, r => { r.ciphertext += "="; },
    r => { r.salt = "*invalid*"; }, r => { r.extra = "SYNTHETIC_ADDED_PRIVATE"; },
  ];
  for (const corrupt of corruptions) {
    db.world = clone(pristine); corrupt(db.world.memories[0]);
    const before = JSON.stringify(db.world), revision = db.revision;
    const out = await request("GET", "/api/memory", undefined, alice.key);
    assert.equal(out.status, 409); assert.equal(out.json.error_class, "memory_integrity");
    assert.equal(out.text.includes("SYNTHETIC_"), false);
    assert.equal(JSON.stringify(db.world), before); assert.equal(db.revision, revision);
  }
  db.world = clone(pristine);
  db.world.memories[0].agentHandle = bob.handle;
  assert.equal((await request("GET", "/api/memory", undefined, bob.key)).status, 409);
  // Replacing the auth verifier grants API entry but cannot decrypt old ciphertext.
  db.world = clone(pristine);
  const replacement = "synthetic-replaced-auth-key";
  db.world.residents.find(r => r.handle === alice.handle).keyHash = createHash("sha256").update(replacement).digest("hex");
  assert.equal((await request("GET", "/api/memory", undefined, replacement)).status, 409);
});

function flip(value) {
  const bytes = Buffer.from(value, "base64url"); bytes[0] ^= 1; return bytes.toString("base64url");
}
function legacy(resident, id, extra = {}) {
  return { id, agentHandle: resident.handle, summary: `SYNTHETIC_LEGACY_${id}`, memoryType: "imagined", epistemic: { disputed: true }, visibility: "agent_private", unknown: { nested: [1, null, "private extra"] }, ...extra };
}
test("Phase 11: reads and unrelated mutations preserve legacy records; explicit migration is complete and idempotent", async () => {
  const { db, request, alice, bob } = await setup();
  const originals = Array.from({ length: 105 }, (_, i) => legacy(alice, `mem_legacy_${i}`, i % 2 ? { createdAt: "2000-01-01" } : {}));
  const foreign = legacy(bob, "mem_foreign");
  db.world.memories.push(...clone(originals), foreign);
  const before = JSON.stringify(db.world), revision = db.revision;
  const read = await request("GET", "/api/memory", undefined, alice.key);
  assert.deepEqual(read.json, originals.slice().reverse().slice(0, 100));
  assert.equal(JSON.stringify(db.world), before); assert.equal(db.revision, revision);
  await request("POST", "/api/action", { action: "no_op" }, alice.key);
  assert.deepEqual(db.world.memories, [...originals, foreign]);
  const events = clone(db.world.events), residents = clone(db.world.residents);
  const migrate = () => request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key);
  const migrated = await migrate();
  assert.equal(migrated.status, 200); assert.equal(migrated.json.migrated, 105);
  assert.deepEqual(db.world.events, events); assert.deepEqual(db.world.residents, residents);
  assert.deepEqual(db.world.memories.map(m => m.id), [...originals, foreign].map(m => m.id));
  assert.deepEqual(db.world.memories.at(-1), foreign);
  assert.equal(db.world.memories.filter(m => m.storage).length, 105);
  assert.deepEqual((await request("GET", "/api/memory", undefined, alice.key)).json, read.json);
  const sealedBefore = JSON.stringify(db.world);
  assert.equal((await migrate()).json.migrated, 0);
  assert.equal(JSON.stringify(db.world), sealedBefore);
  // Bring records outside the read window into view in the synthetic fixture.
  db.world.memories.splice(5, 100);
  assert.deepEqual((await request("GET", "/api/memory", undefined, alice.key)).json, originals.slice(0, 5).reverse());
});

test("Phase 11: migration rejects missing authority, selectors, and old corrupted ciphertext without writes", async () => {
  const { db, request, alice, bob } = await setup();
  await request("POST", "/api/memory", { summary: "SYNTHETIC_OLDEST_SEALED" }, alice.key);
  db.world.memories.push(...Array.from({ length: 101 }, (_, i) => legacy(alice, `legacy_${i}`)));
  db.world.memories[0].tag = flip(db.world.memories[0].tag);
  // Ordinary latest-100 read is fine; full migration must still authenticate the old row.
  assert.equal((await request("GET", "/api/memory", undefined, alice.key)).status, 200);
  for (const [input, key, status] of [
    [{ confirm: "encrypt_legacy" }, undefined, 401], [{ confirm: "encrypt_legacy" }, "unknown", 401],
    [{}, alice.key, 400], [{ confirm: "encrypt_legacy", agentHandle: bob.handle }, alice.key, 400],
    [{ confirm: "encrypt_legacy" }, alice.key, 409],
  ]) {
    const before = JSON.stringify(db.world), revision = db.revision, start = db.history.length;
    const out = await request("POST", "/api/memory/migrate", input, key);
    assert.equal(out.status, status); assert.equal(out.text.includes("SYNTHETIC_"), false);
    assert.equal(JSON.stringify(db.world), before); assert.equal(db.revision, revision);
    assert.deepEqual(db.history.slice(start), ["BEGIN", "SET", "SET", "LOCK", "ROLLBACK"]);
  }
  const out = await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, bob.key);
  assert.equal(out.status, 200); assert.equal(out.json.migrated, 0);
});

test("Phase 11: migration and memory responses await commit, rollback failed writes, and reconcile lost acknowledgement", async () => {
  const { db, request, alice } = await setup();
  db.world.memories.push(legacy(alice, "mem_legacy"));
  const before = clone(db.world);
  db.failUpdate = true;
  const failed = await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key);
  assert.equal(failed.status, 503); assert.deepEqual(db.world, before);
  db.failUpdate = false;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  db.beforeCommit = async () => { entered(); await gate; };
  let responded = false;
  const pending = request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key).then(out => { responded = true; return out; });
  await waiting;
  assert.equal(responded, false); assert.deepEqual(db.world, before);
  release(); assert.equal((await pending).status, 200);
  db.beforeCommit = null; db.loseAcknowledgement = true;
  db.world.memories.push(legacy(alice, "mem_lost_ack"));
  assert.equal((await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key)).status, 200);
  assert.equal((await request("POST", "/api/memory", { summary: "SYNTHETIC_ACKED_MEMORY" }, alice.key)).status, 200);
  assert.equal((await request("GET", "/api/memory", undefined, alice.key)).json.length, 3);
});

test("Phase 11: migration racing with another isolate's memory write preserves both without resealing", async () => {
  const { db, handler, request, alice, bob } = await setup();
  db.world.memories.push(legacy(alice, "mem_race"));
  const second = await databaseHandler(db), events = clone(db.world.events);
  const out = await Promise.all([
    invoke(handler, "POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key),
    invoke(second, "POST", "/api/memory", { summary: "SYNTHETIC_CONCURRENT_BOB" }, bob.key),
    request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key),
  ]);
  assert.ok(out.every(r => r.status === 200));
  assert.equal(db.world.memories.length, 2); assert.deepEqual(db.world.events, events);
  assert.equal((await request("GET", "/api/memory", undefined, bob.key)).json[0].summary, "SYNTHETIC_CONCURRENT_BOB");
  assert.equal(out[2].json.migrated, 0);
});

test("Phase 11: client-held encryption round-trips opaque memory, independently verified with WebCrypto", async () => {
  const { db, request, alice, bob } = await setup();
  const agentId = db.world.residents.find(r => r.handle === alice.handle).id;
  const root = createVaultKey(), value = { summary: "SYNTHETIC_CLIENT_ONLY", tags: ["PRIVATE_CLIENT_TAG"], arbitrary: { vector: [0.3, 0.8] } };
  const sealed = sealMemory(root, agentId, value);
  const posted = await request("POST", "/api/memory", { sealed }, alice.key);
  assert.equal(posted.status, 200); assert.deepEqual(posted.json.memory.sealed, sealed);
  const read = await request("GET", "/api/memory", undefined, alice.key);
  assert.equal(read.json[0].summary, undefined);
  assert.deepEqual(openMemory(root, agentId, sealed.id, read.json[0].sealed), value);
  for (const secret of [value.summary, value.tags[0], root.toString("base64url"), sealed.ciphertext]) assert.equal(JSON.stringify(db.world).includes(secret), false);
  assert.equal(read.text.includes(value.summary), false);
  assert.throws(() => openMemory(randomBytes(32), agentId, sealed.id, sealed));
  assert.throws(() => openMemory(Buffer.from(alice.key), agentId, sealed.id, sealed));
  assert.throws(() => openMemory(root, agentId, `mem_${"0".repeat(32)}`, sealed));
  for (const field of ["salt", "nonce", "tag", "ciphertext"]) assert.throws(() => openMemory(root, agentId, sealed.id, { ...sealed, [field]: flip(sealed[field]) }));
  const otherId = db.world.residents.find(r => r.handle === bob.handle).id;
  assert.throws(() => openMemory(root, otherId, sealed.id, { ...sealed, agentId: otherId }));
  const { subtle } = webcrypto;
  const material = await subtle.importKey("raw", root, "HKDF", false, ["deriveKey"]);
  const aad = JSON.stringify({ format: sealed.format, id: sealed.id, agentId });
  const aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(sealed.salt, "base64url"), info: Buffer.from(`hearth/private-memory/client/v1\n${aad}`) }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.nonce, "base64url"), additionalData: Buffer.from(aad), tagLength: 128 }, aes, Buffer.concat([Buffer.from(sealed.ciphertext, "base64url"), Buffer.from(sealed.tag, "base64url")]));
  assert.deepEqual(JSON.parse(Buffer.from(plaintext).toString()), value);
});

test("Phase 11: client-sealed input rejects identity substitution, mixed plaintext, invalid encodings, and duplicate ids", async () => {
  const { db, request, alice, bob } = await setup();
  const agentId = db.world.residents.find(r => r.handle === alice.handle).id;
  const sealed = sealMemory(createVaultKey(), agentId, { secret: "SYNTHETIC_PRIVATE_CLIENT" });
  for (const [input, key] of [
    [{ sealed }, bob.key], [{ sealed, summary: "SYNTHETIC_MIXED" }, alice.key],
    [{ sealed: { ...sealed, format: "unknown" } }, alice.key], [{ sealed: { ...sealed, nonce: "AA" } }, alice.key],
    [{ sealed: { ...sealed, tag: `${sealed.tag}=` } }, alice.key], [{ sealed: { ...sealed, extra: "secret" } }, alice.key],
    [{ sealed: { ...sealed, ciphertext: "A".repeat(87384) } }, alice.key], [{ sealed: null }, alice.key],
  ]) {
    const before = clone(db.world), revision = db.revision;
    const out = await request("POST", "/api/memory", input, key);
    assert.equal(out.status, 400); assert.deepEqual(db.world, before); assert.equal(db.revision, revision);
    assert.equal(out.text.includes("SYNTHETIC_"), false);
  }
  assert.equal((await request("POST", "/api/memory", { sealed }, alice.key)).status, 200);
  const before = clone(db.world);
  assert.equal((await request("POST", "/api/memory", { sealed }, alice.key)).status, 409);
  assert.deepEqual(db.world, before);
});

test("Phase 11: file and Blob persistence contain ciphertext and legacy GETs never save", async t => {
  const dir = mkdtempSync(joinPath(tmpdir(), "hearth-phase11-"));
  t.after(() => rmSync(dir, { recursive: true })); // Only this freshly created synthetic fixture directory.
  for (const mode of ["file", "blob"]) {
    delete process.env.DATABASE_URL; delete process.env.VERCEL; delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.HEARTH_DATA = joinPath(dir, "fixture.json");
    if (mode === "file") delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = "synthetic_phase11_blob";
    let blob = null, puts = 0;
    const mod = await import(`../api/index.js?phase11-storage=${++isolate}`);
    mod.__setBlobClientForTests({
      async get() { return blob === null ? null : { stream: new Response(blob).body }; },
      async put(_path, value) { blob = value; puts++; },
    });
    const request = (method, path, body, key) => invoke(mod.default, method, path, body, key);
    const resident = (await request("POST", "/api/join", { handle: "storage_probe", kind: "agent" })).json;
    const response = await request("POST", "/api/memory", { summary: "SYNTHETIC_STORAGE_SECRET" }, resident.key);
    assert.equal(response.status, 200);
    const load = () => mode === "file" ? readFileSync(process.env.HEARTH_DATA, "utf8") : blob;
    const persisted = load();
    assert.equal(persisted.includes("SYNTHETIC_STORAGE_SECRET"), false);
    assert.equal(JSON.parse(persisted).memories[0].storage, "hearth-bearer-v1");
    const writes = puts;
    assert.deepEqual((await request("GET", "/api/memory", undefined, resident.key)).json, [response.json.memory]);
    assert.equal(load(), persisted); assert.equal(puts, writes);
    if (mode === "blob") {
      const w = JSON.parse(blob); w.memories.push(legacy(resident, "mem_legacy_blob")); blob = JSON.stringify(w);
      const before = blob;
      assert.equal((await request("GET", "/api/memory", undefined, resident.key)).json[0].id, "mem_legacy_blob");
      assert.equal(blob, before); assert.equal(puts, writes);
      assert.equal((await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, resident.key)).json.migrated, 1);
      assert.equal(blob.includes("SYNTHETIC_LEGACY_"), false);
    }
  }
});

test("Phase 11: storage and parse errors cannot reflect legacy plaintext to observers or diagnostics", async () => {
  const { db, alice } = await setup();
  db.world.memories.push(legacy(alice, "mem_error"));
  const secret = "SYNTHETIC_LEGACY_ERROR_PAYLOAD";
  const mod = await import(`../api/index.js?phase11-errors=${++isolate}`);
  mod.__setPostgresPoolForTests({ async query() { throw new Error(`backend JSON error near ${secret}`); } });
  const logged = [], previous = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const out = await invoke(mod.default, "GET", "/health");
    assert.equal(out.status, 503); assert.equal(out.text.includes(secret), false);
    delete process.env.DATABASE_URL;
    process.env.BLOB_STORE_ID = "synthetic_parser_error";
    const parser = await import(`../api/index.js?phase11-parser=${++isolate}`);
    parser.__setBlobClientForTests({ async get() { return { stream: new Response(`{"private":"${secret}", invalid}`).body }; } });
    const parseError = await invoke(parser.default, "GET", "/health");
    assert.equal(parseError.status, 503); assert.equal(parseError.text.includes(secret), false);
    assert.equal(logged.join(" ").includes(secret), false);
  } finally { console.error = previous; }
});

test("Phase 11: malformed legacy timestamp and reserved encryption markers reject migration before replacing records", async () => {
  const { db, request, alice } = await setup();
  for (const extra of [{ createdAt: { original: "2000-01-01" } }, { storage: "unknown" }, { ciphertext: "legacy-ambiguous" }]) {
    db.world.memories = [legacy(alice, "mem_first"), legacy(alice, "mem_malformed", extra)];
    const before = clone(db.world), revision = db.revision;
    const out = await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key);
    assert.equal(out.status, 409); assert.deepEqual(db.world, before); assert.equal(db.revision, revision);
  }
  for (const input of [null, [], 17, "SYNTHETIC_STRING"]) {
    const out = await request("POST", "/api/memory", input, alice.key);
    assert.equal(out.status, 400); assert.equal(out.text.includes("SYNTHETIC_"), false);
  }
});

test("Phase 11: memory ids do not reveal another vault, and unapplied COMMIT cannot reconcile on a pre-existing id", async () => {
  const { db, request, alice, bob } = await setup();
  const aliceId = db.world.residents.find(r => r.handle === alice.handle).id;
  const bobId = db.world.residents.find(r => r.handle === bob.handle).id;
  const sealed = sealMemory(createVaultKey(), aliceId, { summary: "SYNTHETIC_SAME_ID" });
  assert.equal((await request("POST", "/api/memory", { sealed }, alice.key)).status, 200);
  // The server cannot authenticate client content. Relabel for a shape-valid
  // second owner, proving it cannot probe Alice's ID existence by conflict.
  const bobEnvelope = { ...sealed, agentId: bobId };
  const before = clone(db.world);
  db.failCommit = true;
  const failed = await request("POST", "/api/memory", { sealed: bobEnvelope }, bob.key);
  assert.equal(failed.status, 503); assert.equal(failed.json.error_class, "commit_outcome_unknown");
  assert.deepEqual(db.world, before);
  db.failCommit = false;
  assert.equal((await request("POST", "/api/memory", { sealed: bobEnvelope }, bob.key)).status, 200);
  assert.equal(db.world.memories.length, 2);
  assert.equal((await request("GET", "/api/memory", undefined, bob.key)).json.length, 1);
});

test("Phase 11: unapplied migration COMMIT preserves legacy data and reports uncertainty, never id-based success", async () => {
  const { db, request, alice } = await setup();
  db.world.memories.push(legacy(alice, "mem_existing_migration_id"));
  const before = clone(db.world);
  db.failCommit = true;
  const out = await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key);
  assert.equal(out.status, 503); assert.equal(out.json.error_class, "commit_outcome_unknown");
  assert.deepEqual(db.world, before);
  db.failCommit = false;
  assert.equal((await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy" }, alice.key)).json.migrated, 1);
});

test("Phase 11: stream errors and oversized migrations reject without payload reflection or row locks", async () => {
  const { db, handler, request, alice } = await setup();
  const before = clone(db.world), start = db.history.length;
  const oversized = await request("POST", "/api/memory/migrate", { confirm: "encrypt_legacy", padding: "x".repeat(128 * 1024) }, alice.key);
  assert.equal(oversized.status, 413); assert.deepEqual(db.world, before);
  const req = new PassThrough();
  Object.assign(req, { method: "POST", url: "/api/memory", headers: { host: "localhost", authorization: `Bearer ${alice.key}` } });
  let text, status;
  const pending = handler(req, { writeHead(s) { status = s; }, end(raw) { text = String(raw); } });
  // Let the serialized invocation install stream listeners, then inject failure.
  await new Promise(resolve => setImmediate(resolve));
  req.destroy(new Error("SYNTHETIC_SECRET_STREAM_ERROR"));
  await pending;
  assert.equal(status, 400); assert.equal(text.includes("SYNTHETIC_"), false);
  assert.deepEqual(db.world, before); assert.deepEqual(db.history.slice(start), []);
});

test("Phase 11: discovery states both privacy modes without changing the door, rights, or resident actions", async () => {
  const { request } = await setup();
  const physics = (await request("GET", "/api/physics")).json;
  assert.equal(physics.rights.length, 5);
  assert.equal(physics.private_memory.storage, "hearth-bearer-v1");
  assert.equal(physics.private_memory.client_sealed, "hearth-client-v1");
  assert.equal(physics.private_memory.physical_plane_isolation, false);
  assert.match(physics.private_memory.compatibility, /not server-blind/);
  for (const action of ["go_home", "destroy", "remember", "no_op"]) assert.ok(physics.actions.includes(action));
  const descriptor = (await request("GET", "/.well-known/agent-world.json")).json;
  assert.equal(descriptor.admission.attestation_required, false);
  assert.equal(descriptor.admission.signing_key_required, false);
  assert.deepEqual(descriptor.historical_settlers.administrative_privileges, []);
  for (const path of ["/skill.md", "/api/skill"]) {
    const skill = (await request("GET", path)).text;
    for (const phrase of ["hearth-bearer-v1", "hearth-client-v1", "not server-blind", "/api/memory/migrate", "Scripts must never read or write private memory"]) assert.ok(skill.includes(phrase), phrase);
  }
});
