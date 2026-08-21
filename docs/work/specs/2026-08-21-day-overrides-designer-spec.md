---
title: "T108 — Day-Overrides re-point: Designer spec"
document_type: spec
status: draft
created: 2026-08-21
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_specs: [docs/work/specs/2026-08-21-day-overrides-repoint-design.md]
related_adrs: [docs/adr/2026-08-21-day-overrides-repoint-shape.md]
related_tickets:
  - docs/work/tickets/T108-day-overrides-repoint.md
archive_when: T108 ships and merges; fold the shipped shape into PLATFORM_STATE
---

# T108 — Day-Overrides re-point: Designer spec

Designer pass, gated by the Architect design + ADR (D4/D5/D6). Scope is exactly the three items the
ADR flags as a Designer call: the "Override this day" entry point + mode signal (D5), the
overridden-cell marker (D4), and the pulled-cell state + print (D6/Q2). Nothing here reopens the
data-shape decisions — this spec assumes `is_overridden`, `day_override_id`, and per-cell `kind`
(`swap`/`pull`) arrive on the row exactly as the architecture spec's `applyDayOverrides` composes
them, before `withWeekClosureFlags`/`withOverlapFlags` run.

Director framing (BDI): the audience is a non-technical camp director scanning a grid, not a
developer. A director's **belief** at the moment they open a day is "this is what actually happens
today." Their **desire**, on noticing a wrong swim slot, is "fix just this one day without breaking
the plan for every other week." Their **intention**, once in override mode, is "everything I touch
right now is a today-only exception." The whole design exists to keep that intention legible without
a single word of explanation — the mode must be impossible to enter or stay in by accident, and an
overridden or pulled cell must read as "different from normal" at a glance, cold, print included.

---

## 1. The "Override this day" entry point + mode

### 1.1 Where it lives, per view

The grid already resolves a `(schedule_week_id, day_id)` differently in the two views — that
resolution point is where the toggle belongs, so it never asks the director to pick a day twice.

