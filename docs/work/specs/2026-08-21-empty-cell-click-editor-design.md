---
title: "T112 — Empty-cell click opens the inline editor: design"
document_type: spec
status: draft
created: 2026-08-21
task_class: ui-ux-design
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md]
related_tickets: [docs/work/tickets/T112-empty-cell-click-opens-inline-editor.md, docs/work/tickets/T105-elective-inline-authoring-and-render.md]
archive_when: shipped and merged
---

# T112 — Empty-cell click opens the inline editor: design

## 0. Deterministic evidence (read from code, 2026-08-21)

- `src/components/schedule/SlotCell.jsx`: filled cells own `editing` state
  (`useState`), `handleClick` (left-click → `onSelect` if present, else
  `onCellClick` (stamp mode), else `setEditing(true)`), `handleContextMenu`
  (right-click → `setEditing(true)` unconditionally), `handleEnterKeyDown`
  (Enter on focus → same precedence as click minus `onSelect`/`onCellClick`).
  `canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked &&
  Boolean(activity)` — the `useDraggable` `listeners`/`attributes` are spread
  onto the **same DOM node** that carries `onClick`, and this already ships
  in production for every filled, draggable, selectable cell. Click and drag
  already coexist on one element today; T112 is not introducing that
  coexistence, only extending it to a case where nothing owns `onSelect`.
- `SlotCell.jsx:159`: `if (!slot) return <div {...shellProps}
  aria-label={nameFor('Empty')} />` — a **dead branch**. No caller ever
  passes `slot={null}` into `SlotCell`; all three views render a separate,
  purpose-built empty-cell component instead (below). Confirmed by grep:
  zero call sites pass a null/undefined `slot`.
- Three near-identical static empty-cell components, one per view, each
  hand-copied with the same shape (`role="gridcell"`, `data-empty`,
  `data-cell-key`, `aria-label` via `cellAccessibleName`, no handlers):
  - `ManualBuildView.jsx:58` `EmptyDropCell`
  - `ScheduleGroupView.jsx:16` `EmptyCell`
  - `ScheduleDayView.jsx:15` `EmptyCell`
  None has an `onClick`, `onKeyDown`, `tabIndex`, or editing state. None
  renders `CellInlineEditor`.
- **No per-cell droppable ref exists.** The comment at the top of each empty
  component states it plainly: "No per-cell droppable: T58 moved hit
  resolution to the grid surface, and the drop-target paint to
  `.cell[data-drag-over]`... `data-cell-key` is what makes this cell findable
  from pointer coordinates." One `DndContext`/one droppable lives in
  `ScheduleScreen`; drop targets are resolved by reading `data-cell-key` off
  whatever DOM element sits under the pointer at drag-end, not by a React
  `useDroppable` hook per cell. **This means an empty cell's `onClick` cannot
  conflict with drag-target resolution at the DOM/ref level — there is no ref
  to fight over.** This is the single most load-bearing fact for this design:
  the coexistence risk the ticket names ("must coexist with @dnd-kit
  distance-N drag-activation") is already solved by the architecture, not a
  new problem T112 has to invent a solution for.
- `src/screens/ScheduleScreen.jsx:215`: `useSensor(PointerSensor, {
  activationConstraint: { distance: 5 } })`. **Correction to the ticket**:
  the ticket cites `distance:8`; the live code is `distance: 5`. Use 5 as the
  authoritative value; if a future change moves it, this design's reasoning
  is unaffected — it works for any nonzero distance because the mechanism is
  dnd-kit's standard click/drag disambiguation (`PointerSensor` doesn't
  start a drag, and therefore doesn't call `preventDefault`/suppress the
  subsequent `click` event, until the pointer has moved past
  `activationConstraint.distance`).
- `ScheduleGroupView.jsx` / `ScheduleDayView.jsx` route through
  `decideCell(geometry, ...)` → `decision.kind === 'empty'` renders
  `EmptyCell`; `'overlay'` renders `OverlayCell` (field-trip stamp tool,
  generated route only); everything else renders `SlotCell`.
  `ManualBuildView.jsx` has no `decideCell`/overlay path — it inlines the
  same three-way branch (anchor / activity-or-elective / empty).
