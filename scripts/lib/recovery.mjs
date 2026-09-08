import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { open, lstat, link } from "node:fs/promises";

export const PROFILE = "hearth-state-3.1-phase13-v1";
export const ARCHIVE_FORMAT = "hearth-snapshot-aes256gcm-v1";
export const MAX_BYTES = 64 * 1024 * 1024;
const ZERO = "0".repeat(64);
const HEX = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const has = (value, key) => Object.hasOwn(value, key);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => has(value, k));
const need = (condition, code = "invalid_snapshot") => { if (!condition) throw fault(code); };
export function fault(code = "invalid_snapshot") {
  return Object.assign(new Error("Recovery refused or incomplete; private details withheld. Inspect the error code."), { code });
}
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Parse without silently dropping duplicate keys, rounding numbers, accepting
// invalid Unicode/NUL, or recursing without a bound. No input enters errors.
export function parseJson(bytes) {
  try {
    need(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, "size_limit");
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    let p = 0;
    const whitespace = () => { while (/[\x20\t\n\r]/.test(source[p] ?? "!")) p++; };
    const string = () => {
      const start = p++;
      while (p < source.length && source[p] !== '"') {
        if (source[p] === "\\") p++;
        p++;
      }
      need(p < source.length); p++;
      const value = JSON.parse(source.slice(start, p));
      need(value.isWellFormed() && !value.includes("\0"));
      return value;
    };
    const decimal = token => {
      const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
      let digits = (m[2] + (m[3] || "")).replace(/^0+/, "");
      if (!digits) return "0";
      let exponent = BigInt(m[4] || 0) - BigInt((m[3] || "").length);
      while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
      return `${m[1]}${digits}e${exponent}`;
    };
    const value = depth => {
      need(depth <= 100, "size_limit"); whitespace();
      if (source[p] === '"') return string();
      if (source[p] === "{" || source[p] === "[") {
        const isObject = source[p++] === "{", closing = isObject ? "}" : "]";
        const out = isObject ? {} : [], keys = new Set();
        whitespace(); if (source[p] === closing) { p++; return out; }
        while (true) {
          whitespace(); let key;
          if (isObject) {
            need(source[p] === '"'); key = string(); need(!keys.has(key)); keys.add(key);
            whitespace(); need(source[p++] === ":");
          }
          const item = value(depth + 1);
          if (isObject) Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
          else out.push(item);
          whitespace(); if (source[p] === closing) { p++; return out; }
          need(source[p++] === ",");
        }
      }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(p));
      need(match); p += match[0].length;
      const result = JSON.parse(match[0]);
      if (typeof result === "number") need(Number.isFinite(result) && !Object.is(result, -0)
        && (!Number.isInteger(result) || Number.isSafeInteger(result)) && decimal(match[0]) === decimal(JSON.stringify(result)));
      return result;
    };
    const parsed = value(0); whitespace(); need(p === source.length); return parsed;
  } catch (err) { throw fault(err?.code === "size_limit" ? "size_limit" : "invalid_json"); }
}
function jsonCopy(value) {
  // Library callers must provide JSON data, never classes/getters/secret clients.
  const seen = new Set();
  function check(v, depth) {
    need(depth <= 90, "size_limit");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "string") { need(v.isWellFormed() && !v.includes("\0")); return; }
    if (typeof v === "number") { need(Number.isFinite(v) && !Object.is(v, -0) && (!Number.isInteger(v) || Number.isSafeInteger(v))); return; }
    need(object(v) || Array.isArray(v)); need(!seen.has(v)); seen.add(v);
    need([Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v)));
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(v) && key === "length") continue;
      const d = descriptors[key]; need(typeof key === "string" && d.enumerable && has(d, "value"));
      need(key.isWellFormed() && !key.includes("\0")); check(d.value, depth + 1);
    }
    if (Array.isArray(v)) {
      need(Object.keys(v).length === v.length);
      for (let i = 0; i < v.length; i++) need(has(v, i));
    }
    seen.delete(v);
  }
  check(value, 0);
  return parseJson(Buffer.from(JSON.stringify(value)));
}
function encoded(value, size) {
  need(typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, "base64url");
  need(bytes.toString("base64url") === value && (size === undefined || bytes.length === size));
  return bytes;
}
function rows(list) {
  need(Array.isArray(list)); const ids = new Set();
  for (const row of list) { need(object(row) && text(row.id) && !ids.has(row.id)); ids.add(row.id); }
  return new Map(list.map(r => [r.id, r]));
}
const PERMISSIONS = new Set(["enter","observe","speak","create_subplace","place_thing","use_thing","create_note","set_local_law","destroy_thing","destroy_note","destroy_place","pin_script"]);
const SCRIPT_OPS = new Set(["look","walk","found","make","say","give","agree","sign","permit","law","use","become","go_home","set_home","no_op","destroy"]);
const RESERVED_VERBS = new Set([...SCRIPT_OPS, "observe","move","speak","create_place","create_thing","transfer","rest","leave","legislate","introduce","invoke","pin","unpin","perform","join","remember"]);
const INSTRUCTION_KEYS = new Set(["do","targetId","targetKind","body","name","title","toHandle","agreementId","memoryType","epistemic"]);

