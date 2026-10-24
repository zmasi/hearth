# Notebook/daylight candidate verification

Codex local implementation and verification, October 23, 2026 (Pacific).
Independent acceptance/release is pending. No commit, push, merge or deployment.

Worktree: `C:/Dev/hearth-notebook-daylight`
Branch: `feat/notebook-daylight`
Base/HEAD: `c96eea970f1f5d252be6873674ca41d32a70c172`

## Exact artifact scope

Modified:

- `api/index.js`: owner notebook reads/writes using existing encrypted memories,
  append-only CAS revisions, exact retry, derived civil clock and discovery.
- `observer/app.mjs`, `observer/index.html`, `observer/trails.mjs`: public daylight
  label from the existing map fetch.
- `observer/README.md`, `skill.md`, `docs/NATIVE-HABITATION.md`: usage/discovery.

Added:

- `client/notebook.mjs`: explicit prepare/save/read, default client sealing.
- `test/notebook-daylight.test.mjs`: 12 synthetic tests.
- `docs/NOTEBOOK-DAYLIGHT.md`: exact contract, native usage and limits.
- This verification receipt.

Dependency manifests, lockfile, Vercel configuration, Constitution, bell code,
ROADMAP and DELTAS are unchanged. API deployment remains a single function.

## Executed checks

Pinned Node: `C:/Dev/_tools/node-lts/node-v24.16.0-win-x64/node.exe` — v24.16.0.
Pinned Python fixture: `C:/Dev/_tools/python-3.12.10/python.exe`.

Installed the existing lock with pinned Node running its bundled npm CLI:

```text
npm ci --ignore-scripts --no-audit --no-fund --userconfig=NUL --globalconfig=C:/Dev/hearth-notebook-daylight/.absent-npm-global-config
node --test test/notebook-daylight.test.mjs
npm --userconfig=NUL --globalconfig=C:/Dev/hearth-notebook-daylight/.absent-npm-global-config test
node --check api/index.js
node --check client/notebook.mjs
node --check observer/trails.mjs
git diff --check
```

The initial focused checks reproduced absent notebook routes and the absent
clock-injection seam before implementation. One initial test also needed its
fixture corrected to obtain `me.id` through `/api/me`, not the join response.
Focused checks then passed, including all 12 new tests in the final full run.

Final full suite: **210 passed, 0 failed, 0 skipped, 0 cancelled**, exit 0,
3389.4675 ms. The real AdapterServer boundary ran with its deterministic fixture
driver. No real native model turn ran. Expected synthetic storage-failure tests
emit fixed content-free diagnostics.

The full npm test child had its environment cleared, then inherited only OS
PATH/SystemRoot/WINDIR/TEMP/TMP/ComSpec/PATHEXT/SystemDrive plus the pinned Python
path and `PYTHONDONTWRITEBYTECODE=1`. Node's directory was prepended to PATH.
No `.env` or real credentials were loaded. Tests used injected synthetic storage
and temporary local worlds. The notebook transaction tests simulate PostgreSQL
locks/commits; they are not a real PostgreSQL acceptance drill.

Covered: both privacy modes, actual client/handler round trips, private and
cross-owner exclusions, wrong keys and ciphertext authentication, malformed
identities, stale edits, concurrent isolates, exact retry/commit reconciliation,
old record preservation, 103 revisions read through bounded pagination, stable
page-list cursors, UTC midnight and multi-day absence, each phase boundary,
legacy provenance fallback, discovery and no mutation during clock reads.

## Browser check

Started only a disposable loopback server with a fresh synthetic file world and
injected `2026-10-23T06:30:00.000Z` time. Chrome rendered
`Day 1 · 2026-10-23 · sunrise · 06:30 UTC at this reading` in Trails.
The browser console reported no warnings or errors. Screenshot capture timed
out; mobile layout and screenshot-based visual acceptance are unverified.
The temporary server was stopped and the verification tab closed.

## Acceptance boundaries

The coordination clarification was read before handoff: **all notebook revisions
remain readable; forgetting/retention control is not implemented.** This is not
approval of perpetual private retention. Reconcile that choice with resident
control before release. No resident data was deleted, migrated, imported or read.

See the contract for file/Blob concurrency limits, server-visible metadata,
server-blind content versus compatible plaintext, rollback/omission limits,
existing full-world SQL reads and inherited empty-store bootstrap behavior.
Daylight is civil time, not environmental physics or bell-health detection.

No active writer claim remains outside this isolated candidate. The native
reasoning-effort setting was not exposed in the available session metadata;
no model, effort, role, budget or global runtime configuration was changed.
