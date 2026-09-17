---
title: "Implementation spec — individual elective scheduling"
document_type: spec
status: draft
created: 2026-09-17
task_class: database-sync
archive_when: all eight slices ship and the behaviour is folded into PLATFORM_STATE, or the ADR is rejected
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T192-elective-governance-gate.md, docs/work/tickets/T193-overlay-reconstruction-and-route-validator.md, docs/work/tickets/T194-participant-data-substrate.md, docs/work/tickets/T195-preference-import-service.md, docs/work/tickets/T196-assignment-engine.md, docs/work/tickets/T197-projection-and-export.md, docs/work/tickets/T198-machine-access-adapters.md, docs/work/tickets/T199-individual-electives-end-to-end.md, docs/work/tickets/T202-camper-record-purge-path.md]
---

# Implementation spec — individual elective scheduling

Elaborates `docs/adr/2026-09-17-individual-elective-scheduling.md`. **Blocked on that ADR's owner
approval** for everything except T193.

## Success predicate

A director selects a week, an explicit route (Manual or Generated), and an age division; imports a
real preference sheet; resolves every ambiguous identity and activity mapping; generates
deterministic assignments; sees capacity and eligibility exceptions; makes and locks manual
changes; finalizes the run; and exports child schedules and activity rosters that reconcile
exactly. Outside elective periods, each child's schedule is the selected group schedule.

**Does not count as done:** a solver unit test alone; a migration verified only on a fresh
database; sync verified only by mocks; any surface where capacity is ambiguous between
"uncapped" and "closed"; a linked multi-period choice that places partially; a Delete control whose
copy does not state the rebuild cost; any staff-reachable read path into the participant entities;
generic `list_entities` returning camper rows.

## 1. Premise audit

The owner brief's claims about this repository, verified by opening each file on
2026-09-17 against branch `claude/shoresh-elective-scheduling-b3bec8`.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | `schema.sql` defines `elective_sets` + `elective_set_activities` | CONFIRMED | `electron/db/schema.sql:985`, `:1016` |
| C2 | `camper_headcount` is a nullable offering cap | CONFIRMED (worse) | `schema.sql:1020` — `INTEGER`, nullable, **no DEFAULT, no CHECK**. Zero DB-level defence |
| C3 | `template_slots.elective_set_id` bridges outer and inner | PARTIAL | True in effect, wrong in location: it is a **v35 migration-added** column, not in the fresh `CREATE TABLE` (`schema.sql:509-531`). Documented drift |
| C4 | `buildSchedule.js` recognizes `electiveSetId`, skips the cell, reserves offering locations | CONFIRMED | `src/engine/buildSchedule.js:289-290`, `:367-373`, `:477`, `:540`, `:316`, `:382-385`; `src/engine/electiveOccupancy.js:15` |
| C5 | `conflicts: []` across cohorts; cross-cohort detection unimplemented | CONFIRMED | `buildSchedule.js:874`, `:27`. **Correction:** a cohort loop *does* exist (`:862-870`) — only detection is missing |
| C6 | `electiveSetPopulate.js` creates only flat set membership | CONFIRMED | `src/ingest/electiveSetPopulate.js:1-4`, `:60` |
| C7 | Exports render the set as one **opaque** cell; JSON `format_version: 1` | PARTIAL | `format_version: 1` CONFIRMED (`src/utils/exportScheduleJson.js:43`). **Not opaque:** members are already enumerated — `src/utils/scheduleCells.js:68-70`, `exportScheduleJson.js:38` |
| C8 | MCP `ENTITY_MAP` excludes elective/camper entities | CONFIRMED | `scripts/mcp/tools.js:31-40` |
| C9 | MCP `schedule_state` filters preplaced slots to `activity_id` | CONFIRMED, **and insufficient** | `scripts/mcp/tools.js:136`. But `electron/ops/scheduleEngineInputs.js:26-53` never assembles `electiveSetActivities` or `events` at all — fixing the filter alone does not restore occupancy |
| C10 | `electiveOccupancy.js`, `eligibility.js`, `computeOverlaps.js` under `src/engine/` | PARTIAL | First two confirmed. `computeOverlaps.js` is at **`src/utils/`** |
| C11 | Every §16 path exists as written | PARTIAL | All exist; three given without a directory — `electron/ops/campScopedEntities.js`, `src/screens/ScheduleElectivesScreen.jsx`, `electron/ops/scheduleEngineInputs.js`. `electron/automerge/campDocument.js` is correct and **CLAUDE.md is the stale one** (it claims `electron/sync/automerge/`) |
| C12 | §5 registration list is complete | **WRONG** | Missing ~12 registries — see ADR §Consequences |
| C13 | — | answer | `CURRENT_SCHEMA_VERSION = 65` (`electron/db/localDb.js:25`); additive migration is **v66**. Guard form is banded (`>= 64 && < 65`, `:2518-2519`), not bare `< N` |
| C14 | No `campers` entity exists | CONFIRMED | No table in `schema.sql`; not in `electron/ops/campScopedEntities.js:15-60` |
| C15 | `template_slots` → group → `tier_id` join is available | CONFIRMED | `schema.sql:441-448` (`tiers`), `:430` (`groups.tier_id`), `:527` (`template_slots.group_id`) |
| C16 | `elective_sets` has a legacy free-text `group_ids` | CONFIRMED | `schema.sql:993`, plus `is_all_groups` `:992`; soft unenforced reference at `electron/ops/undoReferences.js:50` |
| C17 | `schedule_weeks` exists; `schedule_templates.kind` distinguishes routes | CONFIRMED | `schema.sql:721-727`, `:757` |
| C18 | Existing spreadsheet safety limits | CONFIRMED | `src/utils/exportSanitize.js:57-61` — 10 MB / 32 sheets / 20 000 rows; `readWorkbookSafely` `:84` |
| C19 | Export formula sanitization exists | CONFIRMED | `src/utils/exportSanitize.js:14`, `:21`, `:28` |
| C20 | A reusable parser exists; the generic planner should not be reused | CONFIRMED | `src/ingest/sheetGrid.js`, `parseGridSchedule.js:1-12` reusable; `src/ingest/buildPlan.js:1-13` proposes structural setup entities — a different job. Note: **no CSV-specific reader** — CSV/TSV route through the same XLSX read (`sheetGrid.js:183`) |

