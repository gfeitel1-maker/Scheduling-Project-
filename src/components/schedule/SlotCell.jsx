import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { S, prefersReducedMotion } from '../../styles/shared'
import { ANCHOR_COLOR, FLAG_COLORS, activityColor } from './slotCellConstants'
import { cellAccessibleName } from './cellLabel'
import CellInlineEditor from './CellInlineEditor'
import './scheduleGrid.css'

// Hover is a CSS selector (`.cell:hover .expand-handle`, `.expand-handle:hover`)
// and costs zero JavaScript — that is the payoff of the spec §6 styling
// relaxation, banked in T56. Both glyphs are always mounted and the stylesheet
// picks one, because a text swap is the one thing a pseudo-state cannot do to a
// text node.
function ExpandHandle({ groupId, dayId, blockId, activityId }) {
  // No activationConstraint here: it is a sensor option, never a useDraggable
  // one, so the value that used to sit here was inert. The threshold is the
  // PointerSensor's, set once in ScheduleScreen (T58, spec §5.6).
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `expand-${groupId}|${dayId}|${blockId}`,
    data: { expandDrag: { groupId, dayId, blockId, activityId } },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="expand-handle"
      data-dragging={isDragging ? '' : undefined}
      onClick={e => e.stopPropagation()}
      title="Drag to extend"
    >
      <span className="expand-glyph expand-glyph--idle">─</span>
      <span className="expand-glyph expand-glyph--active">↕</span>
    </div>
  )
}

// Outline "alert" glyph — deliberately a shape (not a dot), per the design
// spec's "unambiguous even before color registers" instruction for the one
// per-cell flag mark that survives the decolorization pass.
function UnfillableIcon() {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block' }}>
      <circle cx="6" cy="6" r="5.25" stroke="var(--danger)" strokeWidth="1.5" />
      <line x1="6" y1="3.25" x2="6" y2="6.5" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="0.75" fill="var(--danger)" />
    </svg>
  )
}

// Small outline "sun" glyph for outdoor activities — replaces the deleted
// WEATHER_RISK flag. Informational, not a caution state.
function OutdoorIcon() {
  return (
    <svg viewBox="0 0 10 10" width={10} height={10} fill="none" style={{ display: 'block' }}>
      <circle cx="5" cy="5" r="2.1" stroke="var(--text-secondary)" strokeWidth="1.5" />
      <g stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round">
        <line x1="5" y1="0.6" x2="5" y2="1.6" />
        <line x1="5" y1="8.4" x2="5" y2="9.4" />
        <line x1="0.6" y1="5" x2="1.6" y2="5" />
        <line x1="8.4" y1="5" x2="9.4" y2="5" />
      </g>
    </svg>
  )
}

