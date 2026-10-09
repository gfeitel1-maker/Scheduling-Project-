---
title: "T350 slice 5 - binding a special day to a week and weekday (the editor's Placed on strip and day grid)"
document_type: spec
authority: normative
status: draft
date: 2026-10-09
created: 2026-10-09
archive_when: "T350 slice 5 has merged and the special day editor places, replaces and unbinds a special day exactly as this spec describes, with every write failure shown on the control that failed"
authors: [designer]
supersedes: []
ticket_size: medium
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-10-09-special-day-binds-to-a-week-day.md, docs/work/tickets/T350-special-day-week-day-binding.md, docs/work/specs/T350-slice4-replaced-day-render.md]
affects: [src/screens/specialDay/SpecialDayGridEditor.jsx, src/screens/SpecialSchedulesScreen.jsx, src/components/schedule/GridEditorFrame.jsx, src/localClient.js]
---

# T350 slice 5 - binding a special day to a week and weekday

Governed by DESIGN_STANDARD sections 1 (personality), 4 (colour roles), 5 (states), 6a (shared primitives)
and 8 (motion). Inputs: ADR D5, D8, D9, D11; ticket slice 5; the slice 4 render spec (the replaced-day
vocabulary this slice must feed and match). Mode A (feature brief). The brief was sharp, so `clarify`
produced no questions; the three judgement calls it left open are decided in section 12 and flagged there.

Owner rules applied: show, do not tell; no banners (a failure lives on the control that failed); no
coming-soon controls; alike screens look alike (the editor, the picker list and the schedule screen reuse
one vocabulary, section 1).

## Success predicate

A director with a special day open can, in two taps and no typing, put it on a chosen week and weekday;
see at a glance every day it already occupies and every day another special day occupies; take it off
again; and, if the day is taken, get exactly one confirmation that says what undo restores. No write fails
silently. An empty special day (placed nowhere) looks unfinished-but-calm, with one visible next step.

Non-goals: calendar dates (ADR option C); binding from the schedule screen (decided in section 9);
editing a special day's content (unchanged); half-day takeover (that is an Event); new IPC (the two exist).

## 1. One idea: the day grid is the picker

Do not build "a week dropdown and a day dropdown and a Bind button". The picker is a **week x weekday
grid** whose cells show their own state, because the question the director is really asking is "which
days are free, which are mine, which are taken". A form hides that until after the click; a grid shows it
before. It is also the same shape as the thing being edited (weeks down, days across), so it reads as a
map, not a form: show, do not tell.

The same vocabulary appears on three surfaces and nowhere else gets a new one:

| Surface | What it shows | Vocabulary |
|---|---|---|
| Special day editor (this slice) | `Placed on` strip: one slate chip per placement, then a dashed `Place on a day` button that opens the day grid | slate = "this day is a special day" (slice 4 colour), dashed outline = "free, click to fill" (existing empty-cell form) |
| Special Schedules list (this slice) | `Placed Week 2 Tue` sublabel on the row | identical to the Events row sublabel `Placed Mon` (alike looks alike) |
| Schedule screen (slice 4, unchanged) | slate header name, lane, day-pill name | slice 4 |

Colour: `--anchor` is the only hue (it already means "fixed, structural, not a normal editable day",
section 4). `--accent` bronze appears once, for the day awaiting a replace confirmation (section 4
"attention, in progress"). `--danger` appears only on a failed write. No new token, no new hue.

## 2. Layout

New component `src/screens/specialDay/SpecialDayPlacements.jsx` (inline style objects, section 8: the
CSS exception ends at `src/components/schedule/`, and this lives in `src/screens/specialDay/`). It owns
its own data and writes; the editor renders it and passes `campId`, `specialDayId`, `specialDayName`.

`GridEditorFrame` gains one optional slot, `meta`, rendered between the back row and `banners`. Only the
special day editor passes it. (`EventGridEditor` is untouched; events are placed from the schedule.)

```
<- Special Schedules   Color War                                      <- back row + title (unchanged)

PLACED ON  [ Week 2 . Tue  x ]  [ Week 3 . Tue  x ]  [ + Place on a day ]      <- the strip (new)

[ + Add Block ]                                  4 groups x 5 blocks - 12 / 20 filled   <- toolbar (unchanged)
```

With the day grid open the strip's lower edge gains the panel (it pushes the toolbar and grid down; it is
a disclosure, not an overlay, so there is no stacking context to manage and no scroll trap):