**Blast radius.** `graphify affected` resolved for `buildSchedule.js` and `PROJECTIONS`;
`camper_headcount` and `electiveSetId` returned no unique node (a SQL column and a local variable
are not indexed) — reported rather than invented. Confirmed dependants of `buildSchedule.js` by
opening each: `scripts/mcp/tools.js:19,139`, `src/screens/schedule/useGeneration.js:1`,
`useScheduleData.js:2,56`, `useSnapshots.js:2,177`, `src/screens/ScheduleScreen.jsx:36`. Two graph
edges were imprecise — `useScheduleData`/`useSnapshots` import `computeFindings`, not
`buildSchedule`.

### Verified after the owner rulings (2026-09-17)

| Claim | Verdict | Evidence |
|---|---|---|
| Multi-block periods already exist and directors create them | **CONFIRMED** | Span = N sibling `template_slots` rows, head + `is_span_head:false` tails (`electron/db/localDb.js:328-330` added the column at v10; `src/screens/schedule/useSlotMutations.js:49-65`). `activities.span_blocks` (`schema.sql:464`) drives engine placement (`buildSchedule.js:463`, `:512-524`). Arbitrary-N, both routes. Director gestures: drag-to-extend (`useSpanExtendDrag.js`), merge-down (`SlotCell.jsx:381-408`), and the activity length field |
| ...and electives can therefore already span | **CONTRADICTED** | Excluded at four layers: `CHAIN_CONTENT_FIELDS = ['activity_id','event_id']` with the comment *"Electives are deliberately excluded: they never span"* (`useSlotMutations.js:20-29`); engine refuses (`buildSchedule.js:475`, `:372`); geometry gates on `activity_id` (`gridGeometry.js:50`); `elective_sets` has one `time_block_id`. **Linked elective choices are a new concept** |
| Exports render spans correctly | **WRONG** | Not span-aware at all — `src/utils/exportSchedule.js:17-27,33-40` resolves each cell independently; a three-block activity exports as three identical rows. T197 inherits this |
| Erasure is impossible in this repo | **WRONG** (prior review corrected) | Projection delete is a real `DELETE` (`electron/ops/projections.js:820-834`); the rebuild path deletes the SQLite file plus `-wal`/`-shm` (`rebuildSupportCommand.js:126-175`); old-genesis documents are refused at the sync boundary (`syncNode.js:147-153`), so an offline peer cannot re-introduce purged data |
| ...so a purge is available today | **PARTIAL** | Two steps do not exist: no op-log prune (zero hits for any delete against `operations`) and no runtime genesis regeneration (`GENESIS_B64` is a source constant at `campDocument.js:254`). Plus `writePreMigrationBackup()` (`electron/db/projectManager.js:151-158`) leaves a full pre-purge copy that nothing deletes. T202 owns all three |
| Export is admin-gated | **NO — implicitly gated** | `src/utils/exportSchedule.js` is a renderer-side utility called from `ScheduleScreen.jsx` with no `authorize()` call; it is gated by who can read the underlying entities. For this feature that yields the right answer by construction (staff hold no read), but it must be stated, not inherited |