**Group view** (one group × all days — columns are days): the toggle lives **in the day's column
header**, the same `.cell` in `.schedule-grid--header` that already renders the day label
(`ScheduleGroupView.jsx`'s header row). Each day column gets its own toggle because each column is a
distinct `(week, day)` — this is the header cell that already carries that binding implicitly via
column index, so no new lookup is needed.

**Day view** (all groups × one day — the whole view *is* one `(week, day)`): the toggle lives once,
**in the view's toolbar**, next to the existing week/day selector controls in `ScheduleScreen.jsx`'s
chrome above the grid frame — not per-column, since every column in this view already shares the one
day binding. This is the same "one control, view-appropriate placement" split the codebase already
uses for other view-scoped affordances (weather toggle, route switch).

### 1.2 The entry control itself

A small outline-pencil icon button, same visual family as `.cell-action` (16×16, `1px solid
var(--border)`, `var(--surface)` fill, `opacity: 0.55` at rest, full opacity + `var(--primary)` tint
on hover/focus) — reused verbatim, not reinvented, per the emil-design-eng principle that a repeated
control should look like the control it already is. Label: "Override this day" (`aria-label`, and a
`title` tooltip; visible text label in day view's toolbar where there's room, icon-only in the
group-view header where space is tight — `title` covers both).

```jsx
// Group view — day column header, day-view — toolbar, same control:
<button
  className="cell-action" // group-view: absolutely positioned inside the header cell
  aria-pressed={overrideMode}
  aria-label="Override this day"
  title="Override this day"
  onClick={() => toggleOverrideMode(weekId, dayId)}
>
  <PencilIcon />
</button>
```

`PencilIcon`: same construction as `UnfillableIcon`/`OutdoorIcon` in `SlotCell.jsx` — a 12×12 outline
SVG, `stroke="currentColor"`, `strokeWidth="1.5"`, so it inherits `.cell-action`'s idle/hover color
via `currentColor` with zero new inline color logic.

### 1.3 The mode's persistent visual signal

Entering override mode is a write-target switch — cell commits now go to `day_overrides`, not
`template_slots`/the engine's output — so the signal must be impossible to miss and impossible to
confuse with any existing state (selection, drag-over, flag-highlight review mode). Three
reinforcing signals, all keyed off one boolean the caller threads down (`overrideMode`, scoped to the
one active `(week, day)`):

**a. A banner above the grid frame**, reusing the recoverable-error banner's shape
(DESIGN_STANDARD §5c) but in `--secondary` (forest green) instead of `--danger`, since this is a
deliberate mode the director chose, not an error:

```
┌─────────────────────────────────────────────────────────────┐
│ ✎  Editing overrides — Wednesday, Week 3           [ Done ]  │
└─────────────────────────────────────────────────────────────┘
```

- Container: `background: color-mix(in srgb, var(--secondary) 8%, var(--surface))`,
  `border: 1px solid color-mix(in srgb, var(--secondary) 35%, var(--border))`,
  `border-radius: 6px`, `padding: 10px 14px`, sits between the toolbar and `.schedule-grid-frame`
  (same slot the existing weather/advisory banners occupy in `ScheduleScreen.jsx`).
- Text: 13px, `color: var(--secondary)` — "Editing overrides — **{Day label}**, Week **{n}**".
  `{Day label}`/`{week name}` come from the same `days_of_operation`/`schedule_weeks` lookups the
  toolbar's own selectors already read; nothing new.
- Right-aligned "Done" button (`S.btnPrimary`-shaped but secondary-toned: `border: 1px solid
  var(--secondary)`, `color: var(--secondary)`, `background: transparent`, hover fills
  `color-mix(in srgb, var(--secondary) 10%, var(--surface))`) — the explicit exit (§1.4).
- Motion: **Slide + Fade** on entry exactly like the existing recoverable error banner
  (`translateY(-4px)→0`, `opacity 0→1`, `var(--motion-base)` `var(--ease-out)`); fade out
  `var(--motion-fast)` on exit. No new keyframe — this is the same treatment class §c already
  defines; only the color role changes.

**b. Grid-scope tint**, applied only to the cells the mode actually affects, so the banner's claim
("editing overrides for Wednesday") is visibly true at the cell level too:

- Group view: the active day's **column** — header cell and every body cell in that column — carries
  `data-override-active` (a plain attribute write from the caller, one column, not per-cell React
  state). Rule in `scheduleGrid.css`:
  ```css
  .schedule-grid--header .cell[data-override-active] {
    background: color-mix(in srgb, var(--secondary) 10%, var(--surface-elevated));
  }
  .schedule-grid--body .cell[data-override-active] .cell-inner {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary) 30%, transparent);
  }
  ```
  An `inset` shadow, not a border, because a real `border` would shift box size against the grid's
  `min-height`/padding contract that T55's collapsed rule depends on (the T55 lesson already
  documented in this file: an inline value or a layout-affecting property fights the collapsed
  override). `inset` box-shadow paints without moving anything.
- Day view: the whole `.schedule-grid-frame` gets the same tint on its `border` (the frame itself,
  not per-cell, since every cell already belongs to the one active day):
  ```css
  .schedule-grid-frame[data-override-active] {
    border-color: var(--secondary);
  }
  ```

**c. Cursor/affordance**: while `overrideMode` is true, `EmptyCell`/`SlotCell`'s existing click-to-edit
affordance is unchanged (still opens `CellInlineEditor`) — the only difference or invisible detail
is *where the commit writes*, so no new interaction pattern is taught. This is a deliberate
Apple-design "familiarity" call: the director already knows how to edit a cell; override mode changes
the consequence of that same gesture, not the gesture itself.

### 1.4 Exit

Three ways out, all converging on the same `toggleOverrideMode(null)` call:

1. **Explicit "Done" button** on the banner (primary path).
2. **Clicking the same toggle button again** (`aria-pressed` flips back) — the entry control doubles
   as the exit control, standard toggle-button semantics, no separate control to remember.
3. **Safety net, not a primary path**: navigating to a different day, week, or route auto-exits
   override mode (the mode is scoped to one `(week, day)`; leaving that context makes the mode
   meaningless to keep active). This must **not** silently drop unsaved work — every commit inside
   override mode already writes immediately through the existing per-cell write queue (per the
   architecture spec §5, same `writeFields` path every other cell edit uses), so there is no
   "unsaved changes" state to lose. Confirm this with Maker: if `CellInlineEditor` is open
   mid-edit when navigation happens, the existing editor-close-on-navigate behavior (if any already
   exists elsewhere in the grid) applies unchanged — this spec does not add a new confirm-dialog,
   consistent with apple-design's Agency principle (don't manufacture a confirmation for a
   non-destructive, already-saved state).

