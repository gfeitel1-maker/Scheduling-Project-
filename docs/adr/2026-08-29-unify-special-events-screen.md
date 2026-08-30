---
title: "Unify Events, Special Days, and Special Schedules into one Special Events screen"
document_type: adr
authority: normative
status: accepted
date: 2026-08-29
supersedes: []
amends:
  - docs/adr/2026-08-23-override-family-model.md (§6c — the "quiet Sprouts heading, not a nav merge" resolution)
# NOTE: 2026-08-20-special-days-authoring-and-day-override-repoint.md (D1/D3b)
# is PRESERVED, not amended — the corrected (Sprouts) placement keeps its
# authoring-in-Sprouts / grid-in-Plants stage split intact.
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related:
  - docs/work/specs/2026-08-23-schedule-build-ia.md
  - docs/adr/2026-08-22-events-overlay-placement.md
  - docs/adr/2026-08-28-fixed-vs-recurring-events.md
  - docs/adr/2026-08-28-stage-aware-nav-landing.md
  - docs/work/specs/2026-08-28-lifecycle-ia-program.md (§9)
  - docs/work/tickets/T110-unify-special-events-screen.md
implementation_state: implemented
affects:
  - src/screens/SpecialEventsScreen.jsx
  - src/components/CalmEmptyState.jsx
  - src/App.jsx
  - src/screenKeys.js
  - src/components/layout/navSections.js
  - src/components/layout/TopBar.jsx
  - src/components/reconciliation/rootMapNav.js
  - src/screens/ScheduleScreen.jsx
# EventScreen.jsx and SpecialDaysScreen.jsx were DELETED by this change (their
# create + EventDetail logic now lives in SpecialEventsScreen.jsx); they are
# not listed under `affects` because the path-existence check requires live
# files. SpecialSchedulesScreen.jsx (Plants build surface) is intentionally
# UNCHANGED.
---

# Unify Events, Special Days, and Special Schedules into one Special Events screen

**Implemented.** Owner-approved from a throwaway prototype
(`proto-special-unified`), then built for real on branch
`feat/unify-special-events`: a new `SpecialEventsScreen.jsx` in **Sprouts**,
`EventScreen`/`SpecialDaysScreen` deleted, the Plants "Special Schedules" build
surface kept unchanged and reached via a "Build →" hand-off. This document
records the decision as shipped (an earlier draft proposed Plants placement;
see the correction note in the Decision section).

## Context

Today a director manages "the special stuff" across three separate nav
destinations, split across two lifecycle stages:

- **Sprouts → Events** (`events` nav key → `EventScreen.jsx`) — create/list events.
- **Sprouts → Special Days** (`specialdays` nav key → `SpecialDaysScreen.jsx`) — create/list special days.
- **Plants → Special Schedules** (`schedule:special` nav key → `SpecialSchedulesScreen.jsx`) — a picker listing the same two entity types, whose cards open the grid editors (`SpecialDayGridEditor` / `EventGridEditor`) to actually build each one's schedule.

This is three screens and three nav rows for what a director experiences as
one activity: "set up my special stuff and build its grid." Two prior ADRs
recorded a *deliberate* split here:

- `docs/adr/2026-08-23-override-family-model.md` §6c resolved "these feel
  like one thing" as a **display-layer grouping only** (a quiet "Special
  Events" sub-heading over the two Sprouts rows), explicitly **not** a nav
  merge, pending "a director-facing signal (real camp data)."
- `docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md`
  D1/D3b drew the authoring-lives-in-Sprouts / grid-lives-in-Plants line on
  a metaphor basis (Sprouts = "you plant it," Plants = "you grow it").

The owner has now reviewed a rendered prototype that collapses all three
into one screen — one mixed card grid, "+ Special Day" / "+ Event" actions,
a muted type tag per card, a calm empty state, click-a-card-to-build — and
approved it. That is the director-facing signal §6c deferred on. **This ADR
supersedes §6c's "quiet heading, not a nav merge" resolution for this pair of
screens, while preserving D1/D3b's authoring-in-Sprouts / building-in-Plants
stage split** (it does
not touch Electives, which stays a separate sibling by deliberate, unrelated
reasoning — see "What this does not change" below).

## Decision

**One create/manage screen in Sprouts; the Plants build surface stays.**