**Doc staleness found:** `docs/adr/2026-08-21-arbitrary-length-activity-span.md` and
`docs/work/INDEX.md:144` still read `proposed / not started` while the span feature is plainly
implemented. Anyone reading the docs rather than the code would conclude the opposite of the truth.

### Where the brief is wrong, and what changed because of it

1. **C12 / registration list** — incomplete by roughly a dozen entries. T194's exit condition is
   rewritten to enumerate them.
2. **C9 / MCP overlay fix** — the brief names only the filter. T193 is rescoped to fix
   `scheduleEngineInputs.js` as well; the filter fix alone would ship a still-broken surface.
3. **C3 / column-order trap** — T194 gains an explicit fresh-vs-migrated **column order** check,
   which the brief never names.
4. **C7 / "opaque" cell** — exports already enumerate members. T197 does not need to add that.
5. **C5 / "no cohort loop"** — the loop exists. T193 adds cross-cohort *detection* only.
6. **C10, C11 / paths** — corrected above.
7. **C2** — there is no DB constraint to lean on; capacity correctness rests on the explicit
   "no limit" representation (ADR D3) plus write-time validation.
8. **Linked choices** — the brief's fail-closed v1 is rejected; `elective_choices` +
   `elective_choice_offerings` are modeled up front (ADR D12). T195 and T196 rescoped.

## 2. Entities

Per ADR D4, `elective_assignments` and `elective_preferences` carry **deterministic derived ids**.

| Entity | Fields | Id derivation |
|---|---|---|
| `campers` | `id, camp_id, external_id?, display_name, group_id, is_active` | ordinary |
| `elective_assignment_runs` | `id, camp_id, schedule_week_id, schedule_template_id, tier_id, name, status, source_filename, source_sha256, solver_version, solver_generation` | ordinary |
| `elective_occurrences` | `id, run_id, elective_set_id, day_id, time_block_id, tier_id` | derived from run+set+day+block+tier |
| `elective_choices` | `id, run_id, label, is_linked` | derived from run+label |
| `elective_choice_offerings` | `id, choice_id, occurrence_id, activity_id` | derived from choice+occurrence+activity |
| `elective_preferences` | `id, run_id, camper_id, choice_id, rank` | derived from run+camper+choice |
| `elective_assignments` | `id, run_id, occurrence_id, camper_id, activity_id, choice_id, preference_rank?, source, is_locked, solver_generation` | derived from run+occurrence+camper |

A preference points at a **choice**, not directly at an occurrence+activity (ADR D12). A
single-period choice has exactly one `elective_choice_offerings` member, so there is one code path
for linked and unlinked alike. Assignment expands a chosen choice atomically across every member
occurrence — all or nothing.

Derived rather than stored: child schedule cells outside electives (from `campers.group_id` + the
chosen `template_slots`, except on a finalized run — ADR D6); offering location and eligibility
(from `activities`); capacity (from `elective_set_activities.camper_headcount`); activity rosters
(the inverse projection of assignments — **no second roster table**); counts and satisfaction
summaries.

## 3. Findings vocabulary