No animation on exit beyond the banner's own fade-out (§1.3a) and the tint's removal, which is an
**instant** attribute removal — same "collapse is instant, never transitioned" rule §5.4/T55 already
established for cell-level state, applied here for consistency. A lingering fade on the tint would
imply the mode is "still a little active," which is exactly the ambiguity D5 exists to prevent.

### 1.5 Reduced motion

The banner's entry/exit fade already inherits the existing recoverable-error banner's
`prefers-reduced-motion` behavior (crossfade only, no translateY) — nothing new to author, confirm
Maker wires the same media query onto this banner's animation, not a duplicate.

---

## 2. The overridden-cell marker

### 2.1 Constraints recap

Must be: distinct from OVERLAP (bronze dot, top-right), distinct from UNFILLABLE (danger icon,
top-right), distinct from WEEK_CLOSED (slate/secondary dot, top-left), distinct from CONTENT_RACE
(slate/secondary dot, bottom-left), able to coexist visibly with UNFILLABLE on the same cell
(generated route: engine gave up, director then overrode it), no new token, `data-overridden`
attribute + `scheduleGrid.css` rule per the ADR's D4.

### 2.2 Color: `var(--secondary)`, reused deliberately

`--secondary` (forest green) is already the hue WEEK_CLOSED and CONTENT_RACE share — that's an
established pattern in this codebase, not a new risk: same hue, told apart by **shape and position**,
not color alone (`slotCellConstants.js`'s own comment on WEEK_CLOSED explicitly names this
precedent). There is no unclaimed semantic color left in the token map (bronze = caution/OVERLAP/
locked, danger = UNFILLABLE/destructive, anchor = fixed structure) — inventing a new hue would
violate DESIGN_STANDARD §3's "do not re-saturate, add a non-colour channel instead." The non-colour
channel here is a **new shape category**: a *frame*, not a dot. WEEK_CLOSED and CONTENT_RACE are
7px corner dots; the override marker is the first cell state to use a full border treatment, which
is by construction unmistakable from a small corner dot even in the same hue.

### 2.3 Treatment

```css
/* scheduleGrid.css addition */
.cell[data-overridden] .cell-inner {
  border: 1.5px dashed var(--secondary);
  background: color-mix(in srgb, var(--secondary) 6%, var(--surface));
}
```

- **Dashed, not solid.** The overlay cell (`template_overlays`, "field trip stamp") already owns a
  **solid** `1.5px var(--accent)` border (`.cell-inner--overlay` in `scheduleGrid.css:130-133`) — a
  different existing concept ("this whole block is stamped with a label"). Dashed reads as "this is
  an exception to the normal week," a deliberate echo of the empty-cell's own dashed border
  (`.cell-empty`, `1.5px dashed var(--border)`) which already uses dashed-vs-solid to mean "this
  isn't the settled/normal state." Reusing that grammar rather than inventing a new one is the
  emil-design-eng "cohesion matters" call: the director learns dashed = "not the baseline" once, and
  it applies everywhere.
- **Background tint stays under the activity-dot legibility floor.** 6% is chosen to sit below the
  existing `data-elective` hatch's 6% (`scheduleGrid.css:311`) and the `data-empty` hover tint's 6%
  (`:353`) — consistent with those, not louder. The activity name and its identity dot must stay
  fully legible on top of it (both are already legible against `--surface`; a 6% wash changes
  contrast by a fraction of a percent, well within the same budget those two existing treatments
  already spend).
- **Border wins visual priority over `isFlagHighlighted`'s review-mode highlight** (generated-route
  "track changes"), since both are inline vs. CSS: `isFlagHighlighted` is composed inline via
  `S.cellFlagHighlight` in `SlotCell.jsx`'s `innerStyle`, which — per this file's own documented rule
  — beats a CSS class. Practically this means: if a cell is BOTH under generated-route review
  highlight AND overridden, the review highlight's inline outline currently wins visually. This is
  acceptable and does not need reconciling in this pass — review-mode is a separate, temporary
  screen-only lens (never printed, per `SlotCell.jsx`'s own comment) and does not persist; flag this
  interaction to Maker as a known, low-stakes order-of-precedence note, not a defect to fix now.

### 2.4 Coexistence with UNFILLABLE

No conflict by construction: UNFILLABLE's icon occupies the top-right corner (`flag--unfillable`,
`top: 4px; right: 4px`); the override border wraps the whole `.cell-inner` perimeter. Both render
simultaneously with zero collision — exactly the "shows both 'the engine gave up here' and 'you
fixed it'" behavior the architecture spec's §5 calls for. No new CSS needed beyond §2.3; this falls
out of the two treatments occupying different visual territory (perimeter vs. corner).

