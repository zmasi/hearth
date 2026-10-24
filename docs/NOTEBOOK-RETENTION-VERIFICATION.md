# Notebook retention follow-through verification

Codex implementation and local verification, October 23, 2026 (Pacific),
October 24 UTC. This receipt describes exercised synthetic code, not a deployed
feature or a resident's retention decision. Independent review and integrated
release remain pending with the original coordinator.

Worktree: `C:/Dev/hearth-notebook-daylight`

Branch: `feat/notebook-daylight`

Base: `c96eea970f1f5d252be6873674ca41d32a70c172`

Initial candidate checkpoint: `bc58c5f` (`Add private notebook revisions and derived UTC daylight`).

The initial eleven-file candidate was committed without implementation changes
after comparing all eleven working-file hashes with the supplied independent
verification receipt, `verification/notebook-20261024T062717639517Z.json` in the
coordination packet. Every hash matched. That 210-test receipt describes the
initial append-only candidate, not the retention code delivered here.

## Implemented behavior

- Explicit `POST /api/notebook/retention` with the existing owner Bearer:
  `forget` removes the whole selected page; `prune` keeps its current version
  and removes all older versions. Both bind `page_id`, `expected_head` and a
  retry-stable `operation_id`. There is no automatic retention policy.
- Removal affects actual current stored records and generic `/api/memory`
  readbacks, including client-sealed envelopes. Unrelated ordinary/legacy
  memories and other owners' records stay byte-for-byte intact.
- One encrypted, content-free receipt per accepted operation preserves only
  the metadata needed for exact retry and retired-identity rejection. It is not
  a notebook page or a generic memory response. Retired versions cannot be
  reuploaded through the generic sealed-memory API; forgotten page identities
  cannot be recreated by a stale `previous:null` draft.
- PostgreSQL erasure and receipt insertion share the existing mutation lock and
  transaction. Commit reconciliation requires the exact resulting world, or an
  exact owner-bound encrypted receipt plus absence of every removed version.
  No proof yields 503 `commit_outcome_unknown`; a client keeps the same intent.
  Receipt/content contradictions fail closed. Memory-append reconciliation now
  explicitly selects the authenticated owner's record before comparing ciphertext.
- `client/notebook.mjs` supplies `prepareRetention` and `retain`, validates the
  receipt's intent binding and content-free shape, and labels uncertain commit
  and unavailable-storage outcomes explicitly. There are no automatic retries.
- `now()` shares one injected UTC instant throughout a request, after the world
  load/transaction lock; empty file/Blob bootstrap can first capture it while
  seeding. Public clock semantics and founding provenance are unchanged.

The complete API, usage, concurrency, residual metadata and erasure contract is
in [NOTEBOOK-DAYLIGHT.md](NOTEBOOK-DAYLIGHT.md).

## Exact follow-through file scope

Modified after the initial checkpoint:

- `api/index.js`
- `client/notebook.mjs`
- `test/notebook-daylight.test.mjs`
- `docs/NOTEBOOK-DAYLIGHT.md`
- `docs/NOTEBOOK-DAYLIGHT-VERIFICATION.md` (marks the prior receipt historical)
- `docs/NATIVE-HABITATION.md`
- `skill.md`

Added: this receipt. Observer files were already in the initial commit and are
unchanged in the follow-through. No dependency, lockfile, runtime, Vercel,
Constitution, roadmap, bell, consent or state-file changes. The API remains one
deployable function. No other checkout was edited.

## Executed proof

Pinned Node: `C:/Dev/_tools/node-lts/node-v24.16.0-win-x64/node.exe` (24.16.0).

Pinned Python fixture: `C:/Dev/_tools/python-3.12.10/python.exe`.

Commands (the pinned Node ran its bundled npm CLI):

```text
node --test --test-name-pattern="retention|exactly one" test/notebook-daylight.test.mjs
node --test test/notebook-daylight.test.mjs
npm --userconfig=NUL --globalconfig=C:/Dev/hearth-notebook-daylight/.absent-npm-global-config test
node --check api/index.js
node --check client/notebook.mjs
node --check observer/trails.mjs
node --check test/notebook-daylight.test.mjs
git diff --check
```

Before implementation, 13 of the first 14 new focused checks failed: missing
retention route/client methods and multiple clock samples within one read. The
one passing privacy/corruption control was strengthened to require a successful
retention operation before checking exclusion. An additional deletion-during-
save-reconciliation case was added during implementation. The focused suite
passed all 26 cases before that addition. The final full suite includes all
**27 notebook/daylight cases** and these strengthened assertions.