`INVALID_CAPACITY` · `NO_ELIGIBLE_CHOICES` · `CAPACITY_SHORTFALL` · `LOCK_CONFLICT` ·
`STALE_OUTER_SCHEDULE` · `OUTER_RESOURCE_CONFLICT` · `UNSUPPORTED_LINKED_CHOICE` ·
`SUPERSEDED_GENERATION` (ADR D5) · `NO_OFFERINGS` and `NO_CAMPERS` (an empty occurrence must be
distinguishable from a solved one — "0 assignments, 0 findings" reads to a director as success).

`INVALID_CAPACITY` fires on negative or non-integer only. `0` is a valid closed offering and `null`
is replaced by an explicit "no limit" mode (ADR D3). `UNSUPPORTED_LINKED_CHOICE` fires only on
genuinely malformed linkage — members referencing occurrences outside the run, or that the camper
is not eligible for — never as a v1 escape hatch (ADR D12).

## 4. Edge cases the brief did not cover

- **Same name, same group.** The brief's resolution table assumes duplicates are distinguishable by
  group. Twins and common names in one bunk are not, ever, and DOB is out of scope. T195 must ship
  an explicit irreducible-ambiguity path — a disambiguation UI showing existing camper ids and
  creation dates — not a block-and-retry loop with no exit.
- **Pre-existing capacity rows.** Rows written under the old semantics get a defined meaning under
  the new two-part representation. T194 surveys and reports; it does not rewrite (ADR D3).
- **Spans are not export-aware.** A multi-block activity exports as repeated identical rows
  (`exportSchedule.js:17-27`). A child schedule that repeats "Swim, Swim, Swim" is wrong output;
  T197 owns it.
- **Partial linked placement.** A linked choice that places in one member occurrence and not
  another is the failure D12 exists to prevent. Atomicity is a test, not a convention.
- **Finalized run whose template rows are deleted.** Resolved by the finalization snapshot
  (ADR D6).
- **Same-session staleness.** Edit the grid, return, Generate. Resolved by always re-deriving
  (ADR D6).

## 5. Slices

| Slice | Ticket | Exit condition |
|---|---|---|
| 0 Governance | T192 | ADR accepted by the owner; permission and capacity decisions recorded |
| 1 Correct seams | T193 | A stored elective/event overlay appears in `schedule_state`; a cross-cohort location conflict fixture fails before and passes after |
| 2 Data substrate | T194 | Fresh and migrated schemas match including column order; two-device sync and projection rebuild retain rows; derived ids make a concurrent duplicate impossible; governance checks pass |
| 3 Import | T195 | A realistic fixture imports with zero guesses; every ambiguous row blocks; preview writes nothing; a linked choice round-trips as one choice |
| 4 Assignment | T196 | Determinism under shuffled input; capacity, eligibility, locks, infeasibility, staleness, and atomic linked-choice placement all covered |
| 5 Projection/export | T197 | Roster and child schedule reconcile exactly to the assignment rows |
| 6 Machine access | T198 | MCP, CLI and UI return equivalent results; mutations gated and attributed |
| 7 End to end | T199 | The acceptance fixture passes with no manual database edits |
| — Purge | T202 | A camper's data is genuinely unrecoverable after the documented procedure, backup file included |

T193 is severable and proceeds independently of slice 0.

## 6. Acceptance fixture

Two age divisions in different cohorts, ≥2 groups each, 3 elective occurrences, 6 offerings, one
location shared with a non-elective group activity. ≥24 campers including duplicate display names
in different groups, one duplicate display name in the *same* group, one missing external id, one
inactive camper. Ranked choices producing first/second/third-choice assignments, one capacity
shortfall, one eligibility rejection, one locked manual assignment. A Manual and a Generated
template that differ. One outer location conflict blocking finalization.

Passes when: ambiguous rows block until resolved; two runs over identical input produce
byte-equivalent normalized output; no offering exceeds capacity; no camper violates eligibility;
every lock is retained; a child's non-elective cells equal the selected group template; every
assignment appears exactly once in the matching roster and roster counts equal summary counts;
the linked choice places in both member occurrences or neither; changing the template marks the run
stale and prevents finalization; the finalized run survives
sync to a second device and a projection rebuild; JSON, XLSX, UI, CLI and MCP agree.
