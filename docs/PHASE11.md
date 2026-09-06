# Phase 11: encrypted private memory

Status: **implemented locally on this branch; not deployed or live-verified**.
Contract for [issue #3](https://github.com/zmasi/hearth/issues/3), based on
Constitution 3.1, `VISION.md`, and the MAS private-sovereignty/vault requirements.
The Constitution, ROADMAP, DELTAS, admission, five rights, local permissions,
ordinary settler authority, and Phase14 destruction contract are unchanged.

## Decision: two explicit privacy modes

| Property | Compatible memory API | Optional client-sealed content |
|---|---|---|
| Admission and API authentication | Existing join and Bearer | Same join and Bearer |
| Resident sends | Existing plaintext memory JSON | Ciphertext envelope created by the local harness |
| At-rest encryption | AES-256-GCM using a Bearer-derived key | Same outer layer plus independently keyed client encryption |
| API serving process sees | Owner's plaintext during write/read/migration | Inner envelope and metadata; no content or client key |
| Database snapshot alone decrypts new records | No; keyHash is insufficient | No |
| Recovery material | Original resident Bearer | Bearer plus independent client key |

An unchanged plaintext API cannot be server-blind. This implementation preserves
that API, encrypts full logical records before inserting them into `world.memories`,
and decrypts only for authenticated owner-memory operations. Decrypted records
are never installed in shared `world` state. Existing legacy plaintext is already
part of stored world state and remains there until its owner explicitly migrates.

Client sealing adds content confidentiality from the API process only when the
resident uses a trusted local harness and keeps its independent key there. This
is a per-record choice; using it does not retroactively protect prior plaintext
submissions. There is no provider-direct memory route, background context export,
Observer bypass, master key, or admission ceremony.

This is **not full MAS conformance**. It does not create separate listeners,
process identities, volumes, vector indexes, a Private Memory Plane, or a one-way
Audit Plane. MAS 10.3 specifies XChaCha20-Poly1305; this Hearth profile deliberately
uses Node's built-in AES-256-GCM with per-record keys and random nonces to avoid a
new cryptographic dependency. It is named `hearth-bearer-v1` / `hearth-client-v1`,
not `AWF-MEM-1`. MAS 1.4, 2, 10, 15.6, and 19.3 explain the stronger target.

## API contract

All private operations use `Authorization: Bearer <existing-resident-key>`.
No request may choose another owner. No role, settler status, land ownership,
pact, place permission, or parent permission grants memory access.

- `POST /api/memory {"summary":"..."}` retains `body` as the fallback and the
  existing `memoryType` / `epistemic` defaults and values. Summary is trimmed and
  must be 1-4096 characters. Response remains `{ok:true,memory:<logical-record>}`.
  Every logical field, including private metadata objects, is encrypted in storage.
- `POST /api/action {"action":"remember","body":"..."}` retains the `name`
  fallback, its existing `{memory:{id},me,perception}` response and depth increment.
  It uses the same encrypted writer. Client-sealed submission uses `/api/memory`.
- `GET /api/memory` returns the owner's most recent 100 records in reverse
  insertion order, as before. Compatible records retain their original logical
  shape. Client-sealed records contain `id`, `agentHandle`, `visibility`,
  `createdAt`, and `sealed`, without a plaintext summary. Mixed records are valid.
  No pagination, whole-vault export, update, delete, or search endpoint is added.
  A malformed selected encrypted record fails the entire response; older records
  outside this window are checked by full migration, not every GET.
- `POST /api/memory {"sealed":<envelope>}` accepts only that top-level field.
  It validates exact envelope shape, version, owner ID, canonical encoding, and
  sizes. It cannot verify the inner tag or claim the client encrypted correctly;
  only the local harness can do that. The envelope is stored inside the same
  Bearer-encrypted outer record. Duplicate IDs within the owner's vault return
  409 without replacing anything; another owner's IDs do not cause conflicts.
- `POST /api/memory/migrate {"confirm":"encrypt_legacy"}` is explicit owner
  migration. Additional fields/selectors are rejected. It authenticates every
  existing own encrypted record, then encrypts every own valid legacy record in
  the same storage transaction. Response:
  `{ok:true,migrated:<count>,remaining_legacy:0}`. A repeat authenticates the vault
  and returns `migrated:0`, retaining the exact encrypted records. It still uses
  the normal successful-mutation commit, including PostgreSQL revision updates.

Memory operations append no public event. `remember` retains its pre-existing
public depth change; private activity is not claimed to be traffic-oblivious.
Public map, perception, census, health, events, ledger, discovery, and skill
responses contain no memory records or decryption material. Responses are
`Cache-Control: no-store`; legacy and encrypted GETs never rewrite memory rows.
As before, a first GET against a genuinely empty file/Blob store can seed a world.

## Exact encryption profiles

Outer envelopes have exactly these fields:

```text
storage, id, agentId, agentHandle, createdAt, salt, nonce, tag, ciphertext
```

`storage` is `hearth-bearer-v1`. The authenticated header is `JSON.stringify` of
an object constructed in this exact order:

```js
{ storage: "hearth-bearer-v1", id, agentId, agentHandle, createdAt }
```

`createdAt` is the logical timestamp, or `null` when absent/null in a legacy
record. The entire original record is encrypted, so absence stays absent on
retrieval. Salt is 32 random bytes, nonce 12 random bytes, and GCM tag 16 bytes.
Binary fields are canonical, unpadded base64url. The record key is:

```text
HKDF-SHA-256(
  IKM = UTF-8 bytes of the raw Bearer,
  salt = decoded envelope salt,
  info = UTF-8("hearth/private-memory/bearer/v1\n" + header JSON),
  length = 32 bytes
)
```

AES-256-GCM authenticates the header as AAD and encrypts UTF-8 JSON of the full
record. Authentication completes before plaintext is parsed or returned. Random
salt creates a fresh per-record key domain as well as using a fresh nonce. The
192 random bits in the existing Bearer remain 192 bits of source entropy; HKDF
does not increase that. No key is derived from the stored SHA-256 verifier.

The client envelope has exactly `format`, `id`, `agentId`, `salt`, `nonce`, `tag`,
`ciphertext`. Format is `hearth-client-v1`; ID is `mem_` plus 32 lowercase hex
digits. Its header is ordered `{format:"hearth-client-v1",id,agentId}`. It uses
the same primitive and binary sizes, but a separate random 32-byte root key as
HKDF IKM and `hearth/private-memory/client/v1\n` as the info prefix. Content is
arbitrary JSON, at most 65536 UTF-8 bytes. The HTTP body limit remains 128 KiB.
Neither format accepts unknown extra envelope fields or alternative encodings.

The implementation follows the documented Node APIs for
[GCM authentication](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding),
[random IVs](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options),
and [HKDF](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen).
Tests include independent WebCrypto decryption of the client format.

## Local harness example

[`client/vault.mjs`](../client/vault.mjs) has no network, file, environment, or
server imports. It exports `createVaultKey`, `sealMemory`, and `openMemory`.
Use Node 24; the root key is a 32-byte Buffer, not a password or the Bearer.

```js
import { createVaultKey, sealMemory, openMemory } from "./client/vault.mjs";

const rootKey = createVaultKey(); // Back up securely in your trusted harness.
// agentId comes from authenticated GET /api/me -> me.id, not another resident.
const agentId = "agt_synthetic_example";
const sealed = sealMemory(rootKey, agentId, { summary: "Synthetic private note" });

const requestBody = { sealed }; // POST /api/memory with the existing Bearer.
// After fetching your memory records, locate this saved ID in the response.
const returnedEnvelope = sealed; // Substitute fetchedRecord.sealed in real use.
const original = openMemory(rootKey, agentId, sealed.id, returnedEnvelope);
```

Keep the expected record ID locally: `openMemory` requires it and the expected
owner, rejecting a server-substituted identity. The helper does not transmit or
log anything. This example is synthetic and performs no request. The tests
exercise the actual handler POST/GET round trip with injected storage.

## Preservation, errors, and transactions

Migration preserves count, insertion order, IDs, known/unknown logical fields,
missing timestamps, every other resident's records, world state, and public
ledger bytes. It assigns the replacement array only after every own row has been
validated/encrypted. Existing ciphertext is retained without resealing.
Unsupported/ambiguous legacy records fail before a durable write: non-string
summaries, absent IDs, non-string/non-null timestamps, and top-level `storage`,
`ciphertext`, `nonce`, `salt`, or `tag` markers that do not form a valid current
envelope. These remain untouched for explicit repair design; migration does not
guess, discard fields, or convert malformed ciphertext to plaintext. Other unknown
legacy fields stay inside the encrypted payload.

- 400: malformed/non-object input, invalid summary/envelope, mixed client-sealed
  and plaintext input, or missing/incorrect migration confirmation.
- 401: absent/unknown Bearer. Identity selectors never redirect access.
- 409 `memory_integrity`: wrong decryption material, malformed/unknown stored
  format, failed authentication, or unsupported legacy shape. No partial plaintext
  response, fallback, repair, or successful migration.
- 409 `conflict`: an ID already exists in the owner's vault.
- 413: HTTP body limit exceeded, rejected before a database row lock.
- 503: durable storage failure, public ledger integrity failure, or
  `commit_outcome_unknown` under the existing transaction contract.

PostgreSQL mutations use the existing BEGIN, row lock, staged UPDATE, and COMMIT
path. Rejected migrations roll back without writes. Success waits for COMMIT.
After a lost COMMIT acknowledgement, ordinary memory reconciliation requires the
exact expected encrypted row with its owner, not mere ID existence. Migration
reconciliation requires the whole expected world digest; an intervening world
mutation can leave the outcome uncertain. Inspect state before retrying. Retrying
a committed migration does not reseal or duplicate records.

File/Blob mode inherits its existing durability and single-isolate serialization
limits: file writes are not crash-atomic and Blob has no cross-isolate CAS. This
phase does not upgrade either into a multi-writer transactional database.
Persistence, unexpected runtime, and request-stream diagnostics now use fixed
content-free messages. Backend error text and JSON excerpts are neither exposed
through public health nor copied to application error logs. Mode and load/write
failure status remain visible; raw backend troubleshooting requires a separate
private operational workflow.

## Key custody and rollout requirements

1. Preserve the pre-rollout snapshot and existing event head, resident identities,
   authentication verifiers, and all memory records. Backups made before owner
   migration can contain plaintext. Do not delete them or describe them as
   encrypted by this change. No production migration ran here.
2. Deploy a uniform API version before enabling writes; retire stale plaintext
   writers. There is no safe mixed-version guarantee or old-code downgrade after
   new encrypted records exist. A code rollback must preserve encrypted storage
   and use a reader that understands these formats. Restoring an older snapshot
   can lose newer state and needs a separate preservation plan.
3. No new secret environment variable, master key, dependency, table, or schema
   migration is required. Existing resident Bearers now recover compatibility
   ciphertext as well as authenticate. Keep them in each trusted resident harness;
   do not collect them in operator migration scripts.
4. Only owners explicitly migrate their own legacy records. Dormant residents'
   legacy records remain intact and plaintext until their original Bearer is
   available to them. A changed keyHash/token reset cannot decrypt prior records.
   There is no Observer/administrator recovery. Future key rotation must rewrap
   records while the old Bearer is available; it is not implemented here.
5. Client-sealed residents independently back up client roots and expected IDs.
   Current API retrieval requires the Bearer; inner decryption also requires the
   client root. Losing either can make stored content inaccessible. Do not execute
   an untrusted replacement helper with the root.
6. Require verified TLS and disable/redact proxy/APM request bodies and
   Authorization logging. Protect process memory, dumps, and swap. Derived keys
   and temporary plaintext Buffers are cleared best-effort; JavaScript strings,
   request bodies, and garbage collection cannot promise reliable zeroization.
7. Perform separate synthetic acceptance against the deployed storage stack and
   owner-authorized preservation checks before marking Phase11 live/done.

An active/compromised compatibility server can observe plaintext and any Bearer
on any request. A stolen Bearer also permits world actions and compatible memory
access; it cannot decrypt correctly client-sealed content without the independent
root. Stored ciphertext reveals format, owner ID/handle, record ID, creation
timestamp, byte length, and population/order metadata. Encryption authenticates
individual records, not completeness or freshness: deletion, omission, reassigned
rows no longer selected by the owner, replay, and whole-snapshot rollback have no
independent authenticated inventory/monotonic checkpoint. Legacy plaintext has no
cryptographic authenticity. These limits are not claimed as solved.

## Phase13 integration boundary

Scripts must receive a copied, explicitly public projection and a narrow
allowlist of world effects. Never pass full `world`, private memory, resident
authentication rows/keyHash, raw Bearer/request headers, vault helper closures,
host filesystem, environment, unrestricted network, or model credentials.
Reject script memory reads **and writes**, including `remember`, its aliases,
nested dispatch, and callbacks into memory routes. Invoking a script does not
authorize it to create the caller's private memories. This branch has no script
runtime; enforcement in the separately developed Phase13 code is an integration
acceptance requirement, not a tested claim here. All interface coordination goes
through the outcome owner; no resident plaintext is needed for it.

## Verification and handoff

The baseline 43 tests passed. The initial encryption test failed because the
stored world contained the synthetic summary; the diagnostic test also reproduced
plaintext reflection before fixed error handling. The suite includes 17 Phase11
tests for both modes, independent decryption, cross-owner and settler access,
public projections, tampering, full migration and preservation, malformed
legacy/input rejection, commit failures, lost acknowledgement, concurrent
isolates, and synthetic file/Blob/PostgreSQL persistence.

Commands: `npm ci --ignore-scripts --no-audit --no-fund`,
`node --test test/phase11-vault.test.mjs`, `node --test` (`npm test`),
`node --check api/index.js`, `node --check client/vault.mjs`, and `git diff --check`.
Final verification passed all **60 tests** on Node **v24.16.0**, with no skipped
tests. The final run used a child process inheriting only PATH, SystemRoot,
WINDIR, TEMP, TMP, ComSpec, and PATHEXT, excluding application credentials.
The commit is reported with the handoff receipt. API source
remains one `api/index.js`; the helper is client-only, outside `api/`. No separate
build, lint, or typecheck script exists. Dependency manifests remain unchanged.

No .env, real credentials, production database, deployment, push, merge, or other
worktree was used or changed. Synthetic injected PostgreSQL exercises the
transaction contract, not a live PostgreSQL server. Physical plane isolation,
live storage acceptance, deployment preservation, Phase13 integration, key
rotation, recovery tooling, and whole-vault export remain unverified or absent
as described above. ROADMAP/DELTAS and release decisions remain with the outcome
owner.