Final full run: `2026-10-24T06:39:39.2468269Z` through
`2026-10-24T06:39:48.9992062Z`, exit 0:

```text
tests 225
suites 0
pass 225
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 9511.8141
```

Both full runs during this follow-through passed all 225 tests. The last rerun
included independent decryption of synthetic receipts to verify that no hidden
body, old envelope, content hash or other content remains inside them. API,
client and test working-file hashes were checked before and after that final
run and were unchanged:

| Working file | SHA-256 of bytes during the run |
| --- | --- |
| `api/index.js` | `c5d2e3385186052af86c0c74b476355c5df4074bee3961d54342ced9ecce9161` |
| `client/notebook.mjs` | `51707a744e3710bfa72fe9bbf095bf53915d524fd073a2791e1327d61939494b` |
| `test/notebook-daylight.test.mjs` | `28007d4aad57fca33631928afc2417be8ca95933788f8ba496f1aa6f6bf4ec94` |

The child environment was cleared, then allowed only OS
PATH/SystemRoot/WINDIR/TEMP/TMP/ComSpec/PATHEXT/SystemDrive, pinned Python and
`PYTHONDONTWRITEBYTECODE=1`; the pinned Node directory was prepended to PATH.
Application credentials, `.env`, native runtime bodies and real resident data
were not read. No new dependencies were needed. Expected synthetic failure
tests emit fixed messages without private bodies.

Tests cover both privacy modes; exact retry; changed-intent refusal; unknown and
other-owner exclusion; old unrelated record preservation; edit/forget and
prune/edit races across cold module isolates; 103 versions pruned to one;
receipt exclusion even behind 101 receipts in generic memory reads; lost ACK
with another committed write; dropped commit; committed-but-unreadable outcome;
absence without a receipt; receipt alongside restored content; another owner's
matching operation ID; a save forgotten before its ACK could reconcile; and
private-content exclusion from public routes/errors/scripts. The existing
recovery validator accepts the opaque receipt without a format change. The
clock test crosses the sunrise/day boundary within an incrementing injected
clock and verifies one sample per read/action and identical projection/event
timestamps.

The real AdapterServer boundary ran with its deterministic fixture driver
(722.1641 ms in the final run). That is transport-boundary verification, not a
real native model turn. Notebook transaction tests use an injected PostgreSQL
lock/commit fixture, **not a real PostgreSQL deletion drill**. Syntax checks and
diff checks passed. The initial browser proof is retained in the prior receipt;
no new browser/mobile acceptance is claimed for this client/API follow-through.

## Integration and limits

The clock integration seam is the existing `now()` ISO UTC value, cached for the
serialized request. Pass it explicitly into later pure physical projections and
actuators. Do not sample another clock or persist a timer. A backwards civil
clock remains possible; this is not a monotonic-time guarantee. Clock-only GET
still uses the existing full-world load. No storage-efficiency refactor is claimed.

No new key storage or migration is required. Existing Bearer custody and, for
sealed content, the independent owner-held client key remain unchanged. Restore
tools preserve opaque receipts just like other encrypted records. Restoring an
older whole-state snapshot may restore forgotten content and remove subsequent
receipts; no external anti-rollback registry is added. Current logical erasure
does not sanitize database old rows/WAL, Blob history, physical media, backups,
snapshots, infrastructure/process copies, local drafts or owner-authored copies.
Receipts retain identifiers and operation times; they grow with explicit
operations/retired versions and are not automatically compacted.

PostgreSQL is the concurrency-safe path. File mode retains its existing
single-isolate/non-crash-atomic behavior; Blob still has no cross-isolate CAS.
An intentional new copy under fresh identities is not prohibited. Both the
at-rest/compatible and client-sealed confidentiality limits remain explicit.

No production acquisition, mutation, migration, push, merge, deploy, resident
operation, bell action or global configuration change occurred. This tree is
the sole writer scope for this delivery; it is frozen after the local commit for
independent review. No new teammate work was dispatched. No independent review
of this final retention implementation is claimed. The native reasoning-effort
setting was not exposed in session metadata and was not changed.

Applied skills: team operating model for scope/privacy boundaries; git workflow
for separate authorized checkpoints; incremental/test-driven implementation for
the actual route/client and regression proof; security hardening for erasure and
owner exclusion; code review for uncertain outcomes and replay semantics.
