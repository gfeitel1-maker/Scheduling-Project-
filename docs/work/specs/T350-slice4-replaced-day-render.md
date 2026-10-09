---
title: "T350 slice 4 - rendering a replaced day on both routes and every view"
document_type: spec
authority: normative
status: draft
date: 2026-10-09
created: 2026-10-09
archive_when: "T350 slice 4 has merged and the replaced-day render matches this spec on Generated and Manual, in group, day and activity views"
authors: [designer]
supersedes: []
ticket_size: medium
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-10-09-special-day-binds-to-a-week-day.md, docs/work/tickets/T350-special-day-week-day-binding.md]
affects: [src/components/schedule/GroupGridFrame.jsx, src/components/schedule/ScheduleDayView.jsx, src/components/schedule/ScheduleActivityView.jsx, src/components/schedule/scheduleGrid.css, src/screens/schedule/gridTracks.js, src/screens/schedule/useDragFSM.js]
---

# T350 slice 4 - rendering a replaced day

Governed by DESIGN_STANDARD sections 1 (personality), 3-4 (palette and roles), 5 (states) and 8 (motion).
Inputs: the ADR D6/D11 and the T350 ticket (slice 4). Mode A (feature brief); the brief was sharp, so
`clarify` produced no questions. This spec decides everything a Maker would otherwise have to choose.

Owner rules applied throughout: show, do not tell (no explanatory sentences in the UI); no banners
(flags and in-grid labels only); centred text in grid cells; screens that are alike look alike;
neither route is canonical (nothing below branches on route).

## Success predicate

For a week whose weekday is bound to a special day, on **Generated and Manual alike**, the group view,
day view and activity view each show that weekday as the special day's grid and notes, in place of the
normal day. The replaced day reads as "different and read-only" without a sentence. Nothing can be
dropped onto it. The retained normal-day rows stay in storage, hidden, never deleted.

Non-goals: the bind/unbind UI (slice 5), exports (slice 6, but this spec fixes the parity seam, see
section 9), engine behaviour (slice 3), editing a special day from the schedule, calendar dates,
any per-route variation.

## 1. One idea, three views

A replaced day is **the same grid, one column (or the whole frame) swapped for a slate-marked,
read-only lane.** Colour is meaning (section 1 of the standard): `--anchor` slate already means
"fixed, structural, not movable" (section 4) and is outside the activity ladder, so it is the one
colour for "this is not a normal editable day". No new token, no hue, no fill-heavy tint, no hatch
(hatch is already spoken for by electives and events).

| View | Normal | Replaced |
|---|---|---|
| Group (columns = days, rows = camp blocks) | one column per day | that day's column becomes a **lane**: one cell spanning every body row, holding the special day's own blocks |
| Day (columns = groups, rows = camp blocks) | selected day's groups x camp blocks | the **whole frame** shows the special day's blocks x groups, and notes as a final row |
| Activity (columns = days) | cells list group names | that day's column is a lane with no cells (the drilldown ignores it, ADR D6) |

Three views, one vocabulary: same slate header mark, same lane surface, same name-as-link. A Tester who
learns it in group view recognises it in the other two.

## 2. Reading it at a glance

Three redundant, non-colour-only signals so it survives greyscale print and colour-vision difference
(section 3: add a channel, not chroma):

1. **Header mark.** The replaced day's column header gets a 2px slate top rule (inset shadow) and the
   special day's **name** as a second line (section 3 below). Position and text, not just colour.
2. **Lane surface.** A flat, borderless-inside field: `--anchor` at 6% over `--surface` with 1px slate-tinted
   side hairlines. No dashed empty-cell outlines inside it, no hover tint, `cursor: default`. Normal days are
   interactive (hover tints, dashed empties); the lane is inert. Inertness is the read-only signal.
3. **Absence of cell chrome.** No identity-dot rail, no `cell-action`, no flags inside the lane.

Contrast check for the Maker (the standard requires verification, not assumption): lane ink
`color-mix(in srgb, var(--anchor) 75%, var(--text))` on the lane surface must be at least 4.5:1;
estimated about 6.5:1. If the measurement disagrees, shift the mix toward `--text`, never lighten.

## 3. The special day's name

- **Where it lives:** in the replaced day's **header cell** in group and activity views; in the
  **top-left header cell** (where "Block" sits) in day view. The same element in all three: a real
  `<button class="lane-open">` whose label is the name and whose click opens that special day for editing
  (`onOpenSpecialDay(specialDayId)`). The name *is* the link: no separate "Edit" text, no sentence.