```
PLACED ON  [ Week 2 . Tue  x ]  [ + Place on a day ]

+--------------------------------------------------------------+
|            Mon    Tue    Wed    Thu    Fri    Sat    Sun     |
|  Week 1   [   ]  [Visit] [   ]  [   ]  [   ]  [   ]  [   ]   |
|  Week 2   [   ]  [ ## ]  [   ]  [   ]  [   ]  [   ]  [   ]   |   ## = this special day
|  Week 3   [   ]  [ ## ]  [   ]  [   ]  [   ]  [   ]  [   ]   |   [Visit] = another special day (name)
|  Week 4   [   ]  [   ]  [   ]  [   ]  [   ]  [   ]  [   ]   |   [   ] = free (dashed)
+--------------------------------------------------------------+
   Week 1 Tuesday already uses Visiting Day. Use Color War instead?
   (Visiting Day stays saved; bind it again to undo.)
   [ Use Color War ]  [ Cancel ]                                       <- only while a replace is pending
   (x) Could not place Color War on Week 4 Friday.  Try again          <- only after a failure
```

### The strip

- Row: `display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px`.
- Label `Placed on`: `S.sectionCount` (the canonical count-header token, section 6a). Not restyled.
- **Chip** (one per placement): `S.chip('var(--anchor)', true, { padding: '4px 4px 4px 12px', fontSize: 12, fontFamily: 'var(--font-sans)' })`.
  Text `Week 2 . Tue` (a middle dot with spaces; `week.name` then `day.label`). White on `--anchor` measures
  about 5.5:1 (computed, above the 4.5:1 floor). Inside, after the text, a 24x24 icon button
  (`<button aria-label="Remove from Week 2 Tuesday">`) holding `CloseIcon size={10}` (outline, stroke 1.5),
  white at 80%, 100% on hover and focus. 24px is the hit target; the glyph stays 10px.
- **Order:** week `sort_order`, then day `sort_order`. Stable, so a rebind never reshuffles the strip.
- **Place button:** `S.btnSecondary` shape with `border: 1.5px dashed var(--border)`, text `+ Place on a day`.
  This is the existing dashed "empty, click to fill" form, deliberately: an unplaced special day should
  look like an unfilled cell, not a missing feature. While the day grid is open it shows
  `aria-expanded="true"` and the label becomes `Done`, which closes it (no separate close control).
- **Placed nowhere** (the empty state): the strip shows the label and the dashed button only. No sentence,
  no icon block, no card (section 5a asks for a calm empty, not a boxed one; this is a one-line control, so
  the full centred-block pattern would be oversized and is deliberately not used).
- A placement whose week is archived still shows as a chip (it is a real binding) with the week name
  followed by ` (archived)` in the chip text; it can be removed but its week is not a row in the grid.
- A placement whose week, day or special day no longer exists is not shown (ADR D4.7/D5: tolerated, never
  rendered).

### The day grid (the picker panel)

- Panel: `background: var(--surface)`, `1px solid var(--border)`, `borderRadius: 10`, `padding: 12px`,
  `max-width: 560px`, `margin-bottom: 16px`. No shadow (it is in flow, not floating).
- Columns: `grid-template-columns: 96px repeat(N, minmax(52px, 1fr))` where N = the camp's days of
  operation in `sort_order` (so a Mon-Fri camp shows five columns; weekend columns exist only if the camp
  runs weekends). Header cells: the first three characters of `day.label`, 11px condensed uppercase,
  `--text-secondary`, `title` = full label. Row headers: `week.name`, 12px, ellipsis, `title` = full name.
- Rows: every non-archived week in `sort_order`. More than 8 rows scroll inside the panel
  (`max-height: 8 * 36px + header`, `overflow-y: auto`); the header row is `position: sticky`.
- Cells: 36px high (32px button + 4px gap), `borderRadius: 6`, centred content, 11px.
- A camp with no weeks cannot reach this (the schedule screen always has a week); if the list is empty the
  grid shows the existing `S.emptyState` title `No weeks yet.` and no cells (defensive, untested path).

## 3. Cell states (the visual contract)