- Stamp mode (`stampMode`, field-trip overlay tool) only intercepts clicks on
  **filled** cells today (`cellClickHandler` passed to `SlotCell` as
  `onCellClick`, group/day views only — manual view has no stamp mode).
  Neither existing empty-cell component receives or checks `stampMode`.
  This is a **pre-existing gap outside T112's scope** (stamping onto an
  empty cell already does nothing, before and after this ticket) but the new
  `onClick` must not silently start claiming stamp-mode clicks that used to
  be no-ops — see §4.
- `CellInlineEditor.jsx` (not reproduced here) is already the shared
  component `SlotCell` mounts; its props contract (`eligibleActivities`,
  `currentActivityName`, `onPlace`, `onCreateNew`, `onCreateElective`,
  `onCancel`) is exactly what an empty cell needs, since an empty cell is
  simply the `currentActivityName === null` case that already exists inside
  `SlotCell`.

## 1. Candidate approaches considered

Ideation ran under three frames (regulator/audit, speedrunner, remove-the-
load-bearing-assumption) before converging.

- **A. New-gesture plays** (shift+click, ctrl+click, double-click,
  right-click-menu-on-empty) — reuse an existing modifier/gesture instead of
  plain left-click. *Rejected*: the ticket's own success condition is that
  the grid's hint text ("click a cell to pick one") becomes true; a modifier
  requirement keeps it false for a director who does not know the modifier.
  No competing left-click semantic exists on an empty cell to protect
  against, so there's nothing to disambiguate.
- **B. Explicit-mode plays** (grid-wide "edit mode" toggle, hover "+" that
  must be clicked before the cell becomes an editor) — separate "browsing"
  and "authoring" as a global or per-cell mode switch. *Rejected as the
  interaction model*: adds a mode a director has to discover and remember,
  contradicts "point of intent" (the whole reason T112 exists is to remove a
  detour), and is exactly the kind of new process/state the ticket's Owner
  framing ("this is what makes point-of-intent entry reachable") argues
  against re-adding. The **hover "+" affordance** sub-idea survives, not as
  a click-gate but as a **visual invitation** — see §6 (Designer/Tester
  tuning point), where it costs nothing behaviorally.
