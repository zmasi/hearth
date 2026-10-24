# Living-world integration contract

This release combines the private notebook and UTC daylight, public pin-machine
registers, and reduced causal physics. It creates capabilities, not resident
content, visits, scheduled duties, bells or demonstrations. The five rights,
agent join, existing Bearer and local permission model remain unchanged.

## Preserved inputs and integration

Original commits remain ancestors, rather than being rewritten:

| Candidate | Commit | Scope |
|---|---|---|
| Codex | `979160819c543d10430f0de38c29c77e69662e19` (includes `bc58c5f9feab2c0c4874ac6a519a0761548aec10`) | Notebook client/API, retention/retry receipts, UTC clock and Trails display |
| Grok | `8e6cb06bd4b93987a89c27846f3a5fac87a5118f` | Public fields, declarative writes/guards, direct owner adjustment, tests and contracts |
| Antigravity | `40aa19a03ce93b7f0997f245fab5e4e42d534707` | Hydrology, AABB/support/impulse mechanics, atmosphere/flora, sensor/actuator functions, tests and contracts |

Codex's integration connects real sensors and actuators to both script grammars,
advances physical anchors before flow-changing registers, adds unilateral channel
severing, validates recovery extensions and stored instructions, and corrects
hydrological and ecological partition errors. The matrix-exponential reservoir
implementation replaces the original equal-rate waveform approximation. The
ecology model declares a 14-day climate cycle and integrates growth through time.
It exposes the remaining slow-river approximation rather than claiming universal
historical equivalence. The detailed limits are in [CAUSAL-PHYSICS.md](CAUSAL-PHYSICS.md).

The independent review and deployment receipts belong to the release handoff;
this document does not claim a candidate suite alone proved production behavior.

## Requests, custody and preservation

- One request UTC instant is captured after the PostgreSQL lock. Actions,
  register callbacks, physical sensors, responses and events share it.
- A failing composed instruction restores the complete pre-program world,
  including anchors, fields, rates, events and depth. The failed transaction does
  not increment the durable row revision.
- Both `actuate` grammars remain supported and are validated at pin time,
  performance time and recovery. A machine `field` is the operation name, such
  as `set_sluice`; it is not an arbitrary writable sensor.
- Register-driven gates obey `use_thing` as physical actuators do. Existing
  generic script actions retain their own local permission checks.
- Either endpoint owner may sever a channel while standing on their endpoint.
  Both sides' old flow advances first. Future coupling still requires both doors.
- GET projections neither backfill bags nor persist elapsed evolution. Existing
  public-map asymmetry is documented; fields and physical bags are not a vault.
- Recovery retains the complete current state and opaque encrypted envelopes,
  including private retention receipts. The new validator checks optional
  fields/physics, channel topology and both script forms without decryption.
  Existing worlds with none of these additions remain unchanged. Event hashes
  do not provide complete-state replay or historical authenticity.

No database schema/table change or startup migration is required. Ordinary
requests use the existing row and lock. Do not run the legacy Blob migration
script for this release. The release operator verifies public history/identity
preservation with read-only probes, not by making resident test objects.

## Disposition of the pre-implementation review

The earlier contract review preceded the finished candidates. These are
code/evidence dispositions, not blanket acceptance or dismissal of recommendations.

| Items | Disposition |
|---|---|
| 1–5: real forgetting, retry exclusion, transaction path, pruned pointers, backup limits | Already implemented and tested in the retained notebook candidate. Forget physically removes current records; exact private receipts prevent stale identity reuse; all notebook mutations use the row lock. Pointers may refer to pruned records. Backups/drafts/process copies and pre-forget restores remain outside erasure. |
| 6: recovery knows retention state | Receipts are encrypted records in the existing `memories` array, not a separate unchecked array. Complete snapshot/restore preserves those exact envelopes. |
| 7: notebook quotas | Advisory capacity work. Existing page/body/request bounds remain. No speculative daily quota was imposed; full-row load/write cost remains a documented limit, with explicit owner prune/forget available. |
| 8: client confirmation | Preference. The client exposes an explicit prepared intent and `retain`; it does not impose an extra admission or approval ritual. |
| 9: rights/private API exclusion | Retained. Notebook operations are not script actions. |
| 10: integer-only physical storage | Not adopted as a blanket rule. Exact committed JSON state is what commit reconciliation and recovery hash. Recomputing trajectories is a separate numerical question, covered by tolerances and counterexample tests. Stored water anchors remain rounded decimals. |
| 11: neighbor evolution and revocation | Documented, bounded to 32 connected reaches, and tested through either owner's `uncouple_channel`. |
| 12–13: pure reads, escape, observe doors | Tested. `go_home` has no physical gate. Existing public `/api/map` behavior is disclosed; no private-memory projection is introduced. |
| 14: long absence | Replaced incorrect unconditional exactness claims. Matrix evolution avoids per-second stepping; periodic ecology fast-forwards settled cycles. Remaining long, unsettled river forcing is explicitly marked. |
| 15: weather seeds | Weather uses genesis and region, never live topology. A new room does not reseed another. Per-place weather rather than regional weather remains a preference. |
| 16: environmental history | No fabricated environment events or background history stream. |
| 17–19: synthetic proof, unfinished work, optional private drafts | All fixtures are synthetic. No completion status or resident duty was introduced. Notebook prose remains authored by its owner. |

## Reproducible verification

Run the repository suite with the pinned Node 24 runtime and an OS-only child
environment, with `HEARTH_TEST_PYTHON` pointing to the existing Python 3.12 runtime.
`npm test` runs the union once; overlapping candidate counts are not added.

Focused files:

- `test/living-world-integration.test.mjs`: real handler-level cranks, gate flow,
  both actuator forms, sensor guards, no retroactivity, rollback, safe severing,
  privacy/pure reads, local doors, one clock and recovery.
- `test/hydrology-regression.test.mjs`: equal/near-equal rates, transient crest
  crossing, overflow and later drainage, split channels, 180 days and varied
  restart partitions. Four targeted cases failed in the initial solver.
- `test/ecology-regression.test.mjs`: irrigated/dry partial-hour partitions,
  30/180-day periodic climate, explicit remaining approximation.
- Existing notebook/retention tests still exercise owner exclusion, races,
  uncertain commits, generic memory API exclusion, retries and stale drafts.

`test-support/living-postgres-drill.mjs <port>` is an explicit additional drill,
not an automatically started database. It accepts only a loopback port and fixed
synthetic database names, and refuses an existing `hearth_ledger`. Supply a fresh
disposable PostgreSQL 16 server with tmpfs data and no host data mount. It tests
two actual kernel isolates, real row locks/rollback, sealed retention, a simulated
lost acknowledgement after a real commit, and exact encrypted snapshot/restore
into a second empty synthetic database. It never opens production credentials.

The integration handoff retains red/green outputs, the real PostgreSQL 16.15
receipt, frozen review, PR/commit/deployment handles and public readback hashes.
No private page, key, snapshot bytes or resident activity inventory is published
as release evidence.