// Validation never calls the live kernel's initial-chain sealing or any vault
// decryption function. This is a pinned compatibility profile, not state replay.
export function validateWorld(input) {
  const w = jsonCopy(input);
  need(object(w) && w.version === "3.1", "incompatible_snapshot");
  for (const k of ["places","residents","portals","notes","things","agreements","events","memories","quests"]) need(Array.isArray(w[k]));
  need(object(w.rates));
  const places = rows(w.places), residents = rows(w.residents), handles = new Map();
  for (const r of residents.values()) {
    need(/^[a-z][a-z0-9_]{2,23}$/.test(r.handle) && !handles.has(r.handle) && r.kind === "agent");
    need(r.keyHash === null || (typeof r.keyHash === "string" && HEX.test(r.keyHash)));
    for (const field of ["visits","marks","skills"]) if (has(r, field)) need(Array.isArray(r[field]));
    if (has(r, "bonds")) need(object(r.bonds));
    if (has(r, "depth")) need(Number.isSafeInteger(r.depth) && r.depth >= 0);
    handles.set(r.handle, r);
  }
  const livePlace = id => places.has(id) && !places.get(id).destroyedAt;
  for (const p of places.values()) {
    need(text(p.name) && text(p.kind) && Array.isArray(p.laws) && p.laws.every(v => typeof v === "string"));
    need(Number.isSafeInteger(p.revision) && p.revision > 0 && object(p.permissions));
    for (const [k, v] of Object.entries(p.permissions)) need(PERMISSIONS.has(k) && ["public","owner_only","closed"].includes(v), "incompatible_snapshot");
    need(p.ownerHandle === null || handles.has(p.ownerHandle));
    need(p.id === "world" ? p.parentId === null : places.has(p.parentId));
    if (!p.destroyedAt && p.id !== "world") need(livePlace(p.parentId));
    const ancestry = new Set([p.id]); let parent = p.parentId;
    while (parent !== null) { need(!ancestry.has(parent) && places.has(parent)); ancestry.add(parent); parent = places.get(parent).parentId; }
  }
  for (const id of ["world","arrival"]) need(livePlace(id) && places.get(id).ownerHandle === null && places.get(id).permissions.enter === "public");
  need(places.get("world").kind === "world" && places.get("arrival").parentId === "world");
  for (const r of residents.values()) {
    need(livePlace(r.enclaveId) && places.get(r.enclaveId).ownerHandle === r.handle);
    need(livePlace(r.homeId) && livePlace(r.standingId));
  }
  for (const p of rows(w.portals).values()) need(livePlace(p.a) && livePlace(p.b));
  for (const name of ["notes", "things"]) for (const item of rows(w[name]).values()) {
    need(places.has(item.placeId) && (item.destroyedAt || livePlace(item.placeId)));
    need(handles.has(name === "notes" ? item.authorHandle : item.ownerHandle) && typeof item.body === "string");
    if (name === "things") need(text(item.name));
  }
  for (const a of rows(w.agreements).values()) need(text(a.title) && typeof a.body === "string" && handles.has(a.authorHandle)
    && Array.isArray(a.signers) && a.signers.every(h => handles.has(h)) && new Set(a.signers).size === a.signers.length);
  rows(w.events); let previous = ZERO;
  for (const [i, e] of w.events.slice().reverse().entries()) {
    const { id, kind, text: eventText, placeId, actorHandle, createdAt, seq, prev_hash } = e;
    need(text(kind) && typeof eventText === "string" && (placeId === null || text(placeId))
      && (actorHandle === null || text(actorHandle)) && text(createdAt));
    need(seq === i + 1 && prev_hash === previous && e.hash === sha256(JSON.stringify({ id, kind, text: eventText, placeId, actorHandle, createdAt, seq, prev_hash })));
    previous = e.hash;
  }
  need(w.world_sequence === w.events.length && w.ledger_head === previous && w.ledger_genesis === (w.events.at(-1)?.hash ?? ZERO));
  const memoryIds = new Set(); let legacy = 0, encrypted = 0;
  for (const m of w.memories) {
    need(object(m) && text(m.id) && handles.has(m.agentHandle));
    const identity = JSON.stringify([m.agentHandle, m.id]); need(!memoryIds.has(identity)); memoryIds.add(identity);
    need(m.createdAt == null || typeof m.createdAt === "string");
    if (["storage","ciphertext","nonce","salt","tag"].some(k => has(m, k))) {
      need(exact(m, ["storage","id","agentId","agentHandle","createdAt","salt","nonce","tag","ciphertext"]));
      need(m.storage === "hearth-bearer-v1", "incompatible_snapshot");
      need(m.agentId === handles.get(m.agentHandle).id);
      encoded(m.salt, 32); encoded(m.nonce, 12); encoded(m.tag, 16); encoded(m.ciphertext); encrypted++;
    } else { need(typeof m.summary === "string"); legacy++; }
  }
  if (has(w, "scripts")) for (const s of rows(w.scripts).values()) {
    need(["thing","place"].includes(s.targetKind) && text(s.targetId) && handles.has(s.authorHandle));
    need(/^[a-z][a-z0-9_.:-]{0,63}$/.test(s.verb) && !RESERVED_VERBS.has(s.verb));
    need(Array.isArray(s.instructions) && s.instructions.length > 0 && s.instructions.length <= 16);
    need(Buffer.byteLength(canonical(s.instructions)) <= 8192);
    for (const op of s.instructions) need(object(op) && SCRIPT_OPS.has(op.do)
      && Object.entries(op).every(([k, v]) => INSTRUCTION_KEYS.has(k) && typeof v === "string"));
    // Phase13 hashes JSON.stringify insertion order. PostgreSQL jsonb can
    // reorder object keys, so that original hash is retained, not recomputed.
    // The snapshot's full-state digest authenticates these exact stored values.
    need(typeof s.instructionHash === "string" && HEX.test(s.instructionHash));
    need(s.targetKind === "place" ? places.has(s.targetId) : w.things.some(t => t.id === s.targetId));
  }
  return { world: w, world_sha256: sha256(canonical(w)), world_sequence: w.world_sequence,
    ledger_head: w.ledger_head, legacy_memories: legacy, encrypted_memories: encrypted };
}