export default function SlotCell({
  slot, activity, anchor, actColorIdx, weatherMode,
  onRelease, onSelect,
  // Inline-write (replaces the removed EditModal picklist, 2026-08-09):
  // eligibleActivities is this cell's group's eligible activity list (computed
  // by the caller, ScheduleScreen's eligibleActivitiesFor); onPlace/onCreateNew
  // are called with (slot, ...) once the inline editor resolves.
  eligibleActivities = [], onPlace, onCreateNew,
  // Stamp mode (field-trip overlay tool) intercepts a plain click with its own
  // action instead of activating inline write — same precedence the old
  // `onEdit={cellClickHandler || ...}` gave it.
  onCellClick,
  isLocked, isDndEnabled, rowSpan = 1,
  isSelected = false, isMultiSelected = false, pasteMode = false,
  hasMergeDown = false, isMerged = false,
  onMergeDown, onSplitSlot,
  // Generated-route "track changes" review (default off, so the manual route
  // and every existing caller are unchanged). showIdentityDot=false is the calm
  // grid: the activity name carries identity, no colour dot. isFlagHighlighted
  // lights the cell in the active concern's colour; highlightReason is shown in
  // a callout when the lit cell is hovered or focused.
  showIdentityDot = true,
  isFlagHighlighted = false,
  highlightColor = 'var(--danger)',
  highlightReason = null,
  // Placement is computed by placeCell (gridPlacement.js) at the call site and
  // spread in. A grid child with no explicit grid-column stacks in column 1 and
  // nothing throws, so no view may inline these strings.
  gridRow,
  gridColumn,
  ariaColIndex,
  cellKey,
  // T59. The context half of the accessible name — the block names this cell
  // covers (one, or its whole extent when it spans) and its column's day or
  // group. The SUBJECT half is composed here, because which of activity /
  // anchor / unavailable / unfillable / unassigned applies is this component's
  // knowledge, not the view's.
  blockNames,
  column,
  // T55. The head block of this cell is collapsed: presentation only. A cell
  // that merely SPANS ACROSS a collapsed block never receives it — it keeps
  // normal presentation and simply gets shorter, because grid sums the tracks
  // it covers. Nothing about mounting, handlers or focusability changes.
  collapsed = false,
}) {
  // The only remaining state in this component. Hover, split-hover and
  // reason-focus were all deleted in T56: :hover and :focus-within in
  // scheduleGrid.css do that work now, so hovering a cell re-renders nothing.
  const [pressed, setPressed] = useState(false)
  const [editing, setEditing] = useState(false)

  const nameFor = subject => cellAccessibleName({ subject, blockNames, column })

  const shellProps = {
    role: 'gridcell',
    className: 'cell',
    style: { gridRow, gridColumn },
    'aria-colindex': ariaColIndex,
    'aria-rowspan': rowSpan > 1 ? rowSpan : undefined,
    'data-cell-key': cellKey,
    'data-collapsed': collapsed ? '' : undefined,
    // Replaces the old droppable's `disabled: !isDndEnabled || isLocked`. The hit
    // is now resolved from pointer coordinates, so "not a drop target" has to be
    // readable off the element itself — resolveHit reads exactly this.
    'data-drop-disabled': !isDndEnabled || isLocked ? '' : undefined,
  }

  function triggerPress() {
    setPressed(true)
    setTimeout(() => setPressed(false), 110)
  }

  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked && Boolean(activity)
  const showExpandHandle = slot?.activity_id && !slot?.is_anchor && !isLocked

  // Drag only. The matching per-cell droppable is gone: one droppable now sits on
  // the grid surface and the target cell is resolved from pointer coordinates
  // (spec §5.3), which is what removed up to 480 isOver subscribers.
  const { attributes: dragAttributes, listeners, setNodeRef: setRef, isDragging } = useDraggable({
    id,
    disabled: !canDrag,
    data: { slot },
  })

  // dnd-kit hands every draggable `tabIndex: 0`. On a grid that is up to 480
  // tab stops, which is precisely what T59's roving tabindex exists to prevent
  // — the grid must be ONE tab stop. Dropping it here costs nothing: the cell
  // is still focusable (the roving hook writes 0 or -1, and -1 is focusable),
  // and dnd-kit's keyboard sensor (T58) fires off keydown on the focused
  // element, which arrow navigation is what now delivers. The rest of
  // `attributes` — aria-roledescription, aria-describedby — is kept.
  const { tabIndex: _dndTabIndex, ...attributes } = dragAttributes

  if (!slot) return <div {...shellProps} aria-label={nameFor('Empty')} />

  if (slot.type === 'anchor') {
    return (
      <div {...shellProps} aria-label={nameFor(anchor?.name || 'Anchor')} ref={setRef} onClick={() => triggerPress()}>
        <div
          className="cell-inner cell-inner--anchor"
          style={{
            ...S.cellStructuralBar(ANCHOR_COLOR),
            background: 'var(--surface)',
            transform: pressed ? 'scale(0.97)' : 'scale(1)',
            transition: 'transform var(--motion-fast) var(--ease-out)',
          }}
        >
          <div
            className="cell-name"
            // The colour rides a custom property rather than `color` so the
            // collapsed rule can recolour it — an inline `color` would win.
            style={{ '--cell-name-color': ANCHOR_COLOR, fontSize: 11 }}
          >
            {anchor?.name || 'Anchor'}
          </div>
        </div>
      </div>
    )
  }

  if (slot.type === 'unavailable') {
    return (
      <div {...shellProps} aria-label={nameFor('Unavailable')} ref={setRef}>
        <div className="cell-inner cell-inner--fill" style={S.cellUnavailableFill} />
      </div>
    )
  }

  const flags = slot.flags || {}
  const isUnfillable = Boolean(flags.UNFILLABLE) && !flags.UNFILLABLE_dismissed
  // Manual route only. The cell keeps its own activity colour — the marker
  // must not destroy the activity's identity — and carries a bronze dot in
  // the same corner UNFILLABLE's glyph occupies. Dot vs glyph is the
  // non-colour channel that keeps the two from reading alike.
  const isOverlapping = Boolean(flags.OVERLAP)
  const isOutdoor = Boolean(activity?.is_outdoor)
  const showOutdoorIcon = isOutdoor && !isUnfillable
  const isWeatherHighlight = weatherMode && showOutdoorIcon
  const color = activity ? activityColor(actColorIdx) : null

  function handleClick(e) {
    triggerPress()
    if (isLocked) { onRelease?.(slot); return }
    if (onSelect) { onSelect(slot, e); return }
    if (onCellClick) { onCellClick(slot); return }
    setEditing(true)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    setEditing(true)
  }

  // T59's roving tabindex makes every cell a keyboard focus stop; dnd-kit's
  // keyboard sensor owns arrow-key movement, but Enter activating inline
  // write was a gap until now — the accessibility concern the spec's testing
  // seams call out. Space is deliberately left alone: dnd-kit's default
  // keyboard codes use BOTH Space and Enter to start a keyboard-initiated
  // drag (its own stated reason for being retained at all, per this file's
  // header note), so claiming Space here for inline-write would silently
  // break that existing accessibility path. Enter for edit, Space for
  // pick-up-to-drag is the same split common list/grid widgets use. Same
  // click precedence as handleClick, minus onSelect (multi-select has no
  // keyboard entry point today) and onCellClick (stamp mode is pointer-only).
  function handleEnterKeyDown(e) {
    if (editing) return
    e.preventDefault()
    triggerPress()
    if (isLocked) { onRelease?.(slot); return }
    if (onCellClick) { onCellClick(slot); return }
    setEditing(true)
  }

  // Only data-derived paint composes inline. The static half (radius, padding,
  // min-height, flex box) is .cell-inner in the stylesheet, and the rowSpan > 1
  // centring is `.cell[aria-rowspan] .cell-inner` — both because T55's collapsed
  // rule has to override them and no class can override an inline value.
  const innerStyle = {
    ...(isLocked
      ? { ...S.cellStructuralBar('var(--accent)'), background: 'var(--surface)' }
      : isUnfillable
        ? S.cellUnfillableBar
        : { background: 'var(--surface)', border: '1px solid var(--border)' }),
    // Review highlight sits above the base border but below selection/drop
    // indicators (spread later), so an in-progress drag still shows its target.
    ...(isFlagHighlighted ? S.cellFlagHighlight(highlightColor) : {}),
    opacity: isDragging ? 0.4 : 1,
    // Weather outline applies first — selection (spread after) wins if both apply.
    ...(isWeatherHighlight ? { outline: '1px solid var(--text-secondary)', outlineOffset: -1 } : {}),
    // The drop target's paint is NOT here any more. It is a static
    // `.cell[data-drag-over]::before/::after` rule in scheduleGrid.css, written
    // by one setAttribute — an inline value would both re-render the tree and
    // beat the rule (the T55 lesson).
    ...(isSelected
      ? (prefersReducedMotion() ? { boxShadow: S.cellSelected.boxShadow, outline: S.cellSelected.outline, outlineOffset: S.cellSelected.outlineOffset } : S.cellSelected)
      : {}),
    ...(isMultiSelected ? S.cellMultiSelectedFill : {}),
  }

  const tooltipText = activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned')
  const isPasteTarget = pasteMode && !slot?.is_anchor

  return (
    <div
      ref={setRef}
      {...shellProps}
      // cursor is the only inline shell style left; hover, paste-target hover
      // and focus are all selectors.
      style={{ ...shellProps.style, cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : undefined }}
      data-paste-target={isPasteTarget ? '' : undefined}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      // No `tabIndex` here any more. It used to be 0 on a flag-highlighted cell
      // only, as the keyboard path to the reason callout that a mouse gets on
      // hover. T59's roving tabindex makes EVERY cell reachable by arrow keys
      // and owns the attribute outright, so a value here would fight it — and
      // the callout still opens, because :focus-within fires the same either
      // way. The keyboard path is generalised, not removed.
      title={tooltipText}
      aria-label={nameFor(activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned'))}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
      // Composed AFTER the dnd-kit spread so it wins the single onKeyDown slot
      // (object spread, last write wins) rather than being silently replaced
      // by dnd-kit's own listener. Enter is intercepted outright — inline
      // write, never a drag pickup; every other key (Space included) still
      // reaches dnd-kit's listener when the cell is draggable.
      onKeyDown={e => {
        if (e.key === 'Enter') { handleEnterKeyDown(e); return }
        if (canDrag) listeners?.onKeyDown?.(e)
      }}
      // dnd-kit's `attributes` carry role="button", which on a table cell was inert
      // but on a grid child silently replaces role="gridcell" and collapses the
      // grid -> row -> gridcell tree. Spec §8 wants the gridcell; dnd-kit's
      // remaining attributes (tabIndex, aria-roledescription, aria-describedby)
      // are what actually carry the drag affordance, and they are kept.
      role="gridcell"
    >
      <div className="cell-inner" style={{
        ...innerStyle,
        // Compose press-scale with the selection "lift" (translateY) carried by
        // innerStyle's S.cellSelected spread instead of clobbering it — both
        // can be true at once (a selected cell being pressed).
        transform: [
          isSelected && !prefersReducedMotion() ? 'translateY(-1px)' : null,
          pressed ? 'scale(0.97)' : 'scale(1)',
        ].filter(Boolean).join(' '),
        transition: 'transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)',
      }}>
        {/* Why this cell is lit — shown while the lit cell is hovered or
            focused, per the "track changes" review. Screen-only review chrome;
            never printed. */}
        {isFlagHighlighted && highlightReason && (
          <div className="cell-reason" style={S.cellReasonCallout} role="tooltip">{highlightReason}</div>
        )}
        {/* Merge-down button (T4) */}
        {hasMergeDown && !isMerged && (
          <button
            className="cell-action"
            title="Let this activity run into the next period"
            onClick={e => { e.stopPropagation(); onMergeDown?.() }}
          >↕</button>
        )}
        {/* Split button (T4) */}
        {isMerged && (
          <button
            className="cell-action cell-action--split"
            title="Split this back into two periods"
            onClick={e => { e.stopPropagation(); onSplitSlot?.() }}
          >↕</button>
        )}
        {editing ? (
          <CellInlineEditor
            eligibleActivities={eligibleActivities}
            currentActivityName={activity?.name ?? null}
            onPlace={(activityId) => { setEditing(false); onPlace?.(slot, activityId) }}
            onCreateNew={(name) => { setEditing(false); onCreateNew?.(slot, name) }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="cell-name" data-unassigned={!activity ? '' : undefined}>
            {showIdentityDot && activity && (
              <span className="identity-dot" style={{ background: color }} />
            )}
            {activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned')}
          </div>
        )}
        {isOverlapping && (
          <div
            className="flag flag--overlap"
            style={{ background: FLAG_COLORS.OVERLAP }}
            title={flags.OVERLAP_reason || 'More groups booked in than this holds'}
          />
        )}
        {isUnfillable && (
          <div className="flag flag--unfillable" title="Unfillable">
            <UnfillableIcon />
          </div>
        )}
        {showOutdoorIcon && (
          <div className="flag flag--outdoor" title="Outdoor activity">
            <OutdoorIcon />
          </div>
        )}
        {showExpandHandle && (
          <ExpandHandle
            groupId={slot.groupId}
            dayId={slot.dayId}
            blockId={slot.blockId}
            activityId={slot.activity_id}
          />
        )}
      </div>
    </div>
  )
}
