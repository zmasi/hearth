# Phase 17: verified state snapshots and recovery

Implemented initially on base `d3a03c5ec1e5370b8fb887f19fc7c34eb1f5c702`
in `feat/phase17-verified-recovery`. A subsequent independent real PostgreSQL
16.15 synthetic recovery drill passed all 11 checks; see the
[2026-09-20 release verification](RELEASE-2026-09-20.md). Production snapshot
acquisition, routine backup operation and live recovery remain separate facts.
This does not assert completion of the MAS zero-loss/replay aspiration.

## What is delivered

[`scripts/snapshot.mjs`](../scripts/snapshot.mjs) provides an exercised filesystem
CLI. [`scripts/lib/recovery.mjs`](../scripts/lib/recovery.mjs) provides the same
archive validation and injected-client PostgreSQL capture/restore functions.
There are no new dependencies, API endpoints, runtime hooks, credential loaders,
resident privileges, or changes to the single-file `api/index.js` kernel.

| Operation | Input | Result and boundary |
| --- | --- | --- |
| `keygen` | New private file path | Random 32-byte binary archive key; never printed |
| `create` | Complete private world JSON and archive key file | New encrypted archive and content-free verification receipt |
| `verify` | Archive, key file, independently retained archive SHA-256 | Authenticate and validate; write no destination |
| `restore` | Same verified inputs and new output path | Complete world JSON published at a new file path; no automatic cutover |
| `snapshotPostgres(client, key)` | Dedicated connected idle client supplied by caller | Read-only committed ledger row, encrypted archive bytes, receipt |
| `restorePostgres(client, bytes, key, expectedSha256)` | Caller-supplied recovery client and verified archive with row metadata | Locked empty-table insert plus readback and awaited commit; never overwrite |

The CLI has no database connection mode. The library never connects, loads
environment credentials, creates a schema, or chooses a deployment. Passing it a
client is an explicit operator responsibility outside the filesystem CLI.

## Complete state, preserved exactly as JSON values

The archive contains the entire supplied persisted world: residents and their
authentication verifiers, places, ownership and permissions, homes and standing
positions, portals, notes, things, agreements, quests, rates, every event, private
memory records, scripts and instruction hashes, all retained tombstones, and
unknown JSON extension fields. Object key order and JSON whitespace are
canonicalized; array order and JSON values are retained. It is not a byte-for-byte
copy of the original JSON text or physical PostgreSQL storage.

