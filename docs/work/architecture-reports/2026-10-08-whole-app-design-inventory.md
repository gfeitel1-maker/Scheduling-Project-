---
title: "Whole-app design inventory — copy, colour, centring, screen families"
document_type: architecture-report
status: current
created: 2026-10-08
task_class: design
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
---

# Whole-app design inventory, 2026-10-08

Read-only sweep of `src/screens`, `src/components`, `src/App.jsx`, `src/styles/shared.js` and `scheduleGrid.css` at base `origin/main` (worktree `jovial-shaw-4145e6`). No build, test, or browser run was done (machine overloaded), so every claim below is from reading source. Where a finding rests on a layout inference, it says so. Governing standard: `docs/governance/standards/DESIGN_STANDARD.md` (personality: Professional. Grounded. Warm. Quiet. Precise. Never playful; the grid is the visual focus).

Owner's four passes, as success predicates:

1. **Copy.** No sentence whose job is to instruct. If a control is not understandable by looking at it, change the control (label, preview, inline example, disabled state), then delete the sentence. Errors survive only if they name the specific thing that failed, in a few words.
2. **Colour and dots.** Every colour and dot carries one meaning that appears once. Anything duplicated or decorative is merged or dropped.
3. **Centring.** Text inside every schedule-grid cell, the grid headers, and the rows of pills, stat boxes and legend above and below the grid are centred on the grid's axis.
4. **Family consistency.** Screens that are alike share one layout component, so they are alike by construction.

Companion tables in Section A (appendix) are the line-level copy inventory. Sections B to D are the colour, alignment, and family findings. Section F is the batch list for makers.

---

## Headline findings (the ones that change the most)

1. **The app explains itself in three places at once** (helper paragraph, empty-state body, tooltip) on almost every setup screen. The empty-state body ("Type a day below to add your first one.") is the only one that survives in many cases, and even it can become the placeholder in the always-present `InlineAddRow`.
2. **The run-an-elective flow and the import/reconciliation flow carry the largest piles of paragraphs** (`src/screens/elective/run/*`, `src/screens/elective/assignment/*`, `src/screens/ImportScreen.jsx`, `src/components/reconciliation/*`). Those two get their own batches.
3. **Activity colour is used as decoration in one place**: `src/screens/RootsHomeScreen.jsx:151` colours Roots chips by array index from `ACTIVITY_COLORS`. DESIGN_STANDARD section 3 says the ladder encodes how often an activity runs and "assigned arbitrarily that implied order would be actively misleading". The dot has no meaning. Drop it.
4. **Grid cell text is left-aligned everywhere** (`scheduleGrid.css:70,95,167`). One small CSS batch centres it for all five grids (weekly group, day, activity, special day, event).
5. **Three real defects found on the way** (not asked for, but each is one line): `S.primaryBtn` does not exist (`src/screens/ImportScreen.jsx:1662`, the "Build this special day" button renders unstyled); `EventGridEditor.jsx:486` uses tokens that do not exist (`--surface-warning`, `--text-primary`) with a hard-coded `#fff8e1`; the PIN dots on `LoginScreen.jsx:153` are filled in `--warning` (brick red, the destructive hue) and animated with a shake, which section 1 of the standard forbids.

---

## B. Colours, dots, status marks, badges

Standard references: section 3 (activity ladder = frequency only, dot scale), section 4 (danger = destructive/error only, accent = caution, anchor = locked structure, success = status, secondary = structural accent, `--warning` legacy alias, `--purple` deprecated), 6a (shared primitives), 8 (no bounce/shake).

### B1. Dots: one dot component, one meaning each

Every dot in the app, and the call:

| Where | What it is | Call | Why |
|---|---|---|---|
| `src/components/schedule/scheduleGrid.css:217` `.identity-dot` (6px, inline bg from `ACTIVITY_COLORS`) | frequency rung of the activity | KEEP | The one use section 3 sanctions. |
| `src/screens/RootsHomeScreen.jsx:151,548` `chipDot` coloured `ACTIVITY_COLORS[i % 6]` | decorative: index, not frequency | **DROP** | Violates section 3; a ramp assigned arbitrarily is misleading. Chip text is enough. |
| `scheduleGrid.css:235-290` `.flag--overlap`, `.flag--week-closed`, `.flag--content-race` (3 corner dots), `.flag--unfillable` (glyph), `.flag--outdoor` (glyph) | per-cell status | **MERGE** (see B2) | Three dots, two hues, one severity (`FLAG_SEVERITY` says all three are `caution`). |
| `scheduleGrid.css:525` `.row-flag-dot` | "a collapsed row hides a flag" | KEEP | Distinct job (summary of hidden cells), single hue. Use the merged caution hue. |
| legend swatches `src/screens/ScheduleScreen.jsx:1481` (8px dot / 3x12 bar / 10px frame / 10px square) | key for the above | **REDUCE** | Legend shrinks as the flag set merges (B2). Four swatch shapes -> two (dot, bar). |
| `src/components/schedule/FindingsRail.jsx:37` severity dot (filled for danger, ring for others) | severity of a finding row | KEEP shape, **recolour via the merged map** | Already encodes severity by shape; also has a left bar of the same colour (`S.findingsRailRow(SEVERITY_BAR_COLOR)`) so colour is said twice on each row. Drop the dot, keep the bar, or the reverse. Recommend drop the dot. |
| `src/components/setup/ProvenanceDot.jsx` + `provenanceDotStyles.js` + `src/utils/ruleProvenance.js:85` `TIER_DOT_COLOR` (confirmed secondary solid, observed primary ring, inferred accent filled with halo) | "how sure the import was" for a field | **MERGE** (3 tiers -> 2) | Three hues AND three shapes for one axis. See B3. |
| `src/components/setup/DuplicateNameDot.jsx` (wraps ProvenanceDot with `tier=inferred`) | "two rows have the same name" | **MERGE into one "needs a look" dot** | Same bronze halo dot as an unconfirmed field. One glyph, many meanings = not useful. See B3. |
| `src/screens/LocationsScreen.jsx:205,233` `CapacityProvenanceDot`, `DuplicateLocationDot`; `ActivitiesScreen.jsx:168,199` `DuplicateActivityDot`, `RuleProvenanceDot`; `GroupsScreen.jsx:74` `DivisionProvenanceDot` | per-screen wrappers around ProvenanceDot | CONSOLIDATE | Five wrappers, plus a second copy of the popover row and styles inside `ActivitiesScreen.jsx:~100,1490-1520` (`dotStyles`, `ProvenancePopoverRow`) duplicating `provenanceDotStyles.js`. |
| `src/screens/FixedEventsScreen.jsx:936` 8px dot `var(--anchor)` before the event name | marks "fixed" | **DROP** | Every row on this screen is fixed (or every row is recurring: the screen is already scoped by `kind`). A dot present on 100% of rows carries no information. |
| `src/screens/CampBootstrapScreen.jsx:52` 6px navy dot inside `S.authRolePill` ("HOSTING ON THIS DEVICE") | decoration | **DROP** the dot (and see copy pass: the pill itself is CUT) | |
| `src/screens/LoginScreen.jsx:153` PIN-entry dots, `--warning` (brick), shake animation `shoresh-pin-shake` | PIN length feedback | **RECOLOUR to `--primary`, drop shake** | Brick is the destructive hue; entering a PIN is not destructive. Section 8: no shake. Replace the shake with a brief border-colour change on error if a signal is needed. |
| `src/screens/JoinByCodeScreen.jsx:356` spinner | loading | KEEP | Standard allows a 16px outline spinner; this is 18px with 2.5px stroke. Minor: set to 16/2. |
| `src/styles/shared.js:552` `authHostDot` (green dot with halo) and `:647` (second 50% shape) | "online" indicator | KEEP only if still rendered | Not found rendered in `src/screens` at base; check `grep authHostDot` before the batch (dead style = delete). |
| Toggle switch knobs `ActivitiesScreen.jsx:1444`, `GroupsScreen.jsx:~720`, `LocationsScreen.jsx:~1049` | three copy-pasted toggle components | **CONSOLIDATE** to one `Toggle` in `src/components/` | Same markup, same knob, three copies. |
| `src/screens/ReconciliationScreen.jsx` / `RootMap.jsx:411,473` / `RosterList.jsx:128` / `ReconstructionMoment.jsx:131` | circular shapes in the map/roster | Not dots in the status sense; review in the reconciliation batch | |

### B2. Status colours and badges: merge map

The tokens are right. The usage drifts from section 4.

| Item | File:line | Today | Call |
|---|---|---|---|
| Per-cell caution flags | `slotCellConstants.js` `FLAG_COLORS` | OVERLAP `--accent`; WEEK_CLOSED `--secondary`; CONTENT_RACE `--secondary` | **Set all three to `--accent`.** `FLAG_SEVERITY` already says all three are `caution`; section 4 says `--accent` is the caution hue and `--secondary` is a structural accent, not a status. They stay distinguishable by corner position and by tooltip text. Impacts `legend.test.js` and `slotCellConstants.test.js`; maker must update pins, not weaken them. |
| Legend entries | `slotCellConstants.js` `LEGEND_ENTRIES` | 7 entries: Unfillable, Overlapping, Closed this week, Changed elsewhere, Overridden today, Locked, Recurring event | After the merge: **Unfillable** (danger glyph), **Check this cell** (accent dot; covers overlap, closed week, changed elsewhere), **Overridden today** (frame), **Locked** (bar, accent), **Recurring** (bar, anchor). Keep per-flag `title` tooltips on the cells for the specific reason (they already exist at `SlotCell.jsx:~490-515`). Legend "must never go undocumented" (`legend.test.js`) is still honoured because one entry now documents all three dots. |
| "Locked" bar is `--accent` and OVERLAP dot is `--accent` | same | two caution meanings, bronze | Accept: shape differs (bar vs dot) and standard section 4 assigns bronze to "temporary, needs attention". Note: a lock is not an attention state. Optional follow-up: Locked bar -> `--anchor` and fold into Recurring as "Fixed in place". Medium confidence, owner call. |
| Stat badges | `ScheduleScreen.jsx:~1112-1160` | Placed `--success`; Overlapping/Still needed `--accent`; Unfillable `--danger`; Spread `--secondary` | **Placed -> neutral** (it is progress, not status; green says "confirmed"). **Spread -> `--accent`** like Still needed (same severity `info` vs `caution` is a distinction nobody can read from a number). Zero count -> `--text-secondary` (already so). Result: two live colours (accent, danger) instead of four. |
| Sidebar count pills | `Sidebar.jsx:39` `BADGE_PILL` uses `--warning` (legacy alias, brick, white text) | red badge for conflict/attention counts | Section 4: red rare so loud. Counts of items needing a look are caution, not destructive. **-> `--accent`** (bronze). Keep `--danger` only for the failed-sync and backup-failed lines. Also `TONE_COLOR.warning` (`Sidebar.jsx:34`). |
| Sidebar `✓` / `!` marks | `Sidebar.jsx:31,139` | `--success` / `--danger` | KEEP; but `!` for "needed" is a blocking structural gap, not an error. `--danger` is defensible (cannot schedule without it). Leave. |
| Sidebar `needed` text | `Sidebar.jsx:~193` | mono 10px, `--danger` when blocking | **DROP the word** if `!` is present (the mark already says it). Copy pass. |
| Sidebar fallbacks `var(--success, #22c55e)`, `var(--danger, #ef4444)` | `Sidebar.jsx:445-447` | hard-coded fallbacks | Remove the fallbacks (tokens always defined; fallbacks are off-palette). |
| Device chips | `DeviceManagerScreen.jsx:482,486,503,540` | primary / warning / accent chips (3 colours for 3 statuses incl. purge status) | Reduce to: primary (this device), neutral outline (trusted), accent (pending), danger (revoked/purge failed). Use `--danger` not `--warning`. Separate small batch in the Device/Trash batch. |
| Legacy alias callers | `TiersScreen.jsx:512`, `LocationsScreen.jsx:938,984`, `GroupsScreen.jsx:651` (`--warning` on the missing-name dash), `SetupScreenShell.jsx:25` ("Delete All"), `ScheduleScreen.jsx:1047-1049` (Rebuild hover), `WeekSwitcher.jsx:176`, `DeleteWeekDialog.jsx:109`, `LocationPicker.jsx:222`, `ConnectedToolsPanel.jsx:174`, `ReconciliationScreen.jsx:952-953`, `shared.js:231,232,310,313,626,627` | `--warning` = same value as `--danger` | Rename to `--danger` (one sweep, zero visual change). Exception: the "missing name" dash and `danglingWarning` in `LocationPicker` are not destructive -> use `--accent`. "Rebuild this schedule" hover is destructive -> `--danger`. |
| `EventGridEditor.jsx:486` | `S.errorBanner` overridden with `var(--surface-warning, #fff8e1)` / `var(--text-primary)` | tokens do not exist | Delete the override; use `S.errorBanner` or the caution box style. |
| `NameSubjectDialog.jsx:128,143` | `var(--text-primary)`, `var(--surface-sunken, rgba(0,0,0,.04))` | nonexistent tokens | `--text`, `color-mix(in srgb, var(--text) 4%, var(--surface))`. |
| `SpecialEventsScreen.jsx:548` | `S.chip(tagColor, false, ...)` | tag colour per event type | Check `tagColor` source; if per-type hue, **drop colour** (type is already a column). |
| `ScheduleActivityView.jsx:64,93` HIGH chip (`--accent` filled), `OUTDOOR` text (`--accent`) | bronze for "priority high" and "outdoor" | Neither is a caution. **-> neutral outline chips** (or text only). Bronze reserved for attention. |
| `ScheduleScreen.jsx:~1000-1010` Weather Mode ON uses `--accent` border/tint | a view toggle | **-> `--primary`** like the view toggle next to it. |
| `WeekContextBar.jsx` | bronze tinted bar | KEEP (it signals "this week has exclusions": attention). Copy line "Same as every other week" is CUT. |
| `elective/assignment/AssignmentPreview.jsx:70` `FLAG_COLOR[flag]` chips | per-flag colours | **Collapse to accent/danger**; same rule as above. |
| Hard-coded `#fff` | `shared.js:156,427,873`, `ConflictsScreen.jsx:124`, `DeviceManagerScreen.jsx:474`, `LoginScreen.jsx:223`, `ReconciliationScreen.jsx:909,932`, `reconciliationCards.jsx:631,654`, `BundleEditor.jsx:219,235` | white text on navy | Acceptable (text on `--primary`). Optionally token `--on-primary`. No batch. |
| Scrims and shadows `rgba(0,0,0,.45)` / `rgba(0,0,0,.1x)` | `shared.js:300`, `ConfirmDangerDialog.jsx:61`, `DeleteRecordDialog.jsx:196`, `NameSubjectDialog.jsx:109`, `DeleteWeekDialog.jsx:146,153`, `ActivitiesScreen.jsx:321,1487`, `Sidebar.jsx:576`, `VersionsDropdown.jsx:60`, `WeekSwitcher.jsx:60`, `ModeSelectScreen.jsx:26,44` | six different overlay/shadow values | The standard accepts neutral scrims. **Unify to one `S.overlay` and one `S.popoverShadow`**; 3 dialogs re-declare the overlay instead of using `S.overlay`. Low leverage but pure dedup. |

### B3. Provenance dots: reduce three tiers to two

Today: confirmed (solid `--secondary`), observed (ring `--primary`), inferred (halo `--accent`), plus the same dot repurposed for duplicate names and for "capacity unconfirmed". Two decisions the owner can take with confidence:

- A director has one question: "did the app guess this?" Two states answer it: **nothing shown** (confirmed or observed, i.e. it came from the file or was typed) and **one bronze dot** (the app inferred it, click to confirm). The solid green and navy ring dots mark rows that need no action, and per the standard bronze/accent is the only "needs attention" hue.
- The duplicate-name dot becomes the same bronze dot; the popover text says which reason.

Files: `src/utils/ruleProvenance.js` (`TIER_DOT_COLOR`, `tierShapeStyle`, `TIER_LABEL`), `ProvenanceDot.jsx`, `provenanceDotStyles.js`, `ActivitiesScreen.jsx` (delete second copy), `LocationsScreen.jsx`, `GroupsScreen.jsx`. Confidence: medium-high. Risk: tests pinning the tier shapes (`WCAG 1.4.1` comment at `ruleProvenance.js:87`): with one visible state, shape no longer needs to carry the distinction, so the pin is retired, not weakened.

---

## C. Alignment: exact changes to centre

Measured from source, not the browser. Current state:

- `.cell-inner` is `display:flex; flex-direction:column; justify-content:flex-start` with no `align-items` or `text-align` (`scheduleGrid.css:88-96`), so name, dot and location sit top-left. `.cell-name` is `display:flex; align-items:center` with no `justify-content` (`:193-207`), so dot + name hug the left edge.
- Header cells: `text-align:left` (`:70`). Row header: `justify-content:center` on a column flex (so vertically centred) but `align-items` defaults to stretch and the toggle has `align-items:flex-start; text-align:left` (`:152-167`), so left.
- `.cell-empty` is already centred (`:315-326`). That is why an empty cell and a filled cell currently disagree on axis.
- Collapsed cells already `justify-content:center; align-items:center` on the box, but `.cell-name` is `width:100%` with `text-overflow:ellipsis`, so the text is left.

### C1. `src/components/schedule/scheduleGrid.css` (one file, covers all five grids)

All five grids (weekly group view, day view, activity view, special-day editor, event editor) use these classes, so this is the whole change for the grid body. Make exactly these edits:

```css
/* .cell-inner (line ~88) */
.cell-inner {
  justify-content: center;   /* was flex-start */
  align-items: center;       /* new */
  text-align: center;        /* new */
}

/* .cell-name (line ~193) */
.cell-name {
  justify-content: center;   /* new */
  text-align: center;        /* new */
}

/* .cell[aria-rowspan] .cell-inner (line ~102): already centre; no change */

/* anchor cell (line ~108) */
.cell-inner--anchor {
  justify-content: center;   /* new; it is already a row with align-items:center */
}

/* header row (line ~64) */
.schedule-grid--header .cell {
  text-align: center;        /* was left */
}
.schedule-grid--header .row-header {
  text-align: left;          /* keep the corner label "Block" aligned with the row labels below it, see C2 */
}

/* row headers (lines ~129, ~152) */
.row-header { align-items: center; text-align: center; }
.row-header-toggle { align-items: center; text-align: center; }

/* location chip under the name (line ~836) and its add affordance (line ~862) */
.cell-location { justify-content: center; }
.cell-location-add { right: 12px; justify-content: center; }  /* add right:12px so it has a box to centre in */

/* collapsed single-line cells (line ~495) */
.cell[data-collapsed] .cell-name,
.row-header[data-collapsed] .block-name { text-align: center; }
```

Notes the maker must check by eye (not decidable from source):

