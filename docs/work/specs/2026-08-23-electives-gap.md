---
title: Closing the electives gap — manual-create offerings + a Schedule-side builder
document_type: spec
status: active
created: 2026-08-23
archive_when: implementation ships (merged/deferred) or this design is superseded by a new owner decision
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
parent_spec: [docs/adr/2026-08-22-nested-schedules-electives-and-events.md, docs/work/specs/2026-08-23-schedule-build-ia.md, docs/adr/2026-08-22-roots-as-hub-setup-ia.md]
---

# Closing the electives gap — manual-create offerings + a Schedule-side builder

## DESIGN SPEC — Electives Gap (owner priority #2)

### Owner decision this design executes

"You can currently only add activities that are ALREADY PRESENT, when you need to add WHATEVER you
want either through IMPORT or through MANUAL additions — for electives. Then, just like the special
events, there needs to be a BUILDER SCREEN underneath the other schedule build screens."

Two parts:
- **(a)** A director must be able to add *any* activity — not just one already in the catalog — as
  an elective offering via manual entry, not only via file import.
- **(b)** Electives get a build entry reachable from the Schedule nav section, mirroring the pattern
  `docs/work/specs/2026-08-23-schedule-build-ia.md` just shipped for Special Days + Events.

---

### Current-state audit

**Part (a) — manual add is pick-from-catalog only.**
`src/screens/ElectivesScreen.jsx:355–380` ("Add Offering" card) renders a bare `<select>`
(`:358–370`) populated from `availableActivities` (`:164`, the camp's `activities` table minus
whatever this set already offers). Choosing a row and clicking `+ Add` calls `addOffering()`
(`:166–170`), which calls `add({ activityId: pickerActivityId })` (`:168`) — `useCrudScreen`'s
`buildCreateFields` (`:147–150`) writes only `elective_set_id` + `activity_id` into
`elective_set_activities`. **There is no path here to mint a new activity that isn't already in the
catalog.** A director who wants to offer "Pottery" and it doesn't exist yet must leave Electives,
go to `ActivitiesScreen`, create it there, then come back — a context switch the owner is asking to
remove.

**Import already handles arbitrary offerings — confirmed, no gap.**
`runImport()` (`:178–236`) parses a file into a grid (`parseTextGrid`/`workbookToPages` →
`parseGridSchedule`) and hands it to `populateElectiveSet()` (`src/ingest/electiveSetPopulate.js`,
called at `:204–206`). The comment at `:212–221` states plainly that a re-import "lets a director...
refresh" and mints activities the catalog doesn't yet have, with dedup guarded by refreshing both
`reload()` and `refreshActivities()` so a retry can't double-mint. So **part (a)'s only real gap is
the manual-create path** — import already lets a director bring in "whatever" via a file. This spec
does not touch `runImport`/`populateElectiveSet`.

**The reusable inline-create pattern already exists in the codebase.**
`src/components/LocationPicker.jsx` is the precedent: a typeahead (`:69–202`) that filters
`locations` by substring match (`:90`), and when the typed text has no exact match, shows a
`+ Create "<name>" as a new location` row (`LocationPickerPopover`, `:48–59`) styled distinctly
(`createOption`, secondary-green text, `NEW` tag, `:224–227`). Selecting it calls `onCreate(q)`
(`:102–115`), which the *caller* wires to the actual mint — the picker itself has zero knowledge of
how a location is created; that's `LocationsScreen`'s job, matching the "hooks own the write, the
picker owns the UI" seam this repo already uses everywhere else. This is the exact shape the
Add-Offering picker needs, swapped from `locations` to `activities`.

**Part (b) — the Schedule-side build entry.**
`src/screens/SpecialSchedulesScreen.jsx` is the just-shipped picker (`docs/work/specs/2026-08-23-
schedule-build-ia.md`): a list screen under `schedule:special` in `src/components/layout/
navSections.js:124–129`, showing two labeled sub-groups ("Special Days", "Events") as card lists,
each card opening the *existing* `SpecialDayGridEditor` / `EventGridEditor` unmodified. **Electives
is deliberately out of its scope** — the schedule-build-ia spec's OQ3 was resolved 2026-08-23:
"scope is Special Days + Events only; Electives' existing off-grid build path is untouched." The
owner's new ask reopens exactly that boundary: electives should *also* get a Schedule-side entry
"like special events."