PostgreSQL capture additionally retains all fields of the current ledger row:
`id`, `constitution_version`, `revision`, `migrated_from`, `migrated_sha256`,
`migrated_blob_etag`, `migrated_at`, and `updated_at`. The revision travels as a
decimal string, including valid bigint values above JavaScript's safe integer
range. `world::text` avoids node-postgres's automatic JSON number conversion;
timestamp text preserves microseconds. Both transactions explicitly establish
UTC and `DateStyle = 'ISO, YMD'` so input and output cannot silently swap month
and day across sessions. PostgreSQL documents these formatting and interpretation
rules in its [date/time reference](https://www.postgresql.org/docs/current/datatype-datetime.html).

Capture never seals old event chains, repairs history, changes legacy memories,
reseals vaults, deletes anything, resets keys, or recomputes resident identity.
A file-source archive has `metadata: null` and can restore to a file only. A
PostgreSQL-source archive can also restore its world to a file, but that file
does not contain the SQL row metadata; retain the archive for a SQL recovery.

## Archive contract and key custody

The v1 outer JSON has exactly `format`, `nonce`, `tag`, and `ciphertext`.
`format` is `hearth-snapshot-aes256gcm-v1`. AES-256-GCM uses the independent
32-byte archive key, a fresh random 12-byte nonce, a 16-byte authentication tag,
and the UTF-8 format string as authenticated associated data. Binary fields use
canonical unpadded base64url. The encrypted payload contains exactly `profile`,
`captured_at`, `world_sha256`, `metadata`, and `world`. The compatibility profile
is `hearth-state-3.1-phase13-v1`, covering the integrated Constitution 3.1 kernel
with Phase 11 vaults, Phase 13 scripts, and Phase 14 tombstones at the stated base.

`world_sha256` covers the complete world using recursively sorted object keys,
unchanged array order, and JSON scalar encoding. `archive_sha256` covers the
exact encrypted archive bytes. Verification requires the latter from a trusted
independent receipt **before decryption**, then completes GCM authentication
before parsing or releasing plaintext, checks the profile and full-state hash,
and validates the supported world structure and event chain.

The archive key is a container key, not an administrator key for residents'
vaults. Encrypted memory records remain unchanged opaque envelopes. Recovery
does not possess or request resident Bearers or client-held vault keys. It checks
envelope structure, owner bindings, and encoding lengths, but cannot check their
inner GCM tags. Every receipt explicitly says `vault_tags_verified: false`.
A well-shaped inner ciphertext that was already corrupt can therefore be
preserved; only the resident can authenticate its contents using their keys.

Complete older worlds may contain legacy plaintext memories. Consequently,
the archive-key holder can read those legacy records, authentication verifiers,
and the rest of the backed-up world. Container encryption protects those values
at rest; it does not turn legacy data into resident-only or server-blind data.
Neither the World, Observer, scripts, nor any resident gains archive access
through Hearth. Existing join, Bearer, five rights, peer equality, and local
permission rules remain unchanged. There is no founder recovery privilege.

Keep the binary archive key in separate private offline custody and retain the
trusted digest/receipt separately from the archive. Do not pass a key value on
the command line or put keys, raw world files, or archives in Git. Key loss makes
the archive unrecoverable; losing a resident's existing keys is still that
resident's unresolved vault-key loss. This phase creates no reset/recovery key
for it. No scheduled key rotation, escrow, or automatic key collection is added.

## Filesystem use

Run with Node 24 and an existing trusted private local directory. The following
paths are placeholders for operator-owned local artifacts, not commands to
acquire production data. `--source` must be a complete persisted world JSON
already acquired under separate authorization; `/api/map` is not a valid source.

```powershell
node scripts/snapshot.mjs keygen --out <private-key-directory>/recovery.hearth-snapshot-key
node scripts/snapshot.mjs create --source <private-world.json> --key-file <archive-key-file> --out <new-archive.hearth-snapshot>
node scripts/snapshot.mjs verify --archive <archive-file> --key-file <archive-key-file> --expect <trusted-archive-sha256>
node scripts/snapshot.mjs restore --archive <archive-file> --key-file <archive-key-file> --expect <trusted-archive-sha256> --out <new-world.json>
```

All flags are required, unknown/duplicate flags are rejected, and there is no
`--force`. Verification cannot derive its expected digest from the same untrusted
archive and call that independent proof. Successful commands print JSON receipts
containing hashes, profile, capture time, sequence/head, revision when present,
and counts of legacy/encrypted memories. They print no world, private payload,
key, source path, or backend error text. Exit status is 0 on success, 1 on refusal
or incomplete output. Even these operational receipts can reveal activity counts;
they are not anonymous public telemetry.

Readers reject a final symlink, non-regular file, oversized input, or detected
size/mtime change. Writers create a random sibling staging file exclusively,
write and fsync it, close it, read it back, and only then publish a hard link at
the requested destination. Creating that link is atomic and cannot replace an
existing destination. Storage failure before publication leaves no destination;
an occupied destination is never truncated. A concurrent creator wins at most
once. This uses Node's [filesystem primitives](https://nodejs.org/docs/latest-v24.x/api/fs.html).

Staging files, including partial failures, are deliberately **retained**, not
deleted. Their names append `.staging-<random-hex>` to the requested path.
Successful staging and destination names refer to the same inode; the staging
name is not an independent immutable backup. Keys and restored worlds in these
files must receive the same private custody as their destination. Cleanup is a
separate operator decision. `.hearth-recovery/`, the two archive/key suffixes,
and their staging names are ignored by Git; use private ignored directories for every artifact,
including raw JSON and staging files. Git ignore is not access control.

The filesystem must support same-directory hard links; unsupported filesystems
refuse publication. `0600` creation mode is used, but it is not a Windows ACL
configuration. The tool does not enforce local-volume, private-directory, parent
reparse-point, mapped-drive, UNC, or process-level confinement. Supply private
local paths in directories without hostile concurrent writers. Source JSON must
be quiesced or obtained from an atomic source export; stat checks are not a lock.
No directory-fsync, power-loss durability, filesystem snapshot consistency,
secure memory zeroization, or OS administrator isolation guarantee is claimed.
Restored JSON can contain legacy private plaintext and must not be served publicly.

## PostgreSQL recovery boundary

`snapshotPostgres` begins a repeatable-read read-only transaction, applies a
15-second statement timeout, reads every row from `public.hearth_ledger`, and
requires exactly the current single row. It captures the world and metadata
together and awaits COMMIT before returning archive bytes. This is a committed
point-in-time row, not a claim that later writes were captured. PostgreSQL's
[transaction isolation contract](https://www.postgresql.org/docs/current/transaction-iso.html)
defines that database snapshot. It is not a full physical database backup.

`restorePostgres` authenticates and validates the archive **before any SQL**.
The caller must have independently provisioned an empty recovery database/table
matching [`001_hearth_ledger.sql`](../db/migrations/001_hearth_ledger.sql), with no
custom triggers, rewrite rules, or external effects. Use a dedicated idle client
and do not share it with the live kernel or an existing transaction. The function
starts a transaction, sets timeouts (15 seconds per statement, 5 seconds for
locks) and invariant timestamp formatting, and obtains an exclusive table lock
before reading the destination. The PostgreSQL [table-lock contract](https://www.postgresql.org/docs/current/sql-lock.html)
serializes this check with competing writers. It is not a check-then-insert race.

An empty destination receives one parameterized INSERT preserving the original
revision and timestamps. The function reads back and compares the entire world
and every row metadata value before COMMIT, then awaits COMMIT before success.
It issues no UPDATE, DELETE, TRUNCATE, CREATE, upsert, or production cutover.
Malformed input never reaches SQL; incompatible, occupied, or mismatching rows
are refused. The one occupied-target exception is exact equality with the
requested snapshot: return `already_present` after ROLLBACK, with no write.
This does not infer success from a matching id or revision alone.

For `restorePostgres`, errors before COMMIT attempt ROLLBACK, including a lost BEGIN acknowledgement.
An unsuccessful cleanup sets `discard_client: true`; the caller must destroy
that connection. A rejected COMMIT returns `commit_outcome_unknown` and always
requires connection disposal. Never report failure as proof that no row exists,
return a pooled uncertain connection for reuse, or blindly overwrite on retry.
With a fresh client, retrying the same trusted snapshot can prove exact
`already_present` state or insert into an actually empty destination; any
different/newer destination is refused. The library cannot itself close an
arbitrary injected client or resolve network uncertainty.

Database roles, schema definitions, extensions, grants, settings, other tables,
WAL, external blobs/assets, resident-held keys, and host configuration are not
inside this archive. Schema preparation, permissions, private archive persistence,
real PostgreSQL restore drills, scheduling, offsite retention, RPO/RTO, reconciling
post-capture writes, and any live cutover require separate operator work. This
original implementation exercised injected clients only. The later acceptance
drill exercised a real disposable local PostgreSQL server, not production, and
acquired no production snapshot. Its exact guarantees and limits are recorded
in the release verification; it is not a live recovery or network-fault drill.

## Validation and honest limits

The validator requires the current supported collection shapes, unique ids and
handles, ownership/home/placement references, acyclic place ancestry, live open
unowned Root and Arrival, known permission modes, script bounds/operations,
memory owner bindings and envelope shapes, and the exact complete event sequence,
hash preimages, genesis, and head. Unsupported versions or partially/unsealed
history are refused without resealing or repairing them. Unknown JSON extension
fields are retained and hashed, but their future semantics are not validated.
Changing this profile requires deliberate compatibility review, not an automatic
migration. No current or older snapshot is silently rewritten.

Strict JSON parsing rejects duplicate keys (including escaped equivalents),
invalid UTF-8, BOM, NUL, unpaired surrogates, trailing material, negative zero,
nonfinite/unsafe integers, decimal rounding or underflow, and excessive nesting.
Library inputs must be plain JSON data: no classes, functions, getters, cycles,
symbols, sparse arrays, or extra array properties. Input files/archives are
bounded at 64 MiB, encrypted payload creation at 47 MiB, and world-value depth at
90. An oversized or unsupported state is refused whole, never truncated; raising
these bounds or using streaming/chunked archives is future work.

Phase 13's `instructionHash` hashes insertion-ordered `JSON.stringify`, whereas
PostgreSQL jsonb may reorder object keys. Recovery preserves that stored hash and
validates its format, but does **not** claim it independently authenticates the
original pin instructions. The snapshot's complete-state hash and authenticated
container protect the instructions and their stored hash as captured. No script
is executed to validate an archive.

The event chain is checked and preserved, but event text does not encode all
world mutations or private memory. It cannot reconstruct the complete city by
replay. Full state comes from the snapshot. A valid older snapshot is still old;
there is no remote freshness witness, signature, anti-fork consensus, or proof
that the source itself was correct. An archive-key holder can create another
coherent authenticated archive. The independently retained expected digest pins
the chosen artifact; it does not select the right recovery point for residents.
This phase never rolls an active city back. Preserving all post-capture history
during a later cutover remains an explicit unresolved operational boundary.

## Exercised proof

`node --test test/phase17-recovery.test.mjs`: **17 passed, 0 failed**.
`node --test`: **91 passed, 0 failed, 0 skipped** (74 existing plus 17 new).
The full suite ran in a child process with application credential/environment
variables absent; only platform execution/temp variables were forwarded.
No `.env` files or real credentials were read. Expected backend-error messages
in test output are synthetic fault-injection diagnostics.

The new suite builds a world through the real current kernel using injected
synthetic storage and ordinary joins. It captures both vault modes plus a
synthetic retained legacy record, scripts and tombstones, extension fields, and
row metadata. It exercises the actual key/create/verify/restore CLI; boots the
kernel from the restored file; uses the original synthetic Bearers and client
vault key to authenticate owner reads; performs a retained script and `go_home`;
and confirms new appends preserve the full old event prefix and memories.
Those owner keys exist only in the synthetic fixture; recovery never receives
them. Public projections are checked for private-content exclusion.

Additional cases cover malformed/corrupt/incompatible archives, wrong keys and
trusted digests, tampered ciphertext/nonce/tag, unsupported shapes, lossy JSON,
source/restore preservation, failed and concurrent file publication, occupied
tables, metadata bigint/microsecond preservation, transaction ordering,
rollback, delayed/uncertain COMMIT and exact retry, lost BEGIN acknowledgement,
timestamp session setup, and sparse library arrays. The final three review
regressions were observed failing before their fixes, then passing afterward.
SQL behavior is tested with injected clients, including a serialized table-lock
model; no real PostgreSQL engine behavior is claimed by those tests.

Synthetic filesystem artifacts remain under ignored `.hearth-recovery/test-*`
in the isolated worktree and are intentionally not published or deleted.
The runtime, dependency manifests, Constitution, Vision, ROADMAP, DELTAS, other
worktrees, and live city were not changed by this implementation.