- **Header cell, group/activity view (two lines, centred):**
  line 1 the day label as today (uppercase condensed 12px); line 2 the name: `var(--font-condensed)`,
  11px, weight 600, `text-transform: none`, `letter-spacing: 0`, ink colour above, single line, ellipsis,
  `title` = full name. Hover and focus: underline plus a 10px right chevron (`stroke-width` 1.5) appears,
  as the row-header chevron does. Header height grows by one line for the whole sticky header row
  (every column gets the extra line's space via `min-height` on the header row only when any column is
  replaced, so headers stay level).
- **Day view top-left cell:** the name replaces the word "Block". Same button, same style, left padding
  as `.row-header`. Frame carries `data-replaced`, which draws the slate top rule across the full
  header row.
- **Day pills (day view):** see section 7.
- **Too long:** ellipsis at the cell width; the full name is in `title` and the accessible name.

## 4. The special day's time blocks (the hard part)

The special day owns its blocks; they need not match camp blocks in count, times or names. The shared
grid's row tracks come from camp blocks (`buildRowTracks`), so a replaced column cannot line up row for
row. **Decision: a spanning lane.**

- **Group and activity view.** The lane is ONE grid item: `grid-column` = the day's column,
  `grid-row: 1 / -1`, `role="gridcell"`, `aria-rowspan = camp block count`, `aria-colindex` as for any cell.
  Inside it, an internal vertical stack of the special day's blocks, in the special day's own order. The
  stack does not try to align with the camp row headers beside it; the lane is visibly its own surface, so
  misalignment reads as intended, not as a bug.
