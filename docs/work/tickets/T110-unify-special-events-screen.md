---
title: T110-unify-special-events-screen
document_type: ticket
status: completed
created: 2026-08-29
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-29-unify-special-events-screen.md]
archive_when: DONE — shipped per the owner-corrected (Sprouts) design: the Sprouts Events + Special Days rows are merged into one "Special Events" row backed by a new SpecialEventsScreen.jsx; Plants "Special Schedules" is kept unchanged as the build surface; EventScreen.jsx/SpecialDaysScreen.jsx are deleted; all call sites rewired; green.
---

# T110 — Unify Events, Special Days, and Special Schedules into one screen

Executes `docs/adr/2026-08-29-unify-special-events-screen.md`. Owner-approved
from prototype `proto-special-unified` @ `b7d8ed5` (diff vs `e3daf4c` is the
reference shape for the card grid / add-flow / seed-prompt UI — read it
before starting). This ticket is the exact, current-`main`-grounded rewiring;
do not merge the prototype branch directly, it left dead code and no tests.

Base: `origin/main`. Work test-first — write/update the failing test before
each production change, per this repo's TDD default.

## Step 0 — Confirm premise against current code

Before writing anything, re-run the greps below against your checkout (the
ADR's coupling analysis was verified against `main` @ time of writing; if
`main` has moved, re-verify before trusting either the ADR's file list or
this ticket's step list):

```
grep -rn "onNavigate?\.\?('events'\|onNavigate?\.\?(\"events\"" src/
grep -rn "onNavigate?\.\?('specialdays'\|onNavigate?\.\?(\"specialdays\"" src/
grep -rn "'schedule:special'\|\"schedule:special\"" src/
grep -rln "EventScreen\|SpecialDaysScreen" src/
```

If any hit isn't already accounted for in the step list below, stop and
report to Governor before proceeding — do not silently improvise a fix.

## Steps

1. **Rework `src/screens/SpecialSchedulesScreen.jsx`** into the unified
   screen, using the prototype diff as the reference shape:
   - Add `LABELS.addSpecialDay`/`addEvent`, a `typeDay`/`typeEvent` tag per
     `Card`, and an `AddRow` with the two create buttons.
   - Add `createDay()`/`createEvent()`, calling `special_days`/`name` and
     `events`/`name` writes exactly as `SpecialDaysScreen.jsx` and
     `EventScreen.jsx` do today (copy their validation and
     `describeWriteFailure` messages verbatim — don't invent new copy).
   - Add the special-day seed-from-time-blocks flow: on successful
     `createDay()`, show the seed prompt inline (per the ADR, this stays on
     the wrapper screen, not inside `SpecialDayGridEditor`); "Seed from Time
     Blocks" replays `time_blocks` into `special_day_time_blocks` (copy
     `seedFromCampTimeBlocks` from the prototype diff, including its
     partial-failure messaging).
   - Replace the two grouped `<div style={styles.list}>` sections with one
     `styles.grid` of mixed cards (day cards + event cards), each carrying
     its type tag.
   - Replace the current bespoke empty state with `CalmEmptyState` (already
     merged, `src/components/CalmEmptyState.jsx` — reuse, don't re-derive).
   - Delete the "Go to Roots" empty-state link — the unified screen no
     longer directs a director elsewhere to create things; the add buttons
     are now on this screen.

2. **Delete `src/screens/EventScreen.jsx`**, `src/screens/EventScreen.test.jsx`,
   `src/screens/SpecialDaysScreen.jsx`, `src/screens/SpecialDaysScreen.test.jsx`.
   Before deleting, port forward any assertion not already covered by
   `SpecialSchedulesScreen.test.jsx` (create validation, write-failure
   copy, deleted-elsewhere toast) into that file — see Test impact below.

3. **`src/App.jsx`**:
   - Remove `events: EventScreen` and `specialdays: SpecialDaysScreen` from
     `SCREENS`, and the now-unused `EventScreen`/`SpecialDaysScreen` imports.
   - Remove `eventFocusId`/`setEventFocusId` state, the
     `target !== 'events'` clear guard, and the `initialEventId` prop spread
     — `EventScreen` was its only consumer.
   - Keep `specialScheduleFocus` as-is; it already carries both
     `{ type: 'day', id }` and `{ type: 'event', id }` and remains the sole
     focus-carrier for `schedule:special`.

4. **`src/screens/ScheduleScreen.jsx`** — rewire the one production call
   site found by grep: `openEvent()`'s
   `onNavigate?.('events', { eventId })` becomes
   `onNavigate?.('schedule:special', { buildEventId: eventId })`.

5. **`src/components/layout/navSections.js`**:
   - Delete the `special-events-heading`, `events`, and `specialdays`
     entries from the `sprouts` section's `items` (and their surrounding
     comment blocks, which now describe a superseded decision — replace
     with a short comment pointing at the new ADR).
   - In the `plants` section, relabel the `schedule:special` row:
     `label: 'Special Events'` (was `'Special Schedules'`).
   - Delete `specialdays: 'special_days'` and `events: 'events'` from
     `AREA_TABLE` (dead once the nav rows are gone — see ADR's coupling
     analysis).

6. **`src/components/layout/TopBar.jsx`** — update the `'schedule:special'`
   label mapping from `'Special Schedules'` to `'Special Events'`.

7. **`src/components/reconciliation/rootMapNav.js`**:
   - `CHILD_SCREEN.Events` and `CHILD_SCREEN['Special Days']`: repoint both
     from `'events'`/`'specialdays'` to `'schedule:special'`.
   - `SCREEN_LABEL['schedule:special']`: `'Special Schedules'` →
     `'Special Events'`; delete the now-orphaned `SCREEN_LABEL.events` and
     `SCREEN_LABEL.specialdays` entries.
   - Update the comment above `CHILD_SCREEN` that currently explains Events/
     Special Days point at "their own setup-entity edit screen... not the
     Schedule-side build pickers" — that distinction is exactly what this
     ticket collapses; rewrite it to point at the ADR.

8. **`src/screenKeys.js`** — remove `'events'` and `'specialdays'` from the
   valid-keys list.

## Test impact (enumerate before deleting anything)

- `src/screens/SpecialSchedulesScreen.test.jsx` — extend to cover: the
  mixed grid renders both types with correct tags, `createDay`/`createEvent`
  (success + write-failure-message cases ported from the deleted screens'
  tests), the seed-prompt flow (accept/decline), and that
  `CalmEmptyState`'s message shows with zero rows of either type.
- `src/screens/EventScreen.test.jsx`, `src/screens/SpecialDaysScreen.test.jsx`
  — deleted; confirm every assertion in them has a home in the extended
  `SpecialSchedulesScreen.test.jsx` first (diff the two files' `it(...)`
  blocks against the new test file before deleting).
- `src/components/layout/navSections.test.js` — currently asserts
  `eventsIdx`/`specialDaysIdx` ordering and the `sprouts` items list; update
  for the two rows' removal. `keys` assertion at line ~81 for the `plants`
  section needs no index change (schedule:special stays put), just verify
  its label update doesn't break a text-based lookup elsewhere.
- `src/components/layout/Sidebar.test.jsx` — lines ~160/163 assert
  `onNavigate` called with `'events'`/`'specialdays'` from sidebar clicks;
  these two sidebar rows no longer exist, so these assertions are deleted,
  not updated. Add/keep the equivalent assertion for the single
  `schedule:special` row.
- `src/components/reconciliation/rootMapNav.test.js` — lines ~71/72 assert
  `screenForNode('Scheduling', 'Events')` → `'events'` and `'Special Days'`
  → `'specialdays'`; update both to expect `'schedule:special'`. The
  dangling-target guard test in this file (checked against `App.jsx`
  `SCREENS`) must still pass once `events`/`specialdays` are removed from
  `SCREENS` — this is the guard the ADR's "Consequences" section relies on.
- `src/App.test.jsx` / `screenDestinationsExist.test.js` (or wherever the
  `guardScreensExist`-style check lives) — confirm it fails loudly (not
  silently falls to `TiersScreen`) if any stale `events`/`specialdays`
  reference survives; add one if the pattern is missing for this pair.
- `src/data/scheduleRepository.test.js` and `src/screens/event/EventGridEditor.test.jsx`
  reference the `events` **entity** (table name), not the `events` **nav
  key** — unaffected by this ticket, do not touch.

## Explicit non-goals

- No change to `SpecialDayGridEditor.jsx` or `EventGridEditor.jsx`.
- No change to `special_days`/`events` schema, writes, or delete cascades.
- No change to Electives' separate Sprouts/Plants rows.
- No new abstraction/helper module for the two create flows — inline both
  directly in `SpecialSchedulesScreen.jsx` (see ADR §3's over-abstraction
  note).

## Verification

`npm run verify` must pass. Manually confirm in the dev app (webapp-testing
or `run` skill): Sprouts no longer shows Events/Special Days/the heading;
Plants shows one "Special Events" row; creating a day and an event from the
new screen, seeding a day from time blocks, and clicking a card into its
grid editor all work; a Roots census click on "Events" or "Special Days"
lands on the same unified screen; clicking an event cell's drill-in button
on the campwide schedule grid lands on the unified screen with that event
selected.