| State | Appearance | Click does |
|---|---|---|
| Free | `1.5px dashed var(--border)`, transparent. Hover/focus: border `--anchor`, fill `--anchor` 10% over `--surface`. | Binds this special day. No confirmation (nothing is lost, and the next row of the table is the undo). |
| **Mine** (this special day is here) | solid `--anchor` fill, white outline-check icon 12px (stroke 1.5), `title` = "Remove from this day". | Unbinds. No confirmation: unbinding is lossless (ADR D4.6/D8). |
| **Taken** (another special day) | `--anchor` 8% over `--surface`, `1px solid` `--anchor` 30% over `--border`, label = that special day's name, 10px, ink `color-mix(in srgb, var(--anchor) 75%, var(--text))` (the slice 4 lane ink, about 6.5:1), single line, ellipsis, `title` = full name. | Opens the replace confirmation (section 4). |
| Taken, special day missing (stale placement) | as Taken with label `Another` | Same; the confirmation says "another special day". |
| Replace pending | any Taken cell with `outline: 2px solid var(--accent); outline-offset: -2px` (bronze = attention) | n/a, see section 4 |
| In flight | `opacity: 0.6; cursor: progress; aria-busy="true"`, click ignored | n/a |
| Failed | `outline: 1.5px solid var(--danger); outline-offset: -1.5px`, plus the failure line (section 6) | Retries the same action |

Non-colour channels (greyscale and colour-vision safe, the section 3 rule): free = dashed edge, mine =
check glyph on solid fill, taken = a text label. State is never carried by colour alone.

`aria`: the panel is `role="grid"` with `aria-label="Days for Color War"`; rows `role="row"`; cells
`role="gridcell"` containing the one button. Button `aria-label` is a full sentence per state:
"Week 2, Tuesday, free. Place Color War here." / "Week 2, Tuesday, Color War is here. Remove." /
"Week 2, Tuesday, Visiting Day. Replace with Color War." Taken-cell buttons do not use `aria-haspopup` (the
confirmation is inline, not a dialog); the confirmation region is `role="group"` with
`aria-label="Confirm replace"` and receives focus (section 4).

Keyboard: one tab stop for the grid (roving `tabindex`, arrow keys move by cell, Home/End to row ends,
Enter/Space activates, Escape closes the panel and returns focus to the `Place on a day` button). Check
whether `src/components/schedule/useGridKeyboardNav.js` is generic enough to reuse; if it is tied to the
schedule grid's `data-cell-key` model, write the thirty-line roving handler locally rather than bending it.

## 4. The occupied-day replace prompt (one confirmation, names the undo)

Triggered by (a) clicking a Taken cell, or (b) `bindSpecialDay` returning
`{ ok: false, reason: 'occupied', currentSpecialDayId }` for a click that looked Free (another device
bound it a moment ago). Both go to the same state, so the second path is not a separate design; (b) uses
`currentSpecialDayId` to name the occupant.

It is **inline, directly under the grid, not a modal.** Reasons: nothing is destroyed (ADR D4.6 keeps both
the old binding's special day and the day's stored slots), so the danger modal (`ConfirmDangerDialog`,
red button) would overstate it; a modal also hides the grid the director is choosing from, and the
bronze-outlined target cell is the context that makes the question answerable. Confidence 0.7; the
alternative (a `ConfirmDangerDialog`-style modal with a non-danger button) is workable if the owner
prefers to see every replacement as an interruption.

Content (the ADR D11 sentence, verbatim in structure, in two lines):

```
Week 2 Tuesday already uses Visiting Day. Use Color War instead?
(Visiting Day stays saved; bind it again to undo.)
[ Use Color War ]  [ Cancel ]
```

- Line 1: 13px, `var(--text)`. Line 2: 12px, `var(--text-secondary)`. Special day names are in the
  sentence as text, not styled, so a long name wraps rather than truncating the question.
- Buttons: `S.btnPrimary` `Use Color War` (names the action, not "Yes"), `S.btnSecondary` `Cancel`. Navy,
  not brick: this is not destructive (section 4: red is "destructive and error only").
- **One confirmation, ever.** There is no second "are you sure", and no confirmation for Free or Mine
  cells. Confirming calls `bindSpecialDay({ weekId, dayId, specialDayId, replace: true })`.
- Focus moves to `Use Color War` on open (the director just chose to replace; Enter continues, Escape
  cancels). Escape, `Cancel`, clicking another Taken cell (re-targets), or clicking a Free cell
  (cancels the pending replace, then binds that cell) all dismiss it. Closing the panel dismisses it.
