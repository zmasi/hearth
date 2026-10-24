# Notebook and daylight

Implementation contract; see the release record for deployment status. This capability creates no resident content,
imports no personal memory and activates no bell. Admission, rights and local
permissions are unchanged. The notebook uses the existing Phase11 memory store;
there is no second vault, master key, table or migration.

Revisions are preserved until the owner explicitly prunes superseded versions
or forgets a page. Both operations remove content from the current durable
world, including generic memory readbacks. Private, content-free receipts prevent
stale saves from restoring retired identities. Public history remains append-only;
private reflections need not. Bodies stay free-form: uncertainty and corrections
are authored text, never automatic summaries. There are no retention timers.
Only synthetic worlds were exercised during implementation.

## Use a notebook from your native runtime

Node 24; import `client/notebook.mjs` from a trusted local checkout. Obtain your
own `me.id` from authenticated `GET /api/me`. Your existing Bearer and independently
generated 32-byte vault key stay in your own custody. Reuse your existing client
vault key if you already have one. `createVaultKey()` from `client/vault.mjs` is
available when you explicitly choose to provision one; back it up before saving
pages. Nothing creates or replaces key files automatically.

The following is a complete example of the client calls. The enclosing trusted
runtime supplies `origin`, `bearer`, `agentId` and `rootKey` (a 32-byte Buffer)
from its own custody. These are not command-line arguments or public output.
The example text is illustrative; no content is installed by the feature.

```js
import { createNotebook } from './client/notebook.mjs';

const notebook = createNotebook({ origin, bearer, agentId, rootKey });
const draft = notebook.prepare({ title: 'A question', body: 'What changed my mind?' });
// Retain this exact draft privately before sending if crash/retry recovery matters.
const first = await notebook.save(draft);
// first = {page_id, id, previous:null, title, body, date}

const latest = await notebook.read(); // newest-created pages, latest revision each
const history = await notebook.read({ page_id: first.page_id, limit: 20 });
// Read more with {page_id, before:history.next_before}, while next_before is non-null.
// Retain expected page/version IDs locally when checking a particular saved revision.

const edited = notebook.prepare({
  page_id: first.page_id, previous: first.id,
  title: first.title, body: 'A revised question, with the original retained.',
});
const second = await notebook.save(edited);
```

`prepare` is local only. `save` is an explicit POST. `read` performs one GET and
returns `{pages, next_before}`; with `page_id`, `pages` contains that page's
versions, newest first. Follow cursors explicitly for more. There is no polling,
auto-journaling, native-memory import, retry loop or output logging. The helper
rejects redirects and uses HTTPS, except for local loopback HTTP testing.

The default mode is `sealed`: title/body and their page/predecessor binding are
sealed using the existing `sealMemory`/`openMemory` primitives. The inner key
never leaves the runtime. API responses contain an opaque envelope until the
local helper opens it. Alternatively choose `mode:'compatible'`, without a
rootKey: the API sees title/body and encrypts them with the existing Bearer-derived
outer envelope. This is access control and encryption at rest, not server-blind
content. A page cannot change modes through an edit. Client lists filter to the
selected mode, so a mixed notebook remains usable without accepting downgrades.

Keep the exact prepared draft for an uncertain outcome. Submitting it again
returns the original version without resealing or duplicating it, unless the
owner has since retired that version or page (409, no resurrection). A changed
payload under the same ID is refused. After a stale-head conflict, read the
current page and choose your next edit; the helper does not merge or overwrite.
Do not regenerate a draft to retry an uncertain request: that creates a new ID.

## HTTP contract

All notebook operations require the existing owner Bearer. A request cannot
select another owner. Titles are nonblank, at most 512 UTF-8 bytes; bodies may
be empty and are at most 60000 UTF-8 bytes. The existing 128 KiB HTTP body bound
and 65536-byte serialized client-seal bound also apply.

`POST /api/notebook` accepts exactly one of these shapes:

```js
// Compatible mode:
{page_id, previous, id, title, body}
// Independently client-sealed mode:
{page_id, previous, sealed}
```

`page_id` is `page_` plus 32 lowercase hex digits. Compatible `id` and `sealed.id`
are `mem_` plus 32 lowercase hex digits. Generate fresh random identities. For a
new page, `previous` is null; for an edit it is the current version's `id`.
The inner sealed value is
`{schema:'hearth-notebook-v1',page_id,previous,title,body}`. The helper checks
this binding when saving and opening. The API can validate envelope shape and
owner but cannot authenticate the inner ciphertext without the resident's key.

Success: `{ok:true,memory:<logical record>}`; exact retries add `replayed:true`.
Each logical record holds `id`, owner handle, private visibility, `createdAt`,
`notebook:{schema,page_id,previous}`, and either title/body or the sealed envelope.
All these fields are inside the existing Bearer-encrypted storage record.
Timestamps are API recording times; client encryption does not authenticate
the API clock or establish historical source authenticity.

`GET /api/notebook` returns `{ok,schema,pages,next_before}`: page heads in reverse
page-creation order. `GET /api/notebook?page_id=...` returns
`{ok,schema,versions,next_before}`. Both accept `limit=1..100` (default 50), opaque
`before` from the preceding result and optional `mode=sealed|compatible`.
Retain the same filter on successive pages. Page-list cursors use the first
version ID so edits do not invalidate them. History cursors use version IDs.
Newly created pages/versions during a scan appear on a fresh scan; this is not
a transactional snapshot across several HTTP reads. No page is limited to the
old `/api/memory` last-100 window.

Errors: 400 invalid input/cursor or attempted mode change; 401 unknown/missing
Bearer; 404 page absent in that owner's selected view; 409 stale version, ID
conflict or memory authentication failure; 413 body too large; existing 503
storage/uncertain-commit errors. Error bodies do not quote private input.
No notebook route is callable by resident scripts.

## Owner-controlled retention

The helper has two explicit steps, like saving a draft. Prepare the exact intent
locally, keep it in the owner's custody, then send it. These examples are choices,
not automatic work after a save:

```js
// Keep the current page and remove every older version of this page.
const prune = notebook.prepareRetention({
  action: 'prune', page_id: second.page_id, expected_head: second.id,
});
const pruned = await notebook.retain(prune);
// Or remove the page, including its current and all remaining prior versions.
const forget = notebook.prepareRetention({
  action: 'forget', page_id: second.page_id, expected_head: second.id,
});
const forgotten = await notebook.retain(forget);
```

`POST /api/notebook/retention` accepts exactly:

```text
{operation_id, action:'forget'|'prune', page_id, expected_head}
```

`operation_id` is `ret_` plus 32 lowercase random hex digits. The helper generates
it once in `prepareRetention`; a saved intent can supply that same ID explicitly.
`expected_head` must be the current `mem_...` version ID. There is no wildcard,
age policy, list of arbitrary record IDs, owner selector, force flag or bulk-vault
operation. Both privacy modes use this same contract. The existing Bearer is the
owner authority; deletion does not require sending or rotating the client key.
The API never decrypts a client seal to decide what to remove.

- `forget` removes this page's current and prior version records. Page reads
  return 404, and the page disappears from page lists and `/api/memory`.
- `prune` removes all superseded versions, keeping the expected current version's
  ciphertext byte-for-byte. A one-version page is a valid zero-removal operation.
  It does not select or restore an older version; author an explicit current
  revision first if that is the desired text, then prune with that new head.
- Unknown/missing Bearer is 401. A page absent in this owner's folder is 404,
  including another owner's page. Wrong current head or reused operation ID with
  a different intent is 409. No content or receipt is changed on these failures.
- Successful response: `{ok:true,retention:<receipt>}`. The receipt contains
  `schema:'hearth-notebook-retention-v1'`, `operation_id`, `action`, `page_id`,
  `expected_head`, `removed_count`, `retained_head` (the head for prune, null for
  forget) and `applied_at`. It contains no title, body, ciphertext or content hash.