- **Block row inside the lane** (`.replaced-lane-row`): centred, two lines:
  line 1 time range `HH:MM-HH:MM` in the existing `.block-time` look (`var(--font-mono)`, 11px,
  `--text-secondary`); line 2 the cell label for this group via the shared read-only presenter (activity name in
  `.cell-name`, with `.identity-dot` when the slot references a camp activity, plain text otherwise).
  Hairline `1px solid color-mix(in srgb, var(--anchor) 18%, var(--border))` between rows. Block name goes in
  `title` only (the camp grid's row header already spends the block name; the lane spends the time).
- **Row height.** Equal rows, not duration-proportional (the camp grid is not proportional either, so
  alike looks alike): each row `min-height: 40px` (the compact floor in `gridTracks.js`), growing with content.
- **Height contract.** The lane takes normal flow with
  `min-height: calc(var(--lane-rows) * 40px)`. A spanning grid item pushes its excess height into the
  spanned auto tracks (`minmax(48px, auto)`), so when the special day has more blocks than the camp has
  rows, **this week's camp rows grow evenly** rather than the lane scrolling or clipping. Trade chosen
  deliberately: hidden content in a printed-or-screenshotted schedule is worse than taller rows.
  Known edge (accepted, stated): if every camp row is collapsed (fixed 20px tracks) the lane clips with
  `overflow-y: auto`; the lane itself is never `data-collapsed`.
- **Notes.** If the special day has notes, they are the lane's last row (group/activity view) and the
  grid's final full-width row (day view): centred, 12px, `--text-secondary`, `white-space: pre-wrap`. In
  day view that row has a row header whose label is `Notes` (same `.row-header` look), so it is a grid
  row, not a caption outside the grid. Empty notes render no row.
- **Rejected alternatives.** (a) Re-time the whole grid onto a union-of-boundaries time axis: invasive,
  breaks the track model and the row headers. (b) A separate table under the grid: not "in place", and two
  scroll targets. (c) Aligning by position (row i beside row i): false precision when counts differ.
- **Day view needs no lane**: the whole body is the special day, so its blocks simply *are* the rows:
  `buildRowTracks({ timeBlocks: specialBlocks })`, row headers show the special blocks' name and time
  with the existing `.row-header` markup (no collapse toggle: the chevron and `onToggleBlockCollapsed`
  are not rendered, collapse state is keyed to camp block ids and does not apply).

## 5. Cells in a replaced day: read-only, centred

Cell content is centred like every grid cell (`.cell-inner` rules already centre; the lane rows copy the
same flex-centre). A special day cell with no assignment renders **nothing** (no dashed outline: the dashed
outline is the "click to fill" affordance and the lane has none). No flags render in the lane: `OVERLAP`
and `WEEK_CLOSED` are computed after substitution on the visible slots only (ADR D6 ordering), so a
replaced day carries none by construction. Keyboard: the lane is one grid stop; `Tab` reaches the name button
in the header; arrow-key grid navigation lands on the lane as a single read-only cell; `Enter` on the lane
does nothing (the header button is the one action).

## 6. States

| State | Appearance |
|---|---|
| Replaced, has blocks and cells | section 2 + 4 |
| **Empty lane** (special day has no blocks) | the lane shows the standard empty vocabulary: one `.cell-empty`-style dashed box (`1.5px dashed var(--border)`, radius 6) filling the lane inset, centred label = the special day's **name** only, nothing else. Clicking the box opens the special day (same handler as the header name). Hover/focus uses the existing `.cell[data-empty]` tint. It is the one clickable lane state, because an empty special day has exactly one useful action. Export and group/day views agree: name plus notes, no blocks. Day view: the body is one `minmax(120px, auto)` row spanning the frame holding the same dashed box, row header omitted. |
| **Every day replaced** | group and activity view: `data-all-replaced` on the frame removes the 140px row-header column (`columnTracks` gains an option `{ rowHeader: false }`) and the `Block` header cell, body is one row `minmax(200px, auto)`, every column a full-height lane. Day view: unchanged (it already shows one replaced day; every pill carries its name). The Generate control is `disabled` with `title` = "Every day is a special day"; if the engine path is reached anyway, its result surfaces through the existing generation status flag (not a banner, not a modal). |
| **Conflict on the binding** (two devices chose different special days) | a bronze 7px dot (`.flag.flag--placement-conflict`, top-right of the header cell, `--accent`, `box-shadow: 0 0 0 1.5px var(--surface)`, `title` = "Color War or Visiting Day"). This is the existing flag vocabulary (position + dot + tooltip); the lane still shows the winner. In day view the dot sits at the top-right of the top-left header cell. |
| Orphan binding (special day deleted / week or day missing) | no replacement: the normal day shows and nothing renders (ADR D4.7). No placeholder. |
| Loading | the existing skeleton; the lane has no separate skeleton. |
| Bind/unbind write pending/failed | owned by slice 5 (the picker). Slice 4 only renders what the document says. |

## 7. Day pills (day view)

Replaced day pills keep `S.chip` shape, size and selected behaviour unchanged. Markup change only:

```
<button class="press-98 day-pill" data-replaced style={S.chip(...)}>
  <span>Tue</span>
  <span class="day-pill-name">Color War</span>
</button>
```

`.day-pill-name`: `margin-left: 8px; padding-left: 8px; border-left: 1px solid currentColor` at 40%
via `color-mix`; `max-width: 12ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
font-weight: 500; font-size: 11px`. Inherits the chip colour (white when selected, `--text` when not), so
it cannot clash with the selected state and needs no extra colour. A pill with a bronze dot for a binding
conflict reuses `.flag--placement-conflict` positioned `top: -2px; right: -2px`. The name is the marker;
no dot is added for the ordinary replaced case.

Group view pills are groups, not days: unchanged.

## 8. Drag and drop onto a replaced day

Disabled, via the existing mechanism, not a new one. The lane carries:

- `data-cell-key="<selectedGroupOrAll>|<dayId>|replaced"` so `resolveHit` in `useDragFSM.js` resolves a
  hit on it (a missing key resolves `null`, which silently tears down and gives no rejection), and
- `data-drop-disabled=""` so `valid` is false and the FSM tears down instead of committing.

`dayId` must be the real day id (the FSM splits the key on `|`); the third segment `replaced` is a
sentinel that matches no block id, so even a bug that read `valid` wrongly could not write a slot.
There is no per-cell droppable and no `EmptyCell`/`SlotCell` inside the lane, so there is no second path.
Drag source cells elsewhere are unaffected. Drag visuals over the lane (static, no motion, section 8
of the standard and the existing drag rule 1):

```css
.cell[data-replaced][data-drag-over]::after {
  content: '';
  position: absolute;
  inset: 8px 6px;
  border-radius: 8px;
  outline: 2px dashed var(--anchor);
  outline-offset: -2px;
  background: none;            /* rejection draws no fill, unlike a valid target */
  pointer-events: none;
  z-index: 4;
}
.cell[data-replaced][data-drag-over]::before { content: none; }  /* no edge bar: nothing attaches */
```

Maker note: if `useDragFSM` never sets `data-drag-over` on an invalid hit, these two rules are inert and
harmless; rejection is then the (existing) silent tear-down. Do not add a drop-reject animation.
In **Manual**, the same: a replaced lane is not a drop target and never a fill-handle or paste target
(`data-paste-target` is never set on it; the inline editor does not mount in it).

## 9. Print and export parity hints (slice 6 builds the exporters)

- **One presenter, two consumers.** Put the lane's content in a pure module (new
  `src/screens/schedule/replacedLane.js`) exporting `replacedLaneRows({ replacement, groupId })`
  -> `[{ time: '09:00-09:30', label: 'Opening' }]` and `replacedLaneNotes(replacement)`. The React lane
  and the exporters both call it, so screen text and printed text cannot drift (the same trick as
  `scheduleCells.js` for Excel vs JSON).