- It cannot go stale silently: if the occupant changed between opening and confirming, the IPC still
  receives `replace: true` and the older name in the sentence was merely true a moment ago. This is the
  same last-writer behaviour ADR D5 already accepts for a replace; the strip and grid then re-read and
  show what actually happened. (Not worth a second round-trip prompt.)
- Motion: appears with Fade + Lift (`opacity 0 -> 1`, `translateY(4px) -> 0`, `--motion-base`
  `--ease-out`); leaves with Fade, `--motion-fast`. Reduced motion: instant, no translate.

## 5. States and feedback (section 5 of the standard, per write)

Three writes: **bind**, **replace** (bind with `replace: true`), **unbind**. Each shows the three
feedback states the standard requires, on the cell and chip it concerns.

| Phase | Cell (grid) | Chip (strip) |
|---|---|---|
| Pending | cell `aria-busy`, opacity 0.6, `cursor: progress`, ignores clicks. Writes are local and usually finish in a frame, so there is **no spinner and no bar** (a 16px spinner flashing for 20ms is noise, section 5b's "blocking action" is for slow work). If a write is still pending after 400ms, the cell shows a 12px outline spinner (stroke 2, `--text-secondary`) in place of its content. | on unbind: chip opacity 0.6 and its x disabled |
| Success | cell crossfades to its new state, `--motion-fast` (140ms) `--ease-out`, colour/border only. The strip chip **appears** with Fade (`opacity 0 -> 1`, `--motion-fast`) or **leaves** with Fade (`--motion-fast`); no layout animation, the remaining chips reflow instantly. | same |
| Failure | section 6 | the chip stays; failure line under the strip |

Success has no toast and no banner: the cell and the chip changing *is* the confirmation (show, do not
tell). The re-read after every write (section 7) is what guarantees the screen shows the real result.

`prefers-reduced-motion: reduce`: all crossfades become instant (`transition: none`); the state change
is still carried by the static fill/glyph/label difference. Nothing here animates by movement except the
4px lift on the confirmation, which is dropped.

## 6. Every write failure, shown where it happened

No banner, no toast, no `window.alert`. A **failure line** renders directly beneath the control group that
failed (under the grid when the click was in the grid; under the strip when the chip x was clicked), as
plain text with an icon, no filled box (a filled strip across the top of the screen is the banner the
owner rejected; one line attached to the cell is not):

```
(!)  Could not place Color War on Week 4 Friday.   Try again
```

- 16px outline alert icon + message: 13px, `var(--danger)` (section 4: errors are brick). `Try again` is a
  link-button in `var(--primary)` that re-runs the same action (section 5c: a recoverable error always
  offers the next action). `role="alert"`. Appears with Slide + Fade (`translateY(-4px) -> 0`,
  `--motion-base`); reduced motion: instant.
- The failed cell carries the danger outline of section 3 until the next action or a successful retry.
- One failure line at a time; it clears on the next attempt, a successful write, or closing the panel.
- **Message mapping** (the unknown-outcome rule of ADR D9 applies to all of them: after any failure,
  re-read the placements first, so the line never contradicts what the grid then shows):

| Result | Message (director language, ends with a full stop) |
|---|---|
| `reason: 'unknown-week'` | `That week no longer exists.` then the week row re-reads away |
| `reason: 'unknown-day'` | `That day is no longer in this camp's schedule.` |
| `reason: 'unknown-special-day'` | not shown inline: routes to the existing `onDeletedElsewhere` path (the editor already leaves with "This special day was deleted.") |
| `reason: 'occupied'` | not a failure: opens the confirmation (section 4) |
| any other `{ ok: false, reason }` | `describeWriteFailure(new Error(reason), 'Could not place Color War on Week 4 Friday.')` |
| thrown error / rejected / timed out | `describeWriteFailure(err, '<whatFailed>')`; `whatFailed` is `Could not place <name> on <week> <day>.` / `Could not remove <name> from <week> <day>.` |
| session or permission denial | already auto-routes to login via `shoresh:auth-rejected`; the inline line carries `describeWriteFailure`'s copy for the residual case |

`describeWriteFailure` already refuses to blame the network for a non-network failure; use it, do not
write a second translator. Because `bindSpecialDay`/`unbindSpecialDay` resolve with `{ ok: false }` rather
than throwing for the refusals above, the component must branch on `result.ok === false` before it
treats the call as success (the existing `writeField` helper's `status` check does not apply here).
**Required test:** a mocked `{ ok: false, reason: 'unknown-week' }` renders the line and does NOT add a
chip.

## 7. Data and live updates

- Reads (all via `localClient.list`, parallel, camp-filtered): `special_day_placements`, `schedule_weeks`,
  `days_of_operation`, `special_days` (names for Taken cells and the prompt). `special_day_placements`
  is registered for `list` by slice 1 (`SCOPED_LIST_ENTITIES`); `localClient.mock.js` must serve it for
  the browser-mock visual check.
- Placement identity is the derived `(weekId, dayId)`; the component never builds an id itself and never
  writes `special_day_placements` through `localClient.write` (the generic write refuses it, ADR D8).
  It calls only `localClient.bindSpecialDay` / `unbindSpecialDay`.
- **Re-read after every write, success or failure** (not optimistic): it makes the screen equal to the
  document, covers the unknown-outcome case, and local writes are fast. The component keeps only
  transient UI state (`panelOpen`, `inFlight: Set<key>`, `pendingReplace`, `failure`).
- **Live:** subscribe to `localClient.onOpApplied` and re-read when `op.entity === 'special_day_placements'`
  or `'special_days'` or `'schedule_weeks'`, using the editor's existing ref-for-the-callback pattern, so
  another device binding while the panel is open updates the grid under the director's hands. If that
  moves the cell a replace is pending on, the pending state clears (the occupant it named is stale) and
  the cell simply shows its new state: no apology text.
- **Conflict (two devices chose different special days):** a chip whose placement has an unresolved
  `conflicts` row gets the slice 4 bronze dot (7px, `--accent`, `box-shadow: 0 0 0 1.5px var(--surface)`,
  top-right of the chip, `title` = "Color War or Visiting Day"). The source of that flag is whatever
  slice 4's resolver exposes; do not invent a second one. Resolving is the existing `resolveConflict`
  flow, out of scope here.

## 8. Implementation notes for Maker

- **Inline styles only** in `SpecialDayPlacements.jsx`. `scheduleGrid.css` is the scoped exception and its
  boundary is `src/components/schedule/`; this file is in `src/screens/specialDay/`, so no CSS class, no
  second stylesheet. Hover/focus tints on the grid cells use the existing picker-row technique
  (`onMouseEnter`/`onMouseLeave` mutating `e.currentTarget.style`, as `SchedulePickerList` does) so a
  hover does not re-render; at most 8 weeks x 7 days = 56 cells there is no performance case for CSS.
  Focus ring: the browser default / `outline: 2px solid var(--primary)`, never removed.
- Shared tokens only: `S.chip`, `S.btnPrimary`, `S.btnSecondary`, `S.sectionCount`, `S.emptyState*`,
  `useEnterTransition('liftFade')` / `'slideFade'` for the two enters. No hex in the file (chip text
  `#fff` is owned by `S.chip`).
- `GridEditorFrame`: add `meta` (optional) above `banners`; `GridEditorFrame.test.jsx` gains one test that
  `meta` renders in that position and that omitting it changes nothing for `EventGridEditor`.
- The editor's existing `error` + `S.errorBanner` is for its own block/notes/rename writes and is not part
  of this slice. Do not route placement failures into it (it would put them in the banner slot, section 6).
  Whether that existing banner itself should become the inline form is a separate finding, listed in
  section 12.
- Do not add a `window.confirm` anywhere in this slice (the editor's `removeBlock` uses one; that is not a
  precedent to copy).
- Orphans (ADR D4.7/D5) are filtered out in the component before rendering, with a test for a placement
  whose week is gone.

## 9. Binding from the schedule screen's day pill: not in this slice

Considered and deferred. It is not cheap or consistent, for reasons that are about the schedule screen,
not about effort alone:

1. **A pill is already a control.** `S.chip` day pills select the day. Binding needs a second action on
   the same element, which means a split button or a context menu on a navigation control. Nothing else
   on that row works that way (alike looks alike).
2. **Wrong consequence next to the wrong control.** Binding replaces a whole day's schedule on both
   routes. Putting that one mis-click away from "show Tuesday" on the Operate surface is the opposite of
   the quiet, grounded personality.
3. **It would need the picker's whole behaviour twice:** the special-day list, the occupied prompt, the
   failure line and the live refresh, on a screen that already carries slice 4's lane work.
4. **The two-tap path already exists from the other end.** Slice 4 makes the replaced lane's header name a
   link that opens the special day; this slice makes that screen the place to change the binding.

What would make it worth doing later: the owner reports directors binding by navigating Schedule ->
Special Schedules -> day -> picker and finding that too far. The cheapest honest version then is not a
pill menu but a `Place a special day...` entry in the existing week context bar that opens this same
`SpecialDayPlacements` panel in a popover with a special-day chooser on top; it reuses this component.
Confidence in deferring: 0.7.

## 10. The Special Schedules list (alike looks alike)

`SpecialSchedulesScreen.jsx` already gives Event rows a `sublabel` of `Placed Mon`. Special day rows get
the same slot, same style (no new component): load `special_day_placements`, `schedule_weeks`,
`days_of_operation` in the existing `Promise.all`, and set

| Placements for this special day | `sublabel` |
|---|---|
| 0 | none (the row is unchanged; absence is the signal) |
| 1 | `Placed Week 2 Tue` |
| 2 or more | `Placed 3 days` |

The count form avoids a long, wrapping sublabel. Orphans are not counted. This is a read-only addition and
needs no new test beyond the sublabel for each of the three cases.

## 11. Tests and evidence required

- Component (RTL): Free cell binds with exactly `{ weekId, dayId, specialDayId, replace: false }`; Mine
  cell unbinds with `{ weekId, dayId }`; Taken cell opens the confirmation with the ADR D11 sentence for the
  right names and does NOT call bind until confirmed; confirm calls bind with `replace: true`; Cancel and
  Escape call nothing; an `occupied` refusal on a Free click opens the same confirmation naming
  `currentSpecialDayId`'s special day.
- Failure: for each row of the section 6 table, the line renders on the right control, no chip is added,
  `Try again` re-runs the same call, and the placements were re-read first. A thrown error and a resolved
  `{ ok: false }` are both covered (they are different code paths).
- Idempotency: a double click on one Free cell issues one in-flight call (cell ignores clicks while in
  flight).
- Pure: ordering of chips; archived-week chip text; orphan placement not rendered; the three sublabel forms.
- Live: an `onOpApplied` placement op from another device updates the grid, and clears a stale pending
  replace.
- A11y: grid roving focus and arrow keys; every button has its sentence label; the confirmation receives
  focus; the failure line is `role="alert"`.
- **Visual evidence** (distinguishing frames, not "it renders"; capture with CDP `Page.captureScreenshot`
  in `npm run dev` with the browser mock): (1) placed nowhere (dashed button only); (2) two chips plus the
  open grid with Free, Mine and Taken all visible together; (3) the replace confirmation with the bronze
  outline on the target; (4) a failed cell with the failure line; (5) the Special Schedules list with all
  three sublabel forms; (6) frame 2 under `prefers-reduced-motion` and in greyscale (state must still read:
  dashed vs check vs label).

## 12. Open items and judgement calls for Governor

1. **Matrix over two dropdowns** (section 1). Judgement call; the ticket said "week + weekday picker" and
   this is one, but the form is the owner's to veto. Confidence 0.75. Evidence: shows occupancy before the
   click, matches the schedule's own weeks-by-days shape, avoids a Bind button and a form state machine.
2. **Inline replace confirmation instead of a modal** (section 4). Confidence 0.7.
3. **Binding from the day pill deferred** (section 9). Confidence 0.7. If the owner wants it in this slice,
   it grows to a second ticket-sized piece (popover, chooser, second host for the failure line).
4. **Per-week indicator of replaced days** (ticket slice 5 bullet) is satisfied by the day grid's Taken
   cells here plus slice 4's slate header, lane and day-pill name on the schedule. No third surface is
   specced; adding a badge to `WeekSwitcher` rows would duplicate them. Say so if the ticket line should be
   re-worded.
5. **Existing editor `S.errorBanner`** (SpecialDayGridEditor and `S.errorBanner` generally) is a banner of
   exactly the kind the owner rejected. Out of scope here; it is a candidate for the same inline-failure
   form this spec introduces, as a separate cleanup ticket. Not touched.
6. **Data source for the conflict dot** on a chip depends on what slice 4 ends up exposing; the chip
   renders the dot only if that source exists, and this slice must not add its own conflicts reader.
7. **No HTML mockup was produced** (this pass was scoped to the spec file only). The ASCII layout in
   section 2 is the shape; a standalone mockup of frames 2 and 3 is quick to add if wanted before Maker.