`navSections.js:78–82` places `electives` as its own optional Roots child row, **not** grouped under
the `special-schedule-heading` (`:90`) that visually pairs Special Days + Events — that heading is
scoped explicitly to those two ("these feel like one thing," override-family-model ADR §6c). Electives
was never part of that felt-model pairing. `AREA_TABLE` (`:173`) already keys `electives:
'elective_sets'`.

**Structural difference from Special Days/Events that matters for the IA call:**
Special Days and Events each drop into a full campwide-grid *sub-schedule* — `SpecialDayGridEditor`/
`EventGridEditor` are grid components with their own cell renderers. Electives has no grid and no
solver by explicit design (`ElectivesScreen.jsx:1–14` model comment: "no campers roster, no solver —
only holds and displays what the director decides"). What Electives "builds" is a flat list of
offerings with a capacity field — `ElectiveSetDetail` (`:140–405`) is a table, not a grid. The
Schedule-side entry for Electives therefore cannot literally "open the existing grid editor" the way
Special Schedules does; it opens the existing *offerings-table* screen instead. That's a smaller,
cleaner reuse than it first sounds: `ElectiveSetDetail` already is the "build" surface, factored out
of `ElectivesScreen` as its own component — reusing it from a new entry point is the same seam
`SpecialSchedulesScreen` used for the grid editors.

---

### The key IA decision — fold into Special Schedules, or a sibling row

**Recommendation: a new, separate fourth Schedule-nav row, "Electives" — not folded into "Special
Schedules."**

```
Schedule
├── Generated Schedule      (route)
├── Manual Build            (route)
├── Special Schedules       (picker → Special Day grid / Event grid)
└── Electives               (picker → offerings table)
```

**Why not fold it in, even though the owner said "like special events":** "like" describes the
*pattern* (Roots authors, Schedule builds) the owner wants replicated, not a request to put electives
inside the Special Schedules screen. Three reasons folding it in is the wrong call:

1. **"Special Schedules" is named and framed as an exception category.** The schedule-build-ia spec
   is explicit: the label "names an exception category... reads as 'the odd ones, gathered here'"
   (§"Why this doesn't read as a third route", point 3). Electives are not an exception — a weekly
   afternoon-chugim period is core, recurring scheduling structure for most camps, closer in kind to
   Generated/Manual than to a one-off Color War day. Filing it under "Special Schedules" would
   misrepresent it and dilute the label's meaning for the two categories it already correctly names.
2. **Roots doesn't group it there either.** `navSections.js` already draws this exact line: Electives
   is its own row (`:82`), separate from the `special-schedule-heading` grouping Events + Special Days
   (`:90`). The Schedule-side IA should mirror Roots's existing category boundary, the same way
   `SpecialSchedulesScreen`'s two sub-lists mirror Roots's Special Schedule heading (schedule-build-ia
   spec, "Reconciliation with Slice B"). Consistency argues for a sibling row, not a merge.
3. **The content shape is genuinely different**, and mixing it into one screen would force
   `SpecialSchedulesScreen` to render three unrelated detail types (two grid editors + one table)
   behind one undifferentiated card list, weakening the "click a card, get a grid" mental model the
   existing two sub-lists share.

**Why a new row and not a growing list:** same guardrail the schedule-build-ia spec already applied
to Special Days/Events — a *fixed* nav row that opens a picker over the camp's elective sets (data),
never one row per set (nav structure). This keeps the Schedule section from growing as a camp
authors more elective sets, exactly as it already keeps the section from growing as more special
days/events are authored.

**This is the single highest-stakes decision in this spec** — it fixes the taxonomy going forward
(what counts as "special" vs. what doesn't) and is visible to the owner on first use. Confirm before
Maker builds.

> **RESOLVED 2026-08-23 (owner):** **separate "Electives" row under Schedule** (not folded into Special Schedules) — electives are core recurring structure, not a special-day/event exception; matches how Roots already lists them separately. Part (a) (manual create-any-activity via typeahead-with-inline-create) proceeds regardless.

---

### Part (a) — manual create-any-activity on Add Offering

**Layout.** Replace the `<select>` + `+ Add` button block in `ElectiveSetDetail`
(`ElectivesScreen.jsx:355–380`) with an `ActivityPicker` component, structurally identical to
`LocationPicker` (`src/components/LocationPicker.jsx`): a typeahead `<input>` over
`availableActivities`, a popover listing filtered matches, and — when the typed text has no exact
match — a `+ Create "<name>" as a new activity` row.

**What a newly-created activity gets.** Name only, written the same way `populateElectiveSet` already
mints activities from import (so manual-create and import-create produce byte-identical rows — no
second code path for "how an activity is minted"). No location, no eligibility, no rule fields set at
creation time; those are Activities-screen concerns, set later. This mirrors `LocationPicker`'s own
precedent exactly: a just-created location gets an inline capacity stepper (`justCreatedId`,
`ElectivesScreen`... no — `LocationPicker.jsx:81,133–153`) so the *one* field that matters at
creation time (capacity) is fixable without leaving the flow, while everything else is deferred to
its home screen. Activities has no equivalent single "matters most" field at creation — eligibility
is genuinely multi-field (tier or group, not a scalar) — so **no inline just-created affordance is
specced for activities**; the row simply appears in the offerings table with `Who can go` reading
"Everyone" (the existing `eligibilitySummary()` fallback, `:66`) until the director visits Activities
to scope it. Do not invent a second inline eligibility editor here — that duplicates Activities-
screen surface the ADR's "no campers roster, no solver" boundary was written to avoid.

**States** (reusing `LocationPicker`'s exact state machine, retargeted to activities):
- **Default / closed** — input showing placeholder "Search or add an activity…", no popover.
- **Typing, matches exist** — popover lists matching `availableActivities` by substring, each row
  showing name only (activities have no capacity-at-a-glance field the way locations do; capacity
  here lives on the *offering*, not the activity, and is set after adding — see the existing
  `OfferingRow` capacity input, `:103–125`, unchanged).
- **Typing, no exact match** — popover appends the `+ Create "<name>" as a new activity` row, same
  visual treatment as `LocationPickerPopover`'s `createOption` (`:224–227`: border-top hairline,
  `var(--secondary)` text, `NEW` tag).
- **Creating** — `+ Create` row shows disabled/busy state exactly like `LocationPicker`'s `creating`
  flag (`:74,102–115`); no separate spinner component.
- **Created + auto-added** — selecting Create both mints the activity *and* adds it as an offering in
  one action (see Interactions below) — collapses what would otherwise be two flows (create, then
  separately pick-and-add) into the one gesture a director actually wants: "make this an offering."
- **Empty catalog** — if `availableActivities` is empty because every catalog activity is already
  offered (not because the catalog itself is empty), keep today's picker text: "No more activities to
  add" is wrong once Create exists — replace with a hint: "All existing activities are already
  offered here. Type a name below to add a new one." (only reachable when `activities.length > 0`).
- **True empty catalog** (`activities.length === 0`) — picker still works; typing anything falls
  straight to the Create row since there is nothing to match against.

**Interactions.**
- Typing filters the popover live (substring match, same as `LocationPicker:90`).
- Selecting an existing match: adds it as an offering immediately (existing `add()` call), closes
  popover, clears the input — this collapses today's two-step "pick from select, then press + Add"
  into one click, matching `LocationPicker`'s one-click select. (Today's explicit `+ Add` button is
  removed; `useCrudScreen`'s `adding` busy state still gates the picker while the write is in flight.)
- Selecting `+ Create "<name>"`: calls a new `createActivity(name)` → writes `{ name, camp_id }` to
  `activities` (same minimal shape `populateElectiveSet` uses for import-minted activities) → on
  success, immediately calls the existing `add({ activityId: newId })` to create the offering row →
  refreshes both `supportData.activities` (via the existing `refreshActivities` prop, already wired
  at `ElectivesScreen.jsx:551`) and `offerings` (`reload()`) — same dual-refresh discipline
  `runImport` already uses (`:221`) and for the same reason: a second manual-create in the same
  session must not re-offer a name that already exists in the now-stale local `activities` array.
- Keyboard: same as `LocationPicker` (`:169–177`) — ArrowUp/Down cycles matches + the Create row,
  Enter selects the active row or triggers Create, Escape closes.
- Error on create: keep the input text and popover open so the director can retry (matches
  `LocationPicker.handleCreate`'s catch block, `:108–114` — no dedicated error UI for this
  micro-flow, consistent with the precedent it's copying).

**Visual style.** Exactly `LocationPicker`'s token usage, no new tokens: `var(--border)` field,
`var(--primary)` focus ring (`fieldFocus`, `:210`), `var(--surface-elevated)` popover with
`0 2px 16px color-mix(in srgb, var(--text) 12%, transparent)` shadow (`:215`), `var(--secondary)`
create-row text + `NEW` tag in `var(--font-mono)` uppercase (`:224–227`). No activity-specific
color — activity identity color (the six-hue palette, DESIGN_STANDARD §3) is a *schedule-grid*
concept (a small dot on `SlotCell`), not an entity-list concept; this table already renders activity
names as plain text (`OfferingRow`, `:98`) and should keep doing so.

**Animation.** Popover open/close: reuse `LocationPickerPopover`'s existing `useEnterTransition
('popFade')` (`:33`) verbatim — no new animation value to author. Everything else in this micro-flow
(select, create) is a data write with no meaningful visual transition beyond the existing row
appearing in the table on `reload()` — the existing `useCrudScreen`/`reload()` re-render is sufficient;
do not add an entrance animation to the new offering row (occasional-frequency table row insertion
does not clear the bar for added motion per the animation decision framework — it's not a modal, not
a first-time moment, and the table already re-renders cleanly).

---

### Part (b) — Electives builder under Schedule

**Layout.** New nav item `{ key: 'schedule:electives', label: 'Electives' }` appended to the
`schedule` section's `items` array in `navSections.js` (after `schedule:special`, following the exact
naming convention `schedule:generated` / `schedule:manual` / `schedule:special` already establishes).

New screen `ScheduleElectivesScreen` (or, cheaper: extend `SpecialSchedulesScreen`'s picker shape as
a sibling function, not a merged list — see IA decision above for why these stay visually separate
screens even though they share a component pattern), structured exactly like
`SpecialSchedulesScreen`'s list view:
- A single (not two-group — electives has one category) card list of every `elective_sets` row for
  the camp, each card showing: set name, and a one-line status derived the same way
  `SpecialSchedulesScreen`'s `completeness()` (`:43–47`) derives it for grid editors — here,
  "0 offerings" / "N offerings" is the natural equivalent (electives has no fill/empty per-cell state
  the way a grid does, so completeness is offering-count, not slot-fill ratio; do not force the
  Not-started/Partially-filled/Complete vocabulary onto a screen that isn't a grid).
- Clicking a card opens `ElectiveSetDetail` (`ElectivesScreen.jsx:140–405`) **unmodified** — same
  component, same props (`set`, `role`, `activities`, `locations`, `tiers`, `groups`,
  `refreshActivities`, `onBack`), reused verbatim exactly as `SpecialSchedulesScreen` reuses
  `SpecialDayGridEditor`/`EventGridEditor` unmodified. `ElectiveSetDetail` is already extracted as
  its own component inside `ElectivesScreen.jsx` — pulling it out to a shared module (or exporting it)
  is the only structural change needed to reuse it from a second entry point; **zero new
  offerings-table code**.
- Empty state (no elective sets authored yet): one line, "No elective sets yet. Author one from
  Roots." with a plain link to Roots's Electives row — same register and the same "no explainer
  banner" rule `SpecialSchedulesScreen`'s empty state already follows.

**The authoring/building seam (mirrors schedule-build-ia's seam exactly).**
- `ElectivesScreen.jsx`'s list view (`:557–635`, "Add Elective Set" + rename/delete) **stays in Roots
  unchanged** — that's authoring (naming a set), same as `SpecialDaysScreen`'s list view staying in
  Roots.
- **What moves:** the "Manage Offerings" button (`ElectiveSetRow`, `:451`) currently sets
  `selectedSetId` and swaps the *same* `ElectivesScreen` component into `ElectiveSetDetail`
  (`:542–555`). That inline swap is removed from `ElectivesScreen`, mirroring exactly what the
  schedule-build-ia spec did to `SpecialDaysScreen.jsx:157–169`'s `openId` swap. "Manage Offerings"
  becomes a quieter link/row — "Build this set's offerings from Electives under Schedule" — matching
  the copy pattern the schedule-build-ia spec used for `EventDetail`'s removed "Open schedule" button.
- `ElectiveSetDetail`'s `onBack` prop now returns to the new `ScheduleElectivesScreen` list instead of
  `ElectivesScreen`'s own list — the only prop-wiring change to `ElectiveSetDetail`, same one-line
  change schedule-build-ia specced for the grid editors' `onBack`.
- The Slice-2 drill-in behavior — an elective cell's affordance on the campwide grid opens
  `ElectivesScreen` focused on a set via `initialElectiveSetId` (`ElectivesScreen.jsx:466,489`) —
  should now target `ScheduleElectivesScreen` instead, for the same reason: the drill-in from the grid
  is a "go build this" action, which now lives under Schedule. Confirm this redirect with Maker; it's
  a one-line change to whatever navigation call currently opens `ElectivesScreen` with that prop
  (App.jsx's `SCREENS` map / the grid cell's click handler — Maker to locate).

**Visual style.** Identical token usage to `SpecialSchedulesScreen`: `var(--surface)` cards,
`var(--border)` hairlines, `12px` radius, plain `heading` label style, `var(--primary)` row
hover/active. No new color, no new card shape — this list is visually indistinguishable from
`SpecialSchedulesScreen`'s card list except for having one section instead of two.

**States.** Empty / populated / loading / row-hover — identical states to `SpecialSchedulesScreen`,
described there in full; no new state vocabulary needed for a plain card list.

**Animation.**

| Moment | Trigger | Type | Duration | Values |
|---|---|---|---|---|
| Picker → offerings table | Click a card | Crossfade | 150ms | `opacity` only, `ease-out`; matches `SpecialSchedulesScreen`'s `useCrossfade()` (`:27–41`) verbatim — reuse the hook, don't reauthor it |
| Offerings table → picker (Back) | Click "← Back" | Crossfade | 150ms | Same, reverse |
| Nav row → picker screen | Click "Electives" | None (plain swap) | 0ms | Matches every other nav-item screen swap |
| Row hover | Pointer hover | Existing list hover treatment | n/a | Reuse `SpecialSchedulesScreen`'s `Card` `onMouseEnter`/`onMouseLeave` background swap (`:62–63`) as-is |

`prefers-reduced-motion`: crossfade drops to 0ms, same as `SpecialSchedulesScreen`. No bounce, no
scale — this is a list-to-detail same-surface transition, identical relationship to the one
schedule-build-ia already specced and shipped; there is no reason for it to look or feel different.

---

### Prototype

No HTML mockup produced, for the same reason the schedule-build-ia spec skipped one: both new
surfaces (the picker list, the Add-Offering typeahead) are direct structural reuse of components
already live in this codebase — `SpecialSchedulesScreen.jsx` and `LocationPicker.jsx` respectively.
An HTML mock would reproduce components Maker can and should read directly. If the owner wants to see
the taxonomy decision (separate "Electives" row vs. folded into "Special Schedules") before committing
code, the fastest path is a five-minute sidebar mockup showing both nav layouts side by side — flag
to Governor if the owner wants that before sign-off; it's cheap because it's static nav labels, not a
working prototype.

---

### Implementation notes for Maker

- **Part (a):** Extract `LocationPicker`'s create-flow shape into a sibling `ActivityPicker`
  component (or generalize `LocationPicker` if Maker judges the diff small enough — Designer has no
  preference, but do not duplicate the popover/keyboard-nav logic wholesale; factor the shared bits).
  The activity-mint write must go through the same path `populateElectiveSet` uses for import-minted
  activities (check `src/ingest/electiveSetPopulate.js` for the exact field set it writes on create)
  so manual-create and import-create activities are indistinguishable rows.
- Do not add a capacity/eligibility inline editor to the Add-Offering flow — out of scope per the
  "what a newly-created activity gets" section above.
- **Part (b):** `ElectiveSetDetail` must be exported from `ElectivesScreen.jsx` (or moved to its own
  file) so `ScheduleElectivesScreen` can import it without duplicating ~260 lines. Prefer moving it to
  its own file (`src/screens/elective/ElectiveSetDetail.jsx`, matching the `specialDay/` and `event/`
  subfolder convention already used for `SpecialDayGridEditor`/`EventGridEditor`) over a same-file
  export, for consistency with those two precedents.
- `ElectivesScreen.jsx`'s `selectedSetId` state and inline detail-swap (`:466–555`) should be removed
  entirely once the Schedule-side entry exists, not left dead — same "no regression path back into
  the conflated screen" reasoning the schedule-build-ia spec gave for `SpecialDaysScreen`'s `openId`.
- Locate and redirect the Slice-2 grid drill-in (`initialElectiveSetId` prop, `ElectivesScreen.jsx:
  466,489`) to the new screen — this is the one piece of wiring outside the two screens themselves;
  budget time to find its caller (likely `App.jsx`'s `SCREENS` map or a schedule cell's click handler
  in `src/components/schedule/`).
- New nav key: `schedule:electives`. `AREA_TABLE`'s existing `electives: 'elective_sets'` entry
  (`navSections.js:173`) is reused as-is — no new table.
- No explainer banner, no first-time tooltip, no "new" badge on the nav row — same locked-IA rule
  `schedule-build-ia` applied to `schedule:special`.
- Import (`runImport`, `populateElectiveSet`) is unchanged by this spec — verify no incidental
  regression when `ElectiveSetDetail` moves files (import wiring, refs to `activities`/`locations`
  props must survive the move unchanged).

---

### Open questions for the owner

1. **Confirmed by audit, not open:** import already supports arbitrary/new activities. Part (a)'s
   scope is manual-create only. No decision needed here — stated for the record since the owner's
   phrasing ("either through IMPORT or through MANUAL") could be read as asking to also change import;
   this spec does not touch it because it already does what was asked.
2. **The IA call above (separate "Electives" row vs. folded into "Special Schedules")** — this spec
   recommends separate. Confirm before Maker builds; it's the one visible, easily-reversible-later-but-
   annoying-to-redo choice in this spec.
3. **Elective grid drill-in redirect** — Slice 2 lets a director click the opaque "Electives" cell on
   the campwide grid to jump straight into `ElectiveSetDetail`. This spec redirects that drill-in to
   land inside the new Schedule-side screen instead of the old Roots-hosted one. Confirm that's the
   intended behavior (it should be — the whole point of this spec is that building happens under
   Schedule now) rather than leaving the grid drill-in pointed at Roots as a second, now-inconsistent
   entry point.

---

### Recommended path

Ship both parts together as one small feature: (a) an `ActivityPicker` typeahead-with-inline-create on
Electives' Add-Offering flow, copying `LocationPicker.jsx`'s proven shape and minting activities the
same way import already does, closing the only real gap in "add whatever you want" (import already
covers the rest); and (b) a new, separate "Electives" row under the Schedule nav section — a sibling
to the just-shipped "Special Schedules" row, not folded into it, because electives are core recurring
structure rather than an exception category and Roots already draws that same boundary. Both changes
reuse existing components verbatim (`ElectiveSetDetail`, `LocationPicker`'s pattern,
`SpecialSchedulesScreen`'s picker shape, its `useCrossfade` hook) — no new grid code, no new visual
language, no new tokens. The only decision that needs an explicit owner sign-off before Maker starts
is the nav-taxonomy call in the IA section above.
