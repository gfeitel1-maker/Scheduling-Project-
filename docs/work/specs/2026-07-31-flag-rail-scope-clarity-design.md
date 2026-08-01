---
title: "Flag/rail scope clarity — design"
document_type: spec
status: active
created: 2026-07-31
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-schedule-flag-findings-reshape.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: this work is merged and Verifier PASS recorded
---

# Flag/rail scope clarity — design

Companion to the reshape ADR. That ADR split per-slot marks from group-level
findings in the data model and it shipped correctly. This spec answers a
narrower question: the data model is right, so why does a director still
read it as duplication, and what is the smallest visual change that fixes
that reading.

## Diagnosis

**One part of the complaint is apparent, one part is real — and they need
different fixes.**

**Apparent duplication (data is right, presentation hides it):** `UNDERSERVED`
and `DISTRIBUTION` are genuinely group-level facts with no per-cell rendering
at all — a director cannot see them anywhere in the grid. There is nothing
to deduplicate here. The rail is the *only* place these facts exist. This
part of the complaint is a misdiagnosis: the director isn't seeing the same
information twice, they're seeing information whose scope they can't place,
and defaulting to "duplicate" as the nearest available explanation.

**Real duplication (by design, but under-signaled):** `UNFILLABLE` is
different. Its count in the `StatBadge` ("Unfillable: 3") is a sum of
*exactly* the glyphs already visible in the grid below — same flag, same
scope, aggregated. That's a legitimate pattern (a to-do list showing "3
remaining" next to three unchecked boxes is not redundant), but only if the
badge visibly behaves like a live tally of what's on screen. Right now it
doesn't read that way, because of what's described next.

**Root cause: `ScheduleScreen.jsx:1903-1934` renders four `StatBadge`s in one
undifferentiated row** — `Placed`, `Unfillable`/`Overlapping`, `Still
needed`, `Spread across the week` — identical in size, weight, and
interaction (every one of them opens the same `FindingsRail`). Two of those
badges are live tallies of marks the director can already see below them
(`UNFILLABLE`, `OVERLAP`); two are the *only* surface for facts that exist
nowhere else (`UNDERSERVED`, `DISTRIBUTION`). Nothing in the row's typography,
iconography, or the rail's own layout tells the director which is which. A
uniform row of four identical pills, all clickable, all opening one popover,
reads as "four ways to see the same list" — which is the duplication
complaint, verbatim.

**Answer to Q1:** both real and apparent duplication are present, but the
fix is the same for both: teach scope, don't remove data. Nothing needs to
stop existing.

## Visual grammar for scope

Two scope classes, both already present in the code, need a name and a
visual signature:

- **Grid-visible** (`UNFILLABLE`, `OVERLAP`) — this badge's number is a count
  of marks you can find on the grid right now, keyed to one cell each.
- **Grid-invisible** (`UNDERSERVED`, `DISTRIBUTION`) — this badge's number
  has no cell counterpart; the badge is the only place it lives.

The signal: **grid-visible badges get a small glyph that repeats the exact
mark used on the cell.** `UNFILLABLE` badge gets a miniature of the same
outline alert glyph (`SlotCell.jsx:60-68`) at 10px; `OVERLAP` badge gets a
miniature of the same 7px bronze dot. Grid-invisible badges get no glyph —
they keep the plain label they have today. This is a repetition of an
existing shape, not a new visual vocabulary: the director who has already
learned "circle-with-line = unfillable" on the grid sees the identical shape
shrunk down next to the count and the association reads immediately, with no
new legend entry required.

This single change answers Q2 directly: position/shape/containment/motion
were all considered and rejected in favor of the cheapest, most legible
signal — literal shape reuse. A new position or containment scheme would
teach a *new* thing; reusing the glyph teaches nothing the director hasn't
already learned from the grid.

## Is the rail in the right place?

**Yes, keep it where it is — this is the "don't redesign" finding.**

The rail already:
- anchors as a popover directly under the badge row (`FindingsRail.jsx`,
  `top: '100%'`), i.e. adjacent to the thing that opened it, not detached at
  the top of a long screen,
- is closed by default and opened on demand (`findingsRailOpen`), so it costs
  zero attention until the director asks for it,