- The activity view's `.cell-inner--activity` lists group names (`:120-127`). Centre those lines too (it inherits the new `align-items:center`); if the lines look ragged against the 2px gap, keep them `text-align:center`.
- `.identity-dot` has `margin-right:4px` and sits inline before the name, so dot+name centre as one unit. Acceptable and consistent across all cells. Do not move the dot above the name.
- The corner "Block" header: with the row labels centred, centre it too (drop the `.row-header { text-align:left }` exception above). Recommended: **centre everything**; the exception line above is there only if the maker sees the label look orphaned. Decide with one screenshot.
- Flags stay absolutely positioned in corners and are unaffected. `.cell-action` (top-right) unaffected.
- `SpecialDayCell.jsx` / `EventCell.jsx` use the same `.cell-inner`/`.cell-name`/`.cell-shell` classes, so they inherit (verified by `className` grep). `.cell-location` is `position:absolute; left:12; right:12; bottom:8` so centring it is a `justify-content` change only.
- Tests: `ScheduleGridKeyboardNav`, `SlotCell.test.jsx` and the structure tests assert DOM, not CSS, so they should not move. `scheduleGrid.css` has no snapshot test at base (grep `scheduleGrid` in `*.test.*` before editing).

### C2. Stat boxes, pills, legend, toolbar rows (inline styles in `ScheduleScreen.jsx` and the view components)

| Row | File:line | Today | Change |
|---|---|---|---|
| Group pills | `ScheduleGroupView.jsx:~56`, `ManualBuildView.jsx:~103` | `display:flex; gap:8; flex-wrap:wrap` (left) | add `justifyContent:'center'` |
| Day pills | `ScheduleDayView.jsx:~51` | same | add `justifyContent:'center'` |
| Activity view picker cards | `ScheduleActivityView.jsx:~55-60` card `textAlign:'left'` | left-aligned card text | `textAlign:'center'`; the chips row `justifyContent:'center'` |
| Stat boxes | `ScheduleScreen.jsx:~1106` (`display:flex; gap:10; alignItems:center; flexWrap:wrap`) | left | add `justifyContent:'center'`. `StatBadge.jsx` content is already `textAlign:'center'`. Also make the four boxes equal width (`minWidth:90` -> `minWidth:120`) so the row reads as a set. |
| "Off-view honesty" note | `ScheduleScreen.jsx:~1190` | left | **CUT** (copy pass), otherwise `textAlign:center`. |
| Findings rail | `FindingsRail.jsx` | list with left-aligned reasons | KEEP left; it is a list, not a label. |
| Legend | `ScheduleScreen.jsx:~1473` (`display:flex; gap:16; marginTop:16; flexWrap:wrap`) | left | add `justifyContent:'center'`; `marginTop:16` stays. |
| Controls bar (week switcher, view toggle, undo/redo, export) | `ScheduleScreen.jsx:~955` | left cluster, spacer, right cluster | **Leave.** It is a toolbar with two ends, not a label row. If the owner wants it centred too, centre the view toggle only. |
| Route offer cards (no schedule started) | `ScheduleScreen.jsx:~926-950` and `~1247` | card body left aligned inside centred wrapper | cards: `textAlign:'center'`, `alignItems:'center'`, button `alignSelf:'center'` |
| `WeekContextBar` | `WeekContextBar.jsx` | space-between | leave (toolbar) |

Wrap pills + stat boxes + legend in one tiny shared style object (`S.centeredRow`) in `src/styles/shared.js` rather than repeating `justifyContent:'center'` six times. That makes the alignment a rule, not six coincidences.

Also in the same alignment pass, outside the schedule: `S.th` tables are all left aligned with a right-aligned Actions column, which is correct for data tables. Do not centre setup tables.

---

## D. Families of like screens

### D1. Setup tables (Age Divisions, Groups, Days, Time Blocks, Locations, Activities, Fixed Events, Recurring Events, Cohorts, Electives sets, Special Events)

Common skeleton already exists: `SetupScreenShell` (count label, table, footer with utilities + Next) and `InlineAddRow`. Divergences, from source:

| Divergence | Evidence | Proposed single form |
|---|---|---|
| Shell adopted by 7 screens; not by Cohorts, Electives, Special Events, Locations | `grep SetupScreenShell` shows Activities, TimeBlocks, Tiers, Days, Groups, FixedEvents; Locations (`LocationsScreen.jsx:809`) hand-rolls it (own `maxWidth:720`, own Next button at `:944`, own `S.sectionCount` at `:848`); Cohorts (`:269`), Electives (`:160`), SpecialEvents (`:474`) hand-roll | All table setup screens render inside `SetupScreenShell`. |
| Container width differs per screen | 640 (SpecialEvents detail), 680 default, 700 Tiers, 720 Groups/Locations/Electives, 760 FixedEvents/Special list, 780 TimeBlocks, 820 Activities, 900 Cohorts | One width constant, `SETUP_MAX_WIDTH = 760`, set in the shell; remove the `maxWidth` prop. Activities (8 columns) may keep 820 via the one prop, nothing else. |
| Empty state wording | "No days yet / Type a day below to add your first one." (Days), "Add your first age division below or import from Excel." (Tiers), "Add a location below to add your first one." (Locations), "Type a name below and pick a type to add your first one." (SpecialEvents), "Add your first X below." (Cohorts, TimeBlocks, FixedEvents) | One empty state: the title only ("No days"), because the always-present `InlineAddRow` directly below shows how to add. Copy pass CUTs the body. |
| Legacy "No programs yet / Add a Program before adding..." guard | `TiersScreen.jsx:434-437`, `TimeBlocksScreen.jsx:455-458` | Programs are auto-created (`navSections.js` comment: "Every camp has exactly one"). Likely dead branch; confirm and delete. |
| Next button label/style | "Next: Time Blocks →", "Go to Schedule" (FixedEvents), Locations hand-rolled primary, Cohorts none | Shell prop `nextLabel` always; label pattern `Next: X`. |
| Footer utilities | Download Template, Import from Excel, Delete All (Delete All in `--warning`) | Keep; rename `--warning` to `--danger`. |
| Column header styles | all `S.th`; Actions column right aligned on some, centred "Week" column on Activities/Locations | Keep; add `S.thCenter` for the week-toggle column so it is not hand-spread. |
| Toggle switch | three copies | one `Toggle` component (B1). |
| Count label | "3 GROUPS" via `S.sectionCount` in shell; Cohorts and Locations re-implement | via shell only. |
| Back button | Locations has `S.backBar` to Activities; others none | Leave; it is a real sub-flow. |

**Proposal.** Extend `SetupScreenShell` into the only setup frame: props `countLabel`, `columns`, `nextLabel`, `utilities`, children = table. Screens that need a custom body (Special Events, Electives) pass it as children and still get the frame. Batch 4 does Cohorts, Electives, SpecialEvents, Locations adoption; width and empty-state unification ride with it.

### D2. Schedule screens (Generated, Manual, Special Days, Events, Electives)

