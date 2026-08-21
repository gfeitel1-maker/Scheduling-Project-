---
title: 2026-08-21-special-day-author-ui-designer-spec
document_type: spec
status: draft
created: 2026-08-21
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_adrs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
related_specs: [docs/work/specs/2026-08-21-special-day-author-ui-design.md]
related_tickets: [docs/work/tickets/T106-special-day-author-ui.md]
archive_when: T106 ships and merges; visual output matches this spec
---

# Special Day author UI — Designer spec (T106)

This is the visual + interaction spec for the architecture design doc's approach C. It is a
constraint document for Maker, not a suggestion — every value here is either lifted from an
existing token/component or justified against `DESIGN_STANDARD.md`. Where the architecture doc left
a decision to Designer (grid-editor sub-view vs modal — already settled by Governor as sub-view; the
per-cell location affordance — settled here), this spec closes it.

**Personality check for this surface.** A special day is Color War, Maccabiah, a carnival — the
*occasion* is exciting, but the *tool* is not the place that excitement should live. Per
`DESIGN_STANDARD.md` §1, the app is never playful. This screen must feel like a natural extension of
the weekly schedule workspace — same grid, same restraint — not a themed "event builder." The one
thing that's allowed to feel different is the empty state's copy, which can name the occasion by
example without decorating the chrome.

---

## 0. Component/token inventory (what this spec reuses, unmodified)

| Need | Source | Reused as |
|---|---|---|
| Grid container, header, row-header, cell shell | `src/components/schedule/scheduleGrid.css` | classes: `.schedule-grid-frame`, `.schedule-grid`, `.schedule-grid--header`, `.schedule-grid--body`, `.cell`, `.cell-inner`, `.row-header`, `.row-header-toggle`, `.block-name`, `.block-time` |
| Cell leaf rendering (filled) | `src/components/schedule/SlotCell.jsx` | used as-is; no merge/span/elective/flag props passed |
| Cell leaf rendering (empty) | `src/components/schedule/EmptyCell.jsx` | used as-is |
| Inline typed-create editor | `src/components/schedule/CellInlineEditor.jsx` | used as-is (hosted inside SlotCell/EmptyCell already) |
| Grid geometry | `src/screens/schedule/gridPlacement.js`, `gridTracks.js` | `placeCell`, `placeRowHeader`, `columnTracks`, `ROW_FLOOR_NORMAL` |
| Shared component styles | `src/styles/shared.js` (`S.*`) | `S.btnPrimary`, `S.btnSecondary`, `S.btnDanger`, `S.input`, `S.label`, `S.th`, `S.td`, `S.emptyState`, `S.emptyStateTitle`, `S.emptyStateBody`, `S.stateLoading`, `S.errorBanner`, `S.modalLg` |
| List+editor split, empty/error/delete patterns | `src/screens/DayOverridesScreen.jsx` | list table shape, `ConfirmDangerDialog`, `ScreenIntro` |
| Free-text notes pattern | `src/screens/ActivitiesScreen.jsx:447-449`, `AnchorsScreen.jsx:185` | plain `<textarea>` + `useState` + per-field write |