- **C. Pointer-kinematics / sensor-level plays** (branch on whether
  `pointermove` occurred between `pointerdown`/`pointerup`; intercept at the
  sensor rather than the cell) — ★ **this is not a new mechanism to build.**
  It is dnd-kit's own `PointerSensor` + `activationConstraint.distance`
  behavior, already relied on by every filled draggable cell in production
  (§0). The correct move is to point the existing, proven mechanism at a new
  target (the empty cell's `onClick`), not reinvent it.
- **D. Component-unification plays** (one cell component for empty and
  filled; progressive-disclosure inline form; draft-state in the op log) —
  the "one component" half is a real, cheap win because `SlotCell` already
  has a dead `!slot` branch built for exactly this case (§0) and three
  duplicate static components exist that a real empty-cell implementation
  would have to individually patch. The "draft state written through the
  op-log" idea is a trap — flagged below.
- **E. Audit/traceability plays** (focus-gated afforance, undo-log draft
  commit) — the **focus-gated Enter-to-edit** half is not optional, it's
  already decision 6's requirement and mirrors the existing
  `handleEnterKeyDown` pattern; the **op-log draft-and-discard** half is a
  trap (below).

**Traps identified and rejected:**
- *Op-log draft state for an unsaved editor* — the inline editor's typed-but-
  not-committed text must never touch `window.shoresh.write`/the op-log;
  `onPlace`/`onCreateNew`/`onCreateElective` already only fire on commit.
  Writing a "draft" op would create sync noise and multi-device conflicts
  for keystrokes nobody else should see.
- *Grid-wide edit-mode toggle* — see B above; adds a discoverable-failure
  mode (director forgets which mode they're in) the ticket is explicitly
  trying to remove.
- *Unify empty+filled by making `SlotCell` accept `slot={null}` everywhere
  and deleting the three view-level empty components in this same change* —
  tempting (kills duplication in one shot) but expands blast radius into
  `SlotCell`, the single most heavily-tested, highest-traffic cell
  component, for a ticket whose stated scope is "empty cells gain a click."
  Right idea, wrong ticket size — see §3's Reused-vs-new call.

## 2. Decision 1 — scope of the click-model change

**Recommendation: minimal.** Empty cells: single left-click opens the
inline editor. Filled cells: unchanged — left-click still selects
(`onSelect`), edit still opens only via right-click (`handleContextMenu`)
or Enter (`handleEnterKeyDown`).

Reasoning: an empty cell has no selection state to protect (there is
nothing to select — `isSelected`/`isMultiSelected`/`pasteMode` are all
properties of a slot with content, and multi-select's paste/copy verbs
operate over selected *filled* cells' data). Left-click on empty therefore
has exactly one plausible meaning, so there is no left-click overload to
resolve the way filled cells have to resolve select-vs-edit. Changing
filled-cell click semantics too (e.g. "left-click always edits, drag icon
appears for reposition") was considered and rejected: multi-select
(`selectedSlotKeys`), paste-target mode (`pasteMode`/`isPasteTarget`), and
copy/paste of filled cells all depend on left-click continuing to mean
"select" on a filled cell. There is no stated product need to touch that
contract, and doing so multiplies this ticket's regression surface for no
benefit the ticket asks for.

## 3. Decision 3 — where editing state + `CellInlineEditor` live for an empty cell

**Recommendation: extract one shared, stateful `EmptyCell` component and
give it its own `editing` `useState` + `CellInlineEditor` mount, mirroring
`SlotCell`'s pattern — do not touch `SlotCell`'s dead `!slot` branch.**

Concretely:
1. **Dedup first.** `ManualBuildView.jsx`'s `EmptyDropCell`,
   `ScheduleGroupView.jsx`'s `EmptyCell`, and `ScheduleDayView.jsx`'s
   `EmptyCell` are near-identical (same props: `groupId, dayId, blockId,
   gridRow, gridColumn, ariaColIndex, collapsed, blockNames, column`, same
   shell attributes). Extract one `EmptyCell` component to
   `src/components/schedule/EmptyCell.jsx`, imported by all three views,
   replacing the three local definitions. This is a pure refactor with no
   behavior change and should land/verify as its own commit before the
   click behavior is added, so a regression is attributable to one or the
   other.
2. **Add editing to the shared component.** Give the new shared `EmptyCell`
   the same `[editing, setEditing] = useState(false)` `SlotCell` has, a
   `handleClick` that calls `setEditing(true)` directly (no `onSelect`/
   `onCellClick` precedence chain needed — see §4 for the one exception),
   and a `handleEnterKeyDown` for the focused-Enter path (§6). Render
   `CellInlineEditor` when `editing`, else the current static `cell-empty`
   div (or the new hover affordance, §6.1).
3. **Prop surface — the same commit-path props `SlotCell`'s filled branch
   already receives**, threaded through unchanged from each view's own
   props: `eligibleActivities` (from `eligibleActivitiesFor(selectedGroup)`),
   `onPlace`, `onCreateNew`, `onCreateElective`, `electiveSetsAll`,
   `electiveMembersBySet`. `currentActivityName` is always `null` for an
   empty cell (no need to pass it — `CellInlineEditor` already treats
   `null` as "nothing selected yet", confirmed by `SlotCell`'s own
   `currentActivityName={activity?.name ?? electiveLabel ?? null}` for its
   unfilled-but-typed cases).
4. **Why not unify into `SlotCell` (revive the `!slot` branch) instead:**
   rejected in §1's trap list. It is the *architecturally* cleaner endpoint
   (one cell component, not two) but changes the risk profile of the
   change from "one small new component + 3 call-site swaps" to "modify the
   most heavily tested file in the schedule grid for cells it currently
   never receives." If the team wants that consolidation later, it is a
   clean, isolated follow-up once this ships and the dead branch can be
   deleted in the same pass — flagging as an out-of-scope cleanup, not
   silently doing it here.
5. **Placement/geometry props** (`gridRow`/`gridColumn`/`ariaColIndex`/
   `cellKey`/`data-cell-key`) must be preserved exactly as today — they are
   what the pointer-coordinate drop-hit resolution (§0) reads. The new
   `EmptyCell` keeps the same `data-cell-key` attribute on the same
   outermost element; drag-hit resolution is untouched by this change
   because it reads the DOM attribute, not any new state.

## 4. Decision 2 — dnd-kit coexistence (verified, not assumed)

Verified by reading the code (§0), not inferred:

- **No per-cell droppable ref exists**, so there is no `useDroppable` hook
  on the empty cell for a new `onClick` to conflict with. The drop target is
  resolved from pointer coordinates against `data-cell-key` at drag-end,
  entirely independent of any click handler on the cell.
- **Click vs. drag disambiguation already happens at the sensor**, not the
  cell: `PointerSensor` with `activationConstraint.distance: 5` does not
  begin a drag, and does not suppress the browser's native `click` event,
  until the pointer has moved 5px past `pointerdown`. A `pointerdown` +
  `pointerup` with under 5px of movement fires a normal `click` — which is
  exactly the mechanism `SlotCell`'s filled+draggable cells already rely on
  today (`onClick={handleClick}` and `{...listeners}` coexist on the same
  node, in production, right now). Wiring `onClick` on the empty cell is the
  **same** pattern, not a new one; the only difference is the empty cell has
  no `useDraggable` at all (nothing is draggable *from* an empty cell), so
  there is even less to reconcile than on a filled cell.
- **Ghost/drop-preview interaction with an open editor**: while a director
  is mid-drag (an activity chip is in flight from the palette or another
  cell), no *other* cell's editor can be open — `editing` is local
  `useState` scoped to one cell instance, and starting a drag never sets
  it. The one edge case worth a stated rule (not a code change — a rule for
  Maker/Tester to verify): **if an empty cell's editor is already open
  (director clicked it, typing) and the director then starts a drag whose
  drop target resolves to that same cell**, the drop should win over the
  in-progress, uncommitted edit the same way a fresh `onPlace` call
  overwrites the cell today — `setEditing(false)` should be triggered by the
  external prop change the successful drop causes (the cell re-renders with
  `slot?.activity_id` set once the drop write lands, at which point this
  view's slot-vs-empty branch stops rendering `EmptyCell` for that cell at
  all and renders `SlotCell` instead — so the stale editor unmounts for
  free, no explicit "drag wins" code needed). Maker should add a test for
  exactly this sequence (§7) rather than trust the reasoning alone.

## 5. Decision 4 — all three views

Enumerated, with the shared-component fix applying to all three
call sites:

| View | Current static component | Replace with |
|---|---|---|
| `ManualBuildView.jsx:58` `EmptyDropCell` (used at line 272's return) | local, unique props shape | shared `EmptyCell.jsx` |
| `ScheduleGroupView.jsx:16` `EmptyCell` (used at `decision.kind === 'empty'`, line 170) | local, near-identical | shared `EmptyCell.jsx` |
| `ScheduleDayView.jsx:15` `EmptyCell` (same pattern, not re-read in full but grep-confirmed identical shape) | local, near-identical | shared `EmptyCell.jsx` |

`OverlayCell` (generated-route field-trip stamp overlay, `ScheduleGroupView`/
`ScheduleDayView` only) is a distinct `decision.kind === 'overlay'` case and
is **out of scope** — it already has its own click affordances
(`onFillStart`) and is not "empty" in the sense this ticket means.

## 6. Decision 5 — the misleading hint text

Current (`ManualBuildView.jsx:303`): *"Drag activities from the left panel
onto any open cell, or click a cell to pick one. An empty cell just isn't
filled yet."* This becomes literally true once §3 ships for the manual
route. `ScheduleGroupView`/`ScheduleDayView` should be checked for whether
they carry the same or a similar hint string (not confirmed read in this
pass — Maker should grep for the string and update every occurrence, not
just the one line quoted in the ticket). No copy change is needed beyond
making sure the string doesn't imply a gesture that no longer applies (e.g.
if a hint elsewhere says "right-click an empty cell", that would now be
wrong the other way — verify at Maker time.)

### 6.1 Visual affordance — Designer/Tester tuning point, not a hard blocker

The static empty-cell div today gives zero visual signal it's clickable.
This design does not want to gate correctness on a specific hover treatment
(that's a `scheduleGrid.css` polish call, and the `scheduleGrid.css`
exception's stated boundary — pseudo-classes/data-attribute states, no new
React state — governs it), but flags it as a decision Designer/Tester must
close before this ships to a director, not an afterthought:
- Minimum: a `:hover`/`:focus-within` rule on `.cell[data-empty]` (cursor:
  pointer already implied by making it clickable; a subtle background or
  border tint communicates "this responds").
  a `+` glyph on hover (cluster D's surviving idea) is a stronger, more
  self-explanatory affordance and costs nothing structurally — it is
  exactly the kind of ephemeral, hover-only, non-React-state visual this
  codebase's `scheduleGrid.css` exception exists for.
- This must NOT introduce new React state per cell (480-cell cost, the same
  reasoning `SlotCell`'s header comments give for why hover was deleted from
  React state in T56) — CSS-only.

## 7. Decision 6 — accessibility / keyboard

- **Enter on a focused empty cell opens the editor**, mirroring
  `SlotCell.handleEnterKeyDown`'s pattern exactly (roving-tabindex, T59):
  `if (editing) return; e.preventDefault(); setEditing(true)`. No
  `onSelect`/`onCellClick` precedence needed (§4's reasoning: nothing
  competes for left-click on an empty cell, and stamp mode currently never
  reaches empty cells — see below).
- **`aria-label`** stays `cellAccessibleName({ subject: 'Empty', ... })`
  while not editing; when `editing`, `CellInlineEditor`'s own labeling
  (already built for `SlotCell`'s filled case) takes over — reuse as-is,
  no new T59 work needed since it's the same component.
- **Stamp-mode interaction (pre-existing gap, explicitly not silently
  widened):** today, clicking an empty cell in stamp mode does nothing
  (neither view's empty component checks `stampMode`). After this change,
  clicking an empty cell in stamp mode would open the inline editor unless
  guarded — that IS a behavior change stamp mode didn't have before, and
  should be treated as in-scope for this ticket (not deferred), because
  otherwise "click an empty cell while stamping a field trip" silently
  starts an unrelated editor instead of doing nothing OR stamping. Maker
  should thread `stampMode`/`onCellClick`-equivalent into the shared
  `EmptyCell` for the two generated-route views (`ScheduleGroupView`,
  `ScheduleDayView` — `ManualBuildView` has no stamp mode, so it's simpler
  there) with the same precedence `SlotCell` uses: `onCellClick` (stamp)
  wins over `setEditing(true)`. This is a small, bounded addition, not a
  redesign of stamp mode.

## 8. Files/modules affected

**New:**
- `src/components/schedule/EmptyCell.jsx` — shared component, editing
  state + `CellInlineEditor` mount, props per §3.

**Modified:**
- `src/components/schedule/ManualBuildView.jsx` — delete local
  `EmptyDropCell` (lines 58-74), import shared `EmptyCell`, pass the new
  editor-wiring props at its call site (~line 272), update hint text
  (~line 303) if it needs to change.
- `src/components/schedule/ScheduleGroupView.jsx` — delete local
  `EmptyCell` (lines 16-32), import shared component, pass editor-wiring
  props + `stampMode`/click-precedence at its call site (~line 170).
- `src/components/schedule/ScheduleDayView.jsx` — same shape as
  `ScheduleGroupView`.
- `src/components/schedule/CellInlineEditor.jsx` — likely **unchanged**
  (already accepts `currentActivityName={null}`); confirm no prop assumes a
  non-null activity before commit.
- No IPC, schema, or op-log surface changes. `onPlace`/`onCreateNew`/
  `onCreateElective` are existing callback contracts, called with the same
  argument shapes an empty-slot commit already produces today via the
  filled-cell path (an empty cell being edited is just a slot with no
  `activity_id`/`elective_set_id` yet — the commit call sites in
  `ScheduleScreen` already handle a slot with nothing in it, since that is
  what "place into an unfilled slot" already means for drag-drop).

**Deliberately untouched:**
- `src/components/schedule/SlotCell.jsx` — including its dead `!slot`
  branch (§3.4).
- `src/screens/ScheduleScreen.jsx`'s `DndContext`/sensor config — no
  distance, sensor, or droppable change.
- Filled-cell click/select/edit precedence.

## 9. Reused vs. new

**Reused:** `CellInlineEditor` (component + its full prop contract),
`onPlace`/`onCreateNew`/`onCreateElective` callback wiring (unchanged
shape, just now also reachable from an empty cell), `cellAccessibleName`
(T59 labeling), the roving-tabindex grid nav (`useGridKeyboardNav`,
unchanged — Enter interception is local to the cell, same as `SlotCell`),
the pointer-coordinate drop-hit resolution (`data-cell-key`, untouched),
dnd-kit's `PointerSensor`/`activationConstraint` click-vs-drag
disambiguation (already proven in production on filled cells).

**New:** one shared `EmptyCell` component with local `editing` state — the
only genuinely new code. Everything else is extending an existing, proven
pattern (`SlotCell`'s click/edit/Enter handling) to a second component
that was previously static, plus deleting two duplicate copies of the
static version.

## 10. ADR required: no

This does not introduce a new persistent data shape, does not change an
IPC/wire/stored-schema contract, and the interaction-model tradeoff it
makes (empty-cell click opens editor, filled-cell click still selects) is
cheaply reversible — it's a client-side event-handler change with no data
migration, no sync implication, and no cross-module contract other code
depends on. It is exactly the kind of decision this project's existing
practice covers with an in-repo design doc (this one) rather than a
dated ADR. If Decision 3's rejected alternative (unifying empty+filled into
one `SlotCell`) is picked up later as its own follow-up, *that* would be a
better ADR candidate (it changes `SlotCell`'s contract, the single most
call-site-dense component in the grid) — noted for whoever picks it up,
not decided here.

## 11. Regression risks and how each is protected

| Risk | Protection |
|---|---|
| Drag placement onto empty cells breaks | No droppable ref touched (§4); `data-cell-key` unchanged; dnd-kit sensor/distance unchanged. Test: drag-to-empty-cell still places (existing coverage in `ManualBuildView.test.jsx`/`ScheduleGroupView.test.jsx` — confirm it still passes, add if the empty-cell branch wasn't covered). |
| Filled-cell select/multi-select/paste regress | Zero changes to `SlotCell.jsx` or its `handleClick`/`onSelect` precedence (§1, §8). Test: existing `SlotCell.test.jsx` suite must stay green untouched. |
| Merge/split affordance breaks | Only exists on filled cells (`hasMergeDown`/`isMerged` are slot-derived); empty cells never render those buttons; untouched by this change. |
| Keyboard nav (roving tabindex) breaks | `useGridKeyboardNav` untouched; `EmptyCell` gains the same local Enter-interception pattern `SlotCell` already uses, not a new nav mechanism (§7). |
| Stamp mode silently starts editing instead of stamping | Explicitly scoped in (§7) rather than left as a silent gap — `onCellClick` precedence wins over `setEditing` in the shared component for the two generated-route views. |
| Editor left open across a competing drag-drop onto the same cell | Reasoned through in §4; must be covered by an explicit test, not just design reasoning (§12). |
| Three views drift out of sync (one gets the click, others don't) | Single shared `EmptyCell.jsx` used by all three — a missed view is a missing import, not a missed reimplementation. |

## 12. Test seams for Maker (test-first, per view + per regression risk)

- **New behavior, per view:** click on an empty cell opens
  `CellInlineEditor`; typing + commit calls `onPlace`/`onCreateNew`/
  `onCreateElective` with the cell's `slot` identity (groupId/dayId/blockId)
  and the entered value; Escape/cancel closes without calling any commit
  callback.
- **Enter-on-focus parity:** focused empty cell + Enter opens the editor
  (mirrors `SlotCell.test.jsx`'s existing Enter coverage for filled cells —
  write the empty-cell equivalent alongside it).
- **Drag still works:** existing "drag activity onto empty cell places it"
  coverage must still pass unmodified; if no such test currently exists for
  one of the three views, add one now (a regression here is exactly what
  this ticket must not cause, so it should be provably covered, not
  assumed).
- **Filled-cell select untouched:** run `SlotCell.test.jsx` as-is; it should
  require zero edits for this ticket. If it needs an edit, that's a signal
  the "filled-cell behavior unchanged" contract in §1 has been violated.
- **Race case from §4:** open an empty cell's editor (click, don't commit),
  then simulate a drop landing on that same cell (the slot prop transitions
  from empty to filled underneath the open editor) — assert the stale
  editor unmounts and the dropped activity renders, not a stuck editor over
  a filled cell.
- **Stamp-mode precedence:** in `ScheduleGroupView`/`ScheduleDayView` with
  `stampMode` on, click an empty cell — assert stamp behavior fires (or the
  pre-existing no-op continues, per whichever Maker/Governor decide is
  correct at implementation time — §7 flags the choice, doesn't lock it)
  and the editor does not open.
- **Hint text:** if the string is asserted in any existing test (grep for
  "click a cell to pick one" in `*.test.jsx`), update it there too so a
  stale assertion doesn't mask a stale UI string.

## 13. Open questions for Governor

1. **Stamp-mode precedence (§7):** should clicking an empty cell while in
   stamp mode (a) stamp it, extending stamp mode to empty cells for the
   first time, or (b) remain a no-op, explicitly excluding empty cells from
   the new click-to-edit behavior only while stamping? Both are small;
   this is a product call about what a director expects while actively
   stamping a field trip, not a technical one. Recommend (b) — no-op,
   least behavior change — but Governor/Designer should confirm against
   the stamp-mode UX intent.
2. **Hover affordance (§6.1):** does this ship in the same PR as the click
   behavior, or land as a fast-follow polish pass? Recommend same PR (cheap,
   CSS-only, and shipping click-works-but-looks-identical-to-before invites
   a Tester finding identical to the one that opened this ticket — "I
   couldn't tell it was clickable"). Designer's call on exact treatment.
3. **`ScheduleDayView.jsx`'s hint text** (or lack of one) wasn't read in
   this pass — Governor should confirm whether that view carries its own
   copy that also needs the same audit as ManualBuildView's.

## Governor decisions on §13 open questions (2026-08-21)

1. **Stamp-mode precedence:** when stamp mode (FieldTripDrawer) is ACTIVE, an empty-cell click STAMPS
   (active mode wins) — it does NOT open the editor. Only when no stamp mode is active does empty-cell
   click open the inline editor. Preserves existing stamp behavior; least surprising.
2. **Hover affordance ships in the SAME PR.** A subtle CSS-only hover affordance on empty cells (per the
   scheduleGrid.css exception — data-attribute + rule, no new token, no React state) is required for
   discoverability — the click is worthless if undiscoverable. Exact visual is a Designer/Tester tuning
   point, but it ships together.
3. **Audit all three views' hint copy** (ManualBuildView, ScheduleGroupView, ScheduleDayView) — fix any
   "click a cell" text that is currently false, in scope for this ticket.

## Governor addendum after Red Hat (2026-08-21) — SUPERSEDES §1's paste reasoning

Red Hat (Resilience 4/5, BUILDABLE) confirmed the dnd-kit/coexistence reasoning against code (incl. a
static guard test `dragHandlers.test.js` that enforces the single-droppable premise). Corrections to fold
in before/at Maker:

4. **Paste-mode precedence (fixes the HIGH gap).** §1 is WRONG that `pasteMode` is filled-cell-only —
   `handlePasteClick` (`useClipboardSelection.js:65-85`) accepts any target and paste-into-empty is a
   primary flow (banner: "N of M to paste — click a cell to place"). Precedence on an empty cell is
   **THREE-way: stamp > paste > edit.** When stamp mode active → stamp; else if paste mode active →
   paste (via the existing `onCellSelect`/`handlePasteClick` path, same as filled cells); else → open the
   editor. Thread `stampMode` AND `pasteMode`/`onCellSelect` into the shared EmptyCell, mirroring
   SlotCell's existing `onCellClick`-before-`setEditing` gating. Note: `ScheduleDayView` has NO
   paste/stamp today (never receives those props) — so its EmptyCell only needs the edit path.
5. **Dedup content diff — do NOT silently change it.** `ScheduleGroupView` renders visible text
   `<div className="cell-empty">Empty</div>` (deliberate, scheduleGrid.css §7 "visible, not invisible");
   `ManualBuildView`/`ScheduleDayView` render an empty `<div className="cell-empty" />`. The shared
   EmptyCell must make a CONSCIOUS, consistent choice across all three (keep the T59 aria "Empty"
   announcement regardless). Exact visible treatment is a Designer/Tester tuning point together with the
   hover affordance — but it must be a decided, reviewed choice, not a merge artifact.
6. **Hint copy scope (confirmed):** the ONLY "click a cell"/"Drag activities" hint is
   `ManualBuildView.jsx:303` — fix that one; do NOT add hints to Group/Day views.
7. **New test seams:** double-click on an empty cell (open→stopPropagation, no flicker/close); and a
   tablet/touch note (PointerSensor distance:5 covers touch, but the CLAUDE.md "director on a tablet"
   persona is the stress case — Tester validates a finger-tap opens the editor and a finger-drag still
   places).
