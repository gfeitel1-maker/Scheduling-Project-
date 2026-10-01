---
task: "sweeps PR D — delete the op log's dead conflict-arbitration layer (T311 finding 2)"
document_type: run
date: 2026-09-30
round: 2
status: pass
verdict: PASS
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets:
  - docs/work/tickets/T311-retired-ws-host-comment-sweep.md
related_specs: []
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-07-24-bulk-replace-seq-fix.md
  - docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md
selected_agents: [governor, maker, code-reviewer, security, red-hat, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: "Deletion of code already established as dead; the replacement path is recorded in docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md. No new structure, no schema version, no contract change."
  - agent: designer
    reason: not-applicable
    note: "No UI surface touched."
  - agent: tester
    reason: not-applicable
    note: "No user-observable behaviour changes; nothing for a director to exercise."
deterministic_checks:
  - "npx eslint electron"
  - "npx vitest run electron/ops/operations.test.js electron/ops/bulkReplace.test.js electron/ops/projectionsCoverage.test.js electron/ops/ingestUndo.test.js electron/ops/deleteRecord.test.js"
  - "npm run build"
  - "npm run check:governance"
  - "npm run test:integration"
  - "git show --stat HEAD (footprint check)"
completion_evidence:
  - "npx eslint electron — exit 0"
  - "npx vitest run --no-file-parallelism electron/ops/operations.test.js electron/ops/bulkReplace.test.js electron/ops/projectionsCoverage.test.js electron/ops/ingestUndo.test.js electron/ops/deleteRecord.test.js — exit 0, 5 files / 141 tests"
  - "npm run build — exit 0"
  - "npm run check:governance — exit 0, advisory platform-state-stale only"
  - "npm run test:integration — exit 0, 26/26 libp2p scenarios"
  - "symbol-absence grep for the four deleted names — clean (11 survivors, all historical prose or under electron/db/)"
  - "git show --stat HEAD — ten permitted files, nothing under electron/db/"
human_gates:
  - "database-sync human gate per GOVERNANCE_INDEX.md §3 is 'ADR + migration/rollback plan'. No schema version, no migration, no table drop here, so the migration/rollback half is vacuous. Whether the deletion itself warrants its own ADR beyond the existing 2026-09-06 one is an OPEN POINT for the owner (unavailable at time of run)."
verdict: null
completion_evidence: []
archive_when: "T311 finding (2) is discharged and this branch is merged"
---

# Run: delete the op log's dead conflict-arbitration layer

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

## Brief

**Product outcome:** nothing the director sees changes. What changes is that a reader of
`electron/ops/operations.js` can no longer mistake a dead pre-Stage-6 arbitration layer for the
live conflict path, and cannot build on it by accident.

**Success predicate:** `recordConflict`, `detectConflict`, `detectBulkReplaceConflict` and
`latestScopeOpSeq` no longer exist in `electron/ops/operations.js` and are no longer exported; no
non-test reference to any of the four survives outside prose that is explicitly marked historical
(`_Prior:`, ADRs, tickets, runs, architecture reports); every test that exercised only them is
removed with a stated reason, and every test that used one of them as a fixture to pin a **live**
function's behaviour (notably `listPendingConflicts`) is re-expressed against the live writer and
still passes; every surviving comment describes the CRDT reconciler as the conflict path rather
than these functions; and eslint, the named vitest files, `npm run build`,
`npm run check:governance` and `npm run test:integration` all exit 0.

**What does not count as done:**
- Dropping `pending_restores` or `pending_writes` (needs a schema version; another worker's item).
- Touching `electron/db/` at all, including `electron/db/schema.sql`.
- Any schema version bump, ticket number, or status flip.
- Deleting the `listPendingConflicts` coverage because its test file referenced `recordConflict`.
  That is live IPC-backed behaviour (`electron/main.js` → `shoresh:list-conflicts`).
- Changing anything about `based_on_seq` in the schema. There is nothing to change: it was only
  ever a JavaScript parameter of the deleted `detectBulkReplaceConflict`, never a persisted
  column. `CREATE TABLE IF NOT EXISTS operations` in `electron/db/schema.sql` has no such column,
  `git log --all -S"based_on_seq" -- electron/db/schema.sql` returns no commit, and
  `appendBulkReplaceOp` — the only writer of a `bulk_replace` op — neither accepts nor persists
  it. So nothing is owed: no drop, no migration. Only the arbitration functions go.
  **The inherited T311 framing asserted the column still existed in the schema; that assertion
  was wrong, and this run corrected it** (round 2, after the round-1 comment rewrite repeated it).
- Leaving any comment that still describes one of the four as the live path.

## Task class and what it pulls in

`database-sync` — per `GOVERNANCE_INDEX.md` §3 this governs:

| | |
|---|---|
| Standards | relevant sync/op-log ADRs · `PLATFORM_STATE.md` §schema · `ARCHITECTURE_STANDARD.md` |
| Mandatory gates | **integration (mandatory)** · test · lint · build (plus `check:governance` because descriptive docs are in the footprint) |
| Human gate | ADR + migration/rollback plan — migration half vacuous (no schema change); ADR question is an open point, owner unavailable |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `not-applicable` — dead-code deletion under an existing ADR; no new structure |
| Designer | no | `not-applicable` — no UI surface |
| Maker | yes | the deletion itself |
| Code Reviewer | yes | every deleted test either exercised only dead code or is re-expressed; every comment now true |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | no | `not-applicable` — no user-observable change |
| Security | yes | op-log integrity: nothing that enforced a write invariant is lost |
| Red Hat | yes | string/dynamic dispatch, IPC handler names, rollback modules, side-effect reliance, `conflicts` table documented writers |
| Grader | yes | calibrated score |

## Pre-dispatch facts (Governor, verified in this worktree 2026-09-30)

Grep with **quoted** `--include` globs (unquoted globs fail outright in zsh — the exact false
negative recorded in `feedback_use_graphify_before_structural_edits`). Zero non-test callers for
all four. `latestScopeOpSeq`'s only caller is `detectBulkReplaceConflict` at `operations.js:495` —
dead calling dead.

Two live neighbours that must survive intact:
- `latestOpSeq` (`operations.js:643`) — live, reaches the renderer via
  `electron/main.js:811` → `shoresh:latest-op-seq`.
- `listPendingConflicts` (`operations.js:899`) — live, reaches the renderer via
  `electron/main.js:1587` → `shoresh:list-conflicts`. The test block headed
  `recordConflict + listPendingConflicts` (`operations.test.js:903`) pins THIS function's
  behaviour and uses `recordConflict` only as a fixture. It must be re-expressed, not deleted.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| graphify affected ×4 | done | all four headers carried the parens — no doc-node misresolution, no abstention. Output below. |
| grep -rna ×4 | done | quoted `--include` globs. Zero non-test, non-prose references. Output below. |
| npx eslint electron | exit 0 | no output |
| named vitest files | exit 0 | `operations.test.js`, `bulkReplace.test.js`, `projectionsCoverage.test.js`, `ingestUndo.test.js`, `deleteRecord.test.js` — **5 files passed, 141 tests passed** |
| npm run build | exit 0 | `✓ built in 3.79s` (pre-existing >500 kB chunk advisory only) |
| npm run check:governance | exit 0 after `npm run index:work` | before the index refresh: 1 blocking `index-stale` (this run record) + the pre-existing advisory `platform-state-stale`. After: advisory `platform-state-stale` only, which is the one acceptable finding. |
| npm run test:integration | **exit 0** | run by Verifier (mandatory for `database-sync`): **26/26 libp2p scenarios**. |
| footprint | **10 files** — `git show --stat HEAD` | 7 under `electron/ops/` (`bulkReplace.test.js`, `deleteRecord.js`, `ingest.js`, `operations.js`, `operations.test.js`, `projections.js`, `projectionsCoverage.test.js`) plus `docs/work/INDEX.md`, this run record, and the T311 ticket. Nothing under `electron/db/`. |
| symbol-absence grep (all four deleted names) | clean | 11 surviving references, every one either historical prose or under `electron/db/` (the out-of-scope boundary, open points 1–2 below). |

**`git show --stat HEAD` is the footprint instrument here, not `git diff origin/main..HEAD`.**
The two-dot form is the wrong tool on this branch: `origin/main` has advanced past this branch's
merge-base, so other workers' merged commits are reported as if they were changes in this run.
Verifier's round-1 Gate 7 FAIL was exactly that artifact. `git log --oneline origin/main..HEAD`
is one commit, and `git show --stat HEAD` lists the ten permitted files. A reader re-deriving this
with the two-dot diff will reproduce the same false red.

### Line counts (`git diff --numstat`, code only)

| File | + | − |
|---|---|---|
| `electron/ops/operations.js` | 52 | 201 |
| `electron/ops/operations.test.js` | 38 | 164 |
| `electron/ops/bulkReplace.test.js` | 0 | 86 |
| `electron/ops/ingest.js` | 5 | 5 |
| `electron/ops/projectionsCoverage.test.js` | 3 | 3 |
| `electron/ops/projections.js` | 2 | 1 |
| `electron/ops/deleteRecord.js` | 1 | 1 |
| **total** | **101** | **461** |

Of the 201 lines removed from `operations.js`, 149 are the four function bodies plus their doc
comments plus the module-private `latestOpForEntity` (orphaned BY this change — `detectConflict`
was its only caller; the identically-named **exported** `latestOpForEntity` in
`electron/ops/restore.js` is a different, live function and is untouched). The rest is comment
rewriting.

## graphify output (recorded by Maker — header line verbatim for each)

Command form, run from this worktree against the main checkout's graph (the graph lives only there
and reflects committed `main`):

```
graphify affected "<fn>()" --graph ~/dev/shoresh/graphify-out/graph.json
```

**Header lines, verbatim** — each one carries the parentheses, so each resolved the CODE node, not
a same-named documentation node:

```
Affected nodes for recordConflict()
Affected nodes for detectConflict()
Affected nodes for detectBulkReplaceConflict()
Affected nodes for latestScopeOpSeq()
```

None of the four returned `No unique node match` — the graph did not abstain on any of them.

Full output:

```
Affected nodes for recordConflict()
Relations: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, requires
Depth: 2
- operations.test.js [imports] electron/ops/operations.test.js:L10

Affected nodes for detectConflict()
Relations: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, requires
Depth: 2
- operations.test.js [imports] electron/ops/operations.test.js:L10

Affected nodes for detectBulkReplaceConflict()
Relations: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, requires
Depth: 2
- bulkReplace.test.js [imports] electron/ops/bulkReplace.test.js:L5

Affected nodes for latestScopeOpSeq()
Relations: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, requires
Depth: 2
- detectBulkReplaceConflict() [calls] electron/ops/operations.js:L360
- bulkReplace.test.js [imports] electron/ops/bulkReplace.test.js:L5
```

The graph therefore confirms the Governor's pre-dispatch finding independently: the only dependents
are the two test files, and `latestScopeOpSeq`'s single code caller is `detectBulkReplaceConflict`
— dead calling dead. (The `L360` in that edge is the graph's committed-`main` position for the
call, which sat further down in this worktree before deletion; line drift, same call.)

## grep output (recorded by Maker)

Command form (the `--include` globs are **quoted** — unquoted, zsh fails the whole command with
`no matches found: --include=*.js` and prints nothing, which reads as "zero references"):

```
grep -rna "<fn>" --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.sql' \
  --include='*.md' electron src scripts test docs
```

Trimmed of `docs/archive` (historical layer). Prose hits in ADRs, tickets, prior runs,
`docs/work/architecture-reports/**`, `docs/work/onboarding-reconciliation/**` and
`docs/current/PLATFORM_STATE.md` are **historical layers, deliberately not rewritten** per the
brief's hard boundaries, and are elided below; what is listed is every hit in code and in SQL.
Line numbers are pre-deletion.

### `recordConflict`

```
electron/automerge/reconcileForProjection.js:17:  recordConflicts,                     <- LIVE (plural)
electron/automerge/reconcileForProjection.js:30:  recordConflicts(db, conflicts)       <- LIVE (plural)
electron/automerge/conflictStore.js:33:export function recordConflicts(...)           <- LIVE (plural)
electron/automerge/conflictStore.js:116: * same idempotence rule as `recordConflicts` <- LIVE (plural)
electron/automerge/projector.test.js:18:import { recordConflicts, ... }               <- LIVE (plural)
electron/automerge/projector.test.js:144:    recordConflicts(db, conflicts)          <- LIVE (plural)
electron/db/schema.sql:436:-- ... Written today by recordConflicts                    <- LIVE (plural); electron/db/ out of scope
electron/ops/operations.test.js:17:  recordConflict,                                 <- REMOVED (import)
electron/ops/operations.test.js:903:describe('recordConflict + listPendingConflicts   <- RE-EXPRESSED
electron/ops/operations.test.js:934,976,1014,1051,1055,1683: recordConflict(db, ...)  <- RE-EXPRESSED (6 call sites)
electron/ops/projections.js:1235: // Conflicts are created by raw SQL (recordConflict <- REWRITTEN
electron/ops/projectionsCoverage.test.js:315,330: 'raw SQL in recordConflict()'       <- REWRITTEN
electron/ops/operations.js:417: // ... `recordConflict`/`conflicts` table            <- REWRITTEN (historical)
electron/ops/operations.js:866: // ... The live equivalent is `recordConflicts`       <- DELETED with the function
electron/ops/operations.js:872:export function recordConflict(db, ...)               <- DELETED
```

Note the near-miss the plural/singular pair sets up: **every** `electron/automerge/**` hit is
`recordConflicts`, the live CRDT writer, not the deleted singular `recordConflict`. A substring
grep cannot tell them apart, so each line above was opened and read.

### `detectConflict`

```
electron/db/schema.sql:438:-- detectConflict in handleSubmitOp / an op_conflict message  <- OUT OF SCOPE, open point 1
electron/ops/operations.test.js:15:  detectConflict,                                <- REMOVED (import)
electron/ops/operations.test.js:561:describe('detectConflict', ...)                  <- REMOVED (block)
electron/ops/operations.test.js:581,614: detectConflict(db, incomingOp)              <- REMOVED
electron/ops/operations.test.js:621: // ... check detectConflict cannot express      <- REWRITTEN
electron/ops/operations.test.js:808:describe('detectConflict: DELETE_FIELD vs. ...') <- REMOVED (block)
electron/ops/operations.test.js:839,873,898: detectConflict(db, ...)                 <- REMOVED
electron/ops/ingest.js:1723,1725: _Prior block naming detectConflict                 <- REWRITTEN (marked gone)
electron/ops/operations.js:47,55,355,371,393,418,656,669,698,699,703                 <- REWRITTEN or struck through
electron/ops/operations.js:682:export function detectConflict(db, incomingOp)        <- DELETED
```

### `detectBulkReplaceConflict`

```
electron/ops/bulkReplace.test.js:13:  detectBulkReplaceConflict,                     <- REMOVED (import)
electron/ops/bulkReplace.test.js:215,225,229,251                                     <- REMOVED (block)
electron/ops/operations.js:410: // At submission time, `detectBulkReplaceConflict`    <- REWRITTEN (historical)
electron/ops/operations.js:494:export function detectBulkReplaceConflict(...)        <- DELETED
```

### `latestScopeOpSeq`

```
electron/db/localDb.js:757: // latestScopeOpSeq in electron/ops/operations.js         <- OUT OF SCOPE, open point 2
electron/ops/ingest.js:2892: // ... via latestOpSeq/latestScopeOpSeq                  <- REWRITTEN (dead half dropped)
electron/ops/bulkReplace.test.js:12,175,176,179,189,192,212                          <- REMOVED (import + block)
electron/ops/ingestUndo.test.js:233: // ... latestOpSeq/latestScopeOpSeq's convention <- NOT in brief's scope, open point 3
electron/ops/operations.js:402,478,495                                               <- DELETED / REWRITTEN
electron/ops/operations.js:455:export function latestScopeOpSeq(db, entity, scope_id) <- DELETED
electron/ops/operations.js:639,641: latestOpSeq's _Prior cites "latestScopeOpSeq above" <- RESTATED, see below
electron/ops/deleteRecord.js:338: // is counted by latestScopeOpSeq, carried by bulkReplace <- REWRITTEN
```

**The `latestOpSeq` citation move.** `operations.js:639-641` carried a `_Prior:` note whose
reasoning pointed at "`latestScopeOpSeq` above" for why the `COALESCE(host_seq, seq)` is there.
Since the target is gone, the reasoning is now **restated inline on `latestOpSeq` itself** — the
host_seq migration (schema v18), `applyRemoteOp` as its only writer, that writer's removal at the
Stage 6c cutover, and therefore `host_seq IS NULL` on every row on every device — with a
struck-through pointer noting where the shared reasoning used to live. `latestOpSeq` no longer
depends on a deleted function's comment to explain itself.

## Per-test disposition

Every test touched, in the two categories the brief defines.

### `electron/ops/operations.test.js`

| Test / block | Category | Disposition |
|---|---|---|
| `describe('detectConflict')` — 2 cases (`parent_op_id` match → no conflict; divergent parents → conflict) | **(a)** exercised ONLY `detectConflict` | **Removed.** Reason: the function is deleted. The behaviour it pinned — per-field concurrent-write arbitration — is not lost from the product; it moved to the CRDT reconciler and is covered by `electron/automerge/reconcile*` and `electron/automerge/projector.test.js`. Re-expressing these two against the reconciler would be a *new* test of a different mechanism, not preservation of this one. |
| `describe('detectConflict: DELETE_FIELD vs. concurrent field-edit (Round 2 Security MEDIUM #2)')` — 3 cases | **(a)** exercised ONLY `detectConflict` | **Removed.** Reason: same. Worth naming explicitly because it is a *security*-originated block: the MEDIUM #2 fix it pinned lived entirely inside `detectConflict` (compare a delete against the latest op across ALL fields). With no `detectConflict`, there is no code path for that defect to exist on — the guard is not weakened, its subject is gone. |
| `describe('recordConflict + listPendingConflicts ...')` — 4 cases | **(b)** pinned **LIVE** behaviour (`listPendingConflicts`) through a deleted helper | **Re-expressed.** Renamed to `describe('listPendingConflicts ...')`. `recordConflict` was only ever a fixture here. Replaced by a **test-local** `insertOpConflictRow(db, { incomingOp, existingOp })` that writes one unresolved scalar `conflicts` row by direct SQL, in the same shape. **All four cases and every assertion are unchanged**, including the lazy resolved-marking case (`resolved_at` set on a later `listPendingConflicts` call) that the comments around the old `operations.js:894-898` described. |
| `'an existing scalar conflict is unaffected by a unique row also being pending'` (old `:1683`) | **(b)** same | **Re-expressed** the same way — one `recordConflict` fixture call swapped for `insertOpConflictRow`. Its sibling case in that block already used the live `recordUniqueConflicts` and was not touched. |

**Why the fixture is direct SQL and not `conflictStore.recordConflicts`.** The brief's preferred
option was the live writer, "if its shape fits". It does not: `recordConflicts` stores each side as
`{ value, op_id }` under a deterministic `crdt:` id, whereas these cases assert on **whole-op**
rehydration (`pending[0].existingOp.id`, `pending[0].incomingOp.id` — both would be `undefined`)
and on resolution by a later op's `parent_op_id` matching `existing_op_id`. Substituting it would
have silently changed what the four cases test. The direct `INSERT` is confined to the test file and
carries a comment saying it is a fixture, why `recordConflicts` cannot stand in, and that the
assertions below it are about live IPC-backed behaviour.

### `electron/ops/bulkReplace.test.js`

| Test / block | Category | Disposition |
|---|---|---|
| `describe('per-scope conflict detection (round 2)')` — 5 cases (3 × `latestScopeOpSeq`, 2 × `detectBulkReplaceConflict`) | **(a)** exercised ONLY deleted functions | **Removed** as one block. Reason: both functions are deleted and nothing live passes `based_on_seq`. `electron/db/schema.sql` is untouched, as the brief requires — and there was nothing in it to touch: `based_on_seq` was a parameter of `detectBulkReplaceConflict`, never a column (round-2 correction; see "What does not count as done"). Only the arbitration that read the parameter is gone. The block's `appendOp` import (used by nothing else in the file after removal) went with it — orphaned by this change. |

### `electron/ops/projectionsCoverage.test.js` — exemption rationale re-derived, not widened

The `conflicts` exemption rows recorded `entity`/`entity_ids` as "Written only by raw SQL in
`recordConflict()` (electron/ops/operations.js)". After deletion that rationale is **false**, so the
actual writers were re-derived by reading `electron/automerge/conflictStore.js`:

- `entity`, `entity_id`, `field`, `incoming_op`, `existing_op`, `existing_op_id`, `created_at` —
  written by `recordConflicts()` **and** `recordUniqueConflicts()`.
- `entity_ids` — written by `recordUniqueConflicts()` **only** (narrower than the old rationale
  claimed, now stated as such).
- `resolved_at` — written by `clearResolvedConflicts()` / `clearResolvedUniqueConflicts()` in
  `conflictStore.js`, **and** by `listPendingConflicts()`'s lazy resolution scan in `operations.js`.
  The old rationale cited a stale `operations.js:515` line number for the latter and omitted the
  `conflictStore.js` writers entirely; the line citation is dropped (per
  `reference_no_path_line_citations_in_descriptive_docs`) and both writers are named.

**No exemption was added, and no exemption's column set was widened.** Same 10 columns, same
"raw-SQL-only, never via appendOp/PROJECTIONS" conclusion — which remains true — now with the
correct writers named. The file's 20 tests pass unchanged.

## Comment sites rewritten

`electron/ops/operations.js` (11 sites; struck-through names use T311's own `_Prior:` /
strikethrough convention):

| Was | Now |
|---|---|
| "SAME appendOp/detectConflict/appendOp-log path" | "SAME appendOp/op-log path"; the arbitration sentence now names `electron/automerge/reconcile.js` + `conflictStore.js` |
| "via latestOp/detectConflict below" | replaced by the reconciler citation above |
| `_Prior:` "appendOp/detectConflict run" | `appendOp/~~detectConflict~~` |
| "doesn't fit detectConflict's ... model" | "never fitted the op-log's retired per-field ... model either" |
| the whole "Conflict-detection semantics (round 2)" block, ~43 lines describing `based_on_seq` / `latestScopeOpSeq` / `detectBulkReplaceConflict` / `recordConflict` as the live per-scope mechanism | replaced by ≈19 lines: the CRDT reconciler named as the arbiter, then a `_Prior:` paragraph with all three names struck through. **Round 2 corrected this block twice**: it had said "the `operations.based_on_seq` column remains in the schema, written by nothing" — there is no such column and never was (see "What does not count as done") — and its `_Prior:` span contained a bare, un-backticked `bulk_replace`, whose underscore was consumed as the closing italic delimiter and left the paragraph's real trailing `_` stray. |
| `latestOpSeq`'s `_Prior:` citing "`latestScopeOpSeq` above" | reasoning restated inline (host_seq v18 → `applyRemoteOp` → Stage 6c → `host_seq IS NULL`), with `~~latestScopeOpSeq~~` noted as deleted |
| `latestOpForEntity` / `detectConflict` doc comments | deleted with their functions |
| D2 block, "an app-level uniqueness constraint detectConflict cannot see" | "...per-record arbitration cannot see", reconciler named, `~~detectConflict~~` noted as deleted by T311 finding 2 |
| `listPendingConflicts`'s doc comment | now states it is LIVE behind `shoresh:list-conflicts`, names `conflictStore.js`'s `recordConflicts`/`recordUniqueConflicts` as the writers of the rows it reads, and marks `~~recordConflict~~` as the deleted prior writer — previously the writer sat directly above it in this file and needed no citation |

Outside `operations.js` (4 sites, minimal as instructed):

| File | Change |
|---|---|
| `electron/ops/ingest.js` (the S2b `_Prior:` block) | said `detectConflict` "now runs on NO production path at all (it is exercised only by operations.test.js)". Now: struck through, and states the function is **gone**, deleted by T311 finding 2. Its conclusion (an import write is not conflict-checked here) is unchanged. |
| `electron/ops/ingest.js` (ingest-undo Invariant 4) | "via latestOpSeq/latestScopeOpSeq" → "via latestOpSeq". Dead half of the convention citation dropped; `latestOpSeq` survives. |
| `electron/ops/deleteRecord.js` (`removeDayFromWeek`) | "counted by latestScopeOpSeq, carried by bulkReplace, and rendered in a grid position" → "carried by bulkReplace and rendered in a grid position". The orphan-is-not-harmless argument still stands on its two surviving legs. |
| `electron/ops/projections.js` (`conflicts` PROJECTIONS entry) | "Conflicts are created by raw SQL (`recordConflict` in operations.js), no via appendOp" → names `conflictStore.recordConflicts` / `recordUniqueConflicts` in `electron/automerge/conflictStore.js`. (The pre-existing "no via" typo for "not via" is corrected in passing, inside the same sentence.) |

## Open points for the Governor

1. **`electron/db/schema.sql`** (the `conflicts` table comment) — says rows are written "today by
   `recordConflicts`" (correct, live) but then adds "`detectConflict` in `handleSubmitOp` / an
   `op_conflict` message" (both gone; `detectConflict` now deleted too). **Not edited** —
   `electron/db/` is a hard boundary for this run. Needs a separate pass.
2. **`electron/db/localDb.js`** — cites `latestScopeOpSeq` in `electron/ops/operations.js` as the
   home of the `COALESCE` reasoning. That function no longer exists; the reasoning now lives on
   `latestOpSeq`. **Not edited**, same boundary. Flagged as instructed.
3. **`electron/ops/ingestUndo.test.js`** — a comment citing "`latestOpSeq`/`latestScopeOpSeq`'s
   convention", the exact twin of the `ingest.js` Invariant-4 site that WAS in scope. It is not on
   the brief's scope list, so it was left alone rather than quietly widening the footprint. One-line
   fix whenever the Governor wants it.
4. **ADR question** — unchanged from the pre-dispatch note in the front matter: whether this
   deletion warrants its own ADR beyond `docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md`
   is an owner call, not made here.

## Verifier verdict

**PASS** — Verifier, round 1, all seven gates run in this worktree.

Verifier's one round-1 FAIL was Gate 7 (footprint), and it is a measurement artifact rather than a
defect in the change: it used the two-dot `git diff origin/main..HEAD` while `origin/main` had
advanced past this branch's merge-base, so other workers' already-merged commits were counted as
this run's changes. Superseded by `git show --stat HEAD`, which lists exactly the ten permitted
files (`git log --oneline origin/main..HEAD` is one commit).

| Gate | Exit code | Result |
|---|---|---|
| `npx eslint electron` | 0 | no output |
| named vitest files (5) | 0 | 5 files / 141 tests passed |
| `npm run build` | 0 | pre-existing chunk-size advisory only |
| `npm run check:governance` | 0 | advisory `platform-state-stale` only |
| `npm run test:integration` | 0 | **26/26 libp2p scenarios** |
| symbol-absence grep | 0 | 11 survivors, all historical prose or under `electron/db/` |
| footprint | — | FAIL as measured two-dot; **artifact**, see above |

Security scored **5**, confirming `appendOp`, `runAtomic`, `coerceOpValue`,
`MAX_FIELD_VALUE_LENGTH`, `findOpByClientWriteId`, `detectUniqueFieldCollision` and
`UNIQUE_FIELD_ENTITIES` byte-identical to `origin/main` — nothing that enforced a write invariant
was lost with the arbitration layer.

## Grader score

Average — **4.0**, lowest dimension — **3** (evidence quality). Pass is ≥ 4.0 with no dimension
below 3, so this clears the threshold on its lowest point rather than comfortably.

| Dimension | Score | What moved it |
|---|---|---|
| Specification fidelity | 5 | The four functions and their exports are gone; the live `listPendingConflicts` coverage was re-expressed, not dropped; footprint exactly as authorised |
| Maintainability | 4 | Comments now true after round 2; five pre-existing unbalanced `_Prior:` spans deliberately left (finding 5) |
| Security | 5 | Seven op-log write-invariant symbols byte-identical to `origin/main`; nothing under `electron/db/`, `electron/auth/`, `electron/sync/` |
| Resilience | 4 | Dynamic dispatch, IPC names, rollback modules, transitive test masking, the `conflicts` two-worlds row shape and the legacy-row upgrade path all attacked and clean |
| Evidence quality | 3 | Round 1 planted a false factual claim (`operations.based_on_seq` as a schema column — it never existed) and an unbalanced comment delimiter. Review caught both and round 2 corrected them, which is the loop working; the miss still belongs to round 1. |

Grader's own note, worth keeping: the DELETE_FIELD coverage gap (finding 1) is handled adequately
*because* it is carried forward as a finding rather than absorbed into "we deleted dead code".

## Findings carried forward

1. **The DELETE_FIELD-versus-concurrent-field-edit defect class now has zero test coverage
   anywhere.** This is a gap, not a reassurance. Code Reviewer (MEDIUM) and Security (LOW)
   converged on it independently.

   The class originates as "Round 2 Security MEDIUM #2" and was guarded inside the now-deleted
   `detectConflict`. The three tests that covered it were correctly deleted with their dead
   subject — but no equivalent coverage exists on the live CRDT path. `electron/automerge/reconcile.js`
   calls `A.getConflicts` only for keys currently **present** in the collection, while a
   DELETE_FIELD removes the record's field keys outright rather than writing a tombstone value
   into the scanned key-space; and no test under `electron/automerge/*.test.js` exercises a
   concurrent delete versus a concurrent field edit.

   Security established that the gap **predates this commit**: it was introduced by the Stage 6c
   CRDT cutover and is documented as an accepted consequence in
   `docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md`, which states that under Automerge
   "concurrent delete+assign is a first-class, expected occurrence". So this run neither introduced
   nor widened it — **but it did remove the last artifact that would have made a future reader
   notice it.** That is why the finding is recorded here rather than treated as out of scope.

   Carried forward for the board: either an explicit reconcile-level test for
   concurrent-delete-versus-concurrent-edit, or an ADR note stating why the flat-record shape makes
   the "resurrect a near-empty row" shape structurally impossible. **Neither exists today.**
   No ticket created and no number allocated — that is the board's call.

2. **`electron/db/schema.sql`** — the `conflicts` table comment still cites `detectConflict` in
   `handleSubmitOp` / an `op_conflict` message, both gone and now deleted outright. Not edited:
   `electron/db/` is a hard boundary for this run. (Open point 1.)

3. **`electron/db/localDb.js`** — cites `latestScopeOpSeq` in `electron/ops/operations.js` as the
   home of the `COALESCE` reasoning; that function no longer exists and the reasoning now lives on
   `latestOpSeq`. Not edited, same boundary. (Open point 2.)

4. **`electron/ops/ingestUndo.test.js`** — a comment citing "`latestOpSeq`/`latestScopeOpSeq`'s
   convention", the exact twin of the `ingest.js` Invariant-4 site that was in scope. Left alone
   rather than quietly widening the footprint. One-line fix. (Open point 3.)

5. **Pre-existing unbalanced `_Prior:` spans, not touched by this run.** While fixing the one
   delimiter defect this commit introduced, a mechanical parity check found the same imbalance in
   `_Prior:` blocks this commit did not author: `electron/ops/operations.js` (three blocks),
   `electron/ops/deleteRecord.js`, `electron/ops/projections.js` and
   `electron/ops/operations.test.js`. Cause in each case is the same — a bare, un-backticked
   snake_case identifier inside the italic span. Left alone deliberately: out of this run's scope.

## Decision

**PASS** (Governor, round 2). Verifier returned PASS on all eight gates with no unresolved
UNVERIFIED claim, including the mandatory `npm run test:integration` (exit 0, 26/26 libp2p
scenarios) that task class `database-sync` requires. Grader is 4.0 with no dimension below 3. Every
actionable finding from Code Reviewer, Red Hat and Security was fixed in round 2; the one
substantive residual (finding 1) is pre-existing, ADR-documented, and carried forward rather than
closed.

Not pushed, no PR, no merge — per the dispatch brief. Two commits on
`claude/sweeps-d-t311-dead-conflict-layer`: `e7285714` (the deletion) and `9232ad2b` (the
corrections).

### Open points for the owner

1. **The human gate for `database-sync` is "ADR + migration/rollback plan"** (`GOVERNANCE_INDEX.md`
   §3). The migration/rollback half is vacuous here — no schema version, no migration, no table
   drop. Whether the deletion itself warrants its own ADR beyond
   `docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md`, which already records the CRDT
   reconciler as the replacement, is a human call. Owner unavailable at time of run.
2. **T311's own framing was wrong on a fact** and the correction is worth propagating: it asserted
   that `operations.based_on_seq` "still exists in the schema". It never existed — `based_on_seq`
   was only ever a parameter of the deleted `detectBulkReplaceConflict`. Nothing is owed a
   migration. Round 1 repeated the error in a code comment before review caught it.
3. **Findings 2-4 are one-line comment fixes blocked only by this run's `electron/db/` boundary**
   and its footprint discipline. They are cheap and should be swept by whoever next has
   `electron/db/` in scope.