**Nothing in this table is restyled.** New CSS is scoped to two additions inside
`src/components/schedule/scheduleGrid.css` (§3, within the ADR's boundary) and ordinary inline
`S.*`-style objects in the two new screen files (outside `src/components/schedule/`, so plain inline
objects per the general convention, not a new stylesheet).

---

## 1. List screen — `SpecialDaysScreen.jsx`

### Layout

Same shell as every other setup screen (`DayOverridesScreen.jsx` is the direct precedent):

```
<div style={{ maxWidth: 760 }}>
  <ScreenIntro screen="specialdays" />
  {error && <div style={S.errorBanner}>...</div>}
  <div> {count label}                              [+ New Special Day] </div>
  <table>  name | time blocks | groups filled | Actions(Open, Delete)  </table>
  <ConfirmDangerDialog />  (delete)
</div>
```

Columns, left to right:
1. **Name** — `S.td`, `fontWeight: 500`.
2. **Time blocks** — count, `font-family: var(--font-mono)`, `font-size: 12px`, `color:
   var(--text-secondary)` (matches `DayOverridesScreen`'s "N block overrides" cell verbatim).
3. **Groups filled** — a light-touch completeness signal, *not* a progress bar: `"14 / 20 cells
   filled"` in the same mono/secondary style as column 2. This is the one piece of information a
   director actually wants at a glance from the list ("did I finish Color War yet?") and it costs
   nothing — it's a `special_day_slots` count against `groups.length × special_day_time_blocks.length`,
   already-loaded data, no extra query.
4. **Actions** — `Open` (`S.btnSecondary`, navigates to the grid editor sub-view) + `Delete`
   (`S.btnDanger`, admin-gated exactly like `DayOverridesScreen`'s delete button:
   `disabled={role !== 'admin'}`, `title="Admin only"` when disabled).

Row hover: `background: var(--bg)` on `onMouseEnter`/`onMouseLeave`, identical inline pattern to
`DayOverridesScreen.jsx:401-402`. No new hover mechanism — this table is not the schedule grid, so it
doesn't inherit the CSS-file exception; the existing inline hover pattern is correct here.

### Why this reads as distinct from the weekly schedule (design question 1)

The distinction is **navigational and lexical, not chromatic.** Per `DESIGN_STANDARD.md` §1, color is
a data channel — inventing a special-days accent color to "brand" this screen would violate the
personality and the six-color activity palette's exclusivity. Instead:

- **Sidebar placement** (§5 below) puts it under Camp Set Up, not under Schedule — a director reaches
  it from a different mental bucket than "build this week."
- **The list-first structure itself is the signal.** The weekly schedule has no "list of schedules"
  screen (there are exactly two: Manual and Generated, both always visible as fixed nav rows). Special
  Days is the one schedule surface that is *itself a collection* — "here are your constructed days" —
  which is a different shape of screen a director learns to recognize, the same way DayOverrides reads
  differently from Anchors despite both being setup tables.
- **`ScreenIntro`'s copy** (see §6, terminology) is the one place personality can differentiate without
  touching color: something like "Build a full, one-off schedule for a day that doesn't run your normal
  program — Color War, Maccabiah, a carnival, a field-trip day." That sentence alone tells a director
  this isn't "another week."

No new icon, no new accent token. If Roots' Context inventory (D4, out of scope for T106 per the ADR)
later wants a small icon marker for special days there, that's a separate design pass — not introduced
here to avoid a one-off icon nobody else uses.

### Create flow

"+ New Special Day" opens a **small inline prompt, not a modal** — a single name field is not worth a
full `S.modalLg` overlay. Match the lightest-weight existing create pattern in the codebase: an
inline row that appears above the table (input + Create/Cancel), collapsing back when done. This
avoids introducing a new UI pattern (a one-field modal) for a one-field form.

```
[input: "Name your special day…" ] [Create] [Cancel]
```

On submit: write the `special_days` row, then show the **seed-time-blocks prompt** as a second inline
step (not a second screen) directly below the newly created row:

```
"Special Day created. Start with your camp's regular time blocks (you can edit them after), or start empty?"
[ Seed from Time Blocks ]   [ Start Empty ]
```

Both buttons `S.btnSecondary`-weight (this is a convenience choice, not a commitment — neither option
should read as the "primary" recommended path via `S.btnPrimary`'s navy weight, because both are
equally valid and per the architecture doc a director can decline seeding freely). Clicking either
opens the grid editor sub-view immediately.

**Motion:** the inline create row and the seed-prompt row each **Fade + Lift** in
(`opacity 0→1, translateY(8px→0)`, `--motion-base` 220ms, `--ease-out`) — this is exactly
`DESIGN_STANDARD.md` §5a's empty-state entrance vocabulary, reused for a small inserted row rather
than invented fresh. `prefers-reduced-motion`: instant, no fallback tween needed at this scale.

### Empty state (camp has zero special days)

Follow `DESIGN_STANDARD.md` §5a exactly — no card, no shadow, no border, centered, `padding: 60px
16px`:

- Icon: an outline calendar-with-star or similar "event" glyph, ~40px, `stroke-width: 1.5`,
  `var(--text-secondary)`. (Reuse an existing outline icon if the codebase already has one close
  enough — do not invent a bespoke icon library entry for this one screen; a plain outline calendar
  glyph, matching the existing `UnfillableIcon`/`OutdoorIcon` SVG construction style in `SlotCell.jsx`,
  is sufficient.)
- Title: "No special days yet" — `var(--font-condensed)` 600, 15px.
- Body: "Build a standalone schedule for Color War, a field trip, or any day that doesn't follow your
  normal program." — 13px, `var(--text-secondary)`, one line.
- CTA: `S.btnPrimary` "+ New Special Day" (the one primary action on an otherwise-empty screen; this
  is the exception the standard's "Optional single primary CTA" clause covers).
- Motion: **Fade + Lift** on mount, `--motion-base`, per §5a.

### Delete

Reuses `ConfirmDangerDialog` verbatim (same component `DayOverridesScreen` uses). Confirm body is
computed client-side from already-loaded counts, matching the ADR's explicit rejection of a
server-side dry-run/preview endpoint:

> "Delete '{name}'? This special day and its {N} time blocks and {M} filled slots will be removed."

Recovery line: `"'{name}' goes to Trash, and you can put it back from there."` — reused verbatim from
`DayOverridesScreen.jsx`'s `deleteBodyText`/`recovery` pattern, since `deleteSpecialDay`'s cascade is
the same tombstone-based delete model.

---

## 2. Grid editor sub-view — `SpecialDayGridEditor.jsx`

### Layout

Full sub-view (Governor decision 1), reached by "Open" from the list. Structure:

```
<div>
  <div className="back-row">← Back to Special Days   |   {editable name field}</div>
  <div className="grid-toolbar">
    Time blocks: [+ Add Block]        {N groups × M blocks — X / Y filled}
  </div>
  <div className="schedule-grid-frame"> ... groups × special_day_time_blocks grid ... </div>
  <NotesSection />   (see §4)
  <div style={{ marginTop, borderTop, textAlign: right }}>
    [Back to Special Days]
  </div>
</div>
```

This is structurally the weekly `ScheduleGroupView` shape, minus everything the architecture doc
already excluded (routes, engine, spans, electives, undo/redo, clipboard). One CSS Grid container,
`role="grid"`, header row (group names) + body rows (the special day's own time blocks), row-header
column on the left holding the time block name/time — exactly `scheduleGrid.css`'s existing container
and row-header classes, unmodified.

**Name field**: inline-editable title, same convention as most setup-screen headers — click to edit,
blur/Enter to commit a `special_days.name` write. Not a separate "rename" modal.

### Time block row management

Per-row controls live in the `.row-header` cell, alongside the existing `.block-name`/`.block-time`
content, not as a separate editor screen (architecture doc §2, "no need for a separate time-block
editor screen"). Concretely:

- **Add block**: a single `+ Add Block` button in the toolbar (not per-row) appends a new
  `special_day_time_blocks` row with a default name ("New Block") at the end. Opens directly into
  rename mode (see below) so a director doesn't have to click twice.
- **Rename**: click the `.block-name` text → becomes an inline `<input>` (same interaction as the grid
  editor's own name field and `CellInlineEditor`'s general "click to edit inline" pattern). Enter/blur
  commits.
- **Start/end time (optional)**: two small inline text inputs (`type="time"`) below the name, in the
  existing `.block-time` slot's position — `font-family: var(--font-mono)`, `11px`, matching
  `.block-time`'s current style exactly. Left blank, they render nothing (a special day's time blocks
  don't strictly need clock times — Color War stations often just have an order, not a schedule).
- **Reorder**: two small up/down chevron buttons stacked at the left edge of the row header, `16×16`,
  same visual construction as `.cell-action` in `scheduleGrid.css` (border, radius 4, quiet at 0.55
  opacity, full opacity + primary tint on hover/focus) — reusing that button's established look
  rather than inventing a new control style. Writes `sort_order` on click, no drag-and-drop (a
  special day has at most a handful of blocks; drag reorder is over-engineering here per
  karpathy-guidelines — the architecture doc's own "leanest circuit" framing applies to this control
  too).
- **Remove**: a small `×` in the row header, `S.btnDanger`-colored (danger token), with a native
  `window.confirm`-style inline guard **only if the row has filled cells** — matching the app's
  existing lightweight-confirm conventions (no full `ConfirmDangerDialog` for a single row removal;
  reserve that heavier pattern for the special day itself and the whole-template deletes it's already
  used for elsewhere).

### Cells

`EmptyCell`/`SlotCell` render exactly as documented in the architecture doc — reused unmodified, with
`eligibleActivities` = the camp's full activity list, no merge/elective/flag props. `gridRow`/
`gridColumn` come from `placeCell({ blockIndex, columnIndex })` using the special day's own
`special_day_time_blocks` array in place of `timeBlocks`, and the camp's `groups` in place of days —
same call shape, different data source, exactly what `gridPlacement.js`'s "pure function over
`(blockIndex, columnIndex)`" purity buys.

### The per-cell location affordance (design question 2 — the key call)

**Decision: a small secondary line under the activity name, inside the cell, not a separate control
outside it.**

Concretely, inside `.cell-inner`, directly below the existing `.cell-name` line:

```
┌──────────────────────┐
│ ● Capture the Flag    │   ← .cell-name (SlotCell, unmodified)
│ ⌂ Upper Field         │   ← NEW: .cell-location (special-day layer only)
└──────────────────────┘
```

- **Rendered by a thin wrapper, not by `SlotCell`.** Per Governor decision 2, `SlotCell` stays pure.
  The special-day grid editor renders its own small presentational component,
  `SpecialDayCellLocation`, as a **sibling overlay positioned inside the same cell box** — not a
  `SlotCell` prop. Two ways to achieve "inside the same visual cell without touching `SlotCell`":

  **Chosen approach: an absolutely-positioned second line, painted by the special-day container,
  layered over the bottom of the same `.cell` box `SlotCell` already renders.** `.cell` is
  `position: relative` already (scheduleGrid.css line 58); `SlotCell`'s own `.cell-inner` fills it.
  The location line sits as a fourth grid layer using `.cell`'s existing stacking context — a
  `position: absolute; bottom: 4px; left: 12px; right: 12px` node the special-day container renders
  as an **extra child appended after `SlotCell`/`EmptyCell` in the same grid cell's DOM position**,
  using the identical `gridRow`/`gridColumn` placement so it occupies the same grid area. This is a
  peer sibling, not a prop-injected child — `SlotCell` never knows it exists.

  Why not a prop instead: the architecture doc's Governor decision is explicit that `SlotCell` must
  not grow a location-control prop. A sibling absolutely-positioned overlay achieves the visual
  "inside the cell" read without adding a prop, an emitted event, or a new render branch to the shared
  component — it composes at the DOM/CSS layer, which is exactly the seam CSS Grid gives for free
  (multiple children can share one `grid-row`/`grid-column` placement and stack via z-index).

- **Visual weight**: intentionally quieter than the activity name. `font-size: 10px`,
  `color: var(--text-secondary)`, `font-weight: 500`, a small outline "location pin" or "building"
  glyph (12px, `stroke-width: 1.5`, same construction family as `OutdoorIcon`/`UnfillableIcon` in
  `SlotCell.jsx`) at 4px left of the text. No background chip, no border — chips/pills read as
  interactive controls or tags, and a location is neither; it's a second fact about the same cell,
  so it gets typographic weight, not a UI affordance shape. This matches `DESIGN_STANDARD.md` §1's
  "color is a data channel, not ornament" — location is metadata, rendered plainly.

- **Empty state (no location set)**: nothing renders. Do not show a placeholder "+ Add location" line
  on every empty-location cell — that would double the visual density of every filled cell in the grid
  by default, which fights the grid's calm-paper restraint (`DESIGN_STANDARD.md` §1, §3's "usage
  note" about the decolorization pass). A location is optional and the common case; showing an empty
  affordance for the uncommon "add a location" action inverts the visual priority.

- **Interaction — how a director adds it**: **click the location line's area (or, on an empty cell,
  the space just below where the activity name sits) to open a small inline `<select>`** —
  reusing the exact `.cell-inline-editor` visual shell from `scheduleGrid.css` (absolute-positioned,
  `inset: 4px`, `border: 1.5px solid var(--primary)`, `border-radius: 6`, same shadow), but with a
  native `<select>` of the camp's `locations` instead of `CellInlineEditor`'s typeahead input — a
  location list is short and enumerable (unlike activities, which can be typed/created), so a
  dropdown is the right control, not a typeahead. Options: `"— No location —"` (clears) + each
  `locations.name`, alphabetical. Selecting one writes `special_day_slots.location_id` and closes;
  Escape/blur-with-no-change cancels.

  **Discoverability without visual noise**: a location-editable cell that HAS an activity but no
  location shows a **hover/focus-only quiet affordance** — reuse the exact mechanism
  `scheduleGrid.css` already has for `.cell[data-empty]:hover`/`:focus-within` (a subtle tint shift,
  CSS-only, no React state): add one rule, `.cell[data-has-activity]:hover .cell-location-add,
  .cell[data-has-activity]:focus-within .cell-location-add`, showing a barely-there "+ location" text
  affordance (10px, `var(--text-secondary)` at rest → `var(--primary)` on the same hover/focus). At
  rest it is invisible (`display: none`), exactly like the merge button's precedent before T92
  changed it to always-visible — but unlike the merge button, this one stays hover/focus-only on
  purpose, because unlike merging (which the grid legend documents as an important structural
  affordance), "does this cell have a location" is optional per-cell metadata a director sets rarely,
  once, when constructing the day — it does not need permanent visual weight competing with the
  activity name on every glance at a finished grid.

  A cell with no activity yet gets **no location affordance at all** — location without an activity is
  meaningless, so the click target only appears once `activity_id` is set.

### New scheduleGrid.css rules (within the ADR's stated boundary)

Per the ADR (`2026-08-06-schedule-canvas-visual-layer.md` §8 and the codebase's own exception
boundary), these are new ephemeral/interaction states added as classes/attributes in
`scheduleGrid.css`, not React state — consistent with the file's existing pattern:

```css
/* Special-day per-cell location line (T106). Sibling overlay, not a SlotCell
   prop — SlotCell stays pure per the ADR's Governor decision. Shares the
   filled cell's grid placement via a second child in the same grid area. */
.cell-location {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 500;
  color: var(--text-secondary);
  pointer-events: none; /* the click target is the invisible full-cell button below */
  z-index: 2;
}

.cell-location-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

/* Hover/focus-only "+ location" affordance — only on cells that already
   carry an activity and have no location set yet. Mirrors the .cell[data-empty]
   hover-reveal mechanism already in this file. */
.cell-location-add {
  display: none;
  position: absolute;
  left: 12px;
  bottom: 8px;
  font-size: 10px;
  font-weight: 500;
  color: var(--text-secondary);
  z-index: 2;
}

.cell[data-has-activity]:hover .cell-location-add,
.cell[data-has-activity]:focus-within .cell-location-add {
  display: block;
  color: var(--primary);
}

/* Once a location IS set, the add-affordance never shows even on hover —
   the .cell-location line itself is the edit entry point (see JS: clicking
   the location line, not a separate control, reopens the picker). */
.cell[data-has-location] .cell-location-add {
  display: none !important;
}
```

`data-has-activity` and `data-has-location` are plain attributes the special-day container sets on
the same `.cell` shell `SlotCell`/`EmptyCell` already render (they're outer DOM the container owns via
the shared `cellKey`/placement, not props into the leaf components) — consistent with "any new
ephemeral cell state is a data attribute plus a rule in scheduleGrid.css, not React state" (ADR §8,
Future constraints).

**No new design token.** The location line uses `--text-secondary`/`--primary`, already-defined
roles; the icon reuses the existing outline-SVG construction convention. Nothing here touches the
activity palette or introduces a seventh hue.

### States

| State | Treatment |
|---|---|
| Empty cell, no activity | `EmptyCell` unmodified — "Empty" dashed box, hover/focus tint (existing). |
| Filled cell, no location | `SlotCell` unmodified + no `.cell-location` line + `.cell-location-add` hover/focus-only affordance. |
| Filled cell, with location | `SlotCell` unmodified + `.cell-location` line always visible (10px secondary text + icon). |
| Editing activity (typed-create) | `CellInlineEditor` unmodified, exactly as the weekly grid. |
| Editing location (picker open) | New `.cell-inline-editor`-shell-reusing `<select>`, same visual chrome as the activity editor, different control type. |
| Time-block row being renamed | Row header `.block-name` becomes an inline `<input>`, no border change beyond a focus ring (native). |
| Loading (initial grid fetch) | Skeleton per `DESIGN_STANDARD.md` §5b: shaped blocks matching the row/column grid, `color-mix(in srgb, var(--text) 6%, var(--surface))`, 1200ms shimmer (static under reduced motion). |
| Error (grid load failed) | `S.errorBanner` above the grid frame, with retry — per §5c. |
| Delete-block guard | Native lightweight confirm if the row holds filled cells (see above); no confirm if empty. |

### Empty state (zero time blocks, e.g. a director declined seeding and hasn't added any yet)

Same §5a treatment as the list screen, rendered in place of the grid frame:
- Title: "No time blocks yet."
- Body: "Add your first block, or go back and seed from your camp's regular time blocks."
- Two actions: `S.btnPrimary` "+ Add Block", `S.btnSecondary` "Seed from Time Blocks" (only shown if
  seeding hasn't been attempted this session — otherwise just the one primary action).

---

## 3. Record/print notes region (ADR D2)

### Placement

**A "Notes" section below the grid, on the same scroll surface — not a separate tab.** The
architecture doc floated "a Notes tab on the grid editor screen" as an option; this spec picks the
single-scroll placement over a tab for three reasons: (1) a tab hides the notes by default, and
record/print data a director types while actively building the day (team assignments as they place
stations) benefits from being visible, not one click away; (2) the app has no existing tab pattern on
a setup/grid screen to reuse, so a tab would be a new UI primitive for one screen; (3) it matches
`ActivitiesScreen`/`AnchorsScreen`'s precedent of notes-as-a-plain-section, not notes-as-a-modal-or-tab.

```
[ ... grid frame ... ]

──────────────────────────────────────  (border-top: 1px solid var(--border), like existing screen footers)

Notes                                                         [Print]
┌────────────────────────────────────────────────────────────┐
│ Team Yeshiva: bunks 3, 4, 7 — Station 2: Sylvia              │
│ Team Achva: bunks 5, 6, 8 — Station 4: Marcus                │
│ Bus departs 9:15am, returns 3:30pm.                          │
│                                                                │
└────────────────────────────────────────────────────────────┘
```

### Visual style

Plain `<textarea>`, following `ActivitiesScreen.jsx`/`AnchorsScreen.jsx`'s existing pattern exactly:
`S.input`-derived styles but taller — `minHeight: 140px`, `resize: vertical`, `fontFamily:
var(--font-sans)`, `fontSize: 13px`, `padding: 10px 12px`, `border: 1px solid var(--border)`,
`borderRadius: 8px`, `background: var(--surface)`. Label above: "Notes" in the existing section-label
style (`fontFamily: var(--font-condensed)`, `fontWeight: 700`, `fontSize: 12px`, uppercase,
`letterSpacing: 0.05em`, `color: var(--text-secondary)`) — the same label treatment
`DayOverridesScreen.jsx:220-223` ("Block Overrides") already uses.

Save behavior: same per-field write-on-blur (or debounced) pattern the rest of the app's plain
textareas use — no separate "Save Notes" button, matching `ActivitiesScreen`'s convention of folding
this field into the screen's existing per-field write call.

**No structure, no parsing, no rich text.** Per ADR D2 — this is exactly what the architecture doc
already ratified; nothing here reopens that decision.

### Print

No existing `@media print` rules exist anywhere in the codebase today (confirmed by search) — this
is new surface, specified fresh but conservatively:

```css
@media print {
  /* Hide app chrome: sidebar, back button, add/edit controls, cell-action
     buttons, the hover-only location-add affordance (meaningless on paper). */
  .app-sidebar, .grid-toolbar, .cell-action, .row-header-toggle .row-reorder-btn,
  .cell-location-add, .back-row button { display: none; }

  /* Grid: force full contrast, drop shadows/backdrops that don't reproduce
     well, ensure every row prints even if scrolled/collapsed on screen. */
  .schedule-grid-frame { border: 1px solid #000; box-shadow: none; }
  .cell[data-collapsed] { /* never print collapsed — expand for print */ }

  /* Notes: expand to full content height, never clip at the on-screen
     scroll height. */
  textarea.notes-field { display: none; }
  .notes-print-view { display: block; white-space: pre-wrap; font-size: 12pt; }
}
```

Two concrete decisions:

1. **Print the grid and the notes on the same page flow**, notes after the grid, in that document
   order — matching what a director actually wants handed to a counselor at the door: "here's the
   schedule, here's what you need to know." No separate "print notes only" mode for this slice (not
   in ADR scope; flag as a possible follow-up if a director asks).
2. **Collapsed rows must expand for print.** `data-collapsed`'s single-line truncation
   (`scheduleGrid.css`'s collapsed-presentation rules) is a screen-density accommodation; print has no
   scroll-fatigue reason to truncate, and a truncated activity name on a printed schedule is a real
   usability failure (a counselor reading a clipboard can't hover for the full name). Concretely: the
   print stylesheet should force `--grid-rows` back to its uncollapsed value at print time (a print
   media query override on the same custom property, or — simpler and safer — the print action reads
   the live grid state and forces all rows expanded before invoking `window.print()`, then restores
   collapse state after). **Flag to Maker**: the second approach (force-expand via JS, not pure CSS)
   is recommended, because CSS alone cannot override the inline `--grid-rows` custom property's
   *values* (only which rules apply), and the collapsed track height is data-driven per row, not a
   single global class.

`textarea`s do not print their scrollable overflow content in most browsers — hence the `.notes-field`
hide + `.notes-print-view` (a plain read-only `<div>` mirroring the same text) swap above. This is a
plain, well-known print-CSS technique, not a new UI pattern.

**Motion**: none. Print is not an animated surface.

---

## 4. Navigation (design question 4)

Per the architecture doc §5 (Governor decision, already ratified — restated here for completeness,
Designer confirms no visual objection):

- `navSections.js`: new row `{ key: 'specialdays', label: 'Special Days', area: 'specialdays', optional:
  true }` in the **`setup` section**, positioned directly after `dayoverrides` (both are "days that
  aren't a normal week" setup rows — adjacency reads correctly to a director scanning down the
  sidebar, matching the existing rationale comments in this file for why `locations` sits after
  `activities`).
- **Not under the `schedule` section.** A special day is authored once and then it exists as a
  reusable object (per the ADR's D3b durability mapping — special days are tier (c) durable, kept and
  reused), which is a setup-shaped relationship to the camp, not a "build this week" relationship.
  Putting it in `schedule` alongside Generated/Manual would visually imply it's a third route
  competing with those two, which the ADR's D3b explicitly distinguishes it from ("a special day is
  an undated standalone object... it sidesteps the plural-candidates ADR's rule rather than competing
  with it").
- Sidebar row visual treatment: identical to every other optional setup row — no badge, no special
  icon, just the existing `optional: true` styling and the `AREA_TABLE.specialdays = 'special_days'`
  completion-count convention (count of special days created, same mechanism `dayoverrides` already
  uses for template count).

---

## 5. Terminology (design question 3)

Per the architecture doc §7 and Governor decision 3: centralize as a `LABELS` const at the top of each
new file. This spec's copy above (empty-state text, seed-prompt text, delete-confirm text, "Notes"
label) is the **placeholder content** for that object — every user-facing string used in this doc is
written as it should appear in `LABELS`, not as inline JSX, so Maker can lift it directly:

```js
// src/screens/SpecialDaysScreen.jsx
const LABELS = {
  screenTitle: 'Special Days',
  emptyTitle: 'No special days yet',
  emptyBody: "Build a standalone schedule for Color War, a field trip, or any day that doesn't follow your normal program.",
  createCta: '+ New Special Day',
  seedPrompt: 'Special Day created. Start with your camp’s regular time blocks (you can edit them after), or start empty?',
  seedFromBlocks: 'Seed from Time Blocks',
  startEmpty: 'Start Empty',
  deleteConfirmTitle: name => `Delete "${name}"?`,
  deleteConfirmBody: (blocks, slots) => `This special day and its ${blocks} time block${blocks === 1 ? '' : 's'} and ${slots} filled slot${slots === 1 ? '' : 's'} will be removed.`,
  deleteRecovery: name => `"${name}" goes to Trash, and you can put it back from there.`,
}

// src/screens/specialDay/SpecialDayGridEditor.jsx
const LABELS = {
  backLink: '← Back to Special Days',
  addBlock: '+ Add Block',
  notesLabel: 'Notes',
  printAction: 'Print',
  locationPlaceholder: '— No location —',
  locationAddHint: '+ location',
  emptyBlocksTitle: 'No time blocks yet.',
  emptyBlocksBody: "Add your first block, or go back and seed from your camp's regular time blocks.",
}
```

If the terminology-unification ADR (units vs age-division, "programs", "resources"=locations) lands
before Maker starts, Maker substitutes ratified terms directly into these objects — no structural
change needed. Nothing in this spec hardcodes a term the glossary is likely to touch other than
"location(s)" (used above per the current codebase term, since the ADR hasn't landed as of this
writing) and "groups"/"time blocks" (both already the codebase's live terms, unaffected by the units-
vs-age-division question).

---

## 6. Animation summary (Emil-lens, restrained)

Per the app's motion vocabulary (`DESIGN_STANDARD.md` §8: fade/lift/slide/settle, no bounce, three
durations, one ease-out curve) and the finding that this is an Operate surface used occasionally, not
hundreds of times a day — the animation budget here is intentionally small.

| Moment | Purpose | Treatment | Duration/easing |
|---|---|---|---|
| List empty state mount | Prevent jarring pop-in | Fade + Lift (opacity 0→1, translateY 8px→0) | `--motion-base` 220ms, `--ease-out` |
| Inline create row / seed-prompt row insert | Prevent jarring pop-in | Fade + Lift | `--motion-base` 220ms, `--ease-out` |
| Cell inline editor open (activity or location) | Reused unmodified | None — matches existing `.cell-inline-editor`'s deliberate no-entrance-animation ("Quiet, no entrance animation — personality is calm") | n/a |
| Location hover/focus affordance reveal | Feedback (discoverability) | CSS-only `display` toggle via `:hover`/`:focus-within`, no transition needed at this scale (matches `.cell[data-empty]` precedent, which also has no fade — it's an instant tint shift) | instant |
| Grid loading skeleton | Perceived performance | Shimmer, per §5b | `1200ms linear infinite`; static blocks under reduced motion |
| Delete confirm dialog | Reused `ConfirmDangerDialog` unmodified | Whatever that component already does | n/a |
| Row add/remove (time block) | Preventing jarring change | **Deliberately none.** A time-block row insert/removal changing grid track count is a layout-shape change, not a value change — animating grid-template-rows while cell contents reflow risks looking broken given the grid's `minmax(floor, auto)` sizing model (ADR 2026-08-06). Instant is correct here, consistent with the ADR's "collapse is an instant track-height change" precedent (§5.4/DESIGN_STANDARD §8) for the same class of grid-structural change. | instant |

**Rejected candidates** (Emil-lens gate applied):
- Animating the location line's appearance when first set — rejected: it's a data write completing,
  not a UI element the user is actively watching mid-gesture; an instant appearance after the picker
  closes is correct (same logic as the activity name itself, which does not animate in when placed).
- A "confetti" or celebratory animation on special-day creation — rejected outright per personality
  (§1, "never playful") regardless of the occasion's own festive subject matter.
- Print-triggered animation — rejected; print is not an animated surface.

All motion here respects `prefers-reduced-motion: reduce` per the standard's blanket rule; the two
"Fade + Lift" rows fall back to instant/opacity-only exactly as `DESIGN_STANDARD.md` §5a specifies for
existing empty-state motion.

---

## 7. Prototype

Not produced as a separate throwaway HTML file for this pass. Rationale: every visual primitive this
screen uses (grid frame, cell, row header, inline editor, empty state, error banner) already exists
live in the running app (weekly `ScheduleScreen` for the grid; `DayOverridesScreen`/`ActivitiesScreen`
for the list+notes patterns) — the fastest and most accurate way to validate this spec's fidelity is
for Maker to build against the real components and for Tester to review the actual running screen,
not a static mockup that would necessarily diverge from `SlotCell`'s real rendering (dynamic
`activityColor`, real flag glyphs, real `CellInlineEditor` behavior). A static HTML prototype of a
CSS-Grid-based, prop-driven React component tree risks being *less* faithful than the real thing here,
where the weekly screen is a working, visually-identical reference implementation one click away in
the dev app.

**Recommendation to Governor**: skip a standalone prototype artifact for T106; instead, have Maker's
first PR reviewed with Tester driving the actual dev-server screen (per the existing
`Show Me the Running UI` house rule), using this doc's §2/§3 as the acceptance checklist.

---

## 8. Implementation notes for Maker

1. **`SlotCell`/`EmptyCell`/`CellInlineEditor` are imported and rendered exactly as they are today.**
   Do not add props to them for location. The location line and its hover-affordance are rendered by
   `SpecialDayGridEditor`'s own cell-wrapper component (`SpecialDayCell`, suggested name) as a sibling
   DOM node placed via the *same* `placeCell()` result, appended after the `SlotCell`/`EmptyCell`
   element in the grid's DOM — both children share one grid area via identical inline
   `gridRow`/`gridColumn`, which CSS Grid permits (multiple children, one area, stacked by DOM/z-index
   order).
2. **`data-has-activity`/`data-has-location`** are attributes `SpecialDayCell` sets on a wrapping
   element it controls (see the CSS in §2) — they must land on something CSS can select alongside the
   `.cell` box, not inside `SlotCell`'s own render output which the special-day layer does not touch.
   The simplest correct shape: `SpecialDayCell` renders a `<div className="cell-shell"
   data-has-activity={...} data-has-location={...} style={placement}>` that contains both
   `SlotCell`/`EmptyCell` (no placement style of its own — its parent already carries it, so the leaf
   keeps its existing style prop *and* the wrapper places itself identically) and the location overlay
   as siblings. Confirm this composes correctly with `SlotCell`'s own `position: relative`/`.cell`
   class before locking the DOM shape — this is the one part of this spec Maker should sanity-check
   against a real rendered DOM tree early, since `scheduleGrid.css`'s `.cell` selector assumes it's the
   direct grid child.
3. **The location `<select>` reuses `.cell-inline-editor`'s CSS shell** (same class name is fine, or a
   sibling class with identical rules — Maker's call whether to share the exact class or duplicate the
   handful of properties; duplication is acceptable here since the two editors have different DOM
   content, native `<select>` vs `<input>` + suggestion list).
4. **Print** needs the force-expand-before-print approach flagged in §3 — this is real implementation
   complexity beyond a plain `@media print` block; scope it honestly in Maker's task breakdown rather
   than treating it as a one-line addendum to the CSS work.
5. **No new design token, no new activity-palette color, no new icon library.** Every glyph referenced
   here (location pin, calendar) should be built as an inline SVG using the exact construction pattern
   already in `SlotCell.jsx` (`viewBox`, `stroke="currentColor"` or a `var(--token)`, `strokeWidth:
   1.5`, `display: block`) — consistent with the existing `UnfillableIcon`/`OutdoorIcon` components in
   that file, copied as a pattern, not imported (they're module-private to `SlotCell.jsx` today).

## 9. Open items flagged for Governor / owner

1. **Icon choice for the empty-state glyph and the location-pin glyph** are Designer-recommended
   shapes (a generic outline calendar/star; a generic outline map-pin) but not pixel-locked SVG paths
   in this doc — Maker should construct simple, generic outline SVGs matching the existing
   `stroke-width: 1.5` convention; no icon library dependency should be added for two glyphs.
2. **Whether "Groups filled" (list column 3, §1) is worth the extra query cost** at scale (many special
   days × many groups × many blocks) is a performance question Maker/Red Hat should confirm is cheap
   given `special_day_slots` is already loaded for the list's row-count column — flagging so it isn't
   silently dropped as "too expensive" without checking.
3. **Print force-expand mechanism** (§3, item 4 above) needs a concrete implementation decision (JS
   pre-print hook vs. a dedicated print-only render path) — recommend Maker confirm the cheapest
   correct approach during implementation rather than this spec picking one blind.