| Divergence | Evidence | Proposed |
|---|---|---|
| Generated vs Manual are one screen but differ in view component | `ScheduleGroupView.jsx` vs `ManualBuildView.jsx` each re-render the group pills, the grid frame, header row, row header and cells (~250 and ~300 lines) | One `ScheduleGridFrame` (pills row + header + row header toggle) taking a `renderCell`. Divergence is only the cell renderer and empty-cell behaviour. Per `CLAUDE.md`, "separate rows, never canonical" stays. |
| Pickers for Special Schedules and Electives are twins | `SpecialSchedulesScreen.jsx` and `ScheduleElectivesScreen.jsx` both define `useCrossfade` (identical, copy-pasted, second one comments "reused verbatim"), `Card`, `styles.card/heading/list/linkButton`, `maxWidth:760` | Extract `SchedulePickerList` (crossfade + Card + list); each screen supplies rows. Status text "Not started / Partially filled / Complete" (`SpecialSchedulesScreen.jsx:17-19`) becomes a count `3/12` (shows, doesn't tell); green "Complete" colour dropped (neutral). |
| Special-day editor and Event editor are the same page twice | `SpecialDayGridEditor.jsx` (462 lines) and `EventGridEditor.jsx` (677 lines): both have `back-row`, `grid-toolbar` (Add block, Add group, Clear), grid frame, notes field, print, "Block" corner header, `cell-action` move/remove buttons, inline `block-name` editor | One `GridEditorFrame` (back row, title, toolbar, grid, notes, print). Event version has extras: import from file, add group, clear, `italic` secondary button. Fold extras into toolbar props. |
| Back control | `S.backBar` used correctly in both editors; ElectiveSetDetail `← Back to Elective Sets` also `S.backBar` | OK, consistent. |
| Widths | pickers 760, ElectiveSetDetail 760, editors fill | OK. |
| Empty "start" offers | route offer cards in `ScheduleScreen.jsx:926` (two cards, long body) vs picker empty text "No special days or events yet. Go to Roots" | Cards: title + one button, body CUT; picker empty -> title only. |
| Stat boxes and legend exist only on the weekly screen | `ScheduleScreen.jsx` | Not a divergence to fix; editors have no flags. |

### D3. Import and review steps (SeedScreen -> ImportScreen -> ReconciliationScreen)

| Divergence | Evidence | Proposed |
|---|---|---|
| Three different container widths and centring | SeedScreen 380 centred auth card; ImportScreen 760 left; ReconciliationScreen 920 centred (`margin:0 auto`) | Import and Reconciliation are two steps of the same task; give them one frame: same width (the shell main-area width, 760), same left alignment as setup screens (reconciliation 920 centred is the odd one), one step header. |
| Primary button style | ImportScreen uses both `S.btnPrimary` and a non-existent `S.primaryBtn` (`:1662`); Reconciliation `S.btnPrimary` | `S.btnPrimary` only; fix `:1662`. |
| Cards | ImportScreen `S.card`, Reconciliation `reconciliationCards.jsx` own card styles with `#fff` text on tinted chips | Share `S.card`. Review in batch 7. |
| Step identity | no visible step indicator; progress is implied by the "tray" hint text | Replace explanatory hint text with a count in the primary button ("Add 14") and an unresolved count in a small chip (PR #764 started this with "Review N records"). Do not add a stepper. |
| Back | Reconciliation: `Back` secondary button (`:363`); Import: reset via "Choose a different file" (secondary) | Same placement, same label ("Back"). |

### D4. Other families worth naming

- **Auth screens** (ModeSelect, CampBootstrap, JoinByCode, Login, BootRecovery): all use `S.authPage/authCard`. They are alike already; the divergence is copy volume. The PR #764 `htmlFor` fixes are fine.
- **Admin lists** (DeviceManager, Trash, Conflicts): three table/list shapes with 560/860/760/900 widths. Low leverage; fold into the same width constant as D1 in batch 9.

---

## E. PR #764 ("Packaged-audit UI seam B: import copy + small UI fixes") copy audit

Diff taken as `origin/main...pr764` on non-test `src` files only. Adds that violate the rule, and the fix the copy batches should apply when #764 lands:

| Added text | File | Verdict |
|---|---|---|
| `Your file's data is added now. N questions can wait — they stay here for later.` (first-import hint) | `src/screens/reconciliationTray.js` | **CUT.** Explains the app. Show a count instead (`N open`) and leave the button label to say what it does. The existing non-first-import hint (`N questions are still open — they stay here for later.`) is the same disease and goes in the same batch. |
| `Add what Shoresh found in your file` (button label) | `reconciliationTray.js` | **SHORTEN** to `Add` + count (`Add 14`). Long labels are copy. |
| `Found in your file, ready to add: ${labels}` | `reconciliationCards.jsx` (`RequiredGapSummaryCard`) | **SHORTEN / REPLACE**: show the labels as chips under a heading `In your file`; the "ready to add" is implied by the button. |
| `title="No weekly maximum"` / `"At most N per week"` tooltips | `ActivityPalette.jsx` | **CUT** both. The visible text ("no max", "2/3 max") already says it; a tooltip repeating it is noise. |
| `no max` / `${count}/${max} max` visible label | `ActivityPalette.jsx` | KEEP. It replaces `∞` with a word and is a show-not-tell change. |
| `Review N records` (was `Add N records`) | `ImportScreen.jsx` | KEEP: shorter label of what happens next. (Note it now conflicts with the first-import label above; pick one verb. Recommend `Add`, because the button commits.) |
| `htmlFor`/`id` on 7 labels, `timeBlockLabel()` helper, sidebar project-path hidden unless dev DB | CampBootstrap/Join/Login, utils, Sidebar | KEEP. No new copy; accessibility and format only. The `timeBlockLabel` change (`03:20-03:40` shown once as `3:20–3:40 AM`) is a show-not-tell fix. |

Recommendation: ask the #764 owner to drop the first-import hint and the two tooltips before merge, or make batch 1 the immediate follow-up. Do not conflict-edit while #764 is open: batch 5 (import/reconciliation copy) touches `ImportScreen.jsx`, `reconciliationTray.js`, `reconciliationCards.jsx`, `ReconciliationScreen.jsx`, `Sidebar.jsx`, so **land #764 first, then run batches in order below**.

---

## F. PR batches (ticket-sized, run one at a time)

Order is by independence and by risk. Every batch lists its bounded file set. "Pin" = tests that assert the string and must be updated to the new string (never deleted unless the string is gone by design). Each batch is one PR, the maker runs only focused tests plus `npm run check:governance` before push; CI is the gate of record.

**Prerequisite (not a batch): land #764** so batches 5 and 6 do not conflict with it.

### Copy pass

| # | Batch | Files (bounded) | Notes |
|---|---|---|---|
| C1 | **Setup tables: empty states, helper text, hints, placeholders** | `src/components/setup/*`, `src/screens/{Days,Groups,Tiers,TimeBlocks,Cohorts,Locations,Activities,FixedEvents,SpecialEvents,Camp}Screen.jsx`, `src/screens/setup/setupHelpers.js`, matching `*.test.jsx` pins | Empty body -> removed (title stays); helper paragraphs -> inline example in the `InlineAddRow` placeholder. Rows are in appendix, partition 1. |
| C2 | **Schedule screens: toolbar, route offers, banners, legend, pickers, stat text** | `src/screens/ScheduleScreen.jsx`, `src/components/schedule/*` (excluding CSS), `src/screens/{SpecialSchedules,ScheduleElectives}Screen.jsx`, `src/screens/schedule/*` messages | Cuts `Off-view honesty` note, `Weather Mode ON/OFF` -> toggle, route offer bodies -> title + button, FindingsRail intro. Rows in appendix partition 2. |
| C3 | **Elective builder and run flow** | `src/screens/ElectivesScreen.jsx`, `src/screens/elective/**` (including `run/*`, `assignment/*`) | Biggest copy pile (~85 rows). Own batch because of size and the `runStateCopy.js` pins. |
| C4 | **Special day and event editors** | `src/screens/event/*`, `src/screens/specialDay/*` (incl. `seedFailureMessage.js`) | Small. Can merge into C3 if the maker is idle. |
| C5 | **Import and reconciliation** | `src/screens/ImportScreen.jsx`, `src/screens/Reconciliation*.jsx`, `src/screens/reconciliation*.js`, `src/components/reconciliation/*`, `src/screens/SeedScreen.jsx` | Start after #764 lands. Retire the "tell the user what to do" hint pattern in the tray. Rows in appendix partition 3. |
| C6 | **Shell, auth, admin** | `src/App.jsx`, `src/components/layout/*`, `Login/Join/ModeSelect/CampBootstrap/BootRecovery/About/DeviceManager/Trash/Conflicts/RootsHome` screens, `ConfirmDangerDialog`, `DeleteRecordDialog`, `ConnectedToolsPanel`, `RecordHistory` | Security-relevant PIN/lockout wording is KEEP in the appendix; do not shorten without Security review. |

### Colour pass

| # | Batch | Files | Notes |
|---|---|---|---|
| K1 | **Alias and token hygiene (zero visual change)** | `--warning` -> `--danger`/`--accent` per B2 callers; remove nonexistent tokens (`EventGridEditor.jsx:486`, `NameSubjectDialog.jsx:128,143`); remove off-palette fallbacks (`Sidebar.jsx:445-447`); fix `S.primaryBtn`; unify `S.overlay`/popover shadow; one `Toggle` component | Pure refactor. Gate: lint + the touched tests. |
| K2 | **Cell flag and legend merge** | `src/components/schedule/slotCellConstants.js` (+ `.test.js`), `legend.test.js`, `scheduleGrid.css` (flag colours only), `ScheduleScreen.jsx` legend render, `FindingsRail.jsx` | Section B2 rows 1-3. Owner pass-through advised: this changes what colours mean. |
| K3 | **Badges and chips** | `Sidebar.jsx` (`BADGE_PILL`, `TONE_COLOR`), `StatBadge` usage colours in `ScheduleScreen.jsx`, `DeviceManagerScreen.jsx` chips, `ScheduleActivityView.jsx` chips, Weather toggle, `AssignmentPreview.jsx` flag colours | Section B2. |
| K4 | **Dot reduction** | `RootsHomeScreen.jsx` chipDot, `FixedEventsScreen.jsx:936`, `CampBootstrapScreen.jsx:52`, `LoginScreen.jsx` PIN dots (colour + remove shake), `JoinByCodeScreen.jsx` spinner size | Section B1. Small. |
| K5 | **Provenance dot: 3 tiers -> 1 dot** | `src/utils/ruleProvenance.js`, `src/components/setup/{ProvenanceDot,DuplicateNameDot}.jsx`, `provenanceDotStyles.js`, `ActivitiesScreen.jsx`, `LocationsScreen.jsx`, `GroupsScreen.jsx` | Section B3. Needs Code Reviewer on tier pins. Sequence after C1 (same screens). |

### Alignment pass

| # | Batch | Files | Notes |
|---|---|---|---|
| A1 | **Centre the grid** | `src/components/schedule/scheduleGrid.css` only | Section C1. One file, maker verifies with one screenshot per grid (group, day, activity, special day, event). |
| A2 | **Centre pills, stat boxes, legend, route offers** | `ScheduleGroupView.jsx`, `ManualBuildView.jsx`, `ScheduleDayView.jsx`, `ScheduleActivityView.jsx`, `ScheduleScreen.jsx` (row styles only), `src/styles/shared.js` (`S.centeredRow`), `StatBadge.jsx` | Section C2. Do after C2 and K3 to avoid conflicts in `ScheduleScreen.jsx`. |

### Consistency pass

| # | Batch | Files | Notes |
|---|---|---|---|
| F1 | **Setup frame adoption + width constant** | `SetupScreenShell.jsx`, `CohortsScreen.jsx`, `ElectivesScreen.jsx`, `SpecialEventsScreen.jsx` (list), `LocationsScreen.jsx`, all other setup screens' `maxWidth` props | Section D1. Do after C1 and K5. |
| F2 | **Picker twins -> `SchedulePickerList`** | `SpecialSchedulesScreen.jsx`, `ScheduleElectivesScreen.jsx`, new `src/components/schedule/SchedulePickerList.jsx` | Section D2 row 2. Removes the duplicated `useCrossfade`. |
| F3 | **Grid editor frame (special day + event)** | `SpecialDayGridEditor.jsx`, `EventGridEditor.jsx`, new `GridEditorFrame.jsx` | Largest dedup (~1,100 lines -> less). Do after A1 and C4. |
| F4 | **Group-view frame (Generated + Manual)** | `ScheduleGroupView.jsx`, `ManualBuildView.jsx`, new frame component | Highest risk: drag-and-drop and keyboard nav. Needs Tester + Red Hat. Do last. |
| F5 | **Import + Reconciliation shared frame** | `ImportScreen.jsx`, `ReconciliationScreen.jsx`, `S.card` consolidation | Section D3. After C5. |
| F6 | **Admin list widths** | `DeviceManagerScreen.jsx`, `TrashScreen.jsx`, `ConflictsScreen.jsx` | Optional; low leverage. |

### Suggested run order

`#764 lands` -> **K1** -> **A1** -> **C1** -> **K4** -> **C2** -> **K2** -> **K3** -> **A2** -> **C3 (+C4)** -> **K5** -> **F1** -> **F2** -> **C5** -> **C6** -> **F3** -> **F5** -> **F4** (-> F6).

Rationale: K1 and A1 are mechanical with no wording or meaning decisions and give the owner a visible change fast (centred grid). Copy batches follow setup -> schedule -> elective -> import -> shell. Frame consolidations (F*) come after copy and colour so they do not conflict with sweeping string edits.

### Confidence and what I did not do

- Confidence high on: all file:line facts and the CSS centring diff; the `--warning` rename; the dead-dot calls (RootsHome, FixedEvents, bootstrap pill).
- Confidence medium on: merging the three cell caution dots (owner should see before/after screenshots), provenance 3 -> 1 (needs the owner to agree that "confirmed" and "observed" need no mark), dropping the Placed green.
- Not done: no rendered screenshots (machine overloaded); alignment verdicts are derived from CSS and should be confirmed visually per batch A1. The graphify MCP was unavailable; no `graphify affected` was run, so before deleting any shared symbol (`provenanceDotStyles`, `FLAG_COLORS`, `LEGEND_ENTRIES`, `S.chip` callers), the maker must run `graphify affected "<symbol>()"` per repo rule.
- Appendix rows were produced by three read-only sub-sweeps using grep for multi-word strings; one- and two-word labels and some multi-line JSX may be missing. Verdict codes in the appendix: CUT, AFFORD (= REPLACE-WITH-AFFORDANCE, with the named affordance), SHORT (= shorten an error that must name the failed thing), KEEP (with justification).

---

# Appendix A. Line-level copy inventory

Source: three sweeps. Rows are `file:line | text | verdict`. Treat the verdict as a proposal; the maker confirms against current line numbers (these were read on base `origin/main`).


## A1. Setup screens, import, setup components (partition 1)

### Copy sweep 1: setup screens, shell, import (read-only inventory)

Verdicts: CUT / REPLACE-WITH-AFFORDANCE (RWA) / SHORTEN / KEEP. Lines are in the worktree as of this sweep. Multi-line JSX text is cited by first line. Error strings that already use the `describeWriteFailure(err, '<what failed>')` pattern are listed once under DaysScreen and noted "same pattern" elsewhere unless the text differs.

## src/components/setup/SetupScreenShell.jsx
| loc | text | verdict |
|---|---|---|
| :48 | Download Template | KEEP (button label, 2 words; but consider icon+"Template" to cut one word) |
| :50 | Import from Excel | KEEP (action label) |
| :57 | title="Admin only" on Delete All | RWA: disabled state with visible lock icon chip; tooltip-only reason is invisible |
| :58 | Delete All | KEEP (action label) |
| :62 | nextLabel prop, e.g. "Next: Time Blocks →" (see each screen) | SHORTEN to "Time Blocks →" (the arrow already says next) |

## src/components/setup/ImportModal.jsx
| loc | text | verdict |
|---|---|---|
| :77 | `{readyCount} ready, {warnCount} with warnings` default subtitle | RWA: two count chips in the table header (green N / amber N), no sentence |
| :74 | title prop "Import Preview" / "Import Complete" (passed by every screen) | SHORTEN: "Import" / drop title on done step, the result chips are the statement |
| :99 | Import {readyCount} / Importing… | KEEP |
| :97 | Cancel | KEEP |
| :108-116 | `N new` / `N updated` / `N unchanged` / `N skipped` | KEEP (these are counts, not prose); drop zero-state words |
| :121 | Done | KEEP |

## src/components/setup/ImportPreviewSubtitle.jsx
| loc | text | verdict |
|---|---|---|
| :23 | `{ready} ready, {warn} with warnings (skipped)` | RWA: count chips; "(skipped)" is implied by the amber row styling plus a Status column |
| :29-31 | `read from “Sheet1” — not “Programs”, “Notes”` | RWA: show tab name as a chip in the modal header; others-not-read list CUT |
| :21 | mappingIssue line (red) | KEEP the fact, SHORTEN, see entityColumnMapping below |

## src/ingest/entityColumnMapping.js (helper copy, imported by Days/Tiers/etc. via describeMappingIssue)
| loc | text | verdict |
|---|---|---|
| :196-198 | `Can't import yet — missing required column(s): X; column(s) matched more than one field: Y.` | SHORTEN: `Missing column: X` / `Ambiguous column: Y`; red chip, no "Can't import yet" (the disabled Import button already says it) |

## src/components/setup/DuplicateNameDot.jsx
| loc | text | verdict |
|---|---|---|
| :17 | title="Possible duplicate" | RWA: the dot itself is the cue; popover heading may stay |
| :22 | This looks like the same {entityLabel} as "{other.name}". | SHORTEN: `Same as "{other.name}"` |
| :23 | This looks like the same {entityLabel} as N others (e.g. "…"). | SHORTEN: `Same as "{other.name}" +N` |
| :24 | Rename or delete one here to clear this. | CUT (the row is right there) |

## src/components/setup/InlineAddRow.jsx
| loc | text | verdict |
|---|---|---|
| :105 | title="Add" | CUT (button already reads "+ Add") |
| :107 | + Add / Adding… | KEEP |

## src/components/setup/ProvenanceDot.jsx
| loc | text | verdict |
|---|---|---|
| :60-65 | aria-haspopup dialog, ariaLabel / dialogLabel props | KEEP (accessibility only, not visible) |
| :81,:86 | popover title + tier label (TIER_LABEL) | KEEP (a label, not prose) |

## src/screens/setup/setupHelpers.js
No user-facing copy. (Checked: only parse helpers and DOW names.)

## src/screens/CampScreen.jsx
| loc | text | verdict |
|---|---|---|
| :38 | The camp could not be read just now. | SHORTEN: `Couldn't load camp name` |
| :54 | That name could not be saved. | SHORTEN: `Name not saved` |
| :67 | What this camp is called. It appears above the sidebar and on anything you export. | CUT (label "Camp name" is enough; the sidebar shows it live as they type) |
| :79 | Camp name (field label) | KEEP |
| :91 | placeholder="Camp name" | CUT (duplicates the label); or RWA: a fictional example name |
| :105 | ✓ Saved | KEEP (confirmation flash) |

## src/screens/DaysScreen.jsx
| loc | text | verdict |
|---|---|---|
| :111 | That day could not be added. | SHORTEN: `Day not added` |
| :112 | That day could not be saved. | SHORTEN: `Day not saved` |
| :113 | Only an admin can delete days — no days were deleted. | RWA: disable Delete for non-admin with visible lock chip; drop sentence |
| :115 | Those days could not be deleted. | SHORTEN: `Days not deleted` |
| :151 | Only an admin can delete days. | RWA (as :113) |
| :152 | That could not be checked before deleting. | SHORTEN: `Couldn't check usage` |
| :224 | sort_order must be a whole number 0 or greater | CUT (column is internal; ignore bad value and default it) |
| :233 | That import file could not be read. | SHORTEN: `File not readable` |
| :286 | That import could not be completed. | SHORTEN: `Import failed` |
| :307 | nextLabel "Next: Time Blocks →" | SHORTEN: `Time Blocks →` |
| :328 | emptyStateBody "Type a day below to add your first one." | RWA: the add row visible beneath with placeholder "Monday"; CUT the sentence |
| :327 | emptyStateTitle "No days yet" | CUT (empty table + add row speaks for itself) |
| :340 | placeholder "Day (e.g. Monday)" | SHORTEN: `Monday` |
| :350 | `Day of Week` column header | KEEP |
| :384 | title "Delete all days?" | KEEP (destructive confirm) |
| :385 | recovery "They can be restored from Trash." | KEEP (safety-critical; recovery assurance) or RWA: Undo toast instead of dialog |
| :386 | confirmLabel "Delete All Days" | KEEP |
| :77 | aria-label "Edit {day.label}" | KEEP (a11y) |
| :99 | title "Admin only" on Delete | RWA: lock chip, disabled |
| :355 | title "Import Complete" / "Import Preview" | SHORTEN (see ImportModal) |

## src/screens/TiersScreen.jsx (Age Divisions)
| loc | text | verdict |
|---|---|---|
| :107 | title "Remove groups from this age division first" / "Admin only" | RWA: disabled Delete with count chip "3 groups" next to it |
| :180 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN: `Couldn't load` + Retry button |
| :193 | An age division with this name already exists — choose a different name. | RWA: DuplicateNameDot on the add row; or SHORTEN `Name already used` |
| :220 | same string, second site | same verdict |
| :221 | That age division could not be added. | SHORTEN: `Not added` |
| :234 | That age division could not be saved. | SHORTEN: `Not saved` |
| :260 | Only an admin can delete age divisions. | RWA: disabled Delete + lock chip |
| :261 | That age division could not be deleted. | SHORTEN: `Not deleted` |
| :272 | No program selected — add a program before deleting age divisions. | CUT (unreachable state; guard silently) |
| :294 | Only an admin can delete age divisions — no age divisions were deleted. | RWA (as :260) |
| :295 | Deleted N of M age divisions — please try again for the rest. | SHORTEN: `Deleted N of M` |
| :299 | Those age divisions could not be deleted. | SHORTEN: `Not deleted` |
| :338 | sort_order must be a whole number 0 or greater | CUT |
| :351 / :406 | That import file could not be read. / That import could not be completed. | SHORTEN: `File not readable` / `Import failed` |
| :425 | nextLabel "Next: Groups →" | SHORTEN: `Groups →` |
| :435 | No programs yet | CUT |
| :436 | Add a Program before adding Age Divisions. | RWA: disabled add row with visible reason chip "needs a Program" linking to Programs |
| :452 | No age divisions yet | CUT |
| :453 | Add your first age division below or import from Excel. | CUT (add row and Import button are on screen) |
| :473 | placeholder "Age division name (e.g. Yeladim)" | SHORTEN: `Yeladim` |
| :521 | This age division still has N group(s) assigned to it. Removing it will leave that group … | SHORTEN: `N groups will lose their age division` |
| :522 | This age division has no groups, so nothing in your schedules is affected. | CUT |
| :518 | title Delete "{name}"? | KEEP |
| :524 | "{name}" goes to Trash, and you can put it back from there. | SHORTEN: `Recoverable from Trash` |
| :534-535 | Delete all age divisions? / They can be restored from Trash. | KEEP / SHORTEN as above |

## src/screens/TimeBlocksScreen.jsx
| loc | text | verdict |
|---|---|---|
| :43-45 | Morning / Afternoon / Evening (part_of_day options) | KEEP |
| :187 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN: `Couldn't load` + Retry |
| :204 / :231 | A time block with this name already exists — choose a different name. | RWA: DuplicateNameDot; or `Name already used` |
| :232 | That time block could not be added. | SHORTEN: `Not added` |
| :245 | That time block could not be saved. | SHORTEN: `Not saved` |
| :271 | Only a admin… "Only an admin can delete time blocks." | RWA: disabled + lock chip |
| :272 | That time block could not be deleted. | SHORTEN |
| :283 | No program selected — add a program before deleting time blocks. | CUT |
| :305 | Only an admin can delete time blocks — no time blocks were deleted. | RWA |
| :306 | Deleted N of M time blocks — please try again for the rest. | SHORTEN: `Deleted N of M` |
| :310 | Those time blocks could not be deleted. | SHORTEN |
| :356 | Row N ('name', start): part_of_day not specified — pick one | SHORTEN: `Pick Morning/Afternoon/Evening` as an inline select in the preview row (RWA) |
| :358 | sort_order must be a whole number 0 or greater | CUT |
| :370 / :428 | import file could not be read / import could not be completed | SHORTEN |
| :447 | nextLabel "Next: Activities →" | SHORTEN: `Activities →` |
| :456 | No programs yet | CUT |
| :457 | Add a program before adding time blocks. | RWA: disabled add row + reason chip |
| :475 | No time blocks yet | CUT |
| :476 | Add your first time block below. | CUT |
| :486 | placeholder "Name (e.g. Block 1)" | SHORTEN: `Block 1` |
| :535 | This time block will be removed from your schedules. Any activities placed in it will no longer appear on the grid or in exports. | SHORTEN: `Placed activities leave the grid` or RWA show count of affected slots |
| :536 | "{name}" goes to Trash, and you can put it back from there. | SHORTEN: `Recoverable from Trash` |
| :546-547 | Delete all time blocks? / They can be restored from Trash. | KEEP / SHORTEN |

## src/screens/CohortsScreen.jsx (Programs)
| loc | text | verdict |
|---|---|---|
| :20 | None — no recurring events | SHORTEN: `None` |
| :21 | Fixed — recurring events happen at the same time every day | SHORTEN: `Fixed` |
| :22 | Floating — recurring events can move within the day (coming soon) | CUT (coming-soon control banned by owner rule; remove option) |
| :26 | How many groups share a period | SHORTEN: `Groups per period` |
| :27 | Camper headcount (coming soon) | CUT (coming-soon option) |
| :286-288 | Session Weeks / Recurring Events / Capacity Source headers | KEEP |
| :165 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN: `Couldn't load` + Retry |
| :210, :226 | A program with this name already exists — choose a different name. | RWA: DuplicateNameDot; or `Name already used` |
| :211 | That program could not be added. | SHORTEN |
| :227 | That program could not be saved. | SHORTEN |
| :235 | alert('Cannot delete the last program — every camp must have at least one.') | RWA: disable Delete on the last row, no alert; native alert also off-brand |
| :258 | Can't delete — other data (time blocks or recurring events) still references this program. Remove those first. | SHORTEN: `In use by time blocks / recurring events` as disabled-Delete count chip |
| :259 | That program could not be deleted. | SHORTEN |
| :297 | No programs yet | CUT |
| :298 | Add your first program below. | CUT |
| :312 | placeholder "Name (e.g. Main, Specialty)" | SHORTEN: `Main` |
| :324-325 | A program groups age divisions, time blocks, and recurring events that share a schedule structure. Most camps have one program ("Main"). Add a second for specialty programs with a different time grid. | CUT (owner rule: if unclear, the thing is unclear; consider hiding screen when only "Main" exists) |
| :335-336 | Delete this program? / Age divisions and time blocks assigned to it will lose their program reference. | KEEP title; SHORTEN body to counts: `N age divisions, N time blocks affected` |

## src/screens/GroupsScreen.jsx
| loc | text | verdict |
|---|---|---|
| :42-43 | Morning Only / Afternoon Only | KEEP (option labels) |
| :77-79 | ariaLabel "Age division provenance for X: inferred", dialogLabel, title "Age division" | KEEP aria; popover title KEEP |
| :97, :617 | — No age division — | SHORTEN: `None` |
| :230 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN: `Couldn't load` + Retry |
| :297 | A group with this name already exists — choose a different name. | RWA: DuplicateNameDot / `Name already used` |
| :298 | That group could not be added. | SHORTEN |
| :341 | That group could not be saved. | SHORTEN |
| :357 | Only an admin can delete groups. | RWA: lock chip |
| :358 | That could not be checked before deleting. | SHORTEN |
| :389 | Only an admin can delete groups — no groups were deleted. | RWA |
| :390 | Deleted N of M groups (K failed — see console). | SHORTEN: `Deleted N of M` ("see console" is meaningless to a director) |
| :394 | Those groups could not be deleted. | SHORTEN |
| :446 | Missing name | KEEP (names the failed thing) |
| :450 | Age Division "X" ambiguous — more than one age division has this name. Rename one before importing. | SHORTEN: `"X": 2 age divisions share this name` |
| :452 | Age Division "X" not found | KEEP |
| :463 | That import file could not be read. | SHORTEN |
| :550 | nextLabel "Next: Days →" | SHORTEN: `Days →` |
| :555 | No age divisions found. Set up age divisions first so you can assign groups to them. | RWA: cautionBanner (banner banned per owner) becomes a flag/chip on the Age Division column header "none set up" linking to Age Divisions; CUT sentence |
| :567 | Age Division (column header) | KEEP |
| :576 | No groups yet | CUT |
| :577 | Type a group below to add your first one. | CUT |
| :601 | No Age Division (section row) | SHORTEN: `Unassigned` |
| :613 | placeholder "Group name" | RWA: example `Bunk 1` |
| :637 | column labels Name / Age Division / Availability / Status | KEEP |
| :667-669 | Delete all groups? / They can be restored from Trash. / Delete All Groups | KEEP / SHORTEN |

## src/utils/divisionProvenance.js (copy shown by Groups' provenance dot via describeDivisionEvidence)
| loc | text | verdict |
|---|---|---|
| :25 | This age division came from the import, but no reason was recorded. | CUT (show tier label only) |
| :34-36 | The names suggested one "X" division, but on the schedule this group never shares an activity with the rest of it — only with …, so they were kept separate. | SHORTEN: `Kept separate: shares activities only with {list}` |
| :39 | No other group's name shares a stem with this one, so it is its own age division. | SHORTEN: `Own division: no name match` |
| :41 | Grouped with {list} because their names share "stem". | SHORTEN: `Grouped by name: "stem"` |
| :48 | The bracketed part of the name was set aside when comparing. | CUT |
| :56 | {list} was/were ignored — all-camp activities put every group together, so they say nothing about who belongs with whom. | CUT (or `Ignored all-camp: {list}`) |

## src/screens/LocationsScreen.jsx
| loc | text | verdict |
|---|---|---|
| :88 | Before you start (eyebrow of merge gate) | CUT |
| :89 | N locations left to review | KEEP (progress count) |
| :91 | These look like the same location | SHORTEN: `Same location?` |
| :94-96 | Your old schedule used {variants}. Shoresh kept them separate so it wouldn't change your data without asking — but that splits how many groups fit. Merge them into one location, or say they're genuinely different. The activities from both locations will move onto the name you keep. | CUT (the variant rows with capacity and activity counts already show the stakes) |
| :108-110 | `{capacity} at once` / `N activities here` per variant row | KEEP (data) |
| :120 | Room for [stepper] groups at once after merging. | SHORTEN: `Groups at once: [stepper]` |
| :130 | Merge into one location | SHORTEN: `Merge` |
| :138 | No — these are different locations | SHORTEN: `Keep separate` |
| :140 | You can undo this. The merged location stays in Trash if you change your mind. | RWA: Undo toast after merge; CUT sentence |
| :178 | Shoresh set a few capacities from your old schedule | SHORTEN: `Capacities to confirm` |
| :179 | N to look at | KEEP (count) |
| :208 | ariaLabel "Capacity provenance: inferred, needs review" | KEEP (a11y) |
| :220 | No one has confirmed how many groups fit here. | RWA: hollow dot already means unconfirmed; popover just "Unconfirmed" + Confirm |
| :236-248 | Merge into "{other.name}" | KEEP (action; names the target) |
| :253 | This looks like the same place as "X". | SHORTEN: `Same as "X"` |
| :254 | This looks like the same place as N other locations (e.g. "X"). | SHORTEN: `Same as "X" +N` |
| :301 | — none — | KEEP |
| :359 | title={kindInfo.label} | CUT (duplicates cell text) |
| :366 / :935 | title "Admin only" | RWA lock chip |
| :376-384 | Classroom / Group Space; Office / Admin; Generic etc. | KEEP (options), SHORTEN `Classroom / Group Space` to `Classroom` |
| :421 | That location could not be added. | SHORTEN |
| :422 | That location could not be saved. | SHORTEN |
| :423 | Only an admin can delete locations — no locations were deleted. | RWA |
| :424 | Deleted N of M locations (K failed — see console). | SHORTEN: `Deleted N of M` |
| :604, :663 | That merge could not be completed — someone may have changed these locations. Try again. | SHORTEN: `Merge failed — locations changed` |
| :623 | That could not be saved — try again. | SHORTEN: `Not saved` |
| :731 | That import file could not be read. | SHORTEN |
| :779-780 | Only an admin can delete locations. / That could not be checked before deleting. | RWA / SHORTEN |
| :859 | Groups at once (column header) | KEEP |
| :870 | No locations yet | CUT |
| :871 | Add a location below to add your first one. | CUT |
| :892-893 | Off in {week} / Open in {week} (toggle label) | KEEP (state label; short) |
| :906 | placeholder "e.g. Pool, Gym, Beit Midrash" | SHORTEN: `Pool` |
| :105(footer) | Next: Recurring Events → | SHORTEN: `Recurring Events →` |
| :957-959 | Delete all locations? / They can be restored from Trash. / Delete All Locations | KEEP / SHORTEN |

## src/screens/locationMigrationReview.js (helper copy shown in advisory strip/review)
| loc | text | verdict |
|---|---|---|
| :70 | activities here asked for different limits (A and B groups at once). Shoresh kept the most room: N. | SHORTEN: `Limits asked: A, B. Set to N.` |
| :75 | had no limit set and is now N group(s) at a time. That may change a generated week or two — take a look before you regenerate. | SHORTEN: `Was unlimited. Now N.` ; CUT second sentence |

## src/screens/FixedEventsScreen.jsx (Fixed and Recurring Events)
| loc | text | verdict |
|---|---|---|
| :174, :476 | Save failed partway through and couldn't be fully rolled back (admin required) — N incomplete recurring-event row(s) may remain; ask an admin to review/delete them. | SHORTEN (names the failed thing, keep): `Partly saved: N rows incomplete. Admin must delete them.` |
| :175 | Your changes could not be saved. | SHORTEN: `Not saved` |
| :194 | Days (select all that apply) | SHORTEN: `Days` |
| :210 | — Select block — | SHORTEN: `Block` |
| :223 | No age divisions set up yet | CUT / RWA: chip `none` with link |
| :207(form) | placeholder "e.g. Mifkad, Lunch, Swim" | SHORTEN: `Mifkad` |
| :252 | Add {kind}(×N) / Save Changes | KEEP; SHORTEN `Save Changes` to `Save` |
| :356 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN |
| :422, :793 | "X" matches more than one activity in your catalog — rename one of them before saving. | SHORTEN: `"X": 2 activities share this name` |
| :435 | That {event} could not be saved. | SHORTEN |
| :495 | That week could not be saved. | SHORTEN |
| :535 | Only an admin can delete {events}. | RWA |
| :536 | That {event} could not be deleted. | SHORTEN |
| :565 | Only an admin can delete … — no … were deleted. | RWA |
| :570 | Those {events} could not be deleted. | SHORTEN |
| :657 | Missing name | KEEP |
| :662 | Time block "X" ambiguous — more than one time block has this name. Rename one before importing. | SHORTEN: `"X": 2 time blocks share this name` |
| :664 | Time block "X" not found | KEEP |
| :672 | Age Division(s) ambiguous — more than one age division is named: …. Rename one before importing. | SHORTEN: `Ambiguous age division: …` |
| :674 | Age Division(s) not found: … | KEEP |
| :707 | Missing day_label | SHORTEN: `Missing day` (day_label is an internal column name) |
| :713 | Day "X" not found | KEEP |
| :736, :846 | import file could not be read / import could not be completed | SHORTEN |
| :866 | All age divisions | KEEP |
| :873 | Shown from the groups this event covers — not a saved division choice. Re-save it to store the divisions. | CUT (or RWA: italic/hollow styling on derived label) |
| :889 | nextLabel "Go to Schedule" | KEEP (action) |
| :915-916 | Time Block / Age Divisions column headers | KEEP |
| :954 | All weeks | KEEP |
| :Fixed-empty (:37 region) | No time blocks found. Set these up before adding {events}. | RWA: disabled add row + reason chip linking to Time Blocks; no banner |
| :Fixed-empty (:66 region) | Add your first {kind} event below. | CUT |
| :81(row) | aria-label "Edit {name}" | KEEP (a11y) |
| :104 | title "Admin only" | RWA lock chip |
| :1019 | N were group-scoped and filed under Recurring Events/Fixed Events instead | SHORTEN: `N filed as {other kind}` |
| :1035 | This {event} will be removed from your schedules. | CUT (title already says delete) |
| :1036 | "{name}" goes to Trash, and you can put it back from there. | SHORTEN: `Recoverable from Trash` |
| :1046-1048 | Delete all {events}? / They can be restored from Trash. | KEEP / SHORTEN |
| :733 (setImportCohortNote) | note text from import (cohort mapping note, shown in doneExtra as grey sentence) | CUT or SHORTEN to count chip |

## src/screens/ActivitiesScreen.jsx
| loc | text | verdict |
|---|---|---|
| :101 | From this file — {clearly stated in the file / inferred from context / a guess — worth a second look / in conflict with what Shoresh already has}. | SHORTEN: tier dot + label `Stated` / `Inferred` / `Guess` / `Conflict` (CONFIDENCE_COPY in reconciliationCards.jsx :17-22) |
| :102 | plainEvidenceSentence(support) | SHORTEN (keep facts only, drop narration); see reconciliationCards.jsx |
| :172-174 | ariaLabel Possible duplicate of X; title "Possible duplicate" | KEEP aria; RWA title (dot is the cue) |
| :183 | Merge into "X" | KEEP |
| :188 | This looks like the same activity as "X". | SHORTEN: `Same as "X"` |
| :189 | This looks like the same activity as N others (e.g. "X"). | SHORTEN: `Same as "X" +N` |
| :218 | Provenance: {worst}, N of M fields need review | SHORTEN: `N of M to review` |
| :219 | Provenance: all confirmed | CUT (absence of dot = confirmed) |
| :308 | Your changes could not be saved. | SHORTEN: `Not saved` |
| :324 | Add Activity / Edit: {name} | KEEP |
| :329 | placeholder "Activity name" | RWA: `Archery` |
| :337 | Outdoor activity | KEEP |
| :346 | Allow multiple groups at this activity at the same time | SHORTEN: `Shared by groups` |
| :350 | Max groups at once | KEEP |
| :356 | Groups must be from the same age division | SHORTEN: `Same age division only` |
| :364/:367/:370 | Min per week / Max per week / Blocks per session | KEEP |
| :375 | Scheduling Priority | KEEP |
| :383 | Eligible Age Divisions (leave all unchecked = eligible for all) | SHORTEN: `Age Divisions` with `All` chip when none ticked (RWA: show state) |
| :385 | No age divisions set up yet | CUT / chip |
| :399 | Hide more options / More options | KEEP |
| :411 | Override by specific groups | SHORTEN: `Specific groups` |
| :425 | Distribute early in the week | SHORTEN: `Early in week` |
| :431 | times before | KEEP (inline connector) |
| :438 | Weather alternative (shown when weather mode is on) | SHORTEN: `Weather alternative`; parenthetical CUT |
| :440 | — None — | KEEP |
| :546 | "X" changed while you were looking at it — nothing was merged. Try again. | SHORTEN: `"X" changed — not merged` |
| :550 | "X" could not be merged into "Y". | KEEP (names the failed thing) |
| :561 | Merged "X" into "Y", but the name was not remembered — a future import may split them again. | SHORTEN: `Merged, but import may split them again` |
| :605 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN |
| :669, :686, :803, :832 | An activity with this name already exists — choose a different name. | RWA: DuplicateNameDot / `Name already used` |
| :687 | That activity could not be saved. | SHORTEN |
| :741 | You don't have permission to do this. | RWA: lock chip |
| :742 | That could not be checked before deleting. | SHORTEN |
| :763, :790 | An activity named "Copy of X" already exists — rename it before duplicating again. | SHORTEN: `"Copy of X" exists` |
| :791 | That activity could not be duplicated. | SHORTEN |
| :833 | That activity could not be added. | SHORTEN |
| :858 | Only an admin can delete activities — no activities were deleted. | RWA |
| :863 | Those activities could not be deleted. | SHORTEN |
| :929 | Missing name | KEEP |
| :940 | Age Division(s) ambiguous — more than one age division is named: …. Rename one before importing. | SHORTEN |
| :942 | Age Division(s) not found: … | KEEP |
| :950 | Weather alt "X" ambiguous — more than one activity has this name. Rename one before importing. | SHORTEN: `"X": 2 activities share this name` |
| :952 | Weather alt "X" not found | KEEP |
| :968 | Location "X" ambiguous — more than one location has this name. Rename one before importing. | SHORTEN |
| :997, :1126 | import file could not be read / import could not be completed | SHORTEN |
| :1162 | That could not be confirmed. | SHORTEN: `Not confirmed` |
| :1198 | nextLabel "Next: Recurring Events →" | SHORTEN: `Recurring Events →` |
| :1212 | No activities yet | CUT |
| :1213 | Add your first activity or import from Excel. | CUT |
| :1232 | High Priority / Low Priority (section labels) | KEEP |
| :1284 | Up to N (same age division) | KEEP / SHORTEN `Up to N` + `·` same division |
| :1293-1294 | Off in {week} / Runs in {week} | KEEP |
| :1320 | Add Activity | KEEP |
| :1324 | placeholder "Activity name (e.g. Archery)" | SHORTEN: `Archery` |
| :1375 | + new location | KEEP (chip) |
| :1392-1394 | Delete all activities? / They can be restored from Trash. / Delete All Activities | KEEP / SHORTEN |

## src/screens/SpecialEventsScreen.jsx
| loc | text | verdict |
|---|---|---|
| :34 | No special events yet. | CUT |
| :35 | placeholder "Name a special day or event…" | SHORTEN: `Color War` |
| :36 | Special Day created. Start with your camp's regular time blocks (you can edit them after), or start empty? | SHORTEN: `Start from your time blocks?` with the two buttons |
| :37 | Seed from Time Blocks | SHORTEN: `Copy time blocks` |
| :38 | Start Empty | SHORTEN: `Empty` |
| :39 | "X" created — build it from Special Schedules under Schedule. | RWA: toast with `Build →` button that navigates; CUT instruction |
| :78, :157 | That could not be saved. | SHORTEN: `Not saved` |
| :106 | Notes (label) | KEEP |
| :114 | Teams, points, staffing, run-of-show — recorded and printed, never parsed. | CUT; placeholder `Notes` |
| :116 | Location (optional) | SHORTEN: `Location` (empty = none) |
| :123, :195 | Build the schedule → | SHORTEN: `Build →` or `Schedule →` |
| :135 | Delete Event | KEEP |
| :188 | Run-of-show, staffing, anything worth recording — never parsed. | CUT; placeholder `Notes` |
| :207 | Delete Special Day | KEEP |
| :213 | ← Back to Special Events | SHORTEN: `← Back` |
| :222 | That event could not be added. | SHORTEN |
| :223 | That event could not be saved. | SHORTEN |
| :259 | Couldn't load your camp setup — check your connection and refresh. | SHORTEN |
| :305 | An event with this name already exists — choose a different name. | RWA DuplicateNameDot / `Name already used` |
| :315 | A special day with this name already exists — choose a different name. | same |
| :325 | Could not create that special day. | SHORTEN: `Not created` |
| :367 | That special day could not be saved. | SHORTEN |
| :403 | That could not be deleted. | SHORTEN: `Not deleted` |
| :seedFailureMessage.js:10 | Only seeded N of M time blocks before hitting an error — the rest were not added. | SHORTEN: `Copied N of M time blocks` |
| :seedFailureMessage.js:11 | Could not seed time blocks. | SHORTEN: `Time blocks not copied` |
| :430 | This event and its placement on the schedule will be removed. | CUT (title says delete) |
| :431, :457 | "X" goes to Trash, and you can put it back from there. | SHORTEN: `Recoverable from Trash` |
| :456 | This special day and its time blocks and filled slots will be removed. | SHORTEN: `Removes its time blocks and slots` |
| :493 | No special events yet. (emptyMessage in title) | CUT |
| :494 | Type a name below and pick a type to add your first one. | CUT |
| :row tag | Special Day / Event (chip) | KEEP |

## src/screens/ImportScreen.jsx
| loc | text | verdict |
|---|---|---|
| :54 | tiers: 'Age Divisions' (label map) | KEEP |
| :457 | No schedule could be read out of that. It may be a scan rather than a document with text in it. | SHORTEN: `No text found (scanned image?)` |
| :482-483 | {files} doesn't look like a schedule — expected day columns (e.g. Monday–Friday) or time-of-day rows. Nothing was imported. | SHORTEN: `{file}: no day columns found` |
| :808 | That file could not be read. | SHORTEN: `File not readable` |
| :828 | That worksheet could not be read. | SHORTEN |
| :832 | Waiting for a Program to load before importing. Try again in a moment. | SHORTEN: disabled Import with spinner; CUT sentence |
| :864 | The worksheet could not be created. | SHORTEN: `Worksheet failed` |
| :1013 | The split for "X" couldn't be applied — your activity list couldn't be read. Nothing was split; try again from the Activities screen. | SHORTEN: `"X" not split: couldn't read activities` |
| :1024 | The split for "X" couldn't be applied — that activity is no longer in your setup. | SHORTEN: `"X" not split: activity gone` |
| :1038 | "X" could not be split into two activities — that name is already in use. | SHORTEN: `"X" not split: name in use` |
| :1042 | The split for "X" could not be saved. | SHORTEN |
| :1102 | {err.message} Find it under Special Events to finish or delete it. | SHORTEN: `Special day partly built (see Special Events)` |
| :1109 | That special day could not be built. | SHORTEN: `Not built` |
| :1392 | notes: Imported from {files} — {days}, N blocks starting S | CUT (verbose auto-note in data; keep `Imported from {file}`) |
| :1491 | Your import finished, but a split/N splits couldn't be saved: … | SHORTEN: `Imported. N splits not saved: …` |
| :1503 | N placements couldn't be matched and were skipped. | SHORTEN: `N placements skipped (no match)` |
| :1506 | Your imported schedule couldn't be saved as a version this time. | SHORTEN: `Version not saved` |
| :1518 | N cell interpretations couldn't be saved and may be asked about again next time. | SHORTEN: `N answers not saved` |
| :1581-1582 | Import runs on the main computer. Open this camp on the main computer to import last year's schedule. | SHORTEN: `Import on the main computer only` (state reason, no instruction) |
| :1591-1593 | Already have last year's schedule? Open it here and Shoresh will read the groups, days, periods and activities out of it. Nothing is added until you have looked at the list and said so. | CUT (drop zone says it; preview step proves nothing is added) |
| :1600 | Special day built. | KEEP (confirmation) |
| :1610 | This looks like a single-day schedule | SHORTEN: `Single-day schedule` |
| :1613-1615 | N periods across M groups, with no days of the week. It won't be imported as your weekly schedule. | SHORTEN: `N periods × M groups` |
| :1618-1621 | Building it adds N new activities to your camp: …. These stay in your activities even if you delete this day afterwards. | SHORTEN: `+N activities: …` (second sentence CUT) |
| :1626-1627 | It reuses X from your camp rather than making new ones — names are matched ignoring spacing and capitals. | SHORTEN: `Reuses: X` |
| :1632-1634 | You have more than one group whose name matches X, so this day cannot tell which one the column means. Rename one of them under Groups first. | SHORTEN: `"X": 2 groups share this name` |
| :1639-1641 | You have more than one activity whose name matches X, so this day cannot tell which one the file means. Rename one of them under Activities first. | SHORTEN: `"X": 2 activities share this name` |
| :1647-1650 | X is not a group in your camp. Add it under Groups first, or rename the column in the file. | SHORTEN: `Not a group: X` |
| :1654 | A special day called "X" already exists — rename it, or rename this one in the file. | SHORTEN: `"X" already exists` |
| :1663 | Build this special day / Building… | KEEP |
| :1700 | Drop last year's schedule here | SHORTEN: `Drop schedule here` |
| :1706 | Choose a file | KEEP |
| :1723 | Excel, CSV or a plain text schedule. Several files at once is fine. | SHORTEN: `.xlsx .csv .txt` (accept list; RWA: file-type chips) |
| :1730-1731 | Prefer to fill in the details in a spreadsheet? Download a worksheet with everything Shoresh already knows, edit it, and open it back here. | CUT sentence; keep button `Download worksheet` |
| :1734 | Download worksheet / Preparing… | KEEP |
| :1746-1747 | Everything below is what Shoresh found in the file. Nothing is added yet — the next step shows exactly what would change and lets you review anything worth a second look. | CUT (screen is self-evident; button label says Continue) |
| :1755 | Read as one page per group, with the days across the top. / …per day, with the groups across the top. | RWA: layout badge `Groups × Days` / `Days × Groups` |
| :1756 | Could not tell how this file is laid out, so some of the list below may be wrong. Worth checking closely. | SHORTEN: `Layout unclear` amber flag |
| :1775 | Something moved for a day | SHORTEN: `Moved on one day` |
| :1778-1779 | These look like a regular slot that shifted on one day, not new activities. Nothing is being held up — this is just so you know. | CUT |
| :1780 | {pinned} ({block}) looks like it moved to … | SHORTEN: `{pinned}: {block} → {new}` |
| :1808 | Places (section header) | KEEP |
| :1818-1819 | These activities have the same name as a place you already set up, so Shoresh can put them there. Untick any that happen somewhere else. | CUT (checked rows `Archery → Archery Field` are self-explanatory) |
| :1840-1844 | You have more than one place called X, so Shoresh cannot tell which one is meant. Rename one under Locations, or set these by hand. | SHORTEN: `"X": 2 locations share this name` |
| :1851-1852 | Any of these activity names that are also the name of a place? Tick them and Shoresh will add the place — it won't assume anything happens there. | CUT |
| :1886 | Not recognised | KEEP (flag header) |
| :1889-1890 | Shoresh could not match this to anything above. Nothing was added for it — check whether it matters before you continue. | CUT |
| :1896-1897 | Tab "X" doesn't look like a schedule (no day columns or time-of-day rows), so nothing was imported from it. | SHORTEN: `Tab "X": skipped (no day columns)` |
| :1915-1917 | "X" was read as the place an activity happens, because it sits under one. But it is also scheduled elsewhere as its own activity, so it may be a second thing happening rather than a room. Check it on the list above. | SHORTEN: `"X": room or activity?` |
| :1926-1927 | "X" — repeated above each page break, so it was read as a heading rather than something the camp does. If it is a real event, add it under Fixed Events. | SHORTEN: `"X": read as heading` |
| :1964 | Worth a second look | SHORTEN: `Check` |
| :1967-1969 | These will be added like everything else. They just do not read like the other names, so they may be a cell that got split in an odd place — worth a glance before you continue. | CUT |
| :2021 | Which age division each group belongs to. Left as-is uses what the file itself says. | CUT (the select shows "From file: X") |
| :2076 | From file: X / No age division (from file) | KEEP / SHORTEN `From file: X`, `None` |
| :2091 | + New age division… | KEEP |
| :2092 | No age division | SHORTEN: `None` |
| :2098 | placeholder "Age division name" | RWA `Yeladim` |
| :2118 | Guessed how often and for whom, from the file. Edit anything that looks wrong. | CUT |
| :2121 | Clear inferred rules | KEEP |
| :2154 | Recurring Events (section) | KEEP |
| :2157-2158 | These activities sat at the same time across a group's days, so they look fixed rather than scheduled fresh each day. They're added as recurring events you can edit later. | CUT |
| :2162-2163 | Some appeared on a majority of a group's days but not all — you'll be asked to confirm those on the next step. | CUT (confirm chips on rows; `Confirm` flag) |
| :2246 | Longer Blocks | KEEP |
| :2249-2250 | These filled more than one time block in a row. Tell us if this happens every week, or if it was a one-time thing. | CUT; buttons carry it |
| :2286 | Every week | KEEP |
| :2293 | Just this once | KEEP |
| :2326 | Names That Look Like Typos | SHORTEN: `Similar names` |
| :2329-2330 | Two spellings that might be the same thing. Shoresh won't merge these on its own — some camps really do run both. | CUT |
| :2350 | ✓ "V" will be read as "C" | SHORTEN: `✓ V → C` |
| :2351 | ✓ Kept apart — "V" and "C" are different things | SHORTEN: `✓ Kept apart` |
| :2363 | Are these the same thing? | CUT (buttons carry it) |
| :2367 | Same thing — call it "C" | SHORTEN: `Same → "C"` |
| :2370 | Different things — keep both | SHORTEN: `Keep both` |
| :2373 | Not sure — ask me later | SHORTEN: `Later` |
| :2392 | Cells We Weren't Sure About | SHORTEN: `Unclear cells` |
| :2395-2396 | These cells combined more than one word. Tell us what each one means — Shoresh will remember your answer for next time. | CUT |
| :2434 | ✓ Wrapper — "W" won't become its own activity | SHORTEN: `✓ Wrapper` |
| :2435 | ✓ Alternatives — either one is eligible | SHORTEN: `✓ Alternatives` |
| :2436 | ✓ Kept as one thing, as written | SHORTEN: `✓ As written` |
| :2449 | Is this one activity as written, or are "A" and "B" two separate things? | CUT; show the cell text `A + B` and 3 buttons |
| :2450 | Is this one activity as written, or does "W" mean something happens around "X"? | CUT |
| :2454 | One thing, as written | SHORTEN: `As written` |
| :2458 | "W" is a wrapper around "X" | SHORTEN: `W wraps X` |
| :2462 | These are alternatives — either one | SHORTEN: `Either one` |
| :2465 | Not sure — ask me later | SHORTEN: `Later` |
| :2491 | Your camp already has N items set up across the entire camp. What should happen to them? | SHORTEN: `N items already set up` + two option cards |
| :2494 | Keep them / Add what I import alongside what's already here. | SHORTEN: `Add to existing` ; sub CUT |
| :2495 | Replace them / This will replace all Age Divisions, Groups, Days, Time Blocks, and Activities across the entire camp — every Program, not just this one. Clears the N existing items first, then imports. | SHORTEN: `Replace all` ; sub: `N items cleared (all Programs)` (KEEP the scope fact: safety-critical) |
| :2532-2533 | Both your Manual Build and Generated Schedule will be cleared (N slots). | SHORTEN: `N slots cleared (both schedules)` (KEEP, destructive consequence) |
| :2535-2536 | Your N Recurring Events will be cleared. They are recoverable from Trash. | SHORTEN: `N Recurring Events cleared (Trash)` |
| :2541-2544 | You have N saved schedule versions. Unlike the items above, these are not Trash-restorable — they name groups and activities that will no longer exist, so replacing makes them permanently unrestorable. | SHORTEN: `N saved versions lost permanently` (KEEP, safety-critical irreversible) |
| :2572 | Cannot be undone | KEEP (safety flag) |
| :2591 | Waiting for a Program to load before importing… | RWA: disabled Import button with spinner |
| :2616 | Replace with N records / records | KEEP |
| :2647 | Not set | KEEP |
| :2700 | Worth checking — groups unclear | SHORTEN: `Groups unclear` |
| :2742-2743 | Shoresh couldn't tell from this file's layout which groups do which activity, so eligibility is left open. Worth checking. | CUT (the flag `Groups unclear` on :2700 suffices) |
| :2798 | Split into A + B. | KEEP (calm confirmation, short) |
| :2818 | Also a flexible activity — split into two? | SHORTEN: `Split in two?` |
| :2855 | Reuse it | KEEP |
| :2857 | Attach the flexible pattern to the existing "X" activity. | CUT |
| :2861 | Pick a different name | SHORTEN: `Rename` |
| :2862 | Choose another suffix. | CUT |
| :2879 | "X" also appears on its own, outside the fixed time — split it into two activities? | SHORTEN: `"X": split fixed vs. flexible?` |
| :2892 | Add a suffix so the two activities have different names. | CUT; suffix field with placeholder `(flex)` |
| :2909 | Not now | KEEP |
| :2095(reconciliation) | CONFIDENCE_COPY (reconciliationCards.jsx :17-22) | SHORTEN to one word each (see Activities :101) |

## A2. Schedule, electives, events, special days (partition 2)

### Copy sweep 2 (read-only). Verdicts: CUT / AFFORD (replace-with-affordance) / SHORT / KEEP. Paths relative to src/.
Note: "That X could not be Y." write-failure fallbacks (via describeWriteFailure) are one grouped row per file: they name the failed thing, SHORT-form already; KEEP unless noted.

## screens/ScheduleScreen.jsx
| line | text | verdict |
|---|---|---|
| 618-619 | Try to fit ${requiredBefore} in before ${byDay} — ${beforeCount} so far. Spread them out if you can. | SHORT: "${beforeCount} of ${requiredBefore} before ${byDay}" |
| 629 | No activity this group can do fits here | SHORT: "Nothing fits" |
| 638 | More groups are booked into this than it holds | SHORT: "Over capacity" |
| 646 | Marked not to run this week | SHORT: "Off this week" |
| 837 | The week you're building (caption) | CUT (route tab label "Manual" already says it) |
| 839 | Start from a blank week with your meals and recurring events already in place. You place every activity yourself — the way you would in a spreadsheet, but it watches... | CUT; AFFORD: card shows a tiny preview thumbnail of blank grid with meals filled; title "Build it myself" only |
| 840 | Start a blank week | KEEP (action label) |
| 844 | The week the app proposed (caption) | CUT |
| 846 | The app fills the week from your activity targets. You then move things around by dragging. | CUT; AFFORD: thumbnail of filled grid with a drag-cursor on one cell |
| 862 | Which week do you want to open? | SHORT: "Open" with two route cards (no question) |
| 863 | You have both. Opening one changes nothing about the other, and you can switch any time from the left. | CUT (route tabs on left are the affordance) |
| 1056 | Rebuild this schedule | SHORT: "Rebuild" |
| 1098 | Export to Excel | KEEP (action) |
| 1102 | title="Machine-readable schedule data for another tool" | CUT |
| 1102 label | Export data (JSON) | SHORT: "Export JSON" |
| 1152 | Spread across the week (stat label) | KEEP (short label, StatBadge note) |
| 1178 | intro title "What this week still needs" / sub "Nothing here is a mistake. It's what's left to place." | SHORT title "Still to place"; CUT sub |
| 1179 | Everything on your list is placed. | SHORT: "All placed" |
| 1188 | Nothing to light up here — this concern is about time that isn't placed yet. See the list. | CUT; AFFORD: row with no grid target is rendered non-clickable (no highlight affordance) |
| 1190 | Showing ${n} of ${m} here — open the list to reach the rest. | SHORT: "${n} of ${m} shown" |
| 1191 | ${n} lit on the grid. | SHORT: "${n} highlighted" or CUT (count on badge) |
| 1204 | ⊡ ${n} of ${m} to paste — click a cell to place "${name}" | SHORT: "Paste ${name} (${n} left)" |
| 1209 | Esc to cancel | KEEP-or-AFFORD: use an ✕ button, no text |
| 1248 | How do you want to build this week? | CUT; show two route cards directly |
| 1249 | You can do both. Nothing you build one way affects the other. | CUT |
| 937,1042,ElectivesScreen 81 etc. | title="Admin only" | KEEP (explains disabled control; 2 words) |
| 1024/1030 | Undo: ${desc} / Nothing to undo / Redo... / Nothing to redo | KEEP (names what undo does); "Nothing to undo" -> CUT, just disable |
| 1476 + slotCellConstants.js | Legend descriptions (see below) | see slotCellConstants |

## screens/SpecialSchedulesScreen.jsx
| 17 | No special days or events yet. | SHORT: "None yet" + the add row visible (AFFORD) |
| 26 | This special day was deleted. | SHORT: "Deleted on another device" KEEP (must name) |
| 27 | This event was deleted. | same |
| 125 | Couldn't load your camp setup — check your connection and refresh. | SHORT: "Couldn't load camp setup." (no network instruction; app is local-first, "check your connection" is wrong advice) |

## screens/ScheduleElectivesScreen.jsx
| 15 | No elective sets yet. | SHORT: "None yet" |
| 105 | Couldn't load your camp setup — check your connection and refresh. | SHORT: "Couldn't load camp setup." |

## screens/ElectivesScreen.jsx
| 76 | title="Build this set's offerings from Electives under Schedule" | CUT |
| 102-103 | That elective set could not be added/saved. | KEEP |
| 123 | An elective set with this name already exists — choose a different name. | SHORT: "Name already used." |
| 137,152 | That elective set could not be deleted. / The elective choices could not be cleared. | KEEP |
| 177 | No elective sets yet (title) | CUT (keep one of title/body) -> keep this, cut body |
| 178 | Type a name below to add your first one. | CUT; AFFORD: focused blank add-row is right there |
| 223 | title="Clear every elective choice, assignment and run for ${scopeName}" | SHORT: "Clear electives — ${scopeName}" |
| 233 | No elective runs to clear for X — nothing was changed. | SHORT: "Nothing to clear." |
| 234 | Cleared N elective runs for X and their choices and assignments. | SHORT: "Cleared N runs." |
| 240 | Clear elective choices for ${scopeName}? / Clear all elective choices for the season? | KEEP (confirm title names the action) |
| 241 | This permanently removes only the elective runs for X ... from this device and from every device this camp syncs with. A device that is offline will catch up... can reappear... (long body) | SHORT: "Deletes N runs, their choices and assignments, on every device. Can't be undone." |
| 242 | Kept: your elective sets and their offerings, campers, groups, tiers, activities, and schedules... | CUT |
| 252 | Delete "${name}"? | KEEP |
| 253 | Its offerings go with it. Any schedule cell pointing at it falls back to showing nothing scheduled — the same handling as any deleted reference. | SHORT: "Its offerings go with it." |

## screens/elective/ElectiveSetDetail.jsx
| 43 | Import from a file | SHORT: "Import" |
| 44 | No schedule could be read out of that. It may be a scan rather than a document with text in it. | SHORT: "Couldn't read that file." |
| 153 | A minimum to run has to be at least 1. | SHORT: "Minimum is 1 or more." (or clamp stepper at 1 = AFFORD) |
| 226 | title="Place this set on a schedule first — bundles are built from its placed periods." | SHORT: "Place this set on a schedule first" |
| 261,284 | placeholder "No cap" / "No minimum" | KEEP (2 words, values) |
| 366-367, 497, 510, 525, 535, 547, 669, 694, 729, 757 | "That X could not be saved/deleted/removed" write failures | KEEP (group) |
| 778 | an offering whose activity is no longer in your catalog | SHORT: "a removed activity" |
| 782 | "X" is in this set but not on the sheet you just imported. It was left as it is — nothing was removed. | SHORT: "Not on the sheet, kept: X" |
| 783 | N offerings are in this set but not on the sheet you just imported — left as they are, nothing removed: ... | SHORT: "N not on the sheet, kept: ..." |
| 800 | No offerings yet (empty-state title; body line follows in emptyStyles) | CUT body, AFFORD: add-offering row focused |
| 820,822 | Who can go / Minimum to run (column headers) | SHORT: "Open to" / "Minimum" |
| 871 | It stops being one of this set's choices. The activity itself is untouched. | SHORT: "The activity is kept." |
| 881 | Clear all offerings from this set? | KEEP |
| 893 | Its periods and division scope go with it, and this can't be undone. | SHORT: "Can't be undone." |

## screens/elective/BundleEditor.jsx
| 152 | placeholder "Pick a period below to name this bundle" | CUT; AFFORD: name field disabled until a period is picked, periods highlighted |
| 158 | aria-label "Bundle name — a camper's preference sheet must match this text" | SHORT: "Bundle name" (a11y label only) |

## screens/event/EventGridEditor.jsx
| 35,27 | ← Back to Special Schedules | SHORT: "← Special Schedules" |
| 42 | No time blocks yet. | CUT (empty grid with add row) |
| 43 | Add your first block and group to start building this schedule. | CUT; AFFORD: the blank "+ block" / "+ group" add-cells shown in the empty grid |
| 44 | This event was deleted. | SHORT: "Event deleted on another device" KEEP |
| 46 | No schedule could be read out of that. It may be a scan rather than a document with text in it. | SHORT: "Couldn't read that file." |
| 159,176 | Could not seed this schedule from your camp setup. | SHORT: "Couldn't copy camp setup." |
| 190 | Couldn't load your camp setup — check your connection and refresh. | SHORT: "Couldn't load camp setup." |
| 232-406 | Could not add/rename/reorder/remove block/group, place/create activity, set location, clear schedule | KEEP (group) |
| 266 | This block has filled cells. Remove it anyway? | SHORT: "Remove block and its N cells?" |
| 326 | This group has filled cells. Remove it anyway? | SHORT: "Remove group and its N cells?" |
| 546-567 | titles Move left/right/up/down, Remove group/block | KEEP (icon buttons need names) |
| 636,671 | title="Click to rename" | CUT (inline-editable text affordance: hover underline) |

## screens/specialDay/SpecialDayGridEditor.jsx (+ seedFailureMessage.js)
| 27 | ← Back to Special Schedules | SHORT: "← Special Schedules" |
| 32 | + location | KEEP |
| 33 | No time blocks yet. | CUT |
| 34 | Add your first block, or go back and seed from your camp's regular time blocks. | CUT; AFFORD: "+ block" cell and a "Use camp blocks" button in the empty grid |
| 35 | This special day was deleted. | KEEP (SHORT as above) |
| 114 | Couldn't load your camp setup — check your connection and refresh. | SHORT: "Couldn't load camp setup." |
| 168-290 | Could not rename special day / save notes / add,rename,reorder,remove block / place,create activity / set location | KEEP (group) |
| 224 | This block has filled cells. Remove it anyway? | SHORT: "Remove block and its N cells?" |
| 344 | No groups yet. | KEEP-title |
| 345 | Add groups in Camp Set Up before building this special day's grid. | SHORT: "Add groups in Camp Set Up." with link (AFFORD: button to Camp Set Up) |
| 367-371 | Move up/down, Remove block | KEEP |
| 420 | placeholder "Team rosters, station staffing, points, trip times…" | CUT -> "Notes" |
| seedFailureMessage:10 | Only seeded N of M time blocks before hitting an error — the rest were not added. | SHORT: "Added N of M blocks." |
| seedFailureMessage:11 | Could not seed time blocks. | SHORT: "Couldn't add blocks." |

## screens/schedule/* (hooks; error strings)
| useSlotMutations 624,923,1264,1320,1344,1397,1502,1583,766,785,796,1077,1197 | "That activity/elective/event could not be placed/created/restored/locked/..." | KEEP (group; names failed thing) |
| useSlotMutations 1117,1134,1229 | This block changed since you extended/shortened/split it — undo skipped for that cell. | SHORT: "Undo skipped: block changed." |
| useSlotMutations 1213 | Split back into two → ${where} | KEEP (undo description) |
| rowFlags 27 | This period has an unfillable slot | SHORT: "Unfillable slot" |
| rowFlags 28 | This period needs attention | SHORT: "Needs attention" |
| useWeeks 16-73 | That week could not be created/archived/brought back/duplicated; That name could not be saved | KEEP (group) |
| useUndoRedo 34,46 | That undo/redo could not be applied. | KEEP |
| useSnapshots 94 | Only an admin can delete a saved version | SHORT: "Admin only." |
| useSnapshots 100 | That version could not be deleted. It is still in the list. | SHORT: "Couldn't delete that version." |
| useSnapshots 123 | That saved version belongs to the other schedule. Switch to it to restore this version. | SHORT: "Belongs to the other schedule." |
| useSnapshots 165 | Only an admin can restore a version. | SHORT: "Admin only." |
| useSnapshots 183 | Restored. N cell(s) referenced items that no longer exist (likely from a re-import) and were skipped. | SHORT: "Restored; N cells skipped (item removed)." |
| useSnapshots 72,95,166,192 | That version could not be saved/deleted/restored/renamed | KEEP |
| useGeneration 108,196 | This schedule could not be generated: a fixed or recurring event is not linked to a valid activity. Fix it on the Fixed/Recurring Events screen and try again. | SHORT: "Couldn't generate: a recurring event has no activity." (+AFFORD: link to that screen) |
| useGeneration 122,207 | Could not open the generated/manual schedule — nothing was changed. Try again, and tell support if it repeats. | SHORT: "Couldn't open it. Nothing changed." |
| useGeneration 131,216 | Could not save undo point — regeneration cancelled | SHORT: "Couldn't save undo point. Cancelled." |
| useGeneration 144 | Only an admin can regenerate the schedule | SHORT: "Admin only." |
| useGeneration 145,229 | That schedule could not be regenerated. / That fixedEvents could not be placed. | SHORT: second -> "Couldn't place recurring events." (leaks identifier fixedEvents); also 228 "Only an admin can place fixedEvents" -> "Admin only." |
| useScheduleData 193,245 | Failed to load schedule data — check your connection and refresh | SHORT: "Couldn't load the schedule." |
| useScheduleData 237 | ${name} was deleted on another device. | KEEP |
| useScheduleData 377 | Failed to load saved schedule — check your connection and refresh | SHORT: "Couldn't load the saved schedule." |
| useDragFSM 162 | That change could not be saved. | KEEP |
| useClipboardSelection 69 | You cannot paste onto a recurring event, or onto the second half of an activity that runs across two periods. | SHORT: "Can't paste there." (AFFORD: those cells don't take the paste-hover highlight) |
| slotOccupant 25 | throw message (developer) | KEEP (not user-facing) |

## components/schedule/
| ManualBuildView 299 | Drag activities from the left panel onto any open cell, or click an empty cell to type one in. An empty cell just isn't filled yet. | CUT; AFFORD: palette items have grab cursor, empty cells show faint "+" on hover |
| ExportChooserModal 16 | Which schedule do you want to export? | SHORT: "Export which?" with two route buttons |
| VersionsDropdown 65 | Auto-saved before each regeneration | SHORT: "Auto-saved" |
| VersionsDropdown 71 | No versions saved yet. | SHORT: "None yet" |
| VersionsDropdown 114,217 | placeholder "Version name…" / "Name current version…" | KEEP (short) |
| VersionsDropdown 162 | This version recorded no schedule data and cannot be restored | SHORT: "Empty — can't restore" |
| VersionsDropdown 185,193 | Permanently delete this version / Delete this empty version / Delete this version | SHORT: "Delete" (single title) |
| VersionsDropdown 224 | Save as named version | SHORT: "Save version" |
| ConfirmRegenModal 19 | Rebuild this schedule? | KEEP |
| ConfirmRegenModal 21 | The app will propose a fresh schedule and replace the one you're looking at now, including any changes you've dragged into it. | SHORT: "Replaces this schedule, including your edits." |
| ConfirmRegenModal 24 | Anything you built on the Manual side is not touched. | CUT |
| ConfirmRegenModal 27 | You can get this one back from Versions. | SHORT: "Saved to Versions first." |
| ConfirmRegenModal 34 | title="Director only" | KEEP |
| DeleteWeekDialog 55-56 | This week can't be deleted while it has elective assignment runs: X. Delete those runs first — doing it here would destroy their rosters and imported preferences too. | SHORT: "Delete its elective runs first: X." |
| DeleteWeekDialog 60,66 | Week could not be deleted. Please try again, or restart the app if this keeps happening. | SHORT: "Couldn't delete the week." |
| DeleteWeekDialog 95 | Week X has {clauses}. Deleting it removes all of that permanently — this cannot be undone. | SHORT: "Deletes {clauses}. Can't be undone." |
| DeleteWeekDialog 96 | Deleting it removes all of that permanently — this cannot be undone. | SHORT: "Can't be undone." |
| DeleteWeekDialog 110 | There is no way to get this week back. | CUT (duplicates "cannot be undone") |
| StatBadge 33 | Reviewing — click to stop / Click to review these | SHORT: "Stop reviewing" / "Review" ; "click" instructions CUT |
| FindingsRail 58 | title="I can live with this — hide it" | SHORT: "Hide" |
| FindingsRail 31 | No issues found. (default emptyText) | CUT/KEEP-icon only |
| WeekSwitcher 101,123,132,166,175 | Rename/Duplicate/Archive this week; Bring this week back; Permanently delete this week | SHORT: "Rename", "Duplicate", "Archive", "Restore", "Delete" |
| WeekSwitcher 206 | placeholder "Week name…" | KEEP |
| WeekContextBar 15 | Same as every other week | SHORT: "Default" or CUT (show nothing when unchanged) |
| ExclusionConfirmDialog 12 | "X" is currently placed in N time slots in W's schedule. Turning it off doesn't touch those now — they stay right where they are until you rebuild this schedule, and it won't be placed there again after that. | SHORT: "Placed in N slots in W. They stay until you rebuild." |
| ExclusionConfirmDialog 15 | Turning it back on later does not refill those time slots — you'll place it again where you want it. | CUT |
| ActivityPalette 103,156 | Expand / Collapse activity panel | SHORT: "Expand" / "Collapse" |
| ActivityPalette 198 | placeholder "Filter…" | KEEP |
| CellInlineEditor 125 | placeholder "Type an activity…" | SHORT: "Activity" |
| SlotCell 379/380 | Split this back into two periods (title+aria) | SHORT: "Split" |
| SlotCell 404 | Split before this block | SHORT: "Split here" |
| SlotCell 430/431 | Drag to make this activity run longer | SHORT: "Extend" ; AFFORD: resize-handle bar cursor |
| SlotCell 447,456 | Open X in Electives / Open X in Events | SHORT: "Open X" |
| SlotCell 481 | More groups booked in than this holds | SHORT: "Over capacity" |
| SlotCell 488 | Marked not to run this week | SHORT: "Off this week" |
| SlotCell 492,507 | Unfillable / Outdoor activity | SHORT: "Outdoor" |
| SlotCell 501/502 | This cell was changed by another device — dismiss | SHORT: "Changed on another device" |
| slotCellConstants 137 | More groups booked in than this activity holds | SHORT: "Over capacity" |
| slotCellConstants 145 | No eligible activity could be placed here | SHORT: "Unfillable" |
| slotCellConstants 155 | This activity or group is marked not to run this week | SHORT: "Off this week" |
| slotCellConstants 168 | Replaced by a concurrent edit on another device | SHORT: "Changed on another device" |
| slotCellConstants 185 | Changed for this day only — the rest of the week is unaffected | SHORT: "This day only" |
| slotCellConstants 192 | Held in place — regenerating will not move it | SHORT: "Locked" |
| slotCellConstants 199 | Same slot every day — meals, tefillah, flagpole | SHORT: "Every day" |
| slotCellConstants 206 | This group is not scheduled during this block | SHORT: "Not scheduled" |

## components/ (pickers/dialogs)
| ActivityPicker 66 | All existing activities are already offered here. Type a name below to add a new one. | CUT; AFFORD: "+ Add" row is present when query typed |
| ActivityPicker 112/113 | Search or add an activity… | SHORT: "Activity" |
| LocationPicker 21 | Type a location, or add a new one… | CUT |
| LocationPicker 135 | New location — set how many groups fit at once here, or change it later on the Locations screen. | SHORT: "New location — groups at once:" next to CapacityStepper |
| LocationPicker 136 | The schedule will keep this activity to ${cap} here. | SHORT: "Holds ${cap}" |
| LocationPicker 145 | The location set here no longer exists — pick a new one. | SHORT: "Location removed" |
| LocationPicker 164 | placeholder "Search your camp's locations…" | SHORT: "Location" |
| NameSubjectDialog 46 | This device's account is not allowed to name campers. | SHORT: "Not allowed." |
| NameSubjectDialog 47,53 | That name could not be saved. | KEEP |
| NameSubjectDialog 63 | Whose sheet is this? | KEEP (question is the field label; 4 words) |
| NameSubjectDialog 87 | placeholder "First and last name" | KEEP |
| CohortPicker, CapacityStepper, ScheduleDoor | no 4+-word user-facing strings found by grep | n/a (not individually verified beyond grep) |

## screens/elective/assignment/ (AssignmentPanel, ParseSummary, MappingCorrector, builders)
| AssignmentPanel 95 | Camper data in this feature is not yet encrypted at rest. Do not use real camper names until this is enabled. | SHORT: "Not encrypted — use test names." |
| AssignmentPanel 106 | At-rest encryption is on for this device. It does not cover data written before it was enabled, or a peer device syncing this camp with it off. | CUT (state "Encrypted" badge) |
| AssignmentPanel 184 | Checking whether camper data is encrypted at rest on this device… | CUT (no placeholder text; render nothing/skeleton) |
| AssignmentPanel 212 | Replace the sheet you're working on? | SHORT: "Replace this sheet?" |
| AssignmentPanel 514,536 | No rows could be read out of that file. | SHORT: "Couldn't read that file." |
| AssignmentPanel 759 | That file does not read as a camper preference sheet — no camper-name column and no ... | SHORT: "Not a preference sheet." |
| AssignmentPanel 773 | This sheet cannot be assigned yet. | KEEP (title) |
| AssignmentPanel 1001 | Some offerings have a blank capacity and must be fixed before this run can be solved. | SHORT: "Fill blank capacities first." |
| AssignmentPanel 1129 | N camper(s) list the division "X", which is not a division on this schedule — did you mean "Y"? They were considered for every occurrence. | SHORT: "N campers: unknown division "X". Did you mean "Y"?" |
| AssignmentPanel 1130 | ...which is not a division on this schedule. They were considered for every occurrence. | SHORT: "N campers: unknown division "X"." |
| AssignmentPanel 1140 | ...matches more than one division on this schedule — rename one of them to tell them apart. They were considered for every... | SHORT: "N campers: "X" matches several divisions." |
| AssignmentPanel 1157 | N camper(s) in "G" were not placed — their schedule has no period for this elective set. | SHORT: "N campers in G not placed: no period." |
| AssignmentPanel 1172 | N camper(s) are listed on the sheet under "X", but the camp has them in G, which is a different division. They were not placed. Check... | SHORT: "N campers listed under "X" but in G. Not placed." |
| AssignmentPanel 1196 | No campers could be placed. | KEEP |
| AssignmentPanel 1487 | This set's placement on the schedule could not be read for assignment. | SHORT: "Couldn't read this set's placement." |
| AssignmentPanel 1500 | This set isn't on a schedule yet. | KEEP (short) |
| AssignmentPanel 1574 | No camper preferences yet | KEEP title |
| AssignmentPanel 1575 | Import a preference sheet to assign campers into this set's offerings. | CUT; AFFORD: Import button beside title |
| AssignmentPanel 1630 | This set is placed on more than one schedule — choose which to assign against: | SHORT: "Assign against:" with route chips |
| ParseSummary 118 | Add "X" as an activity | SHORT: "Add "X"" |
| ParseSummary 130/133 | Map "X" to an activity this camp has / Map to an activity this camp has… | SHORT: "Map to activity…" |
| ParseSummary 167,168 | Read as separate choices / Added as an activity | KEEP (state labels) |
| ParseSummary 214 | This sheet can't be assigned yet | KEEP |
| MappingCorrector 92 | Filled in from the last time you imported this form. Change anything that looks wrong — | CUT |
| MappingCorrector 114 | No rank columns were found. Ranks look like #1, #2, #3 in your header — add one below. | SHORT: "No rank columns. Add one." |
| MappingCorrector 160 | Each column can only be one of them — change one before confirming. | SHORT: "Two columns share a role." |
| AssignmentPreview 115 | No campers could be placed | KEEP |
| buildOfferings 89 | "X" is set to limited capacity but the number is blank — fill it in to run electives. | SHORT: ""X": capacity blank." |
| buildOfferings 115 | "X" was ranked by campers but does not match any offered activity. | SHORT: ""X" ranked but not offered." |
| buildOfferings 124 | An offered activity ("X") was not ranked by any camper. | SHORT: ""X" offered but never ranked." |
| deriveOccurrences 46 | Group G has no division/tier -- it was skipped for assignment. | SHORT: "Group G skipped: no division." |
| deriveOccurrences 59 | A placement of this set is missing a day or time block -- it was skipped for assignment. | SHORT: "Placement skipped: no day or block." |
| resolvePreferenceCoordinates 150-152 | A choice was written for X, which this camp does not have, so it could not be placed. Nothing was guessed at — check the day and period names... | SHORT: "Unknown day/period: X." |
| resolvePreferenceCoordinates 164-167 | A choice was written for D P, which names only half of a cell — ... left unplaced rather than assigned to a ... | SHORT: "Day or period missing: D P." |
| resolvePreferenceCoordinates 185-187 | A choice was written for D P, a real day and period at this camp but has no elective session in the schedule being filled... the other schedule may have that session. | SHORT: "No session at D P on this schedule." |

## screens/elective/run/ (runStateCopy, Draft/Final/Delete/RunList)
| runStateCopy 28 | Start a new version | KEEP |
| runStateCopy 38 | a camper who is no longer on the roster | SHORT: "removed camper" |
| runStateCopy 53 | This run's schedule changed on another device since you last regenerated. Finalizing now would lock in an outdated version. | SHORT: "Schedule changed. Regenerate first." |
| runStateCopy 55 | A location or activity this run depends on is now double-booked on the main schedule. Fix the conflict there, then finalize again. | SHORT: "Double-booked on the schedule. Fix it, then finalize." |
| runStateCopy 56 | This run was already finalized — on this device or another. Reloading it now. | SHORT: "Already finalized." |
| runStateCopy 62 | This run was finalized on another device while you had it open. It can't be changed — reload it to see the final version. | SHORT: "Finalized on another device." |
| runStateCopy 67 | This run was finalized, so it can't be regenerated. Reload it to see the final version. | SHORT: "Already final." |
| runStateCopy 74 | This run was finalized before a later change on another device synced in. It is out of date. | SHORT: "Out of date." |
| runStateCopy 106 | L has N campers assigned against a capacity of C. | SHORT: "L: N of C." |
| runStateCopy 110 | X's locked placement no longer matches this run — regenerating removed the occurrence it pointed to. | SHORT: "X's lock no longer applies." |
| runStateCopy 114 | N placements in this run came from an earlier version of this schedule. | SHORT: "N placements are from an older schedule." |
| runStateCopy 285-286 | "L" does not W — N campers kept their request as an ordinary choice. | SHORT: ""L": N campers' requests treated as ordinary." |
| runStateCopy 298 | N campers on this run's sheet have no ranked choice and no placement. | SHORT: "N campers: no choice, not placed." |
| runStateCopy 308,315,316 | N campers who are no longer on the roster / This camper is no longer on the roster. / These campers... | SHORT: "removed" |
| runStateCopy 343 | Preparing this run so it can be regenerated… | SHORT: "Preparing…" |
| runStateCopy 344 | This run can't be regenerated right now — go back to Runs and open it again. | SHORT: "Can't regenerate now." |
| runStateCopy 349 | This run could not be prepared for regenerating — go back to Runs and open it again. | SHORT: "Couldn't prepare this run." |
| runStateCopy 356 | Preparing this run is taking longer than expected — go back to Runs and open it again. | SHORT: "Taking too long." |
| runStateCopy 364 (FINALIZE_HINT) | Locks this run. You'll see it as Final, and can always start a new version later. | CUT |
| runStateCopy 365 (REGENERATE_HINT) | Solves this run again from the current schedule, keeping the seats you locked. | CUT |
| runStateCopy 370-371 (COLD_REGENERATE_NOTE) | Regenerating a reopened run reconsiders every camper this run's sheet named — including anyone with no ranked choice and no placement. | CUT |
| runStateCopy 413 | W is double-booked over its capacity of C: A are scheduled there at once. | SHORT: "W: A double-booked (capacity C)." |
| runStateCopy 425 | A conflict was found, but its details could not be shown. | SHORT: "Conflict (details unavailable)." |
| runStateCopy 494-495 | N one of their choices / N placed outside their preferences | KEEP |
| runStateCopy 500 | No campers placed yet. | KEEP |
| camperElectiveWeek 85 | One of their choices | KEEP |
| DraftRunView 224 | Finalizing failed: E. Nothing was changed — try again, or contact support if this keeps happening. | SHORT: "Couldn't finalize: E. Nothing changed." |
| DraftRunView 434,473,490 | That placement/preference could not be saved/removed. | KEEP |
| DraftRunView 1034/1056/1064/1074 | renders FINALIZE_HINT / REGENERATE_HINT / unavailable note / COLD note beside buttons | CUT all four (see runStateCopy) |
| DeleteRunDialog 33-37 | Deleting this run removes it and its camper placements ... offline will catch up ... briefly reappear ... change history ... re-pair ... exported copy | SHORT: "Deletes this run and its placements on every device. Can't be undone." |
| DeleteRunDialog 50 | That run could not be deleted. | KEEP |
| FinalRunView 74-76, 126-128 | This run's snapshot has not fully synced to this device yet (N of M rows) — export would be incomplete, so nothing was produced. Wait for sync... | SHORT: "Not fully synced (N of M rows). Try again after sync." |
| FinalRunView 178-180 | ...export is refused until it does, to avoid printing a schedule with silent gaps. | SHORT: "Not fully synced (N of M rows)." |
| RunList / useRunState 1 each | (short status strings, not individually opened) | n/a |

## A3. Shell, auth, admin, reconciliation, dialogs (partition 3)

### copy3: copy sweep (verdict: CUT default)
Columns: file:line | exact text | verdict

## src/App.jsx
| line | text | verdict |
|---|---|---|
| 139 | This camp's default weekdays could not be set up. | SHORTEN: "Weekdays not set up." (names failed thing) |
| 140 | This camp's default cohort could not be set up. | SHORTEN: "Default program not set up." |
| 146 | This camp's default weekdays and default cohort could not be set up. ${daysCause} | SHORTEN: "Weekdays and program not set up. ${cause}" |
| 148 | ${describeWriteFailure(days...)} ${describeWriteFailure(cohort...)} (joins both long subjects) | SHORTEN: join the short subjects above |
| 242 | A location named "${msg.existing.name}" already exists and wasn't created. | SHORTEN: "\"${name}\" already exists." |
| 243 | A change could not be saved because it conflicts with existing data. | SHORTEN: "Not saved: conflicts with existing data." |
| 359 | The previous attempt has not finished yet, so this was not retried. If nothing changes, restart the app. | SHORTEN: "Still working on the last try." (drop restart instruction) |
| 638 | Retrying… / Try again (op-rejected notice button) | KEEP (action label) |
| 646 | {queueCount} more | KEEP (count) |
| 785 | Something went wrong | SHORTEN: "Couldn't start" |
| 787 | An unexpected error occurred while starting the app. (fallback when device.error empty) | CUT -> show device.error only, or "Couldn't start" ; no fallback sentence |
| 796 | Try again | KEEP (action) |

## src/components/layout/Sidebar.jsx
| line | text | verdict |
|---|---|---|
| 276 | Collapse ${section.title} / Expand ${section.title} (aria/title) | SHORTEN: chevron already shows state; keep as aria-label only, no tooltip |
| 321 | **Setup looks complete.** Tuck this away? | REPLACE-WITH-AFFORDANCE: no offer panel; collapse the setup sections automatically once complete (chevron stays to reopen). If a prompt must remain: "Tuck away?" |
| 324 | Tuck away | CUT with panel (auto-collapse) |
| 325 | Keep open | CUT with panel |
| ~202 | needed (meta label on empty required row) | KEEP (the `!` mark already says it; could CUT word and keep `!`) -> SHORTEN to `!` only |
| 400 | title: Development database — not the installed app's data\n${projectPath} | SHORTEN: "Dev database" (DEV badge already shows) ; path-only title otherwise |
| ~412 | title={`Build: ${buildLabel}`} | KEEP (diagnostic tooltip) |
| 453-456 | Backing up… / Backup saved / Backup failed / Backup now | KEEP (state labels, one-two words) |
| 523/525 | sync not running | SHORTEN: "offline" or dot indicator + name of failed thing "not syncing" |
| 539 | trying… / try again | KEEP (action) |
| 612 | Trying to start sharing… | CUT -> drop tooltip; row shows "trying…" |
| 613 | Sharing with the other computers hasn't started on this computer yet. Click to try again. | CUT (row itself is the "try again" button) |
| 627 | trying… / try again | KEEP |

## src/components/layout/TopBar.jsx
| line | text | verdict |
|---|---|---|
| 8-38 | TITLES map (Roots, Programs, Age Divisions, Groups, Days, Time Blocks, ... Open items, LAN & Devices, About & Legal, Import last year) | KEEP (screen names, not explanatory); SHORTEN "LAN & Devices" -> "Devices", "About & Legal" -> "About" |
| 89 | Log out | KEEP |

## src/components/layout/navSections.js
| line | text | verdict |
|---|---|---|
| 39-125 | nav labels (Age Divisions, Time Blocks, Fixed Events, Recurring Events, Special Events, Generated Schedule, Manual Build, Special Schedules, Elective Schedules) | KEEP (labels) |
| 143 | Re-import last year | KEEP (action) |
| 156 | LAN & Devices | SHORTEN: "Devices" |
| 33/53/92 | section titles Germination / Sprouts / Plants | KEEP (brand vocabulary, not explanatory) |

## src/components/layout/Shell.jsx
| none | no user-facing copy | n/a |

## src/screens/AboutScreen.jsx
| line | text | verdict |
|---|---|---|
| 94 | Shoresh is a scheduling tool for summer camps. | CUT |
| 26 | It runs on your own devices. (agreement heading) | SHORTEN/KEEP: legal surface; keep headings |
| 28-32 | Shoresh has no accounts and no servers. It does not send your camp's information anywhere. ... not through us. | SHORTEN to 1 sentence: "Your camp's data stays on your devices and never goes through us." |
| 35 | You are responsible for the information you put in. | KEEP (legal) |
| 37-39 | That includes any details about campers and staff. Keep your devices secure, and share a camp code only with people you mean to let in. ... | SHORTEN: "You are responsible for campers' and staff details. Share the camp code only with people you trust." |
| 42-46 | It is free and open source. ... full license ... shown below. | SHORTEN: "Free and open source (Apache 2.0)." |
| 49-54 | It comes with no warranty. Shoresh is provided "as is" ... | KEEP (legal warranty disclaimer; trim "Always keep your own record" sentence -> CUT) |
| 57-60 | No one is watching. Shoresh collects no analytics ... nothing to opt out of... | SHORTEN: "No analytics. No data collected." |
| 114 | Shoresh is free and open source, released under the Apache License 2.0. (License section; duplicates agreement point) | CUT (duplicate) |
| 67-74 | APACHE_NOTICE license text | KEEP (legal) |
| 78-80 | Shoresh is built on open-source software. The complete list of third-party dependencies ... scripts/generate-licenses.js ... | REPLACE-WITH-AFFORDANCE: a "Third-party licenses" link/button opening the list; CUT dev-script path sentence |
| 99/120 | section titles User agreement / Third-party software | KEEP |

## src/screens/BootRecoveryScreen.jsx
| line | text | verdict |
|---|---|---|
| 4 | set this device up again and join your camp from another paired device (REJOIN fragment) | SHORTEN: "Join again from another device." |
| 8 | This device can't open its camp data | KEEP (names failure) |
| 9 | Shoresh couldn't unlock the camp file ... Your camp isn't lost — every other device paired ... has a full copy. To recover, set this device up again... | SHORTEN: "Can't unlock this device's camp data. Your camp is safe on your other devices." + button "Join again" |
| 12 | This device's camp key is missing | KEEP |
| 13 | The key this device uses to lock its camp data can't be found, so Shoresh stopped rather than make a new one ... If you moved or restored files ... put them back ... Otherwise, ${REJOIN}. | SHORTEN: "Camp key not found. If you moved files, put them back." |
| 16 | Shoresh can't read its own files | KEEP |
| 17 | Shoresh isn't allowed to read some of its files ... usually a file-permissions problem. Ask whoever looks after this computer ... | SHORTEN: "File permission denied." |
| 20 | This computer's secure storage isn't available | KEEP |
| 21 | Shoresh keeps camp data locked using this computer's secure storage, ... Restart the computer, sign in ... | SHORTEN: "Secure storage unavailable. Restart and open Shoresh again." |
| 25 | An update to this camp's file was interrupted | KEEP |
| 35 | Shoresh was securing this camp's file when it was stopped part-way, and it couldn't finish ... Your original copy is safe ... It's kept here: | SHORTEN: "Update interrupted. Your original is safe at:" |
| 36 | Keep this file. You can also recover by setting this device up again ... | CUT |
| 38 | Shoresh was securing this camp's file when it was stopped part-way, and no saved copy was found ... To recover, set this device up again ... | SHORTEN: "Update interrupted. No saved copy found." |
| 54 | Details were saved for whoever helps you with Shoresh. | CUT |
| 56 | Quit Shoresh | KEEP |

## src/screens/CampBootstrapScreen.jsx
| line | text | verdict |
|---|---|---|
| 25 | Something went wrong. Try again. | SHORTEN: "Couldn't create camp." |
| 53 | HOSTING ON THIS DEVICE | CUT |
| 56 | Set up your camp | KEEP (title) |
| 58-59 | This is a one-time setup. You'll create the first director account — you can add more staff once you're in. | CUT |
| 65/75/84 | labels Camp name / Your name / Create a PIN | KEEP (field labels) |
| 69 | e.g. Camp Willowbrook | KEEP (placeholder example) or CUT; example is show-don't-tell -> KEEP |
| 79 | e.g. Sarah Cohen | KEEP (same) |
| 89 | 6 or more digits | KEEP (security-relevant PIN rule; make placeholder only) |
| 94-95 | You'll use this PIN to log in on this and any connected device. As the director, your PIN needs to be at least 6 digits — staff you add later can use a shorter one. | CUT (placeholder "6+ digits" carries the rule; inline error if short) |
| 103 | Create camp & continue → | SHORTEN: "Create camp" |

## src/screens/ModeSelectScreen.jsx
| line | text | verdict |
|---|---|---|
| 13 | Camp activity scheduling | CUT (tagline; wordmark enough) |
| 16 | First launch on this computer | CUT |
| 17 | How is this device being used? | SHORTEN: drop; the two cards are the question |
| 19-20 | Shoresh needs one computer to hold the master schedule. Choose how this one participates — you can't change this later without reinstalling. | CUT (the "can't change later" is a consequence: surface it as a confirm on choose if true) |
| 31 | Host this camp's schedule | SHORTEN: "Start a camp" |
| 33-35 | This computer starts the camp. Other staff devices ... every device keeps its own full copy. Choose this on the camp office computer... | CUT |
| 49 | Join a camp already set up | SHORTEN: "Join a camp" |
| 51-52 | Connect to a Shoresh Host already running on your network — for staff laptops, counselor stations... | CUT |

## src/screens/SeedScreen.jsx
| line | text | verdict |
|---|---|---|
| 18 | Seed your camp. | KEEP (brand moment, single heading) |
| 25 | Import last year | KEEP (action) |
| 32 | Start by hand | KEEP (action) |

## src/screens/LoginScreen.jsx
| line | text | verdict |
|---|---|---|
| 95 | Camp activity scheduling | CUT (tagline) |
| 98 | Sign in | KEEP |
| 110 | That PIN doesn't match {name}. Try again — you have a few attempts left. | SHORTEN: "Wrong PIN." (attempts-left wording is security-relevant: keep only if exact count shown: "Wrong PIN. 2 left.") |
| 117 | Couldn't reach the app right now. Check your connection and try again. | SHORTEN: "Can't reach the app." |
| 121 | Enter your name and PIN to continue. | CUT (fields are labeled) |
| 128 | e.g. Sarah Cohen | KEEP (example placeholder) |
| 166 | Just a moment | CUT |
| 168-169 | Too many attempts. For security, sign-in is paused briefly. It'll unlock automatically — no need to do anything. | KEEP-SHORT (lockout wording security-relevant): "Too many attempts. Try again in" + timer; CUT "no need to do anything" |
| 171 | Signing in… / Sign in | KEEP |

## src/screens/ConflictsScreen.jsx
| line | text | verdict |
|---|---|---|
| 19 | A staff member's name | SHORTEN: "Staff name" |
| 20 | A staff member's role | SHORTEN: "Staff role" |
| 23 | Which activity is in a cell | SHORTEN: "Activity" |
| 24 | Which group a cell belongs to | SHORTEN: "Group" |
| 25 | Whether a cell was held in place | SHORTEN: "Locked" |
| 38 | Whether an activity is a scheduled event or a free choice | SHORTEN: "Scheduled or free choice" |
| 44 | A change to this record (fallback label) | SHORTEN: "Change" |
| 62 | Two staff members are both named "${value}". | SHORTEN: "Duplicate staff name: ${value}" |
| 66 | Two schedules exist for ${dayName}. | SHORTEN: "Duplicate day: ${dayName}" |
| 66 | Rename or delete one on the Days screen. (whereToFix) | REPLACE-WITH-AFFORDANCE: the "Go to Days" button (line 164) already does it; CUT sentence |
| 70 | Two ${kindLabel} schedules exist for this camp. | SHORTEN: "Duplicate ${kind} schedule" |
| 73 | Two camp maps were created for this camp. | SHORTEN: "Duplicate camp map" |
| 75 | Two records collide on a value that must be unique. | SHORTEN: "Duplicate record" |
| 84-88 | N minutes/hours/days ago | KEEP (time stamp) |
| 105 | PIN was changed | KEEP (security-relevant; no PIN value shown) |
| 129 | Keep this version / Saving… | SHORTEN: "Keep" / "Saving…" |
| 164 | Go to Days | KEEP (affordance) |
| 289 | Saved — this will reach the other computers when they are back in range (kept the first/second version) | SHORTEN: "Kept ${label}'s version" (drop sync explanation) |
| 290 | ✓ Kept ${confirmedSide}'s version | KEEP |
| 296 | A PIN was changed on two devices / The camp map image | SHORTEN: "PIN changed" / "Camp map" |
| 330 | No conflicts to resolve | SHORTEN: "No conflicts" |
| 332 | Everything's in sync. | CUT (title already says it) |
| 341 | N conflicts need your attention | SHORTEN: "N conflicts" |
| 344 | These happened while two devices made changes at the same time. Pick which version to keep for each one. | CUT (two side-by-side "Keep" cards are self-explanatory) |

## src/screens/conflictsNotice.js
| line | text | verdict |
|---|---|---|
| 13 | This changed again — pick again below. | SHORTEN: "Changed again." |
| 16 | Couldn't reach the network — try again when connected. | SHORTEN: "Not connected." |
| 19 | Something went wrong — try again. | SHORTEN: "Not saved." |

## src/screens/TrashScreen.jsx
| line | text | verdict |
|---|---|---|
| 18 | This kind of record is not restorable here. | SHORTEN: "Can't be restored." (better: hide Restore button for those kinds = REPLACE-WITH-AFFORDANCE) |
| 19 | The main computer does not hold enough of this record's history to rebuild it. | SHORTEN: "No history to restore from." |
| 20 | This record is already back. | SHORTEN: "Already restored." |
| 21 | Only an admin can restore records. | CUT (hide Restore button for non-admins; see 273) |
| 28 | A record with that name already exists, so this can't be restored. Rename or remove the existing one first. | SHORTEN (names failure): "Can't restore: name already in use." |
| 33 | A record named "${name}" already exists, so this can't be restored. Rename or remove ... first. | SHORTEN: "Can't restore: \"${name}\" already exists." |
| 35 | That restore did not go through. Try again in a moment. | SHORTEN: "Restore failed." |
| 41 | ${who} is back. ${caveat} / ${who} is back. | SHORTEN: "${who} restored." (caveat text lives in recordLabels restoreCaveat; see that file) |
| 91 | The deleted records could not be read just now. | SHORTEN: "Couldn't load trash." |
| 114 | Waiting for the main computer to bring ${name} back. It will happen as soon as this device reaches it — you can close the app in the meantime. ${caveat} | SHORTEN: "${name}: restore queued." |
| 129 | That restore did not go through — check your connection and try again. | SHORTEN: "Restore failed. Not connected." |
| 157 | ${brought} of ${n} brought back. ${stillOut} still to do. | SHORTEN: "${brought} of ${n} restored." |
| 158 | ${brought} record(s) brought back. | SHORTEN: "${brought} restored." |
| 161 | ${count} ${caveats.join(' ')} | CUT caveats (see recordLabels) |
| 178-180 | N records were deleted with ${parent}: names. They are still deleted. | SHORTEN: "Also deleted with ${parent}: names." ; CUT "They are still deleted." |
| 187 | Bring those back too | SHORTEN: "Restore those too" (KEEP action) |
| 189 | Leave them | KEEP (action) |
| 195 | Waiting on the main computer | SHORTEN: "Queued" |
| 179/203 | an unnamed ${entity} / name not known on this device | SHORTEN: "unnamed ${entity}" / "unnamed" |
| 208 | Will be restored as soon as this device reaches the main computer. | CUT (section title "Queued" says it) |
| 220 | Nothing deleted | KEEP (empty-state title) |
| 221 | Deleted records appear here and can be restored. | CUT |
| 231-233 | Name / Deleted / By | KEEP (column headers) |
| 244 | · ${deleted_on_device_name} | KEEP (data) |
| ~254 | History / Restore / Restoring… | KEEP (actions) |
| 273 | Only an admin can restore records. | CUT (hide/disable Restore for non-admins; nothing else needed) |

## src/screens/JoinByCodeScreen.jsx
| line | text | verdict |
|---|---|---|
| 100 | That code doesn't look right — it's 8 characters, like K4P7-2MRQ. | SHORTEN: "Invalid code." (placeholder K4P7-2MRQ already shows shape) |
| 113 | Couldn't finish closing the previous attempt yet — wait a moment and try again. | SHORTEN: "Previous attempt still closing." |
| 153 | Something went wrong while joining. You can try again. | SHORTEN: "Couldn't join." |
| 170 | Too many tries. Wait a moment and try again. | SHORTEN (lockout, security): "Too many tries. Wait a moment." |
| 171 | That name and PIN didn't match. Try again. | SHORTEN: "Wrong name or PIN." |
| 187 | Couldn't sign in. You can try again. | SHORTEN: "Couldn't sign in." |
| 205 | Join a camp (eyebrow, repeated in Waiting/Outcome 329,345) | CUT eyebrows (title carries it) |
| 206 | Enter the code from your camp's computer | SHORTEN: "Camp code" |
| 208 | On the main computer, open Device Manager and choose Add a device. It will show you a code. | CUT (REPLACE-WITH-AFFORDANCE: the main computer's Add a device screen shows the code large; nothing needed here) |
| 215-216 | placeholder K4P7-2MRQ / aria-label Camp code | KEEP |
| 225 | Looking for your camp… | KEEP (spinner label) |
| 225 | Make sure this device is on the same Wi-Fi as the main computer. | CUT |
| 230 | No camp answered that code | SHORTEN: "Camp not found" |
| 231 | Check that: • the code matches ... • someone chose Add a device ... • both devices are on the same Wi-Fi | CUT (button "Try again" only) |
| 239 | That computer couldn't confirm the code | SHORTEN: "Code not confirmed" |
| 240 | A computer answered, but it couldn't prove it belongs to this camp. Double-check the code ... | CUT |
| 248 | Waiting for approval | KEEP |
| 249 | Someone at the main computer needs to allow this device in. This screen will move on by itself. | CUT |
| 256 | Not on the camp's network / This device wasn't allowed in | SHORTEN: "Not on camp Wi-Fi" / "Not allowed in" |
| 258 | Pairing must happen on the camp's local network — connect this device to the same Wi-Fi/LAN ... VPN, Tailscale and mobile-carrier connections can't be used to pair. | CUT (title names the failed thing) |
| 259 | Whoever is at the main computer turned down the request. You can ask them and try again. | CUT |
| 267 | Almost there | CUT |
| 268 | Sign in | KEEP |
| 269 | Use the same name and PIN you use on the main computer. | CUT |
| 275-287 | placeholders Your name / PIN, aria-labels | KEEP |
| 295 | Getting your camp's schedule… | SHORTEN: "Getting your camp…" |
| 295 | This usually takes a few seconds. | CUT |
| 300 | Signed in, but nothing arrived | SHORTEN: "Nothing arrived" |
| 301 | This device was allowed in, but the camp's schedule didn't come through. Check that the main computer is still on ... | CUT |
| 313 | Done | CUT |
| 314 | You've joined {camp} | SHORTEN: "Joined {camp}" |
| 316 | This device is now part of {camp}. It will find the camp on its own from now on — you won't need the code again. | CUT |
| 318 | Continue / Cancel | KEEP |

## src/screens/DeviceManagerScreen.jsx
| line | text | verdict |
|---|---|---|
| 12-19 | status labels: Allowed in / Waiting for approval / Turned away / No longer allowed / Not set up yet | KEEP (status words) |
| 31 | label: Hidden | KEEP |
| 38-41 | This device reports that it has applied the purge: the camper is hidden from view there. The record is suppressed, not deleted — ... guess-resistant logical erasure, not cryptographic. | KEEP-SHORT (security/privacy-relevant; tooltip): "Hidden on this device. Suppressed, not cryptographically erased." |
| 44 | Not confirmed | KEEP |
| 46-47 | This device has not reported applying the purge. It may be offline or not yet caught up — its state is unknown, never silently treated as erased. | SHORTEN: "Not confirmed; may be offline." |
| 55 | Purge status is tracked only for devices currently in the camp. | CUT |
| 59 | The device disconnected before approval — ask it to request again | SHORTEN: "Device disconnected." |
| 91 | Couldn't read this camp's code. | SHORTEN: "Couldn't load camp code." |
| 104 | Couldn't change whether new devices can join. | SHORTEN: "Couldn't change joining." |
| 129 | Couldn't load your devices — check your connection and refresh. | SHORTEN: "Couldn't load devices." |
| 151/164/176 | Failed to approve / deny / revoke device | KEEP (names failed thing) |
| 223 | Device Manager | KEEP |
| 232 | Add a device (section title; repeated on button 257) | CUT title (button carries it) |
| 237 | On the new device, choose Join a camp and enter this code. | CUT (code shown large is the instruction) |
| 245 | This computer is listening for new devices. Their request will appear below for you to approve. | CUT (Stop adding devices button + code show the state; pending list appears below) |
| 248 | Stop adding devices | KEEP (action) |
| 254 | Setting up {camp} on a second computer or tablet? Start here, then enter the code it shows you on the new device. | CUT |
| 265 | Pending Pairing Requests | SHORTEN: "Requests" |
| 267 | No pending pairing requests. | SHORTEN: "None" or hide section when empty |
| 272/329 | Device Name | KEEP |
| ~ | ID / Actions / Status / Purge status / Authorized At | KEEP |
| 311 | View only from this device | SHORTEN: "View only" |
| 322 | All Devices | SHORTEN: "Devices" |
| 324 | No devices connected yet. | CUT (hide table when empty; or "None") |
| 346 | Removal pending | KEEP |
| 380 | Confirm removal | KEEP (action) |
| 384 | You confirmed this removal | SHORTEN: "Confirmed" |
| ~388 | Revoked | KEEP |

## src/components/ConnectedToolsPanel.jsx
| line | text | verdict |
|---|---|---|
| 8 | Read and change | KEEP (access label) |
| 26/34 | Couldn't load your connected tools. | SHORTEN: "Couldn't load tools." |
| 49 | Couldn't authorize that tool. | KEEP |
| 62 | Couldn't revoke that tool. | KEEP |
| 70 | Connected Tools | KEEP |
| 72-78 | Authorize the scripts and assistants that work with this camp's data, such as the MCP server and the import command-line tools. Each one gets its own name and secret ... Revoking stops ... "Read only" is honored by well-behaved tools, but it is not a lock ... | CUT all but one security-relevant clause. KEEP-SHORT: "Read only is a request, not a lock." (security-relevant honesty) |
| 84 | Secret for "{label}". This is the only time it is shown, so copy it now and keep it with that tool's settings. | SHORTEN (security-relevant): "Secret for \"{label}\" - shown once." |
| 89 | I've saved it | KEEP (action) |
| 94 | No tools are authorized yet. | CUT (empty table + Authorize form) |
| 132 | Tool name | KEEP |
| 138 | e.g. Greg's laptop MCP | KEEP (example placeholder) |
| 144-145 | Read only / Read and change | KEEP |
| 154 | Authorize tool | KEEP |

## src/components/ConfirmDangerDialog.jsx
| line | text | verdict |
|---|---|---|
| 59-60 | {body} paragraph + {recovery} line (props from callers) | KEEP slot but callers should supply <=1 short line; recovery CUT unless it is the undo path ("Goes to Trash") |
| 62 | Cancel / Working… | KEEP |

## src/components/DeleteRecordDialog.jsx
| line | text | verdict |
|---|---|---|
| 74 | Nothing uses ${who} right now. | CUT (no blast radius to state; confirm label suffices) |
| 76 | ${list} use ${who} right now. Deleting it takes ${who} off all of them — they stay on the schedule, just without a location. | SHORTEN (destructive blast radius): "Used by ${list}. They keep their slots, lose the location." |
| 80 | Nothing in your schedules uses ${who}. | CUT |
| 81 | ${who} is used in ${places} in your schedules. Deleting it empties those cells — everything else in the week stays exactly where it is. | SHORTEN: "Empties ${places}." |
| 93 | ${campers} camper(s) is/are in ${who} — they are not deleted, but they will have no group until you put them in one. | SHORTEN: "${campers} campers will have no group." |
| 95 | Nothing in your schedules uses ${who}.${camperNote} | CUT first clause; KEEP camperNote |
| 96 | ${who} is used in ${places} in your schedules. Deleting it removes its whole week from both schedules — there is nothing left behind to fill in.${camperNote} | SHORTEN: "Removes it from ${places} in both schedules." |
| 102 | Nothing in your schedules uses ${who}. | CUT |
| 104 | ${who} holds ${list} across your schedules. Deleting it removes that day from every group's week. | SHORTEN: "Removes ${list} from every group's week." |
| 112 | ${who} goes to Trash, and you can put it back from there — but the activities won't automatically start using it again. | SHORTEN: "Goes to Trash. Activities won't reuse it automatically." |
| 116 | ${who} goes to Trash, and you can put it back from there. | SHORTEN: "Goes to Trash." |
| 117 | ... but the cells it was in stay empty. Putting it back does not put it back on the schedule. | SHORTEN: "Goes to Trash. Cleared cells stay empty." |
| 120 | ${who} goes to Trash, and you can put it back from there. | SHORTEN: "Goes to Trash." |
| 121 | Both schedules are saved exactly as they are now, before anything is removed. You can bring the week back later from Versions on the Schedule screen, and ${who} comes back from Trash. | SHORTEN (destructive undo path): "Schedules saved as a Version first. ${who} goes to Trash." |
| ~150 | Delete “{name}”? | KEEP (destructive confirm) |
| 146 | Only an admin can delete records. | SHORTEN: "Admins only." (better: hide Delete for non-admins = REPLACE-WITH-AFFORDANCE) |
| 164-168 | Delete and clear N places / Delete {the entity} | KEEP (destructive confirm label) |

## src/components/RecordHistory.jsx
| line | text | verdict |
|---|---|---|
| 25/35 | a record that has since been deleted | SHORTEN: "deleted record" |
| 33 | N records | KEEP |
| 45 | ${who} deleted this | KEEP |
| 49-53 | ${who} changed/set X to/from ... | KEEP (history data) |
| 88 | No changes recorded for this record yet. | SHORTEN: "No changes" |

## src/components/AuthWatermark.jsx
| none | decorative, aria-hidden | n/a |

## src/screens/RootsHomeScreen.jsx
| line | text | verdict |
|---|---|---|
| 34-37 | card labels Activities / Groups / Age Divisions / Locations / Days & Blocks / Fixed Events | KEEP |
| 202/219 | aria-label ${row.name} — ${row.why} | KEEP (screen reader; `why` itself should be 2-3 words) |
| 293 | The worksheet could not be created. | SHORTEN: "Worksheet failed." |
| 311 | What has taken root | CUT (cards are self-labelled) |
| 313 | Reading your camp setup… | SHORTEN: "Loading…" |
| 336 | aria-label ${label} — couldn't be read | KEEP (a11y, names thing) |
| 337 | title: Couldn't be read just now | SHORTEN: "Couldn't read" |
| 352/354 | Import last year / Download worksheet | KEEP (actions) |
| 360/370 | Needs your attention (aria + heading) | SHORTEN: "Attention" |
| 385-386 | Some of your camp couldn't be read just now, so this list may be incomplete. Reopening Roots will try again. | SHORTEN: "Some data couldn't be read. List may be incomplete." (drop 2nd sentence) |
| 393 | Nothing needs you right now. | SHORTEN: icon + "All clear" or icon only |
| ~420 | +N more → | KEEP |

## src/screens/rootsChips.js
| none | no user-facing copy | n/a |

## src/screens/attentionRowDestination.js
| none | no user-facing copy | n/a |

## src/screens/recordLabels.js
| line | text | verdict |
|---|---|---|
| 44-77 | field labels: Groups per slot / Fewest per week / Most per week / Same age division only / Eligible age divisions / Preferred by day / Preferred by day, fewest / Wet-weather alternative / Length in blocks / Part of day / Day of the week / Fixed-event model / Held in place / Runs across two periods | KEEP (field names); SHORTEN "Held in place" -> "Locked", "Runs across two periods" -> "Two periods" |
| 100 | Replaced in bulk | KEEP |
| 105 | fallback "something" | KEEP |
| 134 | It is not back on the schedule, though — any cells it was cleared from are still empty. | REPLACE-WITH-AFFORDANCE: after restore, show the existing "Versions" link only where relevant; else CUT |
| 136 | Its week did not come back with it, though. You can bring that back from Versions on the Schedule screen. | CUT (affordance: "Open Versions" button on the restore notice) |
| 138 | What was scheduled on it did not come back, though. You can bring that back from Versions on the Schedule screen. | CUT (same "Open Versions" button) |
| 140 | Activities that pointed to it are not re-bound, though — you will need to set their location again. | SHORTEN: "Activities lose this location." |

## src/screens/reconciliationTray.js
| line | text | verdict |
|---|---|---|
| 35/45 | Use this setup | KEEP (action) |
| 38 | Nothing needed a decision. | CUT |
| 48 | All N decided. | CUT |
| 56 | Use what Shoresh understood | SHORTEN: "Use understood" |
| 59 | N questions are still open — they stay here for later. | SHORTEN: "N still open" |
| 64 | Apply N decisions | KEEP (action) |
| 67 | N questions stay here for later. | SHORTEN: "N still open" |
| 104-106 | N changed since import / N still in use / kept parts | KEEP (receipt facts) |
| 111 | Nothing to undo. | KEEP-SHORT or CUT |
| 113 | Nothing removed — everything had changed since import. | SHORTEN: "Nothing removed." |
| 115 | Nothing removed — kept ${keptClause}. | SHORTEN: "Nothing removed. Kept ${keptClause}." |
| 118 | Removed N records the import created. | SHORTEN: "Removed N records." |
| 120 | Removed N records the import created. Kept ${keptClause}. | SHORTEN: "Removed N. Kept ${keptClause}." |
| 126 | Kept — changed since import: ${fields} | KEEP |
| 131 | ${name} (used by N other records) | KEEP |
| 133 | Kept — still in use: ${items} | KEEP |
| 157 | Imported N records from the file. | SHORTEN: "Imported N records." |
| 160 | Setup replaced and ready. | SHORTEN: "Setup replaced." |
| 164 | Undo complete. | KEEP |
| 176 | for the next few minutes | CUT (show countdown only: "Ns left") |
| 180 | Undo this import | SHORTEN: "Undo import" |

## src/screens/reconciliationTriage.js
| line | text | verdict |
|---|---|---|
| 26 | Only an admin can import a schedule. | SHORTEN: "Admins only." (or hide Import for non-admins) |
| 27 | ${message} Nothing was imported. | SHORTEN: "Not imported: ${message}" |
| 28 | Nothing was imported. Your camp is exactly as it was. | SHORTEN: "Import failed. Nothing changed." (reassurance of no data change is important on failure) |
| 125 | developer throw message | n/a (not user-facing) |

## src/screens/ReconciliationScreen.jsx
| line | text | verdict |
|---|---|---|
| 196 | Could not check this file against your camp. | SHORTEN: "Couldn't read file." |
| 310 | Couldn't remember "${label}" | KEEP (names failed thing) |
| 354 | Checking this file against your camp… | SHORTEN: "Checking…" |
| 465 | N rows read cleanly — nothing needed from you. | SHORTEN: "N understood" |
| 467 | Hide details / Show details | KEEP |
| 506 | N items not mentioned in this file — left as-is, not a problem. | SHORTEN: "N not in file" |
| 508 | Hide / Show them | KEEP (Show them -> "Show") |
| 534 | Nothing left to reconcile. | SHORTEN: "All done" |
| 536 | Your camp setup reflects this file. You're ready to build a schedule. | CUT (the "Go to Schedule" button is the next step) |
| 540 | Go to Schedule | KEEP |
| 571/578 | Could not mark this item handled — try again; the item is still listed and nothing was lost. | SHORTEN: "Couldn't mark handled." |
| 587 | Checking open items… | SHORTEN: "Loading…" |
| 594 | Open items | KEEP (title) |
| 595 | Open each item in the screen where it's fixed, or mark it handled — that just removes it from this list, doesn't change anything in your camp, and can't be undone. | CUT subtitle. Mark handled is irreversible: put that on the button as confirm-free label "Dismiss" ; if truly needed KEEP-SHORT: "Handled items are removed." |
| 600 | Nothing needs you right now. | SHORTEN: "All clear" |
| 617 | Open in ${screen} → | KEEP (affordance) |
| 621 | Mark handled | KEEP |

## src/components/reconciliation/reconciliationCards.jsx
| line | text | verdict |
|---|---|---|
| 18 | clearly stated in the file | SHORTEN: "stated" |
| 19 | inferred from context | SHORTEN: "inferred" |
| 20 | a guess — worth a second look | SHORTEN: "guess" |
| 21 | in conflict with what Shoresh already has | SHORTEN: "conflicts" |
| 36-42 | seen across N groups / observed on X of Y operating days / across groups | KEEP (evidence facts) |
| 57-61 | seen in row N, sheet / set by hand | KEEP (evidence) |
| 66 | From this file — ${confidenceLine}. | SHORTEN: "${confidence}" |
| 67 | No evidence details available for this field. | CUT |
| 92-93 | From this file / Current Shoresh record | SHORTEN: "File" / "Current" |
| 118 | Hide the activities / Show the N activities | SHORTEN: "Hide" / "N activities" |
| 142-143 | Electives · name | KEEP |
| 152/154 | Named by X / Named by X and N other activities | KEEP (evidence) |
| 163 | entity · name · domain | KEEP |
| 170 | Is "word" a place at your camp? | KEEP (the question; short) |
| 174 | Shoresh needs an answer about "name"'s field before it can finish this import. | SHORTEN: "\"name\" - field?" |
| 177 | Keep the current value for "name"'s field or use the file's value? | SHORTEN: "\"name\" - field: keep or use file's?" |
| 178 | Is "name" a new record, or one you already have? | SHORTEN: "\"name\": new or existing?" |
| 186 | "name" wasn't imported from a file — keep it or overwrite from this one? | SHORTEN: "\"name\": keep or overwrite?" |
| 189 | Review priority for N activities carried over from an earlier import | SHORTEN: "Priority for N activities" |
| 200-201 | This looks like an elective period. Create an empty "X" elective set? (You'll add the activities on the Electives screen.) | SHORTEN: "Create elective set \"X\"?" ; CUT parenthetical |
| 208 | Use the file's value for "name"? | KEEP-SHORT |
| 213-221 | answer summaries: Using the file's value / Will use the file's value / Keeping the current value / Using your existing record / Adding as new / Imported with no room — won't be asked about this word again / Skipped — nothing written for this field / Empty elective set created / Not an elective period — left as-is | SHORTEN each to 2-3 words; 218 -> "No room"; 219 -> "Skipped"; 221 -> "Not electives" |
| 263 | Not a place — ignore it | SHORTEN: "Not a place" |
| 265 | Use instead → | KEEP |
| 262 | Yes, add {word} | KEEP |
| 274 | Use this existing place instead. | CUT |
| 288-289 | Use this value / Keep current | KEEP |
| 309/396 | Use the file's value — "v" ; description: Overwrites what's in Shoresh now. | KEEP label; CUT description |
| 317/398 | Keep the current value — "v" ; description: Ignores this file's value going forward for this field. | KEEP label; CUT description |
| 331-332 | Create elective set / Not electives | KEEP |
| 346-347 | It's for all camp; ${who} missed it that week. Everyone is eligible. | KEEP label; CUT description |
| 351-352 | It really excludes ${who}; Keep it limited to the groups the file shows. | KEEP label; CUT description |
| 368 | Skip this field | KEEP |
| 379-380 | Use "name"; Matches an existing record. | KEEP label; CUT description |
| 384 | Something else — add as new; Creates a new record from the file's value. | SHORTEN: "Add as new"; CUT description |
| 385 | Leave unset for now; Skip this decision — it stays here for you to come back to; nothing is written for it. | SHORTEN: "Decide later"; CUT description |
| 460 | This came up N times. Answering here answers all N. | SHORTEN (changes what the action does): "Applies to all N" |
| 470 | ✓ summary | KEEP |
| 480 | Remember this for next time | KEEP (checkbox) |
| 487 | From this file · confidence | KEEP |
| 493 | day · block → day · block | KEEP |
| 511 | ${label} aren't set up yet — ${message} | SHORTEN: "${label} not set up." |
| 512 | ${label} is required before you can build a schedule. | CUT |
| 516/551 | READY TO BUILD? | CUT |
| 524/564 | Skipped — ${label} still isn't set up. | SHORTEN: "Skipped" |
| 535/577 | Set up ${label} | KEEP |
| 538/580 | Skip ${label} for now — I'll add it later | SHORTEN: "Skip" |
| 553 | Your camp still needs: ${labels} | SHORTEN: "Needs: ${labels}" |
| 566 | Undo | KEEP |

## src/components/reconciliation/reconstructionMomentCopy.js
| line | text | verdict |
|---|---|---|
| 41 | Your whole camp came through clean. | SHORTEN: "All clear" or CUT (grid of green rows shows it) |
| 45 | ${labels} need(s) a quick look. | CUT (rows themselves are flagged) |
| 52 | ${understood} look(s) right. ${attention sentence} | CUT (REPLACE-WITH-AFFORDANCE: row status chips in grid) |

## src/components/reconciliation/ReconstructionMoment.jsx
| line | text | verdict |
|---|---|---|
| 67 | Checking this file against your camp… | SHORTEN: "Checking…" |
| 77 | Camp reconstructed | KEEP (title of the moment) |
| 79 | {sentence} paragraph (from copy file) | CUT (see above) |

## src/components/reconciliation/RosterList.jsx
| line | text | verdict |
|---|---|---|
| 59 | (no age division) | KEEP |
| 80 | Find in N... | KEEP (search placeholder) |
| 90 | label (count) | KEEP |
| 96 | No matches. | SHORTEN: "None" |

## src/components/reconciliation/RootMapPanel.jsx
| line | text | verdict |
|---|---|---|
| 21-ish | Understood / Needs attention / Changed / Not in source | KEEP (state labels); "Needs attention" -> "Attention" |
| 29 | Nothing needs you right now. Shoresh understood everything it found. | SHORTEN: "None need attention" |
| 30 | Nothing rooted yet — import something to get started. | SHORTEN: "Nothing yet" (Import button elsewhere is the cue) |
| 31 | Nothing has changed since your last import. | SHORTEN: "No changes" |
| 32 | Nothing left out — everything in this file matched your camp. | SHORTEN: "None missing" |
| 193 | Needs your attention (heading) | SHORTEN: "Attention" |
| 196 | Show all | KEEP |
| 217 | Nothing here yet — open the setup screen to add some. | CUT (Manage → button at 226 does it) |
| 218 | Everything here looks right. | SHORTEN: "All good" |
| 226 | Manage X → | KEEP |
| 243 | Nothing about camp culture was in this file yet. | SHORTEN: "None in file" |
| 331 | N resolved · Show all / Hide resolved | KEEP |

## src/components/reconciliation/RootMap.jsx
| line | text | verdict |
|---|---|---|
| 30-33,48 | Not yet rooted / Rooted / Rooted · Changed / Not started / Not in source | KEEP (state labels) |
| 80 | Unclear: ${unknowns} | KEEP |
| 155/168/219 | aria-labels name — label/count | KEEP |
| 173 | Click to confirm → | CUT (chip already looks pressable; REPLACE-WITH-AFFORDANCE: hover/pressed state) |
| 294 | Nothing imported yet — bring in your roster to get started. | SHORTEN: "Nothing imported" |
| 329 | No entities imported yet — this layer has no root. | SHORTEN: "None" |

## src/components/reconciliation/{domainRollup,groupIdenticalDecisions,selectionModel,rootMapNav,rootMapLayout,reconstructionMoment.gate}.js
| none | no user-facing copy found | n/a |
