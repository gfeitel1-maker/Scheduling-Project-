---
title: Reaching special-day/event grid-building from Schedule nav
document_type: spec
status: active
created: 2026-08-23
archive_when: implementation ships (merged/deferred) or this design is superseded by a new owner decision
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/adr/2026-08-23-override-family-model.md]
---

# Reaching special-day/event grid-building from Schedule nav

## DESIGN SPEC — Special Schedules (Schedule-side build entry)

### Owner decision this design executes

"There still needs to be the place you do the scheduling tied in with the schedule part." Authoring
stays in Roots. The act of *building* a special day's or event's grid becomes reachable from the
Schedule nav section, alongside Generated Schedule / Manual Build, without reading as a third route.
This is a sharpening of the locked Roots-as-Hub IA, not a reversal of it.

---

### Current-state audit

**`src/screens/SpecialDaysScreen.jsx`** conflates authoring and building inside one screen via a
state swap. The list view (`:172-286`) is authoring only — "+ New Special Day" (`:188-201`) writes
just the `name` field (`createDay`, `:83-96`). Creating a day immediately surfaces a seed prompt
(`:252-264`) — "Seed from Time Blocks" / "Start Empty" — and either choice sets `openId`, which swaps
the whole screen to `<SpecialDayGridEditor campId specialDayId onBack onDeletedElsewhere />`
(`:157-169`, component at `src/screens/specialDay/SpecialDayGridEditor.jsx`, cell renderer
`src/screens/specialDay/SpecialDayCell.jsx`). Two clicks (Create, then a seed choice) land the
director in the grid — no separate navigation, same screen.

**`src/screens/EventScreen.jsx`** separates the two actions more, across three layers: the list
(`:294-350`) authors by name only (`addEvent`, `:267-271`); clicking a row opens `EventDetail`
(`:101-197`), which authors name/notes/location (`:151-173`, commits on blur) and shows a read-only
`PlacementSummary` (`:80-99` — placement itself happens by drag-and-drop on the campwide grid,
outside this screen entirely, per comment `:6-9`); a separate "Internal schedule" card with an "Open
schedule" button (`:182-194`) sets `editingSchedule=true`, swapping to `<EventGridEditor>`
(`src/screens/event/EventGridEditor.jsx`, cell `src/screens/event/EventCell.jsx`). Three clicks (Add,
open row, "Open schedule") reach the grid.

**Both screens are reached only via Roots** (`navSections.js:97` `specialdays`, `:85` `events`),
nested under the just-merged "Special Schedule" heading (`:73-80`, override-family-model §6c) that
visually groups Events and Special Days together in Roots — "these feel like one thing," per the
comment. This grouping is a display-layer change only; it doesn't touch the authoring/building
question this spec answers, but it's the correct sibling relationship to preserve on the Schedule
side (see Reconciliation, below).