- **Excel/JSON shape.** Replaced day in the group sheet: the day's column header reads
  `Tuesday - Color War`; the column body is one merged cell across every block row whose text is
  the lane rows joined by newlines (`09:00-09:30  Opening`), `wrapText`, centred; notes in a trailing row
  labelled `Notes`. Day sheet: the special blocks are the row labels, groups the columns, notes the last row.
  JSON: `replaced: { dayId, specialDayId, name, blocks: [...], notes }` beside the normal day, never
  instead of it being silently dropped from `days`. Empty special day: name and notes plus the single
  `-` placeholder line, same as the lane's dashed box.
- **No `@media print` rules exist in the app today and none are added here**; printing goes through
  the exporters. The lane's slate surface is a tint, so the hairline sides and header rule are what survive
  greyscale: that is why they exist.

## 10. Motion (standard section 8)

- **Swap between a normal day and a replaced day** (a bind, unbind, or sync arriving while the view is
  open): the lane/header mark **fades in**, opacity 0 to 1, `--motion-base` (220ms), `--ease-out`; the
  outgoing normal cells are unmounted at the same frame (no cross-slide, no lift, no layout animation).
  Fade only, because a day changing identity is a state change, not a spatial move (Fade, not Lift).
- The initial view entrance is the existing `.schedule-view-enter`; the lane's own fade is imperceptible
  under it and is not suppressed (a descendant selector off `.schedule-view-enter` would also match later
  mounts, since that class stays on the root).
- Hover on the name button: underline and chevron show with `--motion-fast` (140ms) opacity; no movement.
- `@media (prefers-reduced-motion: reduce)`: lane fade `animation: none` (instant swap). Feedback is not
  removed: the header's second line (the name) and the slate rule are the static state change, which is the
  standard's reduced-motion pattern (a static label change instead of movement).
- Nothing in a drag animates (existing rule); nothing else animates.

## 11. CSS and data attributes (scheduleGrid.css, the scoped exception)

New ephemeral state is a data attribute plus a rule here, never React state.

| Attribute | On | Meaning |
|---|---|---|
| `data-replaced` | header cell, lane gridcell, day-view frame, day pill | this day is replaced |
| `data-empty-lane` | lane | special day has no blocks |
| `data-all-replaced` | frame | every day this week is replaced |
| `data-placement-conflict` | header cell, day pill | an unresolved `conflicts` row on the binding |
| `data-drop-disabled` | lane | existing attribute, reused (section 8) |
| `--lane-rows` | lane (inline custom property) | the special day's block count (data, so inline) |

```css
/* ---------- replaced day (T350 slice 4) ---------- */

.schedule-grid--header .cell[data-replaced] {
  background: color-mix(in srgb, var(--anchor) 8%, var(--surface-elevated));
  box-shadow: inset 0 2px 0 var(--anchor);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  overflow: visible;                 /* the conflict dot sits on the corner */
}

.lane-open {
  all: unset;
  box-sizing: border-box;
  max-width: 100%;
  font-family: var(--font-condensed);
  font-size: 11px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: color-mix(in srgb, var(--anchor) 75%, var(--text));
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 4px;
  transition: color var(--motion-fast) var(--ease-out);
}
.lane-open:hover,
.lane-open:focus-visible { text-decoration: underline; color: var(--text); }
.lane-open:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }

.schedule-grid-frame[data-replaced] .schedule-grid--header { box-shadow: inset 0 2px 0 var(--anchor); }

.cell.replaced-lane {                  /* beats .schedule-grid--body .cell on specificity */
  padding: 0;
  cursor: default;
  min-height: calc(var(--lane-rows, 1) * 40px);
  background: color-mix(in srgb, var(--anchor) 6%, var(--surface));
  border-left: 1px solid color-mix(in srgb, var(--anchor) 30%, var(--border));
  border-right: 1px solid color-mix(in srgb, var(--anchor) 30%, var(--border));
  display: flex;
  flex-direction: column;
  overflow-y: auto;                  /* only reachable when every camp row is collapsed */
  animation: replaced-lane-fade var(--motion-base) var(--ease-out);
}

.replaced-lane-row {
  flex: 1 1 40px;
  min-height: 40px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--anchor) 18%, var(--border));
}
.replaced-lane-row:last-child { border-bottom: 0; }
.replaced-lane-row .block-time { color: var(--text-secondary); }

.replaced-lane-notes {
  padding: 8px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

/* Empty lane: the existing empty-cell vocabulary, spanning the lane. */
.cell.replaced-lane[data-empty-lane] { padding: 8px 6px; }
.cell.replaced-lane[data-empty-lane] .cell-empty { flex: 1; width: 100%; cursor: pointer; }
.cell.replaced-lane[data-empty-lane]:hover .cell-empty,
.cell.replaced-lane[data-empty-lane]:focus-within .cell-empty {
  background: color-mix(in srgb, var(--anchor) 10%, var(--surface));
  border-color: var(--anchor);
  color: var(--text);
}

/* Conflict flag: bronze dot, top-right, the existing flag vocabulary. */
.flag--placement-conflict {
  top: 6px;
  right: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1.5px var(--surface);
}

/* Day pill name */
.day-pill-name {
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid color-mix(in srgb, currentColor 40%, transparent);
  max-width: 12ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
}

/* Every day replaced: no camp row-header column. Tracks are set inline by
   columnTracks(n, { rowHeader: false }); this only hides the leftover header. */
.schedule-grid-frame[data-all-replaced] .row-header { display: none; }

@keyframes replaced-lane-fade { from { opacity: 0; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .cell.replaced-lane { animation: none; }
  .lane-open { transition: none; }
}
```