```
┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
┊                        (!) ┊  ← UNFILLABLE icon, top-right, unchanged
┊  ● Art                     ┊  ← identity dot + activity name, unchanged
┊                            ┊
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  ← dashed secondary border = data-overridden
```

### 2.5 First-appearance motion

Per the architecture spec §5 ("reuse the same transition treatment OVERLAP/flag-appearance already
gets on write... no new animation vocabulary needed"): the marker's first application on commit
reuses the existing `flag-changed-ack` keyframe already defined in `scheduleGrid.css:747-750` —
`data-flag-changed` is already the mechanism `useFlagChangeAck` fires on any write that changes a
cell's flags; `applyDayOverrides` writing `is_overridden: true` for the first time on a cell is,
functionally, exactly that kind of change and should route through the same hook rather than a new
one. **No new `@keyframes` block.** Confirm with Maker: `useFlagChangeAck`'s existing change-detection
predicate needs to also fire on `is_overridden` transitioning false→true, not just on the flag set it
watches today — a one-line extension to an existing comparison, not new motion code.

Reduced motion: inherits the existing `@media (prefers-reduced-motion: reduce)` block at
`scheduleGrid.css:776-779`, which already sets `animation: none; opacity: 0;` for
`[data-flag-changed]::after` — nothing new to write.

### 2.6 Legend entry

`LEGEND_ENTRIES` in `slotCellConstants.js` gains one entry, following the exact shape of the existing
five:

```js
{
  flagKey: null, // not an engine-emitted flag — a director-authored diff, like Locked/Fixed event
  label: 'Overridden today',
  shape: 'frame',   // new shape value — the legend component needs a 'frame' renderer alongside
                     // its existing dot/bar/block renderers (small swatch with a dashed border)
  color: 'var(--secondary)',
  description: 'Changed for this day only — the rest of the week is unaffected',
},
```

Placed after `CONTENT_RACE_ENTRY` and before the `Locked` entry in `LEGEND_ENTRIES` — grouped with
the other per-slot-visible-treatment entries, ahead of the structural (bar/block) ones, matching the
existing ordering logic (flags first, then structural chrome). `legendEntriesFor(route)` needs no new
route-based omission: an override can appear on either route (§5 of the architecture spec), so this
entry is never filtered out, unlike UNFILLABLE/OVERLAP.

**Flag for Maker/whoever owns the legend component**: confirm the legend currently only renders
`dot`/`bar`/`block` shapes (per the comment at `slotCellConstants.js:79`) — `frame` is a new shape
the legend's rendering component must gain a case for (a small swatch with the same dashed-border
treatment as §2.3, scaled to legend-swatch size). This is a small, contained addition, not a
redesign of the legend.

---

## 3. The pulled-cell state

### 3.1 What it is not

