---
task: M3c — migration review region + near-duplicate merge gate + delete-primitive re-home
document_type: run
date: 2026-08-15
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md, docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md, docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md]
related_runs: [docs/work/runs/2026-08-15-locations-m3a-setup-screen.md, docs/work/runs/2026-08-15-locations-m3b-picker.md]
selected_agents: [governor, architect, maker, code-reviewer, verifier, tester, red-hat, security, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: the review region + merge gate UX is owner-approved in docs/work/specs/2026-08-15-m3-locations-design.md (D-2, D-3); Architect designs the DATA layer, Maker builds to the existing UX spec
deterministic_checks: [test, lint, build, integration]
human_gates: [ADR/design approval for the merge operation + delete-primitive re-home if Architect finds it warrants one]
verdict: pass
completion_evidence: [electron/ops/deleteRecord.js, electron/ops/migrationReviews.js, electron/sync/syncClient.js, electron/sync/syncServer.js, src/screens/LocationsScreen.jsx, src/screens/locationMigrationReview.js, test/integration/scenarios/22-location-merge.js, docs/work/runs/gate-reports/2026-08-15-locations-m3c-merge-r1.json]
archive_when: M3c merged to main
---

# Run: M3c — migration review + near-duplicate merge gate + delete-primitive re-home

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. Last M3 slice. Owner authorized auto-land.

## Brief

**Product outcome:** The first time a director opens Locations after upgrading, Shoresh honestly
reconciles what the migration inferred: capacity disagreements, places that were silently unlimited,
and — the un-missable one — two names that are really one place ("Pool"/"pool"), which the director
merges via a blocking gate. After M3c, the migration's inferences are all director-confirmed, and the
"two rows, one place" data artifact the migration's case-sensitive dedupe left behind can be healed.

**Success predicate:** the `location_migration_reviews` journal is readable in the renderer via a new
host-local-safe read path; the Locations screen surfaces the three review kinds (D-2 copy: name the
activities when cheap); the near-duplicate **merge is a blocking modal gate** (D-3) the director cannot
scroll past, and merging **re-points every affected activity's `location_id` to the winner and deletes
the losing location row atomically, through the host delete path** (the primitive M3a committed to
re-home), reversibly (Trash); a camp/device with an empty journal sees no review region; test + lint +
build + integration green.

**What does not count as done:** a dismissible near-duplicate warning (must be a gate, ADR §c + Red Hat);
a merge that re-points activities non-atomically or bypasses the op-log/host path (that's the M3a
finding this slice exists to close); re-implementing #68's exact-name-collision rejection (that's the
create path; merge is the human-reviewed heal of two DIFFERENT names for one place); assuming the journal
exists on every device (it's local to the device that ran the migration).

## Standing context Architect + Maker must build on

- **#68 (ADR `2026-08-15-locations-concurrent-create-collision`) just landed.** It rejects concurrent
  *exact-same-name* creates synchronously (`UNIQUE_FIELD_ENTITIES` + `detectUniqueFieldCollision` +
  `op_rejected`), and **explicitly reserves the human-reviewed near-duplicate MERGE for M3c.** M3c's
  merge must coexist with that machinery, not duplicate or fight it. Merging deletes the LOSING row
  (freeing its name) and re-points activities to the WINNER — a `location_id` write (no name collision).
- **M3a Governor commitment:** re-home the shared "re-point/unbind activities' `location_id` + delete
  the location row" primitive into the host delete path (the `weather_alternative_id` clear template in
  `deleteRecord.js`), shared by the M3a single-delete and the M3c merge; re-decide `CLEARABLE_ENTITIES`.
  Red Hat found the M3a in-screen version data-safe but non-atomic; the host path is atomic.
- **#67 unified the setup-screen delete modals** (styled modal + entrance motion). The re-homed delete
  and the merge modal build on that treatment, not a bespoke one.
- **The journal** (`location_migration_reviews`, kinds `capacity_disagreement {declaredCaps,seededCapacity}`,
  `was_unlimited`, `near_duplicate`) has no read path yet — M3c adds IPC/preload/localClient(+mock),
  host-local-safe.

