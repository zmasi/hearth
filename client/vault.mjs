// Trusted, local Node harness helper. No network, environment, file or API access.
// This key must be independent of the Bearer and must never be sent to Hearth.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const FORMAT = "hearth-client-v1";
const LIMIT = 65536;
const invalid = () => new Error("Client-sealed memory could not be authenticated.");
function headerFor(envelope) {
  return { format: FORMAT, id: envelope.id, agentId: envelope.agentId };
}
function derive(rootKey, header, salt) {
  if (!Buffer.isBuffer(rootKey) || rootKey.length !== 32) throw new Error("Use an independently generated 32-byte client key.");
  return Buffer.from(hkdfSync("sha256", rootKey, salt,
    Buffer.from(`hearth/private-memory/client/v1\n${JSON.stringify(header)}`), 32));
}
function decode(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (length !== undefined && bytes.length !== length)) throw invalid();
  return bytes;
}
function validIdentity(agentId, id) {
  return typeof agentId === "string" && /^agt_[A-Za-z0-9_]{1,64}$/.test(agentId)
    && typeof id === "string" && /^mem_[a-f0-9]{32}$/.test(id);
}

export function createVaultKey() { return randomBytes(32); }

// agentId is the owning resident's stable me.id from authenticated GET /api/me.
// Preserve the returned id locally when expecting a particular record later.
export function sealMemory(rootKey, agentId, value) {
  const header = { format: FORMAT, id: `mem_${randomBytes(16).toString("hex")}`, agentId };
  if (!validIdentity(agentId, header.id)) throw new Error("Supply the owning resident's agent id.");
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Memory must be JSON-serializable.");
  const plaintext = Buffer.from(serialized), salt = randomBytes(32), nonce = randomBytes(12);
  let key;
  try {
    if (plaintext.length > LIMIT) throw new Error("Client memory must be at most 65536 UTF-8 bytes.");
    key = derive(rootKey, header, salt);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...header, salt: salt.toString("base64url"), nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  } finally { key?.fill(0); plaintext.fill(0); }
}

// Require both locally expected identities. Do not trust a server-selected id
// when asking whether this is a particular previously stored record.
export function openMemory(rootKey, agentId, expectedId, envelope) {
  let key, plaintext, provisional;
  try {
    const fields = ["format", "id", "agentId", "salt", "nonce", "tag", "ciphertext"];
    if (!validIdentity(agentId, expectedId) || !envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).length !== fields.length || !fields.every(k => Object.hasOwn(envelope, k))
      || envelope.format !== FORMAT || envelope.agentId !== agentId || envelope.id !== expectedId
      || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 87382) throw invalid();
    const header = headerFor(envelope);
    key = derive(rootKey, header, decode(envelope.salt, 32));
    const decipher = createDecipheriv("aes-256-gcm", key, decode(envelope.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(decode(envelope.tag, 16));
    const ciphertext = decode(envelope.ciphertext);
    if (ciphertext.length > LIMIT) throw invalid();
    provisional = decipher.update(ciphertext);
    plaintext = Buffer.concat([provisional, decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch { throw invalid(); }
  finally { key?.fill(0); plaintext?.fill(0); provisional?.fill(0); }
}