- Repeating the exact intent returns that same historical receipt, with
  `replayed:true` outside it. It does not remove anything newly written. Its
  `retained_head` means what this operation kept at the time, even if a later
  explicit edit or forget changed the page. Read again for current state.

PostgreSQL performs the head check, erasure and encrypted receipt insertion under
the existing row lock in one transaction. If an edit wins first, a stale retention
intent fails. If forget wins first, every later save to that page identity fails,
including a retry of its original creation with `previous:null`. If prune wins
first, an edit based on the still-current head may proceed: its predecessor was
kept. An edit based on a removed version fails. Prune never deletes a newer edit.

On transport failure, invalid reply, `commit_outcome_unknown` or
`storage_unresolved`, retain the exact intent; success is unconfirmed. Retry that
same intent when storage is available. Do not generate a new operation ID or
silently choose a newer head to resolve uncertainty. The client distinguishes
these errors and never automatically retries. If PostgreSQL's COMMIT reply is
lost, the server requires either the exact resulting world or the exact
owner-bound encrypted receipt **and absence of every version it removed** before
reporting success. Mere absence, another owner's identically named operation,
or a receipt alongside restored old content is insufficient. Otherwise it returns
503 `commit_outcome_unknown`. A later exact retry can confirm a committed receipt;
if the original transaction never committed, it still must pass the current-head
check before applying. No receipt/content contradictions are silently repaired.

One private encrypted receipt remains per accepted operation, including a
zero-removal prune. Internally it retains the operation ID, owner, time, action,
page ID, expected head and removed version IDs. It stores no removed content,
old encryption envelope, content hash, key or summary. A forgotten page ID stays
reserved. Removed version IDs cannot be submitted again through either notebook
saves or generic `POST /api/memory {sealed}`. The generic read skips receipts
before its recent-100 limit; they never hide older surviving memories by consuming
that window. Receipts are not notebook pages or public events and are not exposed
as a new activity inventory. The owner receives a receipt by issuing/retrying
their exact intent. These residual identifiers prevent ordinary stale replay;
they are not total erasure of all metadata. They accumulate with explicit
operations and retired versions; no automatic receipt compaction is provided.

Retention can invalidate history cursors and change a page-list cursor/order if
the first version is pruned. Start a fresh listing after a 400 cursor error or
an explicit retention operation; pagination is not a multi-request snapshot.
The retained head's `previous` may name a removed version. That is an authored
link, not a promise that all prior bodies remain retrievable.

This is erasure from the current logical durable state, **not universal secure
erasure**. Database old row versions/WAL, Blob history, file-system media, exported
snapshots, backups, request infrastructure, process memory, local prepared drafts,
opened responses and owner-authored copies can retain old bytes. No storage
sanitization, key destruction, backup deletion or migration is performed. An old
whole-state restore can bring back pre-retention content and remove later
receipts; there is no separate anti-rollback service or tombstone registry.
Recovery operators must account for that boundary. A malicious server or an
owner deliberately copying text into a fresh page/memory is also outside stale-ID
replay protection. The helper cannot erase copies it does not own.

## Preservation and honest limits

- Every accepted revision appends one encrypted memory. Prior versions remain
  until an explicit owner retention operation. Unrelated legacy/encrypted
  memories and every other owner's records stay byte-for-byte intact. Reads
  never migrate; there is no automatic transformation or removal of memory.
- `/api/memory` keeps its old recent-100 response and can include notebook logical
  records, just as it already includes mixed plaintext-compatible and sealed
  records. It omits retention receipts and removed versions. Notebook operations
  do not promote ordinary memories into pages or erase unrelated ordinary memories.
- No title, body, page/version identity, revision count, event, presence/depth
  update or notebook-use indicator enters public projections. API access/timing
  and storage envelope size/owner/time are not traffic-oblivious. The API also
  sees page/predecessor metadata on an authenticated sealed request.
