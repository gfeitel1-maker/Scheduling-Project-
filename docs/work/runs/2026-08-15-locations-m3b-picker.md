---
task: M3b — activities location picker + D5 UI freeze + locationFull re-key
document_type: run
date: 2026-08-15
round: 2
status: pass
task_class: ui-ux-design
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/adr/2026-08-15-camp-locations-entity.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
related_runs: [docs/work/runs/2026-08-15-locations-m3-design.md, docs/work/runs/2026-08-15-locations-m3a-setup-screen.md]
selected_agents: [governor, maker, code-reviewer, verifier, tester, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: no new structure; entity/engine/screen shipped. Picker + freeze + flag re-key are behavior over existing state
  - agent: designer
    reason: not-applicable
    note: picker specified + owner-approved in docs/work/specs/2026-08-15-m3-locations-design.md §picker
  - agent: security
    reason: not-applicable
    note: no auth/protocol/IPC change; picker uses existing list/write seams
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence: [src/screens/ActivitiesScreen.jsx, src/screens/ActivitiesScreen.test.jsx, src/screens/schedule/useSlotMutations.js, src/screens/schedule/useSlotMutations.test.js, electron/ops/projectionsCoverage.test.js]
archive_when: M3b merged to main
---

# Run: M3b — activities location picker + D5 UI freeze + locationFull re-key

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. Owner authorized auto-land of M3 slices.

## Brief

**Product outcome:** A director sets an activity's place by picking from their locations — or creating a
new place inline without leaving the activity. Free-text location typing is gone; the activity now binds
to a real place (`location_id`), which is what the engine's capacity logic (M2) consumes. Every activity
a director touches from here on has a real place link.

**Success predicate:** `ActivitiesScreen`'s free-text `location` `<input>` is replaced by the approved
picker (typeahead over existing locations + create-new inline) that writes `location_id`; the UI no
longer writes the free-text `activities.location` string (D5 UI freeze) and a test asserts it for the UI
paths; `useSlotMutations.js` `locationFull` is re-keyed by `location_id` (was activity-keyed/place-blind)
and its `max_groups_per_slot` `!= null` vs `> 0` sentinel aligned with the engine; test/lint/build green;
Tester confirms the picker feels effortless.

**What does not count as done:** the migration review region or merge gate (M3c); routing INGEST to
`location_id` (M4 — ingest still writes free-text `location` on import, so the D5 no-write test is scoped
to UI/non-ingest paths this slice, ingest deferred to M4); making locations required; a picker that can't
create a place inline (contextual creation is core).

## Scope (from the approved design spec §picker + carried items)

1. **The picker** (`src/screens/ActivitiesScreen.jsx`, replacing the free-text `location` input ~line 123):
   typeahead over the camp's `locations`; selecting binds `location_id`; typing a name that doesn't exist
   offers "Create '<name>' as a new place" inline (creates a `locations` row + binds it — contextual
   creation, director never leaves the activity). Blank = no place (valid). Match the mockup's picker
   states (typeahead, create-new row, selected/cleared). The CSV/XLSX activity template import/parse in
   ActivitiesScreen (~line 533/576) must resolve a location NAME to a row (or create it) rather than
   writing free-text — or, if that's M4 territory, keep it writing `location` and note it (see D5 below).
2. **D5 UI freeze:** the picker writes `location_id`, NOT `activities.location`. Add a test asserting no
   **UI** code path writes `activities.location` after the picker lands. **Ingest is explicitly out of
   scope** (it still writes free-text `location` on import; M4 routes it to `location_id`) — scope the
   test to exclude the ingest path and note the deferral, do not weaken it to meaninglessness.
3. **`locationFull` re-key** (`src/screens/schedule/useSlotMutations.js:419-433`): re-key by `location_id`
   → `locations.capacity` (was per-`activity_id`, place-blind) so manual placement on the generated route
   flags an over-capacity place; align the `max_groups_per_slot` sentinel to `> 0` (matches the engine and
   `computeOverlaps`), fixing the `=== 0` spurious-UNFILLABLE case (M2/M3a Red Hat carried). This closes
   the generated-route drag-into-over-capacity-place blind spot M2 handed forward.

## Agents

| Agent | Selected | Why |
|---|---|---|
| Governor | yes | routing |
| Maker | yes | picker + freeze + locationFull re-key |
| Code Reviewer | yes | spec fidelity + the freeze/re-key |
| Verifier | yes | test/lint/build |
| Tester | yes | picker director-experience (the surface most directors touch) |
| Red Hat | yes | the D5 write-path change + `locationFull` re-key alter schedule-flag + write behavior |
| Grader | yes | consolidates |
| Architect/Designer/Security | no | see omissions |

## Round 1 review

- **Code Reviewer:** picker spec fidelity high, D5 freeze thorough + correctly scoped, CSV-importer conversion is a valid in-scope completion (not M4 territory). Blockers in the `locationFull` re-key semantics: (1) replace-in-place self-count false positive; (2) generated-route silently lost the per-activity over-book warning (ADR D2 wants BOTH caps; owner kept the warning at M2); (3) `popFade` inert; (4) misleading capacity-0 comment.
- **Red Hat: 4/5, one needs-fix.** Cleared the two suspicions: case-insensitive create-dedupe is a benign improvement (prevents new splits, no corruption); inline-create id is safe (fresh UUID, op-logged, no migration-id collision). Needs-fix: `ScheduleActivityView.jsx:42,74` still read free-text `act.location` → picker-bound activities show no place there. Accept-with-followup: concurrent same-name create → `UNIQUE(camp_id,name)` collision + swallowed non-FK projection failure → silent divergence (locations-wide); manual-route `computeOverlaps` still treats dangling `location_id` as capacity-1 (disagrees with engine + re-keyed `locationFull`).
- **Tester: UX 4/5, Visual Fidelity 5/5.** Happy path effortless, near-pixel-faithful. MEDIUM: inline-create silently imposes capacity-1 with no in-place fix. LOW-MEDIUM: mockup's "blank is fine" reassurance missing from UI. LOW: long-name overflow.

## Round 2 (fixes dispatched)

A (regressions): A1 ScheduleActivityView display; A2 `locationFull` self-count exclude target group; **A3 restore the activity-cap arm so the generated-route UNFILLABLE = place-full OR activity-cap-full** (ADR D2 + owner M2 keep-the-warning). B: B1 align `computeOverlaps` dangling→unconstrained (all three place-cap consumers now agree); B2 correct the capacity-0 comment. C (picker polish): C1 fix inert `popFade`; C2 inline-create in-place capacity affordance; C3 "Location (optional)" / blank-is-fine; C4 long-name overflow + maxlength; C5 surface a dangling `location_id` on modal open (don't silently persist it).

## Findings carried forward

- **Spun off (task_4cfb8ade, Architect→loop, Red Hat mandatory):** concurrent same-name locations create collides on `UNIQUE(camp_id,name)`; `syncClient.js` swallows the non-FK projection failure → silent cross-device divergence. Locations-entity-wide (M3a + M3b create paths); interacts with M3c's near-duplicate merge. Also review the too-broad swallow of non-FK projection failures.
- The migration's case-sensitive split ("Pool"/"pool" two rows) is a data artifact for **M3c**'s near-duplicate merge to reconcile; the picker's case-insensitive create only prevents NEW splits.
- `locationFull` counts slots vs the engine/`computeOverlaps` distinct-groups (LOW, unreachable in normal data) — align opportunistically if trivial in the A2/A3 fix, else follow-up.

## Round 2 re-review (fixes verified — all favorable)

- **Red Hat: Resilience 5/5.** Every delta HOLDS under adversarial probing (verified in each source, not from comments): A2 self-count excluded on both arms; A3 `placeFull || activityFull` correct with `>0` sentinel; B1 all three place-cap consumers (engine/`locationFull`/`computeOverlaps`) provably agree dangling→unconstrained while the activity-cap arm still fires; C5 clears a dangling id without clearing a valid one or the untouched legacy field. Engine byte-untouched; 209 tests across the surface. Two LOW interim observations (legacy-location resurface on a migrated activity = M4 territory; slots-vs-distinct-groups count asymmetry, unreachable under the one-slot-per-group invariant).
- **Code Reviewer: ready to commit.** All four findings fixed cleanly; two-arm `locationFull` + extracted popover cleaner than what they replaced; no CRITICAL/HIGH/MEDIUM. LOW follow-ups below.
- **Tester: UX 5/5, Visual 5/5.** All three round-1 findings genuinely resolved; inline-create stepper (reused `CapacityStepper`) thoughtfully separated from the fixed-capacity hint. One LOW residual (long just-created name can crowd the narrow modal column).

## Findings carried forward (LOW — none blocking; not another fix round)

- Table shows `—` for an activity with null `location_id` but a legacy `location` string, while the schedule view falls back to the legacy string — display parity gap (Code Reviewer LOW; one-line table fallback if desired).
- `CapacityStepper` is imported screen→screen (`ActivitiesScreen` from `LocationsScreen`); a shared `src/components/` home is cleaner now that two screens use it (Code Reviewer LOW).
- Template-import loop can orphan a just-created place if the activity write throws (best-effort, trivial; Code Reviewer LOW).
- Legacy free-text `location` resurfaces in the card while the modal shows blank, for a migrated-untouched activity — an M1→M4 interim state (Red Hat LOW; M4 owns legacy-string cleanup).
- `locationFull` counts slots vs `computeOverlaps` distinct groups — latent, equal under the one-slot-per-group invariant (Red Hat LOW).

## Round 3 (deterministic-gate fix)

The static `projectionsCoverage` scanner failed (2 tests) — it mis-attributed the picker's new
cross-entity write (`ActivitiesScreen` now writes the `locations` entity via the inline `CapacityStepper`
and inline-create) to `activities`, demanding `capacity` be a registered activities field. **The runtime
was correct** (`capacity` writes to `locations`, where it is registered). Fixed by teaching the scanner
per-call-site entity resolution (an arity guard so the local 2-arg `writeFields` wrapper stops claiming
3-arg `repository.writeFields('locations', …)` calls) — **floor proven intact via a bogus-field probe**
(`locations.bogusField` still fails correctly). Not a floor-lowering; `capacity` NOT added to activities.

## Verifier verdict

**PASS.** All four gate figures confirmed (lint 0 / test 2616 passed·0 failed / build 0 / governance clean).
D5 UI freeze holds (sole `location:` occurrence is the M4-deferred XLSX import column read; `useSlotMutations`
zero). `locationFull` two-arm green. `projectionsCoverage` 20/20, floor intact (`capacity` not on activities,
`location_id` present). Engine `buildSchedule.js` diff empty. Integration legitimately not required.

## Grader score

**PASS — 5.0** (spec-fidelity 5, maintainability 5, resilience 5, UX/visual-fidelity 5, test-quality 5).
All findings fixed + re-verified; scanner fix taught-not-lowered; LOWs carried as follow-ups; concurrent-create
sync risk spun off (task_4cfb8ade). Visual-fidelity caveat: static eval (browser MCP unresponsive).

## Decision

**PASS.** M3b complete: the contextual picker replaces free-text (typeahead + create-inline), the UI freeze
of `activities.location` is done, and `locationFull` now flags both place AND per-activity over-capacity on
the generated route (closing M2's carried blind spot). Auto-landing per owner authorization
(commit → rebase → re-verify → PR → merge).
