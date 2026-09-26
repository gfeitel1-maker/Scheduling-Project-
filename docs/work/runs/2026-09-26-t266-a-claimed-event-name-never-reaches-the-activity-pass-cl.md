---
task: T266: a claimed event name never reaches the activity pass — closes T266
document_type: run
date: 2026-09-26
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
related_tickets: [docs/work/tickets/T266-ingest-pass-exclusivity.md, docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md]
related_specs: []
related_adrs: [docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
selected_agents: [governor, maker, code-reviewer, red-hat, security, verifier, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: the design question this work turns on was already settled by docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md, which this PR flips to accepted; no new contract or data shape was designed here beyond the single additive column that ADR's Option A already specifies.
  - agent: designer
    reason: not-applicable
    note: no visual or interaction design. The UI change is subtractive — six existing menus stop listing rows they should never have listed — and introduces no new surface, copy or motion.
  - agent: tester
    reason: human-waived
    note: the owner's brief scoped the loop to "Maker, Code Reviewer, Red Hat, Security, Verifier, Grader" and did not include Tester. The director-facing behaviour is also not observable without a real imported camp under Electron, which the acceptance test reaches more directly than a UI walkthrough would.
deterministic_checks: [npm run verify, npm run check:governance]
human_gates:
  - owner approved schema v75 before allocation (initially v76; corrected after the no-gaps gate)
  - owner ruled ADR Option A accepted, 2026-09-26
  - owner ruled ADR OQ2: a pinned event's row is hidden from the catalogue entirely
verdict: pass
completion_evidence:
  - commit 55c2257a
  - acceptance test electron/ingestPassExclusivity.integration.test.js, 11 tests, through the real ingest path
  - gate: see "Evidence" below
archive_when: T266's own archive_when holds — the four predicate clauses are discharged by electron/ingestPassExclusivity.integration.test.js running green in CI
---

# T266 — a claimed event name never reaches the activity pass

## What shipped

`activities.catalog_role` (schema v75; NULL = an ordinary free choice,
`'pinned_event'` = claimed by ingest pass 1 or 2), written by `src/ingest/buildPlan.js`
on both the create arm and the recognized-update arm, and honoured through one
shared predicate — `src/engine/freeChoiceActivities.js` — at every free-choice
reader.

The row is **not** deleted. That is the decision the whole change rests on: an
anchor resolves its activity by NAME (`src/engine/anchorActivityLink.js`, no
`activity_id` column), so removing the row removes the only handle the
don't-schedule-twice suppression has, and the engine then places the event a
second time with no error, no finding and no red test. A marker, not a hole.

## Why a previous ticket closed against this and the symptom survived

T234 (completed 2026-09-23) correctly widened *which* names reach the guard. It
did not change what the guard does, and what the guard did was DEMOTE
(`tier: 'low'`) rather than EXCLUDE. A demoted name becomes a reconciliation
card, and `src/screens/reconciliationResolutions.js` removes a name from
`approved` only when the card is UNRESOLVED — so the director's act of diligence,
answering "yes, that looks right", was what wrote the duplicate.

## Evidence

- commit 55c2257a (this record amended onto it).
- Acceptance test `electron/ingestPassExclusivity.integration.test.js` — 11
  tests, green. Runs the REAL path end to end: sample spreadsheet →
  `parseTextGrid` → `extractEntities` → `inferFixedEvents` →
  `derivePinOnlyActivityNames` → `commitIngest` → better-sqlite3 → rows read back
  → `buildSchedule`. Nothing between the file on disk and the assertion is
  constructed by the test.
- Non-vacuity, four ways:
  1. In-test, the expected defect: clearing `catalog_role` puts the claimed name
     back on the grid as a free activity (red), restoring it removes it (green).
  2. In-test, **the defect the guard's description does not point at**: a HOLE
     (deleting the pinned activity rows) satisfies clause 1 perfectly while
     `resolveAnchorActivityIds` silently returns `[]` — clause 3 broken, nothing
     thrown.
  3. Source-level: removing the `emitCreate` marker write turns clause 1 and the
     non-vacuity test red.
  4. Source-level: removing the engine's free-choice filter (all three sites)
     turns the non-vacuity test red.
- A measured near-miss worth recording, because it would have made clause 2
  vacuous: straight out of ingest every activity has a NULL priority and the
  engine places nothing at all. A control run with every marker wiped ALSO placed
  nothing — so "the event was not placed twice" was true of a broken
  implementation. The test now gives every activity a priority, which is what a
  director does next anyway, and only then is the assertion load-bearing.
- A second measured near-miss: the first non-vacuity attempt used a name anchored
  for every group on every day, which the pre-existing per-(group, day)
  suppression already protects — so clearing the marker changed nothing
  observable. The proof now uses a recurring event that covers only some days,
  which is where the gap actually is and is the owner's actual symptom.
- `npm run check:governance`, run locally after `git fetch origin` (CI's shallow
  clone SKIPS status-drift and platform-state-stale, so a green CI has not
  checked those): **0 findings**.
- `npm run verify` (all eight steps, exit code captured to a file, never piped to
  `tail`): verdict line quoted in the PR body.

## Agents

Ran: governor (this loop), maker (implementation carried out in-loop),
code-reviewer, red-hat, security, verifier, grader. Omissions and their reasons
are in the frontmatter above; the Tester omission is the owner's own scoping
decision, quoted there, not an agent's judgement call.

## What review changed

Round 1 reviewers found three real defects, all fixed before this record was
finalised:

- **Code Reviewer, HIGH** — `ActivitiesScreen` filtered at the LOAD, which hid
  pinned-event rows from that screen's own CSV importer dedupe (`existingNames`)
  and from `actMap`. The importer would then have created a SECOND row bearing a
  name an anchor already resolves by: two rows for one real thing, the exact
  corruption class this ticket exists to close, reached through a different door.
  Filtering moved to the readers that are genuinely free-choice menus.
- **Red Hat, MEDIUM-HIGH** — the marker was never cleared, making a
  misclassification a one-way door with no UI behind it. The marker is now
  symmetric, and the clear is guarded on detection having actually run: every
  caller except ImportScreen supplies an empty claimed set via
  `pinOnlyActivityNames ?? []`, so an unguarded clear would have let one MCP or
  workbook re-import un-mark a camp's entire event catalogue. Both directions are
  tested through the real path, and removing the guard at source turns the
  SET-THEN-PARTIAL test red.
- **Red Hat, HIGH** — 23 sibling migration tests still asserted
  `CURRENT_SCHEMA_VERSION).toBe(74)`. The gate was genuinely red on this. All 23
  bumped to 76.

Security returned no vulnerabilities (score 5).

## Two corrections made after CI, both recorded rather than quietly fixed

- **v76 -> v75.** Allocating 76 while 75 did not exist on main left a hole, and
  `migrationDomainState.test.js` ("covers 1..CURRENT_SCHEMA_VERSION with no
  gaps") caught it. Scanning worktrees prevents two branches claiming one number;
  it does not license skipping one. T266 takes v75 because it merges first.
- **Two-wide guard -> one-wide.** The guard was briefly `>= 74 && < 76`. Every
  block from v49 onward is `>= N-1 && < N`, and the hazard the convention exists
  for (bug #194, localDb.js:1975-1979) is a bare `< N` with no LOWER bound — the
  remedy was adding `>= N-1`, not widening the top. A `< N+1` bound re-fires a
  migration on a database already at N, which is not harmless for the blocks here
  that do full table rebuilds. The wrong rationale was deleted from the file
  rather than left for the next reader.
- **A third thing the gate surfaced, read rather than silenced.**
  `migrationWriteTrace.test.js` flagged `v73 activities.catalog_role`. It is not a
  harness artifact: a genuine fresh install replays the whole chain, so schema.sql
  creates the column, v73's table rebuild (whose column list predates it) drops
  it, and v75 re-adds it. End state is provably identical (the fresh-vs-migrated
  column parity test passes), no row value changes, and no reachable database can
  lose data — but it is a STANDING property, not a one-off: the v73 rebuild will
  transiently drop every column added to `activities` after it, and that is only
  safe while the adding migration is numbered above 73. Acknowledged with that
  reasoning in `ACKNOWLEDGED_UNKNOWNS`.

## Sync behaviour, ruled in scope and built

Owner ruling 2026-09-26 reversed an earlier plan to defer this. A disagreement
about `catalog_role` raises a conflict for a human, because an activity's
category is a fact about the camp rather than an opinion a device holds — so two
devices can never legitimately differ, the path essentially never fires, and when
it does it is evidence one device ingested something wrong.

Read rather than assumed: the field RAISES, **by inheritance**.
`PROJECTIONS[entity].fields` is the single gate for both syncing and
conflict-raising (`applyWrite`, campDocument.js:569), and `reconcile`
(reconcile.js:75-107) walks every key with `A.getConflicts` and has no field
allowlist or denylist. Registering the column for materialization enrolled it in
conflict detection. No mechanism was added to make that look deliberate; the
evidence was what was missing — `electron/catalogRoleConflict.test.js`, six tests
over really-merged divergent documents, asserting the `conflicts` ROW.
De-registering `catalog_role` at source turns four of them red. One human-facing
addition: a real `FIELD_LABELS` entry in `src/screens/ConflictsScreen.jsx`.

## Known limit, stated rather than softened

- ImportScreen's React layer is not exercised. Its derivation is covered (the
  extracted `src/ingest/pinOnlyActivityNames.js`, called from the same
  `inferFixedEvents` output); the component is not mounted. The path is not tested
  end to end through the UI.

## What is deliberately NOT in this change

- ADR Option A's `activity_id` identity half. Keeping the catalog row is exactly
  what makes it unnecessary here — name resolution keeps working because the row
  it resolves to keeps existing. It becomes required the moment anything DOES
  delete or merge a catalog row.
- Group eligibility. The drag palette does not filter by it and the inline
  typeahead does; the owner ruled on 2026-09-26 that this asymmetry is intended,
  so the new predicate answers only the free-choice question and changes that
  behaviour in neither direction.
