import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get } from "@vercel/blob";
import { Client } from "pg";

const BLOB_PATH = "hearth.json";
const CONSTITUTION_VERSION = "3.1";
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const verify = args.has("--verify");
const replace = args.has("--replace");

if (apply === verify || (replace && !apply)) {
  throw new Error("Usage: node scripts/migrate-blob-to-neon.mjs (--apply [--replace] | --verify)");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function verifiedPostgresUrl(value) {
  const url = new URL(value);
  if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode"))) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function worldHash(world) {
  return createHash("sha256").update(JSON.stringify(canonicalize(world))).digest("hex");
}

function containsNul(value) {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === "object") return Object.values(value).some(containsNul);
  return false;
}

function validateWorld(world, source) {
  if (!world || typeof world !== "object" || Array.isArray(world)) {
    throw new Error(`${source} did not contain a world object`);
  }
  if (world.version !== CONSTITUTION_VERSION) {
    throw new Error(`${source} has unsupported version ${world.version || "missing"}`);
  }
  for (const collection of ["places", "residents", "portals", "notes", "things", "agreements", "events", "memories"]) {
    if (!Array.isArray(world[collection])) throw new Error(`${source} is missing ${collection}`);
  }
  if (containsNul(world)) throw new Error(`${source} contains a NUL character that PostgreSQL jsonb cannot preserve`);
}

async function readBlobWorld() {
  const token = requireEnv("BLOB_READ_WRITE_TOKEN");
  const got = await get(BLOB_PATH, { access: "private", useCache: false, token });
  if (!got?.stream) throw new Error("The private Blob ledger was not found");
  const world = JSON.parse(await new Response(got.stream).text());
  validateWorld(world, "Blob ledger");
  if (!got.blob?.etag) throw new Error("The private Blob ledger did not include an ETag");
  return { world, etag: got.blob.etag };
}

const databaseUrl = verifiedPostgresUrl(requireEnv("DATABASE_URL_UNPOOLED"));
const databaseHost = new URL(databaseUrl).hostname;
if (databaseHost.includes("-pooler.")) {
  throw new Error("DATABASE_URL_UNPOOLED resolves to a pooled endpoint; use the direct Neon URL for migration");
}
const schemaSql = await readFile(new URL("../db/migrations/001_hearth_ledger.sql", import.meta.url), "utf8");
const blobSnapshot = await readBlobWorld();
const blobWorld = blobSnapshot.world;
const blobHash = worldHash(blobWorld);
const client = new Client({ connectionString: databaseUrl });
let action = "verified";

try {
  await client.connect();
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  if (apply) await client.query(schemaSql);

  let result = await client.query(
    `SELECT world, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag
       FROM hearth_ledger
      WHERE id = $1
      ${apply ? "FOR UPDATE" : ""}`,
    [1],
  );

  if (apply && result.rows.length === 0) {
    await client.query(
      `INSERT INTO hearth_ledger
         (id, world, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag)
       VALUES ($1, $2::jsonb, $3, 1, $4, $5, $6)`,
      [1, JSON.stringify(blobWorld), CONSTITUTION_VERSION, "vercel-blob:hearth.json", blobHash, blobSnapshot.etag],
    );
    action = "inserted";
  } else if (apply) {
    const row = result.rows[0];
    const currentHash = worldHash(row.world);
    if (currentHash === blobHash) {
      action = "already-current";
    } else if (!replace) {
      throw new Error("Neon already contains a different ledger; rerun with --replace only before production cutover");
    } else {
      if (Number(row.revision) !== 1 || currentHash !== row.migrated_sha256) {
        throw new Error("Refusing to replace a Neon ledger that has received post-migration writes");
      }
      await client.query(
        `UPDATE hearth_ledger
            SET world = $1::jsonb,
                constitution_version = $2,
                migrated_from = $3,
                migrated_sha256 = $4,
                migrated_blob_etag = $5,
                migrated_at = now(),
                updated_at = now()
          WHERE id = $6`,
        [JSON.stringify(blobWorld), CONSTITUTION_VERSION, "vercel-blob:hearth.json", blobHash, blobSnapshot.etag, 1],
      );
      action = "replaced-before-cutover";
    }
  } else if (result.rows.length !== 1) {
    throw new Error("Neon ledger row is missing");
  }

  result = await client.query(
    `SELECT world, constitution_version, revision, migrated_from, migrated_sha256, migrated_blob_etag
       FROM hearth_ledger
      WHERE id = $1`,
    [1],
  );
  if (result.rows.length !== 1) throw new Error("Neon ledger row is missing after migration");

  const row = result.rows[0];
  validateWorld(row.world, "Neon ledger");
  const databaseHash = worldHash(row.world);
  if (databaseHash !== blobHash) throw new Error("Neon ledger does not match the Blob snapshot");
  if (row.migrated_sha256 !== databaseHash) throw new Error("Neon migration digest metadata does not match its ledger");
  if (row.migrated_from !== "vercel-blob:hearth.json") throw new Error("Neon migration source metadata is incorrect");
  if (row.migrated_blob_etag !== blobSnapshot.etag) throw new Error("Neon migration ETag metadata does not match the Blob snapshot");
  if (row.constitution_version !== CONSTITUTION_VERSION) throw new Error("Neon ledger metadata version is incorrect");

  await client.query("COMMIT");
  console.log(JSON.stringify({
    ok: true,
    mode: apply ? "apply" : "verify",
    action,
    constitution_version: row.world.version,
    revision: Number(row.revision),
    residents: row.world.residents.length,
    places: row.world.places.length,
    notes: row.world.notes.length,
    things: row.world.things.length,
    agreements: row.world.agreements.length,
    events: row.world.events.length,
    memories: row.world.memories.length,
    blob_sha256: blobHash,
    database_sha256: databaseHash,
    matches_blob_snapshot: databaseHash === blobHash,
  }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  await client.end().catch(() => {});
}