- has a `locate` action (`locateFindingsRow` → `setView('group')` +
  `setSelectedGroup`) that jumps to the grid location — the connective
  tissue between rail and cell already exists, it's just not visible until
  you click a row.

Alternatives considered and rejected:
- **Inline banner above the grid, always open.** Costs permanent vertical
  space and contradicts "closed by default" — a director staring at this for
  hours does not want a fixed alert strip competing with the grid, which
  DESIGN_STANDARD.md §1 names as "the visual focus."
- **Per-cell tooltip only, no rail.** Already rejected by the ADR this spec
  follows — `UNDERSERVED`/`DISTRIBUTION` have no cell to attach to.
- **Split into two separate popovers** (one for grid-visible, one for
  aggregate). Rejected: doubles the click surface for one mental model the
  director needs to build once. A single rail with two clearly labeled
  sections (below) keeps one place to look, teaches the split without
  doubling the UI.

**Answer to Q3:** the rail's position is already correct. The problem was
never geographic distance from the grid — it's that the row of badges above
it gives no visual cue about what's inside.

## Minimum change (Karpathy principle)

Ranked by leverage, cheapest first — items 1-2 alone may be sufficient; test
before doing more:

1. **Copy.** Give the rail an explicit two-part heading instead of one static
   intro string. Section header text: `"On this grid"` above the
   `UNFILLABLE`/`OVERLAP` rows, `"This week overall"` above the
   `UNDERSERVED`/`DISTRIBUTION` rows. Zero layout change, answers "why do I
   see this twice" directly in words.
2. **Ordering + grouping inside the rail.** Currently `findingsRows` is one
   flat array sorted by severity (`ScheduleScreen.jsx:1463-1490`). Group by
   scope first, severity second, so the two section headers above have
   something to sit over that doesn't interleave.
3. **Glyph-on-badge** (described above) — the one true visual (not copy)
   change, and it's a repetition of existing shapes, not a new one.

If 1+2 alone test as sufficient with a director, skip 3. This spec specifies
3 anyway because it's cheap (two SVGs already exist, this reuses them at a
smaller size) and it's the only piece of the complaint that copy can't fully
solve — the badge row's uniform look is itself the thing being
misread, and copy inside a collapsed popover doesn't fix what the closed
state looks like.

**Answer to Q4:** the minimum change is items 1 and 2 — copy and grouping,
inside `FindingsRail`, no new component. Item 3 is the one restrained visual
addition, scoped to two 10px glyphs reused from `SlotCell.jsx`.

## Layout

No new components. Changes are confined to `ScheduleScreen.jsx` (badge row
+ `findingsRows` construction) and `FindingsRail.jsx` (section headers +
badge glyph passed in).

- `StatBadge` (wherever it's defined — check for an existing shared
  component before adding a prop; if it takes children/icon slot already,
  use that) gains an optional `glyph` prop: a tiny inline SVG or `null`.
  Passed only for the `Unfillable`/`Overlapping` badge, matching whichever
  the active route shows.
- `findingsRows` construction (`ScheduleScreen.jsx:1463-1490`) gains a
  `scope: 'cell' | 'week'` field: `'cell'` for `UNFILLABLE`/`OVERLAP` rows,
  `'week'` for `UNDERSERVED`/`DISTRIBUTION`. Sort key becomes
  `[scope, severity]` so cell-scope rows render first, week-scope second.
- `FindingsRail` renders one `<div>` section header (13px, `--text-secondary`,
  ~600 weight) before the first row of each scope group, only when both
  groups are non-empty (a single-scope rail — e.g. manual route with zero
  underserved findings — gets no header at all, since there's nothing to
  distinguish it from).

## Visual style

All values reference existing tokens; no new token is introduced.

- Badge glyph: reuse `UnfillableIcon` (`SlotCell.jsx:60-68`) and the existing
  inline `OVERLAP` dot markup (`SlotCell.jsx:277-287`), both already
  `var(--danger)` / `FLAG_COLORS.OVERLAP` respectively. Render at the same
  proportions, just smaller — 10px box for the glyph (down from 12px on the
  cell), 6px dot (down from 7px) — small enough to read as "the same mark,
  shrunk," not a new icon.
- Glyph sits to the *left* of the badge's numeral, 4px gap, vertically
  centered with the label text — mirrors `cellIdentityChip`'s existing
  `marginRight: 4` convention (`shared.js:406-414`) rather than inventing new
  spacing.