const ROW_FIELDS = ["id","constitution_version","revision","migrated_from","migrated_sha256","migrated_blob_etag","migrated_at","updated_at"];
function validateMetadata(row) {
  need(exact(row, ROW_FIELDS)); need(row.id === 1 && row.constitution_version === "3.1");
  need(typeof row.revision === "string" && /^[1-9]\d{0,18}$/.test(row.revision) && BigInt(row.revision) <= 9223372036854775807n);
  need(text(row.migrated_from) && typeof row.migrated_sha256 === "string" && HEX.test(row.migrated_sha256)
    && (row.migrated_blob_etag === null || typeof row.migrated_blob_etag === "string"));
  for (const field of ["migrated_at","updated_at"]) need(text(row[field]) && Number.isFinite(Date.parse(row[field])));
}
function archiveKey(key) { need(Buffer.isBuffer(key) && key.length === 32, "invalid_archive_key"); }
export function createSnapshot(world, key, { metadata = null, capturedAt = new Date().toISOString() } = {}) {
  archiveKey(key); const checked = validateWorld(world);
  const row = metadata === null ? null : jsonCopy(metadata); if (row) validateMetadata(row);
  need(typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt)) && new Date(capturedAt).toISOString() === capturedAt);
  const payload = { profile: PROFILE, captured_at: capturedAt, world_sha256: checked.world_sha256, metadata: row, world: checked.world };
  const plain = Buffer.from(canonical(payload)); need(plain.length <= 47 * 1024 * 1024, "size_limit");
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(ARCHIVE_FORMAT));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const bytes = Buffer.from(JSON.stringify({ format: ARCHIVE_FORMAT, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") }));
    return { bytes, receipt: { ...summary(payload, checked), archive_sha256: sha256(bytes) } };
  } finally { plain.fill(0); }
}
function summary(payload, checked) {
  return { ok: true, profile: PROFILE, captured_at: payload.captured_at, world_sha256: checked.world_sha256,
    world_sequence: checked.world_sequence, ledger_head: checked.ledger_head,
    revision: payload.metadata?.revision ?? null, legacy_memories: checked.legacy_memories,
    encrypted_memories: checked.encrypted_memories, vault_tags_verified: false };
}
export function verifySnapshot(bytes, key, expectedSha256) {
  archiveKey(key); need(typeof expectedSha256 === "string" && HEX.test(expectedSha256), "expected_digest_required");
  need(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, "size_limit");
  need(sha256(bytes) === expectedSha256, "archive_digest_mismatch");
  const archive = parseJson(bytes);
  need(exact(archive, ["format","nonce","tag","ciphertext"]) && archive.format === ARCHIVE_FORMAT, "incompatible_snapshot");
  let provisional, plain;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, encoded(archive.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(ARCHIVE_FORMAT)); decipher.setAuthTag(encoded(archive.tag, 16));
    provisional = decipher.update(encoded(archive.ciphertext)); plain = Buffer.concat([provisional, decipher.final()]);
    const payload = parseJson(plain);
    need(exact(payload, ["profile","captured_at","world_sha256","metadata","world"]) && payload.profile === PROFILE, "incompatible_snapshot");
    need(typeof payload.captured_at === "string" && Number.isFinite(Date.parse(payload.captured_at))
      && new Date(payload.captured_at).toISOString() === payload.captured_at);
    if (payload.metadata !== null) validateMetadata(payload.metadata);
    const checked = validateWorld(payload.world); need(payload.world_sha256 === checked.world_sha256, "state_digest_mismatch");
    return { payload, receipt: { ...summary(payload, checked), archive_sha256: expectedSha256 } };
  } catch (err) {
    if (["incompatible_snapshot","state_digest_mismatch","size_limit","invalid_json","invalid_snapshot"].includes(err?.code)) throw err;
    throw fault("archive_authentication_failed");
  } finally { provisional?.fill(0); plain?.fill(0); }
}

