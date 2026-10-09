---
ticket: T350
document_type: ticket
title: Bind a special day to a (week, day) and replace that day's schedule on both routes
status: open
created: 2026-10-09
archive_when: "a director can place a special day on a week and weekday, both Generated and Manual views and every export show it in place of that day, the engine generates nothing on it, a clash between devices is a conflicts row, and unbinding restores the original day; full gate green"
task_class: database-sync
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-09-special-day-binds-to-a-week-day.md, docs/governance/standards/DESIGN_STANDARD.md]
related_prs: []
related_tickets: [docs/work/tickets/T145-remove-day-overrides.md, docs/work/tickets/T106-special-day-author-ui.md]
---

# T350 - Special day binds to a (week, day)

Owner ruling 2026-10-09 (audit #31): "a special day gets a date/day picker and replaces that day's
schedule in the week." Design and decisions are in
docs/adr/2026-10-09-special-day-binds-to-a-week-day.md; this ticket only slices it.

## Success predicate

A director opens a special day, picks a week and a weekday, and from then on that week's Generated and
Manual views and all exports show the special day's grid and notes in place of that day. Generating
produces nothing on the day. Unbinding brings the previous day back exactly. Two devices binding different
special days to the same day produce a conflict a person resolves.

## Non-goals

Calendar dates; half-day or block-level takeover (that is an Event); per-cell people or rosters; any
designation of a canonical route; changing buildSchedule itself.

## Slices (one PR each, in order; each leaves main green)

Amended 2026-10-09 after Red Hat's accuracy review; see the ADR's revision note and D3-D11.

1. **Schema + registration (schema first).** Schema version N is NOT v91 (claimed by #772/T311 and
   #762/T348): take the next free number after #772 merges, likely v92, re-check #762 and every local
   worktree, run `npm run schema:check` on rebase. DDL in electron/db/schema.sql + `SPECIAL_DAY_PLACEMENTS_DDL`
   constant + migration (guard `>= N-1 && < N`) + `vN_down.js` + `deriveSpecialDayPlacementId`
   (opaque/join convention; `special_day_id` is a **soft** reference). Registration per ADR D10 (projections,
   campScopedEntities, campDocument, projector, permissions, localClient.mock, undoReferences, restore
   refusal, SCOPED_LIST_ENTITIES, PARENT_SCOPED_DEPENDENTS, recordLabels; mergeActivity checked and
   unchanged). **Genesis:** add to `GENESIS_ENTITIES`, regenerate `GENESIS_B64` (the fifteenth), update the
   pinned head test; consequence: every paired device re-pairs (pre-production, acceptable, stated in the PR
   body). Tests first: byte-identical DDL, migration + rollback, parity, and the two-document tests of ADR D5
   (unbind-vs-rebind add-wins convergence; partial row projects nothing and records no failure; clash
   becomes a `conflicts` row). Doc-fact markers (version, entity count).
2. **Write path + cascades.** `bindSpecialDay`/`unbindSpecialDay` through `authorize()`; bind writes all
   three fields in one `runAtomic`; replace-on-occupied; foreign-camp refusal; scheduleRepository loader;
   cascades in deleteWeek, deleteSpecialDay, ingest teardown; `duplicateWeek` copies placements with the
   **derived** id of the new week. Contract tests per ADR D9 (idempotent retry, unknown-outcome re-read,
   surfaced failure). Restore is refused (ADR D8); test the refusal.
3. **Engine entries.** `src/engine/effectiveDays.js` (`resolveEffectiveDays`, `dropReplacedPreplaced`);
   `buildSchedule` and `computeFindings` accept `replacedDayIds` and apply it at entry for **every** loop.
   Wire all eight entries in the ADR D4 table incl. scripts/mcp/tools.js and
   electron/ops/scheduleEngineInputs.js, pinned by `engineEntryReplacedDays.test.js`. **Failing tests first:**
   a locked activity on a replaced day is not placed or counted; `prefer_before_day` on a replaced day yields
   an explicit DISTRIBUTION finding (not silence); UNDERSERVED/DISTRIBUTION use effective days;
   `computeFindings` replaces days with no `fixedEvents`/`weekId` (the manual route); `recalcStats` and
   `recalcFindings` require `replacedDayIds` (guard test on one-argument calls); `generate()` carries forward
   replaced-day rows through the restoreSnapshot dead-reference guard; regenerate-then-unbind restores the
   day; every-day-replaced week generates nothing and does not throw.
4. **Render both routes.** Designer pass first (DESIGN_STANDARD sections 5 and 8; reduced-motion
   equivalent; inline label not banner). Apply replacements in the ScheduleScreen slots pipe before
   `withWeekClosureFlags`/`withOverlapFlags`; read-only replaced lane in group and day views with an edit
   link; empty-lane state for a special day with no blocks; unresolved-conflict marker. Visual evidence
   required (distinguishing frame, both routes).
5. **Binding UI.** Week + weekday picker on the special day editor, list of its placements with unbind,
   occupied-slot replace prompt that names its undo (ADR D11), per-week indicator of replaced days. Every
   write failure surfaced.
6. **Exports.** `exportToExcel` (exportSchedule.js) and `buildScheduleExport` (exportScheduleJson.js) print
   the special day grid and notes, with round-trip tests; `buildCampDataWorkbook` gains a read-only
   "Placed on" column. `exportWorkbook` is deliberately unchanged (ADR D7).
7. **Docs.** WHERE_DATA_LIVES, PLATFORM_STATE, CLAUDE.md pointers; mark the amended ADRs; flip this ticket.

Independent reviewers per slice: Red Hat on 1, 2 and 3 (stored shape, sync, genesis, cascades); Security on
2 (IPC + authorize); Tester on 4 and 5.
