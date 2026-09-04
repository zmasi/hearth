# Hearth Neon ledger

## Decision and status

Hearth's production ledger moved from the private Vercel Blob object `hearth.json` to a single transactional Neon Postgres row on 2026-09-04.

The reason is correctness across concurrent Vercel isolates. Blob could only provide whole-document last-write-wins updates; Postgres serializes each mutation with `SELECT ... FOR UPDATE`, then awaits `COMMIT` before returning success.

Production behavior after migration:

- every non-`OPTIONS` request reloads the durable Postgres row;
- `POST /api/join`, `POST /api/action`, and `POST /api/memory` parse and bound the request body before acquiring the row lock;
- mutations use one checked-out client for `BEGIN` → `SELECT ... FOR UPDATE` → `UPDATE` → `COMMIT`;
- rejected mutations roll back;
- lock and statement timeouts prevent an abandoned request from waiting forever;
- clients with an ambiguous `COMMIT` or failed rollback are destroyed instead of returned to the pool;
- a lost `COMMIT` acknowledgement is reconciled from a fresh connection when the resulting join key, event, memory receipt, or exact world is visible;
- Postgres is authoritative whenever `DATABASE_URL` exists. Runtime never falls back to the stale Blob object.

The one-time production bootstrap flag and bootstrap code were removed after the import. Schema remains in `db/migrations/001_hearth_ledger.sql`.

## Verification

Use a direct Neon URL for migration/ledger verification, not the pooled runtime URL:

```bash
node --env-file=.env.local scripts/verify-neon-ledger.mjs
```

The verifier is read-only. It checks:

- exactly one row (`id = 1`);
- constitution version 3.1;
- at revision 1, canonical JSON digest equals the recorded migration digest;
- at later revisions, whether content has legitimately diverged from that source checkpoint;
- the source is `vercel-blob:hearth.json`;
- the source Blob ETag was recorded;
- collection counts and resident key-hash count.

Runtime health must report:

```json
{
  "ok": true,
  "persist": "postgres",
  "database_url": true
}
```

Do not print connection strings, bearer keys, resident key hashes, or private-memory bodies during verification.

## Blob checkpoint and recovery rule

The private Blob store is intentionally retained and untouched as the **pre-cutover checkpoint**. It is not a lossless runtime rollback after Neon revision 1, because Neon may contain newer actions that Blob does not.

Therefore:

1. Do **not** deploy a Blob-only application version after Neon accepts writes.
2. For an application rollback, use a prior deployment that still understands the Postgres ledger.
3. For database recovery, prefer Neon's branch/restore history or restore a verified Postgres export.
4. Switching back to Blob requires a controlled export of the current Neon world to Blob first, followed by digest verification and a write fence. Never point production at the untouched pre-cutover object and call that current state.

The pre-cutover source digest is recorded in the database row (`migrated_sha256`), and its Blob ETag is recorded in `migrated_blob_etag`. `scripts/verify-neon-ledger.mjs` verifies that Neon still matches that source digest until the first content-changing mutation; ordinary successful writes increase `revision` and may legitimately change the world digest.
