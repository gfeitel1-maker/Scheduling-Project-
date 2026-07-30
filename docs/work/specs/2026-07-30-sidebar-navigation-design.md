---
title: "Sidebar navigation and visual hierarchy — design"
document_type: spec
status: active
created: 2026-07-30
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: phase 1 is merged and Verifier PASS recorded
---

# Sidebar navigation and visual hierarchy — design

Decision document for the sidebar. Companion files:

- `2026-07-29-sidebar-visual-hierarchy-design.md` — Designer's visual spec
  (density, states, motion, icons). **Subordinate to this document** where the
  two disagree; the disagreements are listed in §6.
- `2026-07-30-sidebar-oss-reference.md` — source-verified mechanics from
  NocoDB, Baserow, OpenProject and Twenty, with corrections to earlier passes.
- `prototypes/2026-07-29-sidebar-visual-hierarchy-prototype.html`

## 1. Success predicate

A director opening Shoresh for the first time knows where to start without
being told, and a director in week three sees their two candidate weeks
without scrolling past nine setup screens they finished in June.

Observable: (a) the first-run sidebar names the next incomplete setup step in
plain language; (b) once every required setup area holds data, the daily-use
items are visible without scrolling at the default window size; (c) neither
candidate schedule is presented as primary at any point.

**Non-goals.** Cross-screen navigation ("click Bunk 4, see everywhere it
appears") is **not** a sidebar problem and is out of scope — see §5. No router.
No command palette in phase 1. No saved/starred views in phase 1.

## 2. What the sidebar is today

`src/components/layout/Sidebar.jsx`, 221 lines. Fixed 200px, no collapse, no
resize. Two hardcoded sections in `NAV_SECTIONS`: **Setup** (9 items) and
**Operations** (Generated Schedule, Manual Schedule, Conflicts, + admin-only
Device Manager). Flat text buttons, no icons. Active state = `--primary` +
weight 600 + 3px left border. Optional warning-coloured numeric badge per item.
Footer: camp name, DEV badge, build label, "Backup now" (admin), version.

Navigation is a plain string in `useState` in `AppShell` (`src/App.jsx`),
looked up in `SCREENS`. No router, no URL, no history.

## 3. The decisive constraint: 1 to 100 groups

A camp runs **as few as 1 group and as many as 100** (product owner, 2026-07-30).
That range, not aesthetics, settles the hierarchy question.

Both the ideation pass and the visual pass proposed rendering
Programs → Units → Groups as a three-level indented tree in the sidebar. At 100
groups that tree is unusable, and the OSS evidence says so independently:

- **Twenty** caps nesting at two levels, hardcoded in the type
  (`NavigationDrawerItemIndentationLevel = 1 | 2`).
- **Baserow** caps at two.
- **OpenProject** refuses indentation for depth entirely — it drill-downs, one
  level on screen at a time.
- **NocoDB** is the only one that reaches three, only in its multi-source case,
  and does it by hardcoding four separate padding combinations by hand. It also
  had to add a paid folder layer because flat lists broke down at scale.

### D1 — Groups do not go in the sidebar

**The sidebar carries Programs → Units. Two levels. Groups live on a screen.**

Clicking a Unit navigates to the Groups view scoped to that Unit. The
highest-cardinality entity in the data model does not belong in 200px of
permanent chrome, and a structure that works at 1 group and collapses at 100 is
not a structure.

**Dependency Maker must resolve, not assume.** "Scoped to that Unit" needs a
parameter, and `onNavigate` currently accepts a bare screen string
(`src/App.jsx`, `SCREENS` lookup). Phase 2 therefore requires widening the
navigation callback to carry an optional scope — e.g.
`onNavigate('groups', { tierId })` — and `GroupsScreen` accepting and applying
it. That is a small, contained change and it is **not** the shared-selection
layer ruled out in §5: one screen, one optional argument, no history, no context,
no router. If it cannot be done without touching more than `App.jsx` and
`GroupsScreen`, stop and raise it rather than growing the change.

This rejects both agents' proposals. It is the one decision here that came from
the group-count answer rather than from either agent.

Programs and Units are low-cardinality in every camp shape we know of. If a camp
ever runs enough Units to flood the sidebar, D2 already bounds it.

### D2 — Auto-expand-on-select, no disclosure state

A Program's Units render **only while that Program is the selected one**. No
chevrons, no expand/collapse state, nothing persisted. Selecting another Program
closes the first.

Taken from Baserow (`v-if="isAppSelected(application)"`). It is cheaper than
guide lines and cheaper than drill-down, there is no expansion state to store or
desync, and the visible row count is bounded by the largest single Program
rather than by the whole camp.

Rejected alternative: **drill-down with a back header** (OpenProject, and
Twenty's `NavigationDrawerBackButton`). It handles unbounded depth, which we do
not have once D1 caps us at two levels, and it costs a navigation-history
concept the app currently lacks. Revisit only if D1 is reversed.

### D3 — Indentation, not guide lines

One indent level for Units. No connecting lines, no elbows, no indentation
guides.

Twenty draws elbow guides with a five-state machine that darkens the path from
folder to selected child — genuinely elegant, and unjustifiable for a single
level of nesting that only ever shows one parent's children at a time. Designer's
spec proposes guide lines at 16/30/44px for three levels; D1 removes the third
level and D2 removes the ambiguity guides would resolve.

## 4. Progress and recession

This is the part that serves the success predicate's first clause.

### D4 — Setup rows state their own condition, in camp language

Each setup row carries an inline state suffix derived on every render:

```
Programs             2
Units                4
Groups              14
Days                 7
Time Blocks    not set yet
Activities     add Time Blocks first
Fixed Events
Day Overrides
```

Rendered as a **secondary label** — `label · secondary` at lighter colour and
regular weight — not as a badge. Twenty and NocoDB both carry no counts in the
sidebar at all; where OpenProject and Baserow do, they use badges for things
needing action. A count is information, not an alert. The warning badge stays
reserved for Conflicts, where acting is the point.

**A row whose prerequisite is missing is muted and explains itself, but stays
clickable.** It never blocks and is never disabled. Designer's spec dims
Activities with a lock glyph; that is overridden — see §6.

The explanation string must be **the same string the destination screen shows in
its own empty state**, imported from one shared module. Two hand-maintained
copies will drift.

### D5 — Zero renders as nothing

A count that cannot be justified by live data renders **nothing** — never `0`,
never a stale cached number. This is OpenProject's actual implementation
(`filter_unread` returns `nil` at zero so the badge disappears) and it
generalises: the sidebar must not assert state it cannot substantiate.

### D6 — Setup recedes once complete, reversibly and by hand

When every **required** setup area holds data, the Setup section collapses to a
single row:

```
  Camp Setup ▸

OPERATIONS
  Generated Schedule
  Manual Schedule
  Conflicts        [2]
  Device Manager            (admin)
```

Clicking it expands the full list in place. It never navigates.

Two guards against premature recession:

- **"Required" is not "every count > 0".** Fixed Events and Day Overrides are
  legitimately optional and must not gate recession. The required set is
  Programs, Units, Groups, Days, Time Blocks, Activities.
- **The fold does not fire automatically the first time.** It offers itself
  ("Setup looks complete — tuck it away?") and the director accepts. Layout that
  rearranges itself unprompted, at the exact moment a director finishes setup,
  is disorienting. Once accepted, the folded state persists.

Persistence is `localStorage`, per device, never synced — a view preference, not
camp data. Precedent: OpenProject persists sidebar width and collapse in
`localStorage`; Twenty persists width and per-section open state the same way.

Phase is **derived every render** from counts already available to `App.jsx`.
Nothing stored, nothing on the wire, nothing that can desync between Host and
Client. If a count is unavailable for a required entity, that is a gap to raise
before building — not a placeholder `true`.

## 5. Explicitly out of scope

**Cross-screen navigation is not a sidebar problem.** Today `campId` and
`onNavigate(screenKey)` are the only things threaded into screens. There is no
selection context and no history. "Click Bunk 4 anywhere, see where it appears"
requires a shared-selection layer across 11 screens. It is a real project and it
is not this one.

**No saved/starred views in phase 1.** OpenProject's model is the one to copy
when we do — four sections (Starred / Default / Public / Private), alphabetical
within each, static entries deliberately non-favouritable, and crucially
**saving decoupled from surfacing** (public/private is access, starred is
sidebar presence). It needs a new persisted entity, and it is the one concept
whose failure mode is a governance violation rather than an inconvenience. Hold
until phases 1–2 have survived a season.

**No command palette in phase 1.** Worth noting for later that the four
products disagree on what one should index: Baserow's searches row content,
NocoDB's searches bases/tables/views but not records.

**No LAN sync status in the sidebar** (product owner, 2026-07-30). Two products
put async state there — Baserow renders in-flight jobs as pseudo-items with live
progress, and its footer undo/redo carry spinners — but we are not adding it.

To be precise, since this could be read as freezing the footer entirely: what is
declined is *adding sync state*. Designer's footer **triage** still applies — DEV
badge promoted to the header beside the camp name, path and build collapsed
behind a "Diagnostics ▾" disclosure, Backup and version unchanged. Promoting DEV
matters because it is the only thing distinguishing a development database from a
real camp's data (`docs/adr/2026-07-28-explicit-userdata-directory.md`).

## 6. Where this overrides Designer's visual spec

| Designer's decision | Ruling |
|---|---|
| Programs→Units→Groups as a 3-level indented tree with guides at 16/30/44px | **Overridden** by D1/D2/D3 — 2 levels, one indent, no guides, Groups on a screen |
| Activities dimmed with a lock glyph until prerequisites exist | **Overridden** by D4 — muted and self-explaining, always clickable |
| Setup auto-collapses when complete | **Amended** by D6 — offered once, accepted by the director, then persisted |
| Numeric badge per setup row | **Amended** by D4 — secondary label; badge reserved for Conflicts |
| Icons on all 13 items | **Amended** — per-item decision, not blanket. "Groups" and "Days" have obvious glyphs; "Day Overrides" and "Fixed Events" do not, and an unrecognisable icon adds noise while claiming to reduce it. Ship icons only where the glyph is unambiguous; a row without one is not broken |
| Bordered pair + caption for the two schedules | **Adopted as specified** — see §7 |
| DEV badge promoted to header; path/build behind a "Diagnostics ▾" disclosure | **Adopted** |
| 200 → 224px width | **Adopted.** For reference: Twenty 220 (min 180, max 350), Baserow 240, OpenProject 280. 224 is at the narrow end but within range |

Everything in Designer's spec not listed here — density, item height, states,
motion tokens, contrast, focus order — stands as written. Its motion values were
verified against `src/index.css:25-28`; the tokens it uses are real.

## 7. Non-canonical-schedule compliance

Per `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md` and its
2026-07-29 addendum (route selection lives in this sidebar; the neutral
`schedule` entry asks rather than defaults).

- Generated and Manual keep **identical** icon, weight rules, row height, type
  size and indent. Alphabetical order, which is an artifact of the alphabet and
  labelled as such in the code comment already at `Sidebar.jsx:27-30`.
- Grouped as a **symmetric pair** with a shared border and the caption
  "two candidate schedules — neither is final". Neither is inside or under the
  other. The caption makes a rule that currently exists only in an ADR visible
  to the director.
- **No collapse, no drag-reorder, and no usage- or recency-based ordering** for
  this pair, ever.

That last clause is not defensive boilerplate. **NocoDB demonstrates the failure
live**: a same-list view drag persists
`updateView(id, { order }, { is_default_view: … })`, recomputing the default via
`getFirstNonPersonalView`. Reordering silently reassigns which view is default.
A shipping product designates by accident through ordering alone. Ours must not
be able to.

- D6's recession applies to the **Setup** section only. The Operations pair never
  folds, never recedes, and is never reordered by state.

## 7a. Coordination with the trash/record-history stream

A concurrent stream (`feat/trash-and-record-history`) is building the trash and
record-history work. As of 2026-07-30 it has already landed, unmerged:

- a `{ key: 'trash', label: 'Trash' }` entry in `NAV_SECTIONS`' Operations
  section, below Conflicts (`Sidebar.jsx`), plus the `SCREENS` entry in `App.jsx`
- `src/components/RecordHistory.jsx`, `src/screens/TrashScreen.jsx`
- `src/screens/recordLabels.js`
- History-panel wiring inside `GroupsScreen`, `TiersScreen`, `ActivitiesScreen`,
  `AnchorsScreen`, `TimeBlocksScreen`

Consequences for this spec:

1. **Trash is an Operations row and must survive the restructure.** It is
   subject to §7's recession rule the same way Conflicts is: the Operations
   section never folds. Its count follows D5 — an empty trash renders no
   suffix, not `0`.
2. **`recordLabels.js` is the shared string home. Do not build a second one.**
   It already provides `entityLabel()` and field labels in camp language
   (`tier_id` → "Unit") and was written to be shared so two surfaces cannot
   describe the same record differently. D4's prerequisite sentences and the
   destination screens' empty-state strings belong there, extending it rather
   than paralleling it.
3. **Merge order: trash first.** It sits lower in the stack (schema → IPC →
   screens) and its footprint on `Sidebar.jsx`/`App.jsx` is six additive lines,
   which rebases cleanly under this restructure.
4. **The entity-table and structure-tree specs must not run in parallel with
   it.** `2026-07-29-shared-entity-table-design.md` rewrites five of the screens
   that stream is editing, and a wholesale table rewrite would silently drop the
   History wiring without failing loudly. Sequence those specs after trash
   merges.

Phase 1 of this spec touches only `Sidebar.jsx` and `App.jsx` and is safe to
build in parallel.

## 8. Phasing

**Phase 1 — recession and row state.** D4, D5, D6, plus Designer's density,
states, footer triage and the §7 pair treatment. No schema, no migration, no
`PROJECTIONS` entry, nothing on the LAN, no router, no stored state beyond one
`localStorage` boolean. This phase alone satisfies the success predicate.

**Phase 2 — hierarchy.** D1, D2, D3. Depends on phase 1 shipping first, because
phase 1 *shrinks* the sidebar and phase 2 spends some of the reclaimed space.

**Phase 3 — reassess.** Saved views, command palette, cross-screen selection.
Nothing here is committed.

If drag-to-reparent is ever added: **batch writes through a draft state**
(Twenty's `navigationMenuItemsDraftState`) flushed by an explicit save. Every
write in Shoresh is an op that replicates; one op per drag frame is not
acceptable on a LAN.

## 9. Testing

Extract the derived logic into pure modules so it is testable without React —
`src/components/layout/sidebarState.js` (row state, required-set completeness)
and `src/components/layout/sidebarTree.js` (Program → Unit shaping).

- a required entity at count 0 yields "not set yet"; an optional one yields no
  suffix
- Activities yields "add Time Blocks first" when Time Blocks is empty, and that
  string is the *same object* the Activities screen's empty state renders
- recession triggers only when all six required areas hold data; Fixed Events and
  Day Overrides empty does not block it
- recession does not fire automatically before the director accepts it; once
  accepted it survives reload
- a count that cannot be resolved renders no suffix, never `0`
- selecting a Program shows only its Units; selecting another closes the first
- a Unit with a null `cohort_id` is still reachable, not swallowed
- **100 groups across 1 Program and 1 Unit does not change the sidebar's row
  count** — the D1 regression test
- Generated and Manual render with identical style props, and no code path
  reorders them

## 10. Open questions

- **Does a real director cross the setup→daily threshold without noticing the
  fold offer?** The one thing worth watching in use.
- **Is `count > 0` honest for Days and Time Blocks?** If camps set these up
  incrementally, `7` and `6` are not evidence of done and D6's required-set needs
  a stronger predicate than non-empty.
- **Should a keyboard shortcut toggle the sidebar?** None of the four products
  has one — verified *absent* in Twenty by code search, not merely unfound. If we
  add one we are ahead of all four, not catching up.
