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

1. **Schema + registration (schema first).** Pick the schema version at start (expected v91; re-check main).
   `special_day_placements` DDL in electron/db/schema.sql + `SPECIAL_DAY_PLACEMENTS_DDL` constant + migration
   (guard `>= 90 && < 91`) + `v91_down.js` + `deriveSpecialDayPlacementId` (opaque/join convention) +
   registration in projections.js, campScopedEntities.js (parent schedule_weeks/week_id), campDocument.js,
   projector.js, permissions.js, localClient.mock.js, recordLabels. Test first: byte-identical DDL,
   migration + rollback, PROJECTIONS-vs-MODELED_ENTITIES parity, and the **two-document concurrent-create
   test of the same derived id** (ADR D5; its result may change the id strategy before anything else is
   built). Run `npm run schema:check` and bump doc-fact markers (version, entity count).
2. **Write path + cascades + undo.** `bindSpecialDay`/`unbindSpecialDay` handlers through `authorize()`,
   preload + localClient, camp-scope refusal, replace-on-occupied; cascades in deleteWeek, deleteSpecialDay,
   duplicateWeek; undoReferences + restore (Trash restore of an unbound placement). Contract tests per
   ADR D9 (idempotent retry, foreign-camp refusal, unknown-outcome re-read, surfaced failure).
3. **Resolution + engine skip.** Pure `resolveDayReplacements`; extend `resolveWeekCatalog` to take
   placements/days and return effective `days` + `replacedDayIds`; thread through generate(),
   placeFixedEvents(), computeFindings(), recalcFindings(), restoreSnapshot(); generate() carries forward
   stored rows of replaced days in its bulk replace. Tests: nothing generated on a replaced day, findings
   and goals judged on effective days, orphan placement ignored, regenerate-then-unbind restores the day.
4. **Render both routes.** Designer pass first (DESIGN_STANDARD sections 5 and 8; reduced-motion
   equivalent; inline label not banner). Apply replacements in the ScheduleScreen slots pipe before
   `withWeekClosureFlags`/`withOverlapFlags`; read-only replaced lane in group and day views with an edit
   link; unresolved-conflict marker. Visual evidence required (distinguishing frame, both routes).
5. **Binding UI.** Week + weekday picker on the special day editor, list of its placements with unbind,
   occupied-slot replace confirmation, per-week indicator of which days are replaced. Every write failure
   surfaced.
6. **Exports.** exportToExcel, exportScheduleJson, exportWorkbook print the special day grid and notes;
   round-trip tests.
7. **Docs.** WHERE_DATA_LIVES, PLATFORM_STATE, CLAUDE.md pointers; mark the amended ADRs; flip this ticket.

Independent reviewers per slice: Red Hat on 1, 2 and 3 (stored shape, sync, cascades); Security on 2
(IPC + authorize); Tester on 4 and 5.