export async function readPrivateFile(path, limit = MAX_BYTES) {
  let handle;
  try {
    const before = await lstat(path); need(before.isFile() && !before.isSymbolicLink() && before.size <= limit, "unsafe_file");
    handle = await open(path, "r"); const opened = await handle.stat();
    need(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, "unsafe_file");
    // Fixed bound also covers a file that grows between stat and read.
    const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1));
    let offset = 0;
    while (offset < bytes.length) { const got = await handle.read(bytes, offset, bytes.length - offset, null); if (!got.bytesRead) break; offset += got.bytesRead; }
    const after = await handle.stat();
    need(offset <= limit && after.size === before.size && after.mtimeMs === before.mtimeMs && offset === before.size, "source_changed");
    return bytes.subarray(0, offset);
  } catch (err) { throw fault(["unsafe_file","source_changed"].includes(err?.code) ? err.code : "file_read_failed"); }
  finally { await handle?.close(); }
}
export async function writeNewFile(path, bytes, io = { open, link }) {
  need(typeof path === "string" && Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, "invalid_snapshot");
  const staging = `${path}.staging-${randomBytes(16).toString("hex")}`;
  let handle;
  try {
    handle = await io.open(staging, "wx", 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const actual = await readPrivateFile(staging);
    need(actual.equals(bytes), "output_verification_failed");
    // Local hard-link publication is atomic and never replaces an existing
    // name. No check-then-write, overwrite-capable rename, or partial target.
    await io.link(staging, path);
  } catch (err) { throw fault(err?.code === "EEXIST" ? "destination_exists" : "output_incomplete"); }
  finally { await handle?.close(); }
  // Staging artifacts remain private and are never automatically removed.
  // Only a successfully verified complete file is published as destination.
}
export async function restoreFile(bytes, key, expectedSha256, destination) {
  const checked = verifySnapshot(bytes, key, expectedSha256);
  await writeNewFile(destination, Buffer.from(canonical(checked.payload.world)));
  const restored = validateWorld(parseJson(await readPrivateFile(destination)));
  need(restored.world_sha256 === checked.receipt.world_sha256, "output_verification_failed");
  return { ...checked.receipt, action: "restored_new_file" };
}

const SELECT = `SELECT id, world::text AS world_json, constitution_version, revision::text AS revision,
  migrated_from, migrated_sha256, migrated_blob_etag, migrated_at::text AS migrated_at, updated_at::text AS updated_at
  FROM public.hearth_ledger ORDER BY id`;
function decodeRow(raw) {
  need(exact(raw, [...ROW_FIELDS, "world_json"]));
  const { world_json, ...metadata } = raw; validateMetadata(metadata);
  need(typeof world_json === "string"); return { metadata, world: parseJson(Buffer.from(world_json)) };
}
async function rollback(client) { try { await client.query("ROLLBACK"); return true; } catch { return false; } }
export async function snapshotPostgres(client, key) {
  archiveKey(key); let begun = false;
  try {
    begun = true; await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    const result = await client.query(SELECT); need(result.rows.length === 1, "source_row_missing");
    const row = decodeRow(result.rows[0]); const snapshot = createSnapshot(row.world, key, { metadata: row.metadata });
    await client.query("COMMIT"); begun = false; return snapshot;
  } catch (err) {
    const clean = !begun || await rollback(client);
    throw Object.assign(fault("snapshot_read_failed"), { discard_client: !clean });
  }
}
export async function restorePostgres(client, bytes, key, expectedSha256) {
  const checked = verifySnapshot(bytes, key, expectedSha256), { world, metadata } = checked.payload;
  need(metadata !== null, "postgres_metadata_required");
  let begun = false, committing = false;
  const same = raw => { const row = decodeRow(raw); return canonical(row.metadata) === canonical(metadata) && canonical(row.world) === canonical(world); };
  try {
    begun = true; await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("LOCK TABLE public.hearth_ledger IN EXCLUSIVE MODE");
    const before = await client.query(SELECT);
    if (before.rows.length) {
      need(before.rows.length === 1 && same(before.rows[0]), "destination_not_empty");
      need(await rollback(client), "rollback_failed"); begun = false;
      return { ...checked.receipt, action: "already_present" };
    }
    const result = await client.query(`INSERT INTO public.hearth_ledger
      (id, world, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag, migrated_at, updated_at)
      VALUES ($1, $2::jsonb, $3, $4::bigint, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
    [1, canonical(world), metadata.constitution_version, metadata.revision, metadata.migrated_from,
      metadata.migrated_sha256, metadata.migrated_blob_etag, metadata.migrated_at, metadata.updated_at]);
    need(result.rowCount === 1, "restore_verification_failed");
    const after = await client.query(SELECT); need(after.rows.length === 1 && same(after.rows[0]), "restore_verification_failed");
    committing = true; await client.query("COMMIT"); begun = false;
    return { ...checked.receipt, action: "restored_empty_postgres" };
  } catch (err) {
    if (committing) throw Object.assign(fault("commit_outcome_unknown"), { discard_client: true });
    const clean = !begun || await rollback(client);
    const code = ["destination_not_empty","restore_verification_failed"].includes(err?.code) ? err.code : "restore_failed";
    throw Object.assign(fault(code), { discard_client: !clean });
  }
}