- Section header inside `FindingsRail`: `fontSize: 12`, `fontWeight: 600`,
  `color: 'var(--text-secondary)'`, `padding: '6px 10px 2px'`, no border (the
  existing `findingsRailRow` bottom border already separates rows visually;
  a second border on the header would be one rule too many).
- No color changes. `FLAG_SEVERITY`/`FLAG_COLORS`/`SEVERITY_BAR_COLOR`
  (`slotCellConstants.js:16-37`) are untouched — this spec is entirely about
  shape, grouping, and copy, per the hard constraint that colour never
  carries meaning alone, and per the decolorization spec's intent (below).

## States

- **Badge row, rail closed (default):** four `StatBadge`s, two carrying the
  new glyph, two not. No rail visible. This is the state a director sees
  100% of working time — it must not grow taller or heavier than today's row.
- **Badge row, rail open:** unchanged trigger (click any badge), unchanged
  popover mechanics. New: two section headers inside, rows grouped by scope.
- **Rail open, only one scope has rows** (e.g., generated route with
  UNFILLABLE issues but no findings, or vice versa): no section header shown
  — a single unlabeled list, exactly like the rail's current behavior when
  `emptyText` fires for zero rows in one category. Do not show a header
  labeling an empty group.
- **Rail open, both scopes empty:** unchanged, `emptyText` message stands.
- **Hover/focus on a glyph-bearing badge:** unchanged from existing
  `StatBadge` hover treatment — the glyph is decoration on an existing
  interactive element, not a new interactive target, and must not intercept
  the click.

## Interactions

