import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const configuredConnectionString = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
assert.ok(configuredConnectionString, "DATABASE_URL_UNPOOLED (or POSTGRES_URL_NON_POOLING) is required");
const connectionUrl = new URL(configuredConnectionString);
assert.equal(connectionUrl.hostname.includes("-pooler."), false, "ledger verification requires a direct Neon endpoint");
const sslmode = connectionUrl.searchParams.get("sslmode");
assert.ok(sslmode && !["disable", "allow"].includes(sslmode), "Postgres connection must require verified TLS");
if (["prefer", "require", "verify-ca"].includes(sslmode)) {
  connectionUrl.searchParams.set("sslmode", "verify-full");
}
assert.equal(connectionUrl.searchParams.get("sslmode"), "verify-full", "unsupported Postgres SSL mode");
const connectionString = connectionUrl.toString();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const pool = new Pool({ connectionString, max: 1 });
try {
  const result = await pool.query(`
    SELECT world,
           constitution_version,
           revision::text AS revision,
           migrated_from,
           migrated_sha256,
           migrated_blob_etag,
           migrated_at,
           updated_at
      FROM hearth_ledger
     WHERE id = 1
  `);
  assert.equal(result.rows.length, 1, "expected exactly one Hearth ledger row");
  const row = result.rows[0];
  const world = row.world;
  const actualDigest = digest(world);
  const revision = BigInt(row.revision);
  assert.equal(world.version, "3.1", "unexpected world version");
  assert.equal(row.constitution_version, world.version, "row/world constitution versions differ");
  assert.equal(row.migrated_from, "vercel-blob:hearth.json", "unexpected migration source");
  assert.match(row.migrated_sha256, /^[0-9a-f]{64}$/, "invalid migration source digest");
  assert.ok(row.migrated_blob_etag, "migration Blob ETag is missing");
  const sourceDigestMatches = row.migrated_sha256 === actualDigest;
  if (revision === 1n) {
    assert.equal(sourceDigestMatches, true, "revision 1 must match the imported Blob snapshot");
  }

  const keyHashCount = world.residents.filter((resident) => Boolean(resident.keyHash)).length;
  const counts = {
    places: world.places.length,
    residents: world.residents.length,
    residents_with_key_hashes: keyHashCount,
    portals: world.portals.length,
    things: world.things.length,
    notes: world.notes.length,
    agreements: world.agreements.length,
    events: world.events.length,
    private_memories: world.memories.length,
  };
  console.log(JSON.stringify({
    ok: true,
    version: world.version,
    revision: row.revision,
    source: row.migrated_from,
    source_etag_recorded: true,
    source_digest_matches: sourceDigestMatches,
    content_changed_since_migration: !sourceDigestMatches,
    current_digest: actualDigest,
    counts,
    migrated_at: row.migrated_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }, null, 2));
} finally {
  await pool.end();
}