> **Placement correction (owner, 2026-08-29):** an earlier draft of this ADR
> put the unified screen in **Plants** (reworking `SpecialSchedulesScreen.jsx`
> in place and retiring the Sprouts rows into it). The owner corrected this
> after seeing the rendered prototype: the create/manage cards belong in
> **Sprouts** (authoring), and the Plants **"Special Schedules"** build
> surface stays exactly as it is. So this is a **2→1 merge in Sprouts**, not a
> 3→1 collapse — building still happens in Plants, reached via a "Build →"
> hand-off. The sections below reflect the shipped design.

1. **The screen.** A **new** `src/screens/SpecialEventsScreen.jsx`, in
   **Sprouts**. It owns:
   - the single mixed card grid (special days + events, each card tagged
     "Special Day" / "Event" via `S.chip`),
   - both add flows — "+ Special Day" / "+ Event" — calling the exact same
     `special_days`/`events` writes the two retired screens called today
     (including the special-day seed-from-time-blocks prompt, kept inline),
   - the calm empty state (`CalmEmptyState.jsx`, created in this change —
     outline icon + one quiet line, no illustration/explainer),
   - **on card click, a detail view** (editable name + notes, commit-on-blur,
     reusing `EventScreen`'s `EventDetail` pattern for both entity kinds —
     both `special_days` and `events` already carry a `notes` column) that
     carries a **"Build this schedule →"** action. The grid editors are NOT
     opened on this screen; the "Build →" hands off to Plants (see point 2).

2. **Nav merge — Sprouts 2→1; Plants untouched.** Remove the two Sprouts rows
   `events` and `specialdays` and the now-empty `special-events-heading`; add
   exactly one Sprouts row `{ key: 'specialevents', label: 'Special Events' }`.
   **Plants' `schedule:special` "Special Schedules" row is kept unchanged** —
   same key, same label, same pinned position — and remains the build surface
   the detail's "Build →" routes to (via the existing
   `initialSelection` / `specialScheduleFocus` `{ type: 'day'|'event', id }`
   carrier). No 3→1 collapse; the Plants build surface is deliberately
   preserved, mirroring the Electives authoring(Sprouts)/building(Plants)
   split.

3. **Retiring the two authoring screens.** **Delete**
   `src/screens/EventScreen.jsx` and `src/screens/SpecialDaysScreen.jsx`
   outright — do not keep them as unreachable dead code, and do not extract
   their create logic into a shared helper module. Their entire create logic
   is ~15 lines each (one `localClient.write` call plus a name-input form);
   the prototype already inlined equivalent logic directly in
   `SpecialSchedulesScreen.jsx`. A helper module for two call sites that
   will only ever have one caller is the over-abstraction this ADR
   deliberately avoids. Their own test files
   (`EventScreen.test.jsx`, `SpecialDaysScreen.test.jsx`) are deleted with
   them; the behavior they proved (create validation, write-failure
   messaging, deleted-elsewhere handling) is re-proved against the unified
   screen — see "Test impact."
   - `SpecialDayGridEditor.jsx` and `EventGridEditor.jsx` are **not**
     touched by this ADR — they stay exactly as they are, reached the same
     way they are reached today.

4. **The seed-prompt.** **Stays inline on the unified screen**, exactly
   where the prototype put it (a dismissible banner shown immediately after
   creating a special day, before the grid editor opens), **not** relocated
   into `SpecialDayGridEditor.jsx` as a first-run editor state. Reasoning:
   moving it into the editor would touch a component this ADR has otherwise
   declared out of scope, for a purely cosmetic gain — the prompt already
   reads naturally as "you just created a special day, want it pre-filled?"
   on the same screen that just created it. Keeping it on the wrapper screen
   is the smaller, more reversible change, and matches the approved
   prototype exactly.

5. **Roots census / attention-list wiring.** `rootMapNav.js` today points the
   Roots census tree's "Events" and "Special Days" child nodes at the retired
   `events`/`specialdays` screen keys. Repoint both to the new `specialevents`
   key — the unified grid is small and mixed by design, so clicking either
   census node lands on the same full grid rather than a type-filtered view.
   The `specialevents` label is "Special Events"; the Plants `schedule:special`
   row keeps its "Special Schedules" label unchanged.

## Coupling analysis — is this really migration-free?

**Yes — this is a pure UI/nav consolidation. No schema or migration
required.** Verified by grep against the actual current-`main` code, not
memory:

- **No schema change.** `special_days`, `events`, and their child tables
  (`special_day_time_blocks`, event group/time-block/slot tables) are
  untouched. The unified screen calls the exact same entity writes the two
  retired screens call today.