- Clicking any of the four badges still opens the one shared rail (unchanged
  — this spec does not split the rail per Q3's rejected alternative).
  `onLocate` behavior for individual rows is unchanged.
- The glyph itself is not clickable and has no independent hover state — it
  is inline with the badge's existing click target, `pointerEvents: 'none'`
  is not required since it's a plain inline SVG with no listeners, but
  `pointer-events: none` should still be set defensively so a stray click on
  the glyph's bounding box can't be mis-attributed to something else later.

## Animation

No new animated moment. The rail's open/close remains whatever it already
is (`FindingsRail.jsx` currently sets `opacity: 1` unconditionally with a
reduced-motion branch that resolves to `animation: 'none'` — if that looks
like dead code today, it's out of scope for this spec; note it to Maker as a
pre-existing observation, not something to fix here). Section headers appear
instantly with the rows they group — they are not a separate animated
element, they render as part of the same list paint.

**Reduced motion:** unaffected, since nothing here adds motion.

## Accessibility

- Glyph shapes duplicate what non-colour encoding already exists on the
  cell (outline ring vs. filled dot) — this spec does not introduce a new
  colour-only signal anywhere.
- Section headers are plain text, read naturally by a screen reader
  traversing the rail in DOM order; no `aria-` additions needed beyond what
  `FindingsRail` already has (verify it has a landmark role — if not, that's
  a pre-existing gap outside this spec's scope, flag to Maker but do not
  silently expand scope to fix it here).
- Contrast: `var(--text-secondary)` on `var(--surface-elevated)` for the
  section header text is the same pairing already used for `.locator` text
  one line below it in the same row (`FindingsRail.jsx`) — already verified
  compliant in the decolorization work; no new pairing introduced.
- Glyph size (10px/6px) stays above the smallest existing on-screen glyph
  (the 7px `OVERLAP` cell dot) in absolute terms only marginally smaller;
  acceptable because the glyph is supplementary to an adjacent numeral and
  label, never the sole carrier of the count.

## What belongs in `S`

Nothing new. This spec deliberately adds zero entries to `src/styles/shared.js`:
- The section-header style is four properties, used in exactly one place
  (`FindingsRail.jsx`) — inlining it there is consistent with how
  `findingsRailRow` and `findingsRailPanel` already document adjacent, only
  slightly more complex styles as `S` entries because they're **shared
  across files**; a single-use style stays local per the same file's own
  precedent (compare `cellActionBtn`, which *is* shared across two call
  sites in `SlotCell.jsx` and therefore lives in `S`).
- The glyph markup reuses existing inline SVG already defined in
  `SlotCell.jsx` and `slotCellConstants.js` — if `StatBadge` needs to render
  it, extract the two SVG snippets into small named function exports
  alongside `UnfillableIcon`/`OutdoorIcon` in `SlotCell.jsx` (or promote to
  `slotCellConstants.js` if `SlotCell.jsx`'s no-non-component-exports rule,
  noted in that file's own header comment, applies) — not into `S`, since
  `S` holds style objects, not markup.

## Behaviour at 100 groups

- **Per-cell marks:** unaffected by scale — each `UNFILLABLE`/`OVERLAP` mark
  is drawn once per cell regardless of grid size; this spec touches no
  per-cell rendering path.
- **Badge numerals:** at 100 groups the `Unfillable`/`Still needed` counts
  can legitimately run into the dozens or low hundreds. The badge glyph does
  not scale with the number — it stays fixed-size regardless of whether the
  adjacent numeral is `3` or `340`. No truncation logic needed since these
  are plain numerals, not a list.
- **Rail contents:** at 100 groups, `findingsRows` can be long — this is
  already handled by the existing `maxHeight: 400, overflowY: 'auto'` on
  `findingsRailPanel` (`shared.js:456-466`), unchanged by this spec. Grouping
  by scope actually **helps** at this scale more than at 6 groups: a director
  scanning 60 "This week overall" rows benefits from the section boundary
  telling them where the smaller, more urgent "On this grid" list ends,
  since severity-only sorting (today's behavior) would otherwise interleave
  a handful of grid-visible danger rows among a long tail of caution/info
  week-level rows, burying the ones with an on-grid location to jump to.
- **Locate action at scale:** `locateFindingsRow` jumps to `view: 'group'`
  for one group — unaffected by total group count, since it targets exactly
  one. No change needed.
- **No pagination, no virtualization introduced** — out of scope for this
  spec; if 100-group rails prove too long in practice that's a follow-up
  ticket (e.g., a text filter atop the rail), not something this
  restrained a change should absorb.

## Prototype

`docs/work/specs/prototypes/2026-07-31-flag-rail-scope-clarity-prototype.html`

Static HTML/CSS (not React, not `S` objects — illustration only per the
task's own carve-out). Shows:
1. **Before** — today's uniform badge row + flat-sorted rail, 6 groups.
2. **After** — glyph-bearing badges + two-section rail, 6 groups.
3. **100-group case** — same after-state, rail populated with a long,
   scope-grouped list, to demonstrate the grouping's payoff at scale.

## Non-canonical-schedule check

This spec does not touch which route is shown, does not add or remove any
badge that exists only on one route, and does not change `UNFILLABLE`
(generated-only) or `OVERLAP` (manual-only) exclusivity. The glyph reuse is
symmetric: whichever of the two the active route shows gets a glyph; the
other route's badge (which doesn't exist on screen at all, per
`ScheduleScreen.jsx:1908-1922`'s existing ternary) is unaffected. Neither
route's badge row gains an item the other lacks as a result of this spec —
the asymmetry that already exists (`Unfillable` vs `Overlapping`, one per
route) is preserved exactly, not amplified or corrected, because that
asymmetry is the intended design per
`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`. Section
headers read `"On this grid"` / `"This week overall"` — deliberately
route-agnostic language, so neither route's section reads as more or less
validated than the other's.

## Check against the decolorization spec's intent

`docs/work/specs/2026-07-28-schedule-grid-decolorization-design.md` (status:
active, not yet archived — confirmed still governing, its shipped surface
matches `slotCellConstants.js`'s `LEGEND_ENTRIES`/`FLAG_COLORS` and
`shared.js`'s `cellStructuralBar`/`cellUnfillableBar`/etc., all present and
unchanged in the code read for this task) established: colour is never the
sole carrier, hue is reserved for a fixed small vocabulary, and shape/text
does the disambiguating work colour used to. This spec's one visual change
(badge glyphs) is a *reuse* of shapes that decolorization pass already
established as the non-colour channel for `UNFILLABLE` (outline
alert-glyph) and `OVERLAP` (dot) — it adds no new hue, no new shape
vocabulary, and no glyph that isn't already load-bearing elsewhere on
screen. It extends the existing grammar into one more location rather than
inventing a second one.
