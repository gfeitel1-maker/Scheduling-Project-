# Schedule grid: drag-first placement + inline write — design

**Status:** Design (approved via brainstorming 2026-08-09). Awaiting spec review, then implementation plan.
**Branch context:** surfaced during the 2026-08 UI/UX audit (`work/uiux-audit-2026-08`). This is a LARGER item — its own spec → plan → build. Implementation is DEFERRED and must not begin until the in-flight Schedule safe-polish loop has freed `src/screens/ScheduleScreen.jsx` (avoid two-writer collision).

## Goal (success predicate)

A director builds and edits a week on the Schedule grid through two natural, consistent gestures — **drag** and **type-in-cell** — with no click-to-pick modal, and the grid *shows* the outcome of a drop before it happens. Placement, counts, and flags stay honest and update in the same beat.

Observable:
- Dragging an activity onto an occupied slot shows a **static ghost** of the incoming activity in that cell and dims the occupant; on drop, the incoming activity takes the slot and the displaced one returns to the left palette.
- Typing into a cell matches existing eligible activities (typeahead); an unrecognized name can create a new activity and place it.
- After any place/replace/clear, the left `ActivityPalette` counts and the flag system (`recalcStats` + `recalcFindings`) reflect the change.
- There is no `EditModal` picklist and no floating `DisplacedPalette` tray.

## Non-goals

- No two-cell **swapping**. Occupied-slot drops are always replace-and-return-to-palette.
- No change to the schedule **engine**, the seeded generation, DnD activation distance, snapshot/undo semantics, or the two-routes / no-canonical-schedule rules.
- No redesign of the toolbar/chrome density or the flag lifecycle (both separately deferred: see `project_schedule_toolbar_ia`, `project_schedule_flag_lifecycle`).
- Per-slot **weather-alternative swap** (previously owned by `EditModal`) is NOT rebuilt here — see Deferred.

## Interaction model

One placement surface, two gestures, one underlying mutation:

1. **Drag from palette → slot.** Places the activity. If the slot is occupied → replace (below).
2. **Drag grid card → another slot.** Moves it; source slot becomes empty. If target occupied → replace.
3. **Drag grid card → palette.** Clears the slot (the activity returns to the palette by virtue of no longer being placed).
4. **Click a cell → inline "write the activity."** The cell becomes an inline text entry (typeahead). This replaces the removed picklist and is the keyboard-fast path. Resolving it places/replaces exactly like a drag.

### Replace / displace semantics (all drop paths + inline write)
- The incoming activity takes the target slot.
- The displaced occupant simply **returns to the palette** — there is no separate displaced store; the palette already derives `scheduledCount`/`atMax` live from placed slots, so clearing a slot returns its activity automatically.
- If the incoming card came from another grid slot, that **source slot is cleared**.
- **Anchors (Fixed Events) are not valid targets or sources** — they are engine-pinned; a drop onto an anchor slot is refused (preserve existing `is_anchor` guards). Span/merged double-length slots keep their current behavior.