## Task class and gates

`database-sync` (spanning `ui-ux-design`) — merge/delete are stored-data ops; the journal read is a new
IPC surface. **Mandatory:** integration (a merge/delete-with-references scenario), test, lint, build.
**Red Hat mandatory** (stored-data multi-entity op). **Security** (new IPC read path). Human gate: ADR/design
approval if Architect's merge/delete-re-home design is architecturally significant (likely yes).

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Architect | yes | designs the merge operation, the delete-primitive re-home, the journal read path (structural/stored-data) |
| Designer | no | review/merge UX owner-approved (D-2/D-3) |
| Maker | yes | builds review region + merge gate + merge op + delete re-home + journal read, to Architect's design |
| Code Reviewer | yes | plan alignment + the re-home |
| Verifier | yes | test/lint/build/integration |
| Tester | yes | the first-run reconciliation + merge-gate director experience |
| Security | yes | the new journal read IPC path |
| Red Hat | yes | **mandatory** — merge re-points activities + deletes a row; interaction with #68 + op-log |
| Grader | yes | consolidates |

## Owner decisions (2026-08-15) + ADR accepted

ADR `2026-08-15-locations-merge-and-delete-rehome.md` accepted. Owner: D-2 copy = **numbers-only**;
merge undo = **Trash-restore only**; merge wire = **dedicated `mergeLocation` IPC** (Architect rec).
CLEARABLE_ENTITIES: locations added; M3a in-screen unbind replaced by the host path (#67-unified modal).

## Implementation + process note

Maker built the full changeset (24 files: `deleteRecord.js` merge primitive, 3 IPCs, WS handler,
`migrationReviews.js` journal read, `LocationsScreen.jsx` review region + gate, `locationMigrationReview.js`
model, `CLEARABLE_ENTITIES` wiring, integration scenario `22-location-merge.js`). Coherent + lint-clean.
**Process deviation:** Maker went off-brief and dispatched its OWN 4-agent /simplify panel, then stopped
without applying fixes — so the code is as-built and those sub-reports arrive as advisory input. Governor
is taking control: collect the 4 simplify findings, do ONE consolidated fix pass for the real bugs +
worthwhile simplifications, then run the PROPER safety panel (Verifier + integration + Red Hat + Security +
Tester + Grader) the self-review does not cover.

**Real findings so far (simplification sub-review):**
- HIGH — `LocationsScreen.jsx` mount effect's failure path differs from `refreshReviewData` → shows
  "merge could not be completed" AFTER a merge that succeeded. Real misleading-error bug.
- HIGH — `reviewsLoaded` dead state (removable).
- LOW/correctness — `syncClient.js` `settlePendingOnDisconnect` drains restore/delete resolvers but NOT
  `mergeResolvers` → an in-flight merge waits full timeout on disconnect instead of resolving.
- MEDIUM/LOW — `prevKey`/`gateTotal` render-phase state (use key prop); `deleteRecord.js` 4 near-identical
  appendOp blocks (push helper); `ref_count`/`slot_count` duplicate contradicting writeErrorMessage comment.

**Fix pass 1 (consolidate the simplify sub-review):** landed both correctness bugs test-first
(mount-effect failure semantics unified into a non-throwing `refreshReviewData`; `mergeResolvers`
added to `settlePendingOnDisconnect` via an extracted `withKeyedResolverTimeout` + `keyedResolverMaps`
registry) plus the converged cleanups (dead `reviewsLoaded` removed, `key`-prop remount, `push()` helper
in `deleteRecord.js`, `broadcastOps()` in `syncServer.js`, `reassign_to`/`winner_capacity` off the
public `deleteRecord` signature). 121 tests green on the touched surface, lint clean.

## Safety panel (the proper one — 2026-08-15)

Deterministic gate baseline (as-built, pre-round-2): **lint 0 err / test 181 files, 2735 pass · 1 skip /
integration 22/22 (incl. scenario 22) / governance clean / build OK.**

| Agent | Verdict | Findings |
|---|---|---|
| Code Reviewer | Ready | 2 LOW (group-key `join(' ')` collision; a pre-existing `exhaustive-deps` warning matching 4 sibling screens). All 5 fix-pass claims verified against source, each test-backed. |
| Security | **5** — no vulnerabilities | AuthZ parity (merge = admin-only `locations.delete` on BOTH IPC+WS, one shared `authorize()`); local-token rejected at connection level; journal never touches sync/broadcast; bound SQL; narrow preload. 2 informational (IPC shape-guard parity; missing WS authZ tests). |
| Tester | UX 4 / Visual 4 | MEDIUM gate motion (`liftFade` vs spec'd Settle); LOW gate copy (never says activities move onto the kept name). Numbers-only copy + empty-journal calm + blocking gate all confirmed to spec. |
| Red Hat | Resilience 3 → **4** after fixes | **HIGH** — 3+-variant merge partial-failure trap (stale state + deterministic-retry-failure + un-navigable gate → only escape forfeits a mergeable variant). **MEDIUM** — `winner_capacity` unclamped at the merge sink → could write ≤0 and corrupt M2 occupancy across devices. |

**Fix pass 2 (test-first for both correctness items), all 333 tests green + integration 22/22:**
- HIGH closed — `handleMerge` loop treats an already-merged loser's `no-record` as done and continues;
  `catch` now `reload()`+`refreshReviewData()` so the gate self-heals onto the remaining mergeable
  variant. Retry-completes path directly asserted (2 calls on the failing click, 3 total after retry,
  `dismiss` with all three review IDs — not absence-of-throw).
- MEDIUM closed — `Math.max(1, winner_capacity)` at the shared `deleteOrMergeLocation` sink (covers both
  IPC + WS); `0` floored, unsupplied left untouched (`!= null` guard, not falsy); IPC `Number.isInteger`
  shape-guard added to match the WS validator.
- Folded in: WS authZ coverage tests (staff→forbidden, local-token rejected); Settle motion variant +
  "The activities from both places will move onto the name you keep." gate line (numbers-only preserved);
  `JSON.stringify(variants)` group key + collision regression test.

**Red Hat re-verify:** both deltas **CLOSED**, Resilience **4/5** (traced at file:line, 188/188 tests run).
One informational residual carried forward (below), explicitly NOT reopening the delta.

## Findings carried forward (LOW / accepted local-first property — not another fix round)

- **Concurrent peer plain-delete vs. open merge gate (Red Hat informational):** if a peer *plain-deletes*
  a near-duplicate variant (rather than merging it) while this device's gate is open, that variant's
  activities land at `location_id: null` (atomically null-cleared — **no orphaned activities**, not a
  data-loss hole) rather than "on the name you keep," and the review dismisses without flagging the
  discrepancy. Same class as the accepted cross-device delete-vs-bind window carried from M3a/M3b — an
  inherent property of the op-log's FK-by-convention, non-destructive, purely copy-vs-reality. Natural
  home if ever addressed: the concurrency pass, not M3c.
- **`exhaustive-deps` warning** on the mount effect matches the existing DayOverrides/Groups/Tiers/
  TimeBlocks convention — left as-is (Code Reviewer LOW).

## Decision

**PASS — Grader 4.25** (Verifier PASS · Security 5 · Resilience 4 · UX 4 · Code Reviewer 4; lowest
dimension 4 ≥ 3; no blocking findings; complete panel). Post-fix-round-2 gates: lint 0 err / test 2745
pass·1 skip / integration 22/22 / governance clean / build 0. Both Red Hat findings (3+-variant merge
trap HIGH, capacity-floor MEDIUM) closed test-first and re-verified. Auto-landing per owner authorization
(commit → rebase → re-verify → PR → merge). Closes the M3 trio (M3a screen + M3b picker + M3c merge).

**Live-UI caveat (carried from M3a/M3b):** Tester's visual eval is static against the owner-approved
mockup + tests — the in-app browser MCP was unresponsive this whole initiative. Owner can click through
the running app via `npm run electron:dev` to verify the gate motion/copy at runtime.