**`navSections.js:102-115`** (Schedule section) holds exactly two flat item rows, deliberately
undifferentiated by weight or order (`:106-111`, alphabetical, "neither is the camp's real
schedule"). The rationale for keeping Special Days out of this section is explicit at `:91-96`:
putting it under `schedule` "would visually imply a third route competing with Manual/Generated."
That concern is the hard constraint this spec must satisfy — not by keeping the build action out of
Schedule, but by giving it a visual shape that is legibly *not* a route.

**Click path today**, Color War example: Roots → "Special Days" child row → name the day → seed
prompt → grid. The build action is *findable* only by a director who thinks "this is setup" — a
director sitting on the Schedule screen mid-week, thinking "I need to fill in Thursday's Color War,"
has no path there from Schedule at all. That's the gap the owner is closing.

---

### The IA: Special Schedules entry under Schedule

**Recommendation: a single, third row in the Schedule nav section — "Special Schedules" — that opens
a picker screen, not a route.**

```
Schedule
├── Generated Schedule      (route)
├── Manual Build            (route)
└── Special Schedules       (picker → build)
```

Considered and rejected: making the *existing* build screens (`SpecialDayGridEditor`,
`EventGridEditor`) directly reachable as flat additional Schedule rows, one per authored entity. This
fails immediately — the row list would grow unboundedly as a camp authors more special days, and nav
rows that multiply with data are exactly the "third+ route" smell the locked IA rejects. A single,
fixed "Special Schedules" row that opens an internal list solves this: the nav never grows, and the
list inside is data, not navigation structure.

**Why this doesn't read as a third route:**

1. **Visual demotion, not addition.** Generated/Manual are rendered as the two primary schedule
   destinations — equal weight, side by side (per `:106-111`'s "neither is canonical" rule). Special
   Schedules is visually subordinate: same row style as any nav item, but the screen it opens is a
   *picker*, never a grid on arrival. A route takes you straight to a schedule; this takes you to a
   list of things you can go build. That's the same shape as the difference between "Manual Build"
   (arrives at a grid) and Roots's own child rows (arrive at setup lists) — directors already read
   that distinction correctly today.
2. **No independent `slots`/`overlays`/`stats` state.** Manual and Generated each key a full
   `route` state slice in ScheduleScreen (`slots`/`overlays`/`snapshots`/`stats`/`findings`, per
   CLAUDE.md's Two-routes description). Special Schedules introduces none of that — it reuses the
   existing `SpecialDayGridEditor`/`EventGridEditor` components verbatim, each already independently
   stateful and already proven not to compete with the two routes (they're currently reached from
   Roots without incident).
3. **Label says "special," not "another way to schedule."** "Special Schedules" names an exception
   category, paired with the icon/weight treatment described below — it reads as "the odd ones,
   gathered here" rather than "door number three."

---

### The authoring-vs-building split

**Stays in Roots (no code change to authoring):**
- `SpecialDaysScreen.jsx` list view (`:172-286`) — name a day, choose seed strategy. Creating a day
  no longer auto-forwards into the grid editor (see seam below); it returns to the list.
- `EventScreen.jsx` list (`:294-350`) and `EventDetail` (`:101-197`) — name, notes, location,
  placement summary. The "Open schedule" button (`:182-194`) is removed from here — building moves
  to the Schedule-side entry (see seam below). Placement on the campwide grid (drag-and-drop) is
  unaffected; it was never part of this seam.

**Reachable under Schedule (new):**
- A new picker screen, `SpecialSchedulesScreen`, listing every authored special day and event (query
  both `special_days` and `events` tables, same shape driving `AREA_TABLE` at `navSections.js:156-158`).
  Selecting a row opens the *same* `SpecialDayGridEditor` / `EventGridEditor` components already
  built — zero new grid-editing code, only a new entry point and a redirect of the existing "open
  the grid" affordance.

**The seam, precisely:**
- `SpecialDaysScreen.jsx:157-169` today swaps `openId` state to show the grid inline. That inline
  swap is removed from `SpecialDaysScreen`. Its "Open" button (`:243`) and the seed-prompt "land in
  grid" behavior (`:120,127`) instead navigate to `SpecialSchedulesScreen` with that day
  pre-selected (or the seed prompt's "Start Empty"/"Seed" choice completes, then the screen shows a
  toast/inline confirmation — "Color War created — build it from Special Schedules under Schedule" —
  no explainer banner, just a location hint in plain copy).
- `EventScreen.jsx:182-194`'s "Open schedule" button is removed from `EventDetail`. In its place, a
  quieter link/row: "Build this event's schedule from Special Schedules." `EventDetail` keeps its
  read-only `PlacementSummary` (`:80-99`) unchanged — that's authoring-adjacent context, not building.
- Both `SpecialDayGridEditor` and `EventGridEditor` keep their existing props contract
  (`campId`, `specialDayId`/`eventId`, `onBack`, `onDeletedElsewhere`) — `onBack` now returns to
  `SpecialSchedulesScreen` instead of the Roots list screen. This is the only prop-wiring change to
  either grid editor.

This is the smallest seam that satisfies the owner's decision: no schema change, no new grid
component, no change to what "authoring" means — only where the *button that opens the grid* lives
and what it returns to.

---

### Layout (SpecialSchedulesScreen)

- **Reached via** `navSections.js` new item `{ key: 'schedule:special', label: 'Special Schedules' }`
  appended to the `schedule` section's `items` array, after Manual Build.
- **Screen structure**: a simple list screen, visually closer to Roots's entity list screens
  (SpecialDaysScreen's own list view is the nearest precedent) than to a schedule grid — this is
  the strongest single signal that it's a picker, not a route. Two sub-groups, each a labeled list
  of cards: "Special Days" and "Events" (mirrors the Roots "Special Schedule" heading grouping —
  same two categories, same order, so a director's mental map transfers directly between Roots and
  Schedule).
- Each row/card: name, a one-line status (e.g. "Not started" / "Partially filled" / "Complete" —
  derived the same way `findings`/fill-state is already computed for the main grid, reusing
  existing per-cell fill logic rather than inventing a new completeness metric), and for events only,
  its placement date if already placed on the campwide grid (pulled from `PlacementSummary`'s
  existing query).
- Empty state (no special days or events authored yet): a single line — "No special days or events
  yet. Author one from Roots." with a plain link back to Roots's Special Schedule heading. Per the
  locked IA, this is not an explainer banner (no illustration, no dismiss action, no onboarding
  copy) — one sentence, same register as the rest of the app's empty states.
- Clicking a row opens the corresponding existing grid editor full-screen, same as it does today
  from Roots — no new visual language for the grid itself.

### Visual style

- Card background: `var(--surface)` (`#FFFCF8` light / `#FCFBF8` dark, DESIGN_STANDARD.md:50) —
  matches every other list screen in the app, including SpecialDaysScreen's own list view. No new
  surface token.
- Section sub-headings ("Special Days", "Events"): same non-interactive `heading` treatment already
  used at `navSections.js:80` for the Roots grouping — plain label, no chrome, no icon.
- Status text: use `var(--success)` only for "Complete" (`#00AA59` light / `#4C8A63` dark,
  DESIGN_STANDARD.md — "status: confirmed/online/merged" semantics already established); "Not
  started"/"Partially filled" use `var(--text-secondary)` (neutral, no invented status color).
  `--primary` (`#00ADBB` light / `#173B63` dark) is reserved for the nav row itself and the row's
  hover/active state, consistent with how Generated Schedule/Manual Build rows are styled today —
  do not introduce a new accent color for this feature.
- No color-coding by "special day" vs "event" beyond the section grouping — color is a data channel
  per the personality standard, and category membership is already conveyed by which sub-list a row
  sits in.

### States

- **Empty** (no entities authored): single-line message + Roots link, described above.
- **List, populated**: cards as described, sorted by name within each sub-group (same
  non-designating ordering rule as Generated/Manual — no recency or usage-based reordering).
- **Row hover/focus**: standard list-row hover treatment already used elsewhere (subtle
  background shift, no scale/transform — this is a list, not a button grid).
- **Loading**: standard list-screen skeleton already used by other setup screens (no new pattern).
- **Grid editor open** (post-selection): identical to current `SpecialDayGridEditor` /
  `EventGridEditor` states — unchanged.

### Interactions

- Clicking "Special Schedules" nav row → navigates to `SpecialSchedulesScreen` (plain screen swap,
  same as any other nav item — no special transition given the low frequency of this navigation,
  per the animation decision framework's frequency table).
- Clicking a card → opens the grid editor. Use a **crossfade** (not slide, not scale) between the
  picker list and the grid editor — this is a same-surface state change (list → detail within one
  logical screen), the same relationship SpecialDaysScreen already has internally today between its
  list and grid views. 150ms, `ease-out`, opacity only (no transform) — matches "Dropdowns,
  selects" duration band and keeps under the 300ms UI ceiling. `filter: blur(2px)` is not needed
  here since it's a full-screen swap, not an overlapping crossfade of two visible states.
- Grid editor's "Back" (`onBack`) → same crossfade, reverse direction, returning to the picker list
  with the previously-open card scrolled into view (standard list-return behavior, no special
  scroll-restoration code needed beyond what other setup screens already do).
- No hover-triggered previews, no drag-and-drop on this screen — it is a picker, deliberately inert
  beyond click-to-open, reinforcing that it isn't a working surface itself.

### Animation

| Moment | Trigger | Type | Duration | Values |
|---|---|---|---|---|
| Picker → grid editor | Click a card | Crossfade | 150ms | `opacity` only, `ease-out`; no transform, no scale |
| Grid editor → picker (Back) | Click Back / `onBack` | Crossfade | 150ms | Same as above, reverse |
| Nav row → picker screen | Click "Special Schedules" | None (plain swap) | 0ms | Matches existing nav-item screen swaps (Roots/Generated/Manual show no transition today) |
| Row hover | Pointer hover | Existing list hover treatment | n/a | Reuse whatever `Sidebar`/list-row hover token is already in use elsewhere — do not invent a new one |

All animated moments here are **occasional** (a director opens this a handful of times per session
at most) — per the frequency table, that lands in "standard animation," which the crossfade above
satisfies without needing spring physics or bounce. `prefers-reduced-motion` fallback: crossfade
duration drops to 0ms (list swap becomes instant, matching Nav-row → picker behavior) — no motion,
opacity change only, per the reduced-motion principle of removing movement while keeping state
changes legible.

### Prototype

No HTML mockup produced. The layout is a direct reuse of an existing screen shape (SpecialDaysScreen's
own list view is the closest living reference in the codebase — Maker should literally read that
component before building `SpecialSchedulesScreen`, since the new screen is structurally the same
list-of-cards pattern with a second data source added). Given the size of this seam — one new list
screen wrapping two data sources, zero new grid code — an HTML prototype would reproduce a component
Maker can read directly; building one would cost more than it clarifies. If the owner wants to see it
live before sign-off, the fastest path is Maker building the picker screen behind a feature flag and
reviewing it in `npm run electron:dev`, not a throwaway HTML mock.

### Reconciliation with Slice B (Roots "Special Schedule" heading)

Slice B (override-family-model §6c, `navSections.js:73-80`) grouped Events and Special Days under one
quiet heading in Roots, because the owner's felt model treats them as one thing. This spec mirrors
that exact grouping on the Schedule side — `SpecialSchedulesScreen`'s two sub-lists use the same two
category names, same order (Special Days, Events — matching `navSections.js:85,97`'s order), so a
director's mental map is identical in both places: "Special Schedule" is one family with two kinds,
authored in Roots, built from Schedule. No new taxonomy is introduced by this spec.

### Implementation notes for Maker

- Do not touch `SpecialDayGridEditor.jsx` or `EventGridEditor.jsx` internals — only their entry
  point and `onBack` target change.
- `SpecialDaysScreen.jsx`'s `openId` state and inline grid swap (`:157-169`) should be removed
  entirely, not just hidden — leaving dead state risks a future regression back into the conflated
  screen.
- `EventScreen.jsx`'s "Open schedule" button and `editingSchedule` state (`:182-194`) move to
  `SpecialSchedulesScreen`, not duplicated — `EventDetail` should have no path to the grid editor
  after this change, only the read-only `PlacementSummary`.
- `AREA_TABLE` (`navSections.js:147-159`) already has `specialdays`/`events` entries — the new
  picker screen's data source is the same two tables, no new table.
- New nav key: `schedule:special`. Follow the existing `schedule:generated`/`schedule:manual` naming
  convention exactly (`navSections.js:112-113`).
- The completeness status shown per card ("Not started"/"Partially filled"/"Complete") must reuse
  existing fill-state logic from the grid editors (whatever already determines an empty vs. filled
  cell) — do not compute a new metric from scratch; ask the grid editor components what they already
  expose or can cheaply expose.
- No explainer banner, no first-time tooltip, no "new!" badge on the nav row — per the locked Roots
  IA principle (killed `SCREEN_INTRO`, "no explainer banners") applied consistently to this
  companion surface.

---

### Open questions for the owner

> **RESOLVED 2026-08-23 (owner + Governor):** OQ2 → **remove the auto-forward** (creating a special day/event returns to the Roots list with a quiet hint pointing at Schedule → Special Schedules; owner's explicit call). OQ1 → **no badge** (take the spec's recommendation — "things you can optionally build" carry no urgency). OQ3 → **scope is Special Days + Events only**; Electives' existing off-grid build path is untouched.


1. **Nav row icon/weight** — should "Special Schedules" carry any visual marker (e.g. a small count
   badge showing how many special days/events exist) the way Conflicts carries a badge
   (`navSections.js:135`)? This spec recommends no badge — a badge implies urgency/action-needed,
   which doesn't apply to "things you can optionally go build." Confirm.
2. **Auto-navigate on creation?** — today, creating a special day auto-forwards into its grid. This
   spec removes that (return to the Roots list, with a hint pointing at Schedule). Confirm the owner
   is fine with that extra step, since the alternative (keep auto-forward, but forward across nav
   sections into `SpecialSchedulesScreen`) is a rougher cross-section jump immediately after an
   authoring action.
3. **Elective sets** — `electives` (`navSections.js:72`) is authored in Roots but is *not* part of
   the Special Schedule heading grouping and has its own build surface already (off-grid, per
   `docs/adr/2026-08-22-nested-schedules-electives-and-events.md`). Confirm this spec's scope is
   correctly limited to Special Days + Events only, and Electives' existing build path is untouched.

---

### Recommended path

Ship a single new nav row, "Special Schedules," under the Schedule section, opening a picker screen
that lists authored special days and events grouped exactly as Roots already groups them, with each
row opening the existing, unmodified grid editors; remove the "open the grid" affordance from both
Roots authoring screens so building has exactly one home. This is the smallest change that honors
both halves of the owner's decision — authoring stays in Roots, building lives under Schedule — while
staying visually and structurally distinct from Generated/Manual: a picker with no independent
schedule state, no grid on arrival, and a label that names an exception category rather than a third
way to build a week.