### Drop preview (static ghost)
- While a drag hovers an occupied, valid slot: render a **static ghost** of the dragged activity inside the target cell and **dim the current occupant** to signal displacement.
- **No motion tween.** Implemented as a `data-` attribute + a rule in the existing `src/components/schedule/scheduleGrid.css` (the app's one sanctioned stylesheet), per the "no drag-over animation" ADR (`2026-08-06-schedule-canvas-visual-layer.md`) and its data-attribute-not-React-state guidance — must not churn React state across the up-to-480 cells.

### Inline write (match, and create-new if no match)
- Click a cell → inline text field, focus, typeahead over the slot's **eligible** activities (respect existing eligibility rules).
- **Match:** Enter / click a suggestion places that activity (replace semantics if occupied).
- **No match → create-new:** offer "Create '<name>'", which:
  - Creates a new activity in the catalog (camp-scoped), **stamped with human provenance** so a later import does not clobber it — reuse the existing human-edit/provenance channel (`src/ingest/fieldUpdate.js` and the shared human-fields mechanism from PR #28; the plan must locate the exact API). See `project_activity_rule_provenance`.
  - **Available to any editing role** (not admin-gated), unlike other catalog writes — decided 2026-08-09. The plan should confirm this doesn't conflict with the server-side authorize() gate on activity writes; if it does, that gate is the thing to adjust, not a client-only bypass.
  - **Frequency rule derives from usage, not a fixed default.** A cell-created activity's `min_per_week` reflects the number of times it is placed in the week (self-calibrating), so it is never falsely flagged as under-served and the palette shows it as met. `max_per_week = null` (∞), normal/default priority. The observable requirement: a hand-created activity produces no spurious under-served flag and its target tracks its usage; the plan may implement this as set-from-count-on-create kept in sync with usage, or as a derived target — whichever is cleaner, as long as the observable holds.
  - **Eligibility default = all groups** (director refines on the Activities screen if needed).
  - Appears in the `ActivityPalette` immediately (palette derives from the activities list).
  - Is placed into the originating cell.
- **Placing an existing activity never creates or changes a rule** — only new (cell-created) activities get the usage-derived rule.
- **Enter places the top match** (or, in the create-new case, confirms creation and places). No Tab-to-accept. Escape / blur without a selection cancels, leaving the slot unchanged.

### Counts & flags
- `ActivityPalette` counts (`scheduledCount of target`, `count/max`, `atMax`) already derive from slots → update for free on place/replace/clear.
- The place/replace/clear mutations MUST run the existing `recalcStats` + `recalcFindings` and fire the post-edit flag-ack (`useFlagChangeAck`, shipped in the schedule polish loop) so flags update in the same beat as the edit.
- A newly created activity entering the palette must recompute palette targets/counts.

## Components — removed / added / changed

**Removed**
- `src/components/schedule/EditModal.jsx` (the picklist) and the click-to-open handler.
- `src/components/schedule/DisplacedPalette.jsx` (floating tray) and `displacedItems` state / the displaced bits of `useOverlayFillStamp`.

**Changed**
- `useSlotMutations`: `swapSlots` → `replaceSlot` (place incoming; clear source if grid-to-grid; occupant returns to palette via slot clear). Ensure it triggers `recalcStats`/`recalcFindings`.
- `dragFSM` / `useDragFSM` / `dragHandlers` / `GridDragSurface`: drop-target resolution produces the static-ghost preview state (data-attribute) and the replace outcome; `allowSwap` is removed/retired.
- `SlotCell`: render the ghost/dimmed-occupant states from data-attributes; host the inline-write text field + typeahead when the cell is clicked.
- `ActivityPalette`: unchanged for counts; verify it reflects a newly created activity and displaced returns.
- `ScheduleScreen`: remove `EditModal`/`DisplacedPalette` wiring; route click-to-cell into inline-write; keep both routes (palette is shared across group/day/activity views).

**Added**
- Inline-write control (typeahead + create-new) within `SlotCell` (or a small dedicated cell-editor component it renders).
- A `createActivityFromCell` path (catalog write + provenance stamp + default rules) — small, testable, kept out of the engine.

## Edge cases
- Anchor slots: not droppable/writable/creatable-into.
- `atMax` activity dropped again: keep existing placement rules (max is a cap; behavior unchanged, just surfaced by palette state).
- Generated route: replacing engine output edits the proposal (already allowed); displaced returns to palette as "unplaced."
- Empty cell inline-write that resolves to nothing (blur/Escape): no-op.
- Create-new with a name that collides case/space-insensitively with an existing activity: treat as a match, do not create a duplicate (reuse the family's normalized dup-name check).

## Testing seams
- `replaceSlot` mutation: place into empty; replace occupied (occupant gone, not swapped); grid-to-grid clears source; triggers recalc.
- Drag-over → ghost state in `dragFSM` (and that it does NOT fire on anchors).
- Inline write: typeahead match places; create-new path writes a provenance-stamped activity with default rules, adds to palette, places it; dup-name collapses to match; Escape cancels.
- Counts/flags recompute on displace and on create-new.
- Accessibility: click-to-write gives the cell a keyboard path (the previous concern about a dead cell is resolved by inline write).

## Deferred (captured, not built here)
- **Per-slot weather-alternative swap** (was in `EditModal`). The global weather toggle still works; the granular per-slot swap is unreachable until a small follow-up. Track separately.

## Resolved decisions (2026-08-09)
1. **Cell-created activity rule = derived from usage** (min_per_week tracks placement count; self-calibrating; never a spurious under-served flag). Max ∞, normal priority, eligible all-groups. Placing an *existing* activity adds no rule.
2. **Create-new is available to any editing role** (not admin-gated).
3. **Enter places/replaces** the top match (or confirms create-new). No Tab-to-accept; Escape/blur cancels.