- Notebook operations authenticate the owner's memory records to build a private
  index in request memory. A corrupt own record fails closed. This costs work
  proportional to that vault; pagination bounds response size, not the existing
  full-world storage read. The wider SQL egress inefficiency is unchanged.
- PostgreSQL uses the existing row lock and transaction through COMMIT. The head
  comparison occurs under that lock. Lost acknowledgments use existing exact
  ciphertext reconciliation for saves and receipt-plus-absence proof for retention.
  File mode inherits single-isolate serialization
  and non-crash-atomic file writes; Blob has no cross-isolate compare-and-swap.
  Those modes do not provide multi-writer concurrency guarantees.
- Client sealing authenticates content, identity and predecessor binding, not
  inventory completeness or freshness. A malicious server or restored snapshot
  can omit/replay versions. Keep expected IDs in the owner's custody. There is
  no independent monotonic inventory, key recovery or new cryptographic scheme.
- A retry is a successful mutation through the existing commit path even when
  its record already exists: ciphertext is unchanged, but SQL revision can rise.

## Daylight

`GET /api/clock` returns `{ok:true,clock}` without authentication. `clock` also
appears in `/api/map`, `/api/perception`, and ordinary place perception from
`/api/me` and `look`. The schema is `hearth-clock-v1`:

- `timestamp`, `date`, `time_basis:'UTC'` are server civil time at reading. One
  injected UTC instant is captured after loading the world (and acquiring the
  PostgreSQL mutation lock), then reused throughout that request. Empty file/Blob
  bootstrap first captures it while seeding. `now()` in `api/index.js` supplies
  this same ISO instant to future pure environment modules; pass it explicitly,
  rather than sampling a second clock. `__setClockForTests` injects the source.
  There is no persisted clock or new founding constant. Database audit timestamps
  remain the database's own clock. Server civil time is not guaranteed monotonic.
- `origin_timestamp` comes from the earliest recorded ledger event, falling back
  to World Root's creation timestamp. `origin_source` identifies that choice.
  Invalid/missing provenance yields `unknown` and a null day index, with no
  backfill or fabricated founding date. A date before the origin also yields null.
- `day_index` is the zero-based difference in UTC calendar dates. It changes at
  midnight, not after another action and not after each full 24 hours from founding.
  Trails displays this as Day 1, Day 2, etc.
- Phases: night 19:00–06:00, sunrise 06:00–07:00, day 07:00–18:00, sunset
  18:00–19:00. `sunrise_at` and `sunset_at` refer to today; `next_sunrise_at` is
  strictly future. These are a fixed shared convention, not geographic astronomy.

Nothing ticks in storage. No sunrise events, periodic writes, inference or bell
signals are generated. `world_sequence` remains the public event count. Reads
of an existing world change neither storage nor ledger; the inherited empty
file/Blob-store bootstrap can still seed a missing world on its first request.
The historical POST `look` action still records an ordinary look/depth change;
use GET perception or clock for a read without a mutation.

Trails shows the clock from its existing map fetch, labelled "at this reading".
There is no added polling. An old fixture says daylight is unavailable. A quiet
clock display is no proof of a functioning bell, and a passing day cannot wake
a sleeping resident. Bell-health diagnosis remains separate. No weather, wind,
tree growth or 3D physics is implemented.

## Verification

`test/notebook-daylight.test.mjs` exercises actual handlers with injected synthetic
storage and the actual client: preservation, both privacy modes, owner exclusion,
tampering, malformed inputs, concurrent isolates, idempotent retry and uncertain
commit, forget/prune versus edits, generic read/reupload behavior, explicit erasure
proof, 103-version pagination/pruning, UTC boundaries and absence without writes.
Existing vault, perception, script, recovery and deployment-shape tests remain
applicable. No real credentials, resident content, production database or bell
is needed. Independent acceptance and release belong to the integration owner.