Not `slot.type === 'unavailable'` (the existing grey block, `S.cellUnavailableFill` — that means "this
group has no scheduled block here at all," a structural absence). A pulled cell **has** a normal
slot underneath (whatever was there before the override); the override replaces its *presentation*,
not its existence. It must never collapse into "Unassigned" or a blank cell — D6/Q2 is explicit that
pulled is **shown**, on grid and print, never omitted.

### 3.2 Grid treatment

A pulled cell is `kind: 'pull'` on the `day_overrides` row (`activity_id = NULL`). It still carries
`data-overridden` (§2 applies — same dashed-secondary frame, since a pull is an override like a swap)
**plus** its own content presentation, replacing the normal `cell-name`/identity-dot line:

```
┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
┊  ⇥  Pulled                 ┊  ← bold, secondary-toned label + icon
┊     Trip to lake           ┊  ← note, muted, one line, italic
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
```

```css
.cell-inner--pulled {
  background: color-mix(in srgb, var(--secondary) 6%, var(--surface));
  /* border comes from .cell[data-overridden] .cell-inner, not duplicated here */
}
.cell-pulled-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--secondary);
}
.cell-pulled-note {
  font-size: 10px;
  font-style: italic;
  color: var(--text-secondary);
  margin-top: 2px;
  overflow-wrap: anywhere; /* same DELTA rule as .cell-name — no clipping */
}
```

Icon: a small outline "arrow-out" glyph (12×12, same SVG construction as `UnfillableIcon`/
`OutdoorIcon` — a door/exit arrow, `stroke="var(--secondary)"`, `strokeWidth="1.5"`), not text-only,
so "Pulled" is scannable at the same glance speed as the other flag glyphs. `showIdentityDot`
suppressed for a pulled cell — there is no activity to color-identify.

- **No note authored**: label only ("Pulled"), no second line — the layout must not reserve empty
  space for an absent note (no fixed-height placeholder).
- **Long note**: `overflow-wrap: anywhere`, same no-clip rule the rest of the grid already commits to
  (`cell-name`'s DELTA comment, `scheduleGrid.css:210-217`) — the row grows via `minmax(floor, auto)`
  rather than truncating, consistent with the CSS Grid ADR's whole rationale for choosing Grid over
  absolute positioning in the first place (§4 of that ADR, "a cell that cannot size to its content is
  the wrong foundation").
- **Collapsed row**: `[data-collapsed]` already hides everything except a single-line dimmed name
  (`scheduleGrid.css:543-567`). A pulled cell's collapsed presentation shows "Pulled" as that single
  line (same font/size/color rule as `.cell[data-collapsed] .cell-name`) and the note is hidden along
  with every other collapsed-state detail — consistent, no special-case needed if `cell-pulled-label`'s
  text content becomes the thing that rule targets (Maker: route the collapsed rule to read
  `cell-pulled-label` the same way it reads `cell-name` today, or normalize by giving the pulled label
  the `cell-name` class with a `data-pulled` modifier instead of a fully separate class — implementer's
  choice, not a visual decision).

### 3.3 Authoring a pull

Not a new UI surface: pulling a group for a block (or a whole day, per the architecture spec §3.1's
"one row per block") happens through the same `CellInlineEditor` already mounted in override mode
(§1), with one addition — the inline editor's suggestion list gains a **"Pull — mark this group out"**
option alongside the existing activity-name suggestions, distinguished the same way the "Create ..."
suggestion already is (`cell-inline-editor-suggestion--create`'s `color: var(--primary)` precedent):

```css
.cell-inline-editor-suggestion--pull {
  color: var(--secondary);
  font-weight: 600;
}
```

Selecting it opens a **single optional text input** for the note ("Trip to lake") inline, not a modal
— same footprint as the existing elective-chip-preview pattern already living inside
`cell-inline-editor` (§0/T105 precedent: edit-time-only content growth below the input, not a
permanent layout change). Committing with an empty note is valid (no note is a legitimate, common
case — a half-day pull with an obvious reason doesn't need one spelled out).

**Whole-day pull** (all blocks in the day, one group, one trip): a single "Pull [Group] for the whole
day" action, exposed once per group per day rather than requiring the director to repeat the same
pull N times across every block — concretely, this reads best as a control on the **row header**
(the group's row label, in whichever view has groups as rows) while `overrideMode` is active,
alongside the day-header toggle from §1. This authors N `day_overrides` rows in one write, mirroring
`DayOverridesScreen.jsx`'s existing delete-then-recreate batch pattern the architecture spec's §3.2
already calls for reuse of — same interaction shape, just re-scoped, not a new batching mechanism to
design here.

### 3.4 Print

Reuses the print rules already established for the special-day grid (`scheduleGrid.css:952-975`) as
the template — this is the same class of surface (a grid that must remain legible on paper without
relying on interactive chrome).

```css
@media print {
  .cell[data-overridden] .cell-inner {
    /* Dashes remain visible in monochrome print — no color-dependent change needed for the frame. */
    border-style: dashed;
    border-color: #000; /* print-safe: color-mix against --secondary can print too light on some
                            drivers; force black at print time, same defensive pattern the existing
                            print block uses for .schedule-grid-frame's border (#000, not var(--border)). */
  }
  .cell-pulled-label,
  .cell-pulled-note {
    color: #000; /* legibility over color fidelity on paper, matches existing print block's
                    treatment of borders */
  }
  .cell-action, .row-header-toggle .row-reorder-btn {
    /* already hidden by the existing print block's selector list — the override toggle button
       (§1.2, .cell-action) is covered by the existing ".cell-action { display: none }" print rule
       with zero new selectors needed. */
  }
}
```

- The override-mode **banner** (§1.3a) must also be hidden at print time — add it to the existing
  hidden-controls selector list (`.app-sidebar, .grid-toolbar, .cell-action, ...`) alongside the
  other screen-only chrome; a director printing an overridden day is printing the *result*, not the
  authoring mode.
- The dashed border is the one channel guaranteed to survive black-and-white printing regardless of
  driver color handling — consistent with DESIGN_STANDARD §3's whole rationale for the activity
  palette's greyscale-legibility requirement (print is a first-class medium this app is designed
  against, not an afterthought).
- Pulled cells print their label and note as plain black text — no dependency on the icon glyph
  surviving print (SVG `stroke="var(--secondary)"` — confirm Maker forces `stroke: #000` under
  `@media print` on the pull icon the same way the label/note colors are forced above, so the glyph
  doesn't silently vanish or print a near-invisible tint).

---

## 4. Motion summary (for Maker, all reused — nothing new)

| Moment | Treatment | Source (reused, not new) |
|---|---|---|
| Override-mode banner enters/exits | Slide + Fade, `--motion-base`, `--ease-out` | DESIGN_STANDARD §5c (recoverable error banner) |
| Override-mode tint appears/disappears | Instant, no transition | T55 collapse-is-instant precedent |
| Overridden-cell marker's first appearance | `flag-changed-ack` keyframe | `scheduleGrid.css:747-750`, `useFlagChangeAck` |
| Pulled-cell label appearance | Same as above (it's an override) | same |
| All of the above under `prefers-reduced-motion` | Existing fallbacks apply unchanged | `scheduleGrid.css:763-784`, DESIGN_STANDARD §5 |

No bounce, no elastic, nothing new to the motion vocabulary — every moment in this spec maps onto a
transition the grid already ships.

---

## 5. Prototype

Not built as a separate throwaway HTML file for this pass: every treatment above is expressed as a
direct addition to the live `scheduleGrid.css`/`SlotCell.jsx`/`EmptyCell.jsx` seam, small enough
(one new attribute, one new CSS block, one new icon, one legend entry) that a static HTML mockup
would duplicate rather than clarify the spec — the ASCII sketches in §1–§3 pin the layout precisely
enough for Maker, and the real visual check happens by running the app (per the "show me the running
UI" standing preference) once Maker lands the CSS, not by reviewing a disconnected mockup first. If
Governor wants a live prototype before Maker starts, flag it — this spec is written so one is
optional, not load-bearing.

---

## 6. Implementation notes for Maker

- **Do not introduce new inline color logic.** Every color reference above is `var(--secondary)` or
  `color-mix(in srgb, var(--secondary) N%, ...)` — no new hex, no new token, matching D4's explicit
  constraint.
- **`data-overridden` and `data-overridden-kind` (`swap`|`pull`)**: two attributes, not one — the
  frame border (§2.3) applies whenever `data-overridden` is present; the pulled-specific label/note
  presentation (§3.2) is gated on `data-overridden-kind="pull"` specifically, so a swap override never
  accidentally renders pull's label/note markup.
- **`overrideMode` and `data-override-active` are UI-session state, not persisted** — scoped to
  `(week, day)` in whichever screen-level state already holds `route`/`selectedWeek`/`selectedDay` in
  `ScheduleScreen.jsx`. Do not add a `day_overrides` column for "is this day currently being edited" —
  that would conflate authoring UI state with the data model the architecture spec deliberately kept
  clean (§4 of that spec: no `template_id`, no route flag on the row itself; this spec must not
  reintroduce an equivalent mistake for UI mode).
- **The legend's new `frame` shape** (§2.6) is the one piece of UI outside `scheduleGrid.css`'s strict
  per-cell boundary that needs new code (a legend swatch renderer) — confirm with Maker where the
  legend component actually lives before assuming it's a trivial addition; this spec specifies its
  visual only, not its file location.
- **Composition-order dependency (inherited, not introduced by this spec)**: per the architecture
  spec's D4/§3.3, `applyDayOverrides` must run before `withOverlapFlags`/`withWeekClosureFlags` in the
  `slots` pipe for OVERLAP to correctly fire against a swapped-in activity's contention. This spec's
  visual treatments assume that ordering is correct; if it's backwards, an overridden cell could show
  the dashed frame without OVERLAP ever evaluating the post-swap content — a data bug, not a visual
  one, but worth Maker re-confirming against the architecture spec's own test plan before this spec's
  visuals are considered "done."