(The drag-over rules are in section 8.)

## 12. Components and files to touch

| File | Change |
|---|---|
| src/components/schedule/GroupGridFrame.jsx | accept `replacements` (Map dayId -> replacement); header: replaced columns get `data-replaced` + `.lane-open`; body: for a replaced day render ONE lane via a new `renderLane` slot instead of per-block `renderCell`; `data-all-replaced` + track option; keep camp rows/row headers otherwise; the collapsed-row flag dot uses camp cells only |
| src/components/schedule/ScheduleDayView.jsx | when the selected day is replaced: frame `data-replaced`, rows = special blocks (no collapse toggles), top-left header = `.lane-open`, notes row; pills get `.day-pill`, `.day-pill-name`, `data-replaced`/`data-placement-conflict` |
| src/components/schedule/ScheduleActivityView.jsx | replaced day column = lane with no rows (name only); header mark as group view |
| src/components/schedule/ScheduleGroupView.jsx, ManualBuildView.jsx | pass `replacements` and `renderLane` (the same lane for both routes; the lane is a shared component, not per-route) |
| new src/components/schedule/ReplacedLane.jsx | the one lane component (rows, notes, empty state, `data-cell-key`, `data-drop-disabled`, aria) used by all three views |
| new src/screens/schedule/replacedLane.js (+ test) | pure presenter shared with exporters (section 9) |
| src/components/schedule/scheduleGrid.css | section 11 and section 8 rules |
| src/screens/schedule/gridTracks.js (+ test) | `columnTracks(n, { rowHeader })`; a lane-height helper if wanted |
| src/screens/schedule/useDragFSM.js | none expected; verify with a test that a hit on `...|replaced` is `valid: false` |
| src/screens/ScheduleScreen.jsx | resolve replacements once (ADR D6 `resolveDayReplacements`) before `withWeekClosureFlags`/`withOverlapFlags`; pass down; wire `onOpenSpecialDay` |

## 13. Tests and evidence required

- Component: lane renders in all three views on both routes with the same output for the same inputs (a
  table-driven test over `route` x `view`); lane has `data-drop-disabled` and a three-segment cell key;
  empty-lane, all-replaced and conflict states; the name is a button with the full name in `title`.
- Pure: `replacedLaneRows` ordering, empty cell omitted, notes trimmed.
- Drag: a drag released on the lane writes nothing and leaves both slots untouched.
- Visual (required by the ticket; demand a *distinguishing* frame, not "it renders"): Generated and
  Manual, group view with a three-camp-block week and an eight-block special day (rows grow), day view,
  activity view, empty lane, every-day-replaced, conflict dot, a replaced pill selected and unselected,
  and the same screens with `prefers-reduced-motion`. Capture with CDP `Page.captureScreenshot`.
- Greyscale check of one frame: the replaced day must still read (rule, hairlines, name).

## 14. Open items for Governor (not blocking)

1. Does a `special_day_slots` cell reference a camp activity (identity dot) or hold free text? This spec
   handles both; if only one exists, the presenter simplifies.
2. Spec decision worth owner awareness: when a special day has more blocks than the camp, **camp rows grow**
   that week. Alternative is an inner scroll, rejected as hidden content. Confidence 0.7.
3. The Generate-disabled title string in the every-day-replaced state is a one-phrase exception to "no
   explanatory text" (a tooltip on a disabled control). Without it the control looks broken. Confidence 0.8.
