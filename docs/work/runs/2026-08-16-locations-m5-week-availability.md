---
task: M5 — week-scoped location availability (week_location_exclusions enforcement + UI + lifecycle wiring)
document_type: run
date: 2026-08-16
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-camp-spatial-model-assessment.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-02-schedule-weeks-first-class.md, docs/adr/2026-08-03-multi-week-slices-2-3.md]
related_runs: [docs/work/runs/2026-08-15-locations-m4-import-export.md]
selected_agents: [governor, maker, code-reviewer, verifier, tester, red-hat, security, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new structure. week_location_exclusions table shipped in M1; M5 applies the EXISTING week-exclusion primitive (mirrors week_activity_exclusions/week_group_exclusions end-to-end) + wires the hand-enumerated week-lifecycle surfaces M1 left. No schema change, no new contract, no ADR-significant decision.
  - agent: designer
    reason: not-applicable
    note: the UI is a byte-for-byte mirror of ActivitiesScreen's owner-approved WeekToggle pattern (weekId prop + per-row toggle). No new visual design.
deterministic_checks: [test, lint, build, integration]
human_gates: []
verdict: pass
completion_evidence: [src/engine/weekCatalog.js, src/screens/LocationsScreen.jsx, src/data/scheduleRepository.js, electron/ops/duplicateWeek.js, electron/ops/deleteWeek.js, electron/ops/projections.js, electron/ops/projections.test.js, electron/ops/locationsRegistries.test.js, docs/work/tickets/T82-week-activity-group-exclusions-never-persist.md]
archive_when: M5 merged to main
---

# Run: M5 — week-scoped location availability

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. Owner authorized auto-land of locations slices.
> Q4 (closures = PER-WEEK) already decided in the parent ADR — no open owner question for M5.

## Brief

**Product outcome:** A director can mark a place closed for specific weeks ("the lake is closed weeks 1–2"),
and when they GENERATE that week's schedule, no activity bound to that place is scheduled. The toggle is
the same per-week on/off control activities and groups already have.

**Success predicate:**
1. **Engine honors it (generate route):** `resolveWeekCatalog` (`src/engine/weekCatalog.js`) gains a
   `locationExclusions` param, builds `excludedLocationIds` (rows filtered to `week_id === weekId`), and
   **filters out activities whose `activity.location_id ∈ excludedLocationIds`** (the location→activity
   hop — filtering the `locations` capacity array alone is INSUFFICIENT: an unmapped `location_id` reads
   as unconstrained in `buildSchedule.js:218-232`, so its activities would still place). Anchor
   suppression parity (a `location-excluded` reason mirroring `activity-excluded`/`all-groups-excluded`).
   Threaded through `src/screens/schedule/useGeneration.js` (the only exclusion-honoring call site).
2. **UI:** `LocationsScreen.jsx` gains `weekId`/`weeks`/`onSelectWeek` props, `loadExclusions`,
   `handleToggleExclusion`/`confirmExclusion` (turning OFF counts placed slots + confirms if >0; ON deletes
   immediately), and a per-row `<WeekToggle>` — mirroring `ActivitiesScreen.jsx`. Repo
   (`src/data/scheduleRepository.js`): `loadWeekExclusions` also returns `locationExclusions`; new
   `toggleLocationExclusion`.
3. **The five hand-enumerated surfaces M1 left unwired** (all mirror the activity/group entries exactly):
   - `permissions.js` staff `.delete` grant — add `week_location_exclusions.delete` (else staff can CLOSE
     a location but never REOPEN it, since toggle-off = row delete). + `authorize.test.js` case.
   - `main.js` `SCOPED_LIST_ENTITIES` + mock `MOCK_SCOPE_KEYS` (+ `ipcSurfaceParity.test.js`) — so
     `listByScope` accepts `week_location_exclusions`.
   - ingest `PARENT_SCOPED_DEPENDENTS` (`ingest.js`) + mock `dependentTables` — replace-mode clear.
   - `duplicateWeek.js` + mock — copy `week_location_exclusions` when a week is duplicated (else closures
     are silently lost).
   - `deleteWeek.js` + mock — delete `week_location_exclusions` when a week is deleted (else orphaned rows).
4. **Tests** mirror the existing exclusion tests: `weekCatalog.test.js` (location-excluded → its activities
   filtered), `ScheduleScreenExclusions.test.jsx` (generate: a closed location's activity does not appear;
   persists across rebuild), `scheduleRepository.test.js` (toggle write/delete), `authorize.test.js` (staff
   delete grant), duplicate/delete-week tests, and EXTEND `locationsRegistries.test.js` to cover the five
   surfaces above (they'd pass CI today while unwired — close that blind spot).
5. test/lint/build/integration green.

**What does not count as done:** filtering only the `locations` array in the engine (activities with an
excluded `location_id` would still place — must filter the activities); making the manual drag-drop route
week-aware (out of scope — see inherited limitation); a staff role that can close but not reopen a location;
duplicate-week silently dropping location closures; adding `week_location_exclusions` to a registry without
its verbatim mock/parity twin; a new ADR or schema change (none needed).

## Standing context (from the Explore map, 2026-08-16)

- **The engine is NOT week-aware.** Week-scoping is a pure pre-pass (`weekCatalog.js resolveWeekCatalog`)
  that filters the catalog before `buildSchedule`, and runs ONLY on the generate route
  (`useGeneration.js:68`); `placeAnchors` (`:149`) and the manual route (`useSlotMutations.js`,
  `computeOverlaps.js`) consult NO exclusions. M5 adds location filtering in the pre-pass, same as the
  other two exclusion types — inheriting the generate-only limitation.
- **M1 wired the CENTRAL registries** (PARENT_SCOPED_ENTITIES, PROJECTIONS, permissions.ENTITIES,
  syncServer DOMAIN_PARENT_SCOPED, RESTORE_DECISIONS, MOCK_WRITE_ALLOWLIST, rollback) — sync/CRUD replicate
  automatically. It left the FIVE hand-enumerated week-lifecycle surfaces in §3 above.
- **Schema asymmetry (intentional, M1):** `week_location_exclusions.location_id` has NO FK (the
  activity/group ones do) — deliberate no-FK convention so location-delete/merge can re-point/clear it
  (`deleteRecord.js:40,118`). Do not add an FK.
- **Dual-copy discipline:** every registry has an electron + `src/localClient.mock.js` twin; the week-
  lifecycle handlers (duplicateWeek/deleteWeek) also have mock equivalents. Update both.

## Inherited limitation → separate follow-up

The manual drag-drop route honors NO week exclusions (activity, group, or location) — enforcement is
generate-only. M5 matches this for locations (fixing it for locations alone would be inconsistent). The
cross-cutting gap "manual route should honor week exclusions for all three types" is a SEPARATE follow-up
ticket, spun off, not M5's scope.

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Maker | yes | engine pre-pass + UI mirror + the 5 lifecycle surfaces + tests |
| Code Reviewer | yes | mirror fidelity + the dual-copy/registry parity |
| Verifier | yes | test/lint/build/integration |
| Tester | yes | the director's close-a-place-for-a-week experience |
| Red Hat | yes | engine placement change + sync-entity wiring + week-lifecycle copy/delete correctness (duplicate-week dropping closures is a real data-loss class) |
| Security | yes | the `permissions.js` staff `.delete` grant (authorization change, even if a mirror) |
| Grader | yes | consolidates |
| Architect/Designer | no | see omissions |

## Safety panel (2026-08-16)

Maker built the full changeset (24 files) test-first; 401/401 touched-file tests, lint 0 err, integration
22/22. Gate baseline: **test 2800 pass·1 skip·0 fail / integration 22/22 / build 0** (governance was
index-stale, regenerated → clean).

| Agent | Verdict | Findings |
|---|---|---|
| Code Reviewer | Ready (M5 scope) | Plan-aligned, all 5 lifecycle surfaces faithfully mirrored in both copies, no half-wired pair. `projections.js` `''` fix verified correct + fail-first guarded (via duplicateWeek.test). 3 LOW (deleteWeek stale comment; ExclusionConfirmDialog "places" copy collision; a test-name overstatement) + the HIGH escalation below. |
| Security | **5** | Staff `.delete` grant is a minimal exact mirror; authorize() gates toggle write+delete; listByScope isolation parameterized; no new IPC. |
| Tester | UX 3 / Visual 5 | Visual = pixel mirror of the activity toggle. MEDIUM: "places" copy collision (place=location in this app) + clear-vs-warn behavior clarity. LOW: no generate-only hint (consistent w/ siblings). Copy "Open/Off in {week}" is right. |
| Red Hat | Resilience **3** | **M5's OWN code HOLDS — empirically verified on real better-sqlite3:** location exclusion persists with the REAL location_id (the `''` seed is overwritten by the following field op; week_id always fires first at every call site), degenerate-safe, engine location→activity hop correct, all 5 surfaces + dual-copy parity HOLD. Score capped at 3 ONLY because the review surfaced the shipped sibling bug below. |

## HIGH — pre-existing shipped data-loss bug (NOT M5's; discovered via M5). Owner decision: fix NEXT.

**Both Red Hat and Code Reviewer independently PROVED end-to-end on real SQLite:** `week_activity_exclusions`
and `week_group_exclusions` have NEVER persisted a freshly-created exclusion on real devices. `ensureExists`
seeds `INSERT OR IGNORE (id, week_id)`, omitting the `NOT NULL` `activity_id`/`group_id` → the INSERT is
silently dropped by OR IGNORE → the follow-up field UPDATE hits zero rows. `performWrite` returns `applied`
unconditionally (never checks `.changes`), so the UI shows the toggle checked with false success; both ops
still land in the op-log and replicate. Concrete failure: director closes "Swim" for Week 3, sees it stick,
generates → Swim is scheduled anyway. `duplicateWeek`/`restore` recovery paths are broken by the same root
cause. Live on `main` (f3da7a9) since multi-week Slice 2; invisible because all exclusion persistence tests
use the mock (no constraint enforcement) or seed rows via raw multi-column SQL that bypasses `ensureExists`.
The M5 `''` fix cannot be reused for the siblings — their columns are real FKs to activities/groups.

**Owner decision (2026-08-16): "Land M5 now, fix the bug next."** M5 is correct and independently valuable
(location closures work + verified); it ships now. The sibling repair is the IMMEDIATE next slice — its own
Architect-designed fix (proper NOT-NULL/FK-safe row seeding; likely retiring M5's `''` hack in the same
mechanism fix), full panel incl. Red Hat, plus the real-SQLite exclusion-persistence test coverage that was
missing. Tracked as **T82** (supersedes the Maker's chip task_dfad43e9).

## Consolidated fix round (small, M5-scope only — dispatched 2026-08-16)

FIX 1 ExclusionConfirmDialog "places"→non-colliding term (all three entities). FIX 2 align the clear-vs-warn
copy to the actual (mirror-of-sibling) behavior. FIX 3 deleteWeek stale-comment (steps 1–5→1–6). FIX 4 a
directly-named `projections.test.js` case for the location seeding fix (legible regression guard). FIX 5
test-name fix. NOT patching: the `''` order-dependence orphan (Red Hat proved UNREACHABLE; the T82 mechanism
fix will address seeding robustly) and the generate-only limitation (sibling-consistent; manual-route
follow-up task_b5527645).

## Decision

**PASS — Grader 4.25** (Verifier PASS · Security 5 · Resilience 4 · UX 4 · Code Reviewer 4; lowest dim
4 ≥ 3; no blocking findings). Fix round closed all copy/comment/test-legibility items. Re-verify: unit
2801 pass·0 fail / integration 22/22 (scenario 10 pairing flake confirmed harness-only — clean on re-run)
/ governance clean / build 0. GateReport at
`docs/work/runs/gate-reports/locations-m5-week-availability-r1.json`. Auto-landing per owner authorization.

**T82 — RESOLVED on rebase (convergence).** Between M5's panel and its landing, a concurrent session's
**PR #73** (`314bae3`, merged main `62cfa66`) fixed the shipped sibling bug the principled way: a shared
`ensureWeekJoinRow(table, secondColumn)` in `projections.js` that reconstructs both NOT NULL columns from
the op-log and inserts the complete row once both are known (order-independent, no placeholder), + the
missing real-SQLite tests. On rebasing M5 onto it, **M5 adopted the same helper for
`week_location_exclusions`** — retiring its interim `''` placeholder and the `''`-orphan LOW at once; all
three `week_*_exclusions` tables now share one correct mechanism. T82 marked completed; the owner's
"fix it next" is moot (already fixed). Still open: **task_b5527645** (manual route honors week exclusions —
all 3 types).

**Live-UI caveat (carried from M1–M4):** Tester eval is static against tests + the sibling ActivitiesScreen
pattern — the in-app browser MCP was unresponsive this whole initiative. Owner can `npm run electron:dev`.

## Rebase integration with PR #74 (2026-08-16)

Landing M5 collided with **PR #74** (`944528e`/merge `c16ee92`), the manual-route follow-up spun off as
task_b5527645, which a concurrent session implemented: a soft `WEEK_CLOSED` derived marker on BOTH routes
for week exclusions (`computeWeekClosures.js` + `withWeekClosureFlags` + `ScheduleScreen` chaining). It
covered activity/group and its header comment left a LOCATION arm as "a small, isolated addition" for M5.
(Also: my chained branch-delete closed the interim PR #75 — no work lost, recovered from the local branch.)

Rebased M5 onto #74 and integrated rather than shipping a 2-of-3 asymmetry:
- **Fixed a real auto-merge regression:** the anchors-only `resolveWeekCatalog` call in `useGeneration.js`
  (`placeAnchors`) had silently lost `locationExclusions` — restored.
- **Added the location arm** to `computeWeekClosures`/`withWeekClosureFlags`/`ScheduleScreen` (a hand-placed
  activity on a place closed that week now shows the same soft `WEEK_CLOSED` marker, both routes) + unit
  tests in `computeWeekClosures.test.js`. Route-agnostic per #74's design; never blocks (Art. V).
- **T82 resolved** via #73's `ensureWeekJoinRow`, which M5 adopts for `week_location_exclusions` (both
  conflicts in `projections.js`/`projections.test.js` resolved to the shared helper).

**Red Hat re-verify of the integration: Resilience 4/5, all 4 correctness dimensions HOLD** (generate-route
enforcement intact, the location marker arm correct, soft/never-blocks, route-agnostic wiring; 195 tests
green). Its one NEEDS-FIX — the `placeAnchors` `locationExclusions` line was untested (the exact line
auto-merge dropped) — **CLOSED:** added a fail-first-proven guard test in `useGeneration.test.js` (removing
the line fails it). Two LOW/informational (weekId-filter duplication between resolveWeekCatalog and
computeWeekClosures — no current bug; both-reasons join — correct). Final tree re-verified green on rebase.