- **`readiness.js` has no coupling to the `events`/`specialdays` nav
  keys.** `REQUIRED_AREAS` and `OPTIONAL_AREAS` (the setup-gate and
  sidebar-badge source of truth) do not list `events` or `specialdays` at
  all — neither is a gated or badged area. Nothing there breaks when the
  nav keys disappear.
- **`navSections.js`'s `AREA_TABLE`** (`specialdays: 'special_days'`,
  `events: 'events'`) is a **separate concept from the nav screen key** —
  it drives row item-counts, keyed by the nav-item `key`, independent of
  which screen that key routes to. Since this ADR removes both nav items
  entirely (rather than repointing them to a shared screen the way
  `fixedevents`/`anchors` do), their `AREA_TABLE` entries are dead and
  should be deleted alongside the nav rows. No runtime coupling breaks —
  they simply have no consumer once the rows are gone.
- **`SCHEDULE_ROUTE_BY_SCREEN` and `ANCHOR_KIND_BY_SCREEN`** in `App.jsx`
  do not reference `events`, `specialdays`, or `schedule:special` in any
  way that this change touches (the former is about the two schedule
  routes; `schedule:special` was already, correctly, absent from it as "a
  picker, not a route" — that stays true).
- **One real call site needs rewiring**, not zero:
  `src/screens/ScheduleScreen.jsx`'s `openEvent()` (an event cell's
  drill-in button on the campwide grid) called `onNavigate?.('events',
  { eventId })`. With `events` retired, it now becomes
  `onNavigate?.('specialevents', { eventId })` — landing on that event's
  detail within the unified Sprouts screen (the natural "inspect this event"
  destination the drill-in intended). This is the only production call site
  found by grep for `onNavigate('events'` / `onNavigate('specialdays'`
  across `src/`.
- **`App.jsx`'s focus-carrying state collapses from two to one.**
  `eventFocusId`/`initialEventId` existed only to feed `EventScreen`'s own
  `initialEventId` prop; once `EventScreen` is deleted, `eventFocusId` and
  its two read sites (`initialEventId` prop, the `target !== 'events'`
  clear guard) are deleted with it. `specialScheduleFocus` already covers
  both `{ type: 'day', id }` and `{ type: 'event', id }` and is the single
  focus-carrier the unified screen consumes via `initialSelection`.

**No load-bearing coupling was found that complicates the "no migration"
determination.** The one non-trivial finding is the `ScheduleScreen.jsx`
call site above, which this ADR's plan enumerates as a required rewiring,
not a blocker.

## What this does not change

- **Electives** stays a separate sibling row in both Sprouts
  ("Electives," authoring) and Plants ("Elective Schedules," building) —
  `docs/work/specs/2026-08-23-electives-gap.md` drew that line for
  different reasons (electives are core recurring structure, not an
  exception category) that this ADR does not revisit.
- **Fixed Events / Recurring Events** (`fixedevents`/`anchors`, both
  `AnchorsScreen.jsx`) are unrelated to this merge and untouched.
- **Delete cascades, write paths, and grid-editor behavior** for both
  special days and events are reused verbatim, not reimplemented.

## Consequences

- Sprouts' "Special Events" heading (a piece of §6c's now-superseded
  resolution) disappears; Sprouts loses two rows, Plants keeps the same row
  count with one relabeled entry.
- A director who used to reach "Events" or "Special Days" as two separate
  Sprouts rows now finds both under one Sprouts "Special Events" screen
  (create + manage), and still builds each one's schedule in Plants "Special
  Schedules" via the detail's "Build →" hand-off. The authoring(Sprouts)/
  building(Plants) stage split is preserved — this change only unifies the
  two *entity types* within the authoring stage, exactly parallel to how
  Electives already works.
- Once `events` and `specialdays` are removed from `SCREENS`, any missed
  reference to either key (a stale call site the grep in this ADR didn't
  catch, or a future regression) falls through `App.jsx`'s
  `SCREENS[resolvedScreen] || TiersScreen` fallback and lands silently on
  Age Divisions — the exact class of bug `src/engine/readiness.js`'s
  `dayoverrides` removal (T108) called out and a guard test caught. Unlike
  `'readiness'`, `events`/`specialdays` get no redirect entry (there is no
  single unambiguous target — a bare `events` deep link doesn't know which
  event to focus) — so the ticket's test coverage must include the
  guard-test pattern in `screenDestinationsExist.test.js` catching any
  reintroduced reference, not a redirect.
