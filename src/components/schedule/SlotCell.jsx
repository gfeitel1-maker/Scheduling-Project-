import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { S, prefersReducedMotion } from '../../styles/shared'
import { ANCHOR_COLOR, FLAG_COLORS, activityColor } from './slotCellConstants'
import { cellAccessibleName } from './cellLabel'
import CellInlineEditor from './CellInlineEditor'
import './scheduleGrid.css'

// T92. The merge/split affordance's glyph. Replaces the bare `↕` text node —
// ambiguous and font-dependent — with a small outline SVG, same construction
// as UnfillableIcon/OutdoorIcon below. `currentColor` lets the button's own
// idle/hover/split CSS `color` rules drive it with no extra inline style. The
// split reading is the same chevron rotated 90°, not a second glyph — one icon
// vocabulary for "this control changes the cell's block span".
function ExpandGlyph({ direction = 'merge' }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none"
      style={{ display: 'block', transform: direction === 'split' ? 'rotate(90deg)' : undefined }}>
      <path d="M3 4.5 L6 7.2 L9 4.5" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
  // T105 — elective authoring/render. electiveSetsAll/electiveMembersBySet
  // are the RENDER lookups (design §2 — the unfiltered list; a one-off must
  // render). onCreateElective is CellInlineEditor's third commit path.
  // isContentRaced/onDismissContentRace surface the CONTENT_RACE flag (§5).
  electiveSetsAll = [], electiveMembersBySet, onCreateElective,
  isContentRaced = false, onDismissContentRace,
  // Stamp mode (field-trip overlay tool) intercepts a plain click with its own
  // action instead of activating inline write — same precedence the old
  // `onEdit={cellClickHandler || ...}` gave it.
  onCellClick,
  isLocked, isDndEnabled, rowSpan = 1,
  isSelected = false, isMultiSelected = false, pasteMode = false,
  hasMergeDown = false, isMerged = false,
  onMergeDown, onSplitSlot,
  // T107 item 1/2 (Designer spec 2026-08-21) — drag-to-extend + click-any-
  // interior-cell-to-split. spanTailBlockIds is the ordered list of block ids
  // this span currently covers past its own head (empty for a non-span
  // cell); band 1 is always the head (this cell) and is never itself a split
  // target (Interactions §"Click-any-interior-cell-to-split" #3). onSplitAt
  // is called with the covered block's id when a band 2..N is clicked.
  // onExtendGrab starts the drag-to-extend gesture on pointerdown on the
  // handle; showExtendHint mirrors showMergeHint's one-time discoverability
  // convention.
  spanTailBlockIds = [],
  onSplitAt, onExtendGrab, showExtendHint = false,
  // T92. Device-local, one-time onboarding pulse on the first mergeable cell of
  // a camp's first Manual Build session. Owned by the caller (localStorage flag
  // lives in ManualBuildView, not here) — this prop is purely "should THIS
  // cell's merge button show it right now".
  showMergeHint = false,
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
    'data-elective': slot?.elective_set_id ? '' : undefined,
    // T108 Phase 2 (design §5.3, Designer spec §2) — a SWAP override (a pull
    // never reaches SlotCell; it routes to PulledCell in gridGeometry.js's
    // decideCell). Two attributes per the Designer spec §6 implementation
    // note: data-overridden gates the frame border, data-overridden-kind
    // distinguishes swap/pull for any future shared styling.
    'data-overridden': slot?.is_overridden ? 'true' : undefined,
    'data-overridden-kind': slot?.is_overridden ? 'swap' : undefined,
  }

  function triggerPress() {
    setPressed(true)
    setTimeout(() => setPressed(false), 110)
  }

  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked && Boolean(activity)

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
  // Manual route only. Slate dot in the top-LEFT corner (clear of the top-right
  // flag cluster) — the activity or its group is marked not to run this week.
  const isWeekClosed = Boolean(flags.WEEK_CLOSED)
  // T105 §4 — dangling-reference fallback: slot.elective_set_id can point at
  // a set deleted from another device (or a race with an in-flight delete).
  // A missing set renders a plain, non-alarming placeholder rather than a
  // blank cell (indistinguishable from "Unassigned") or a thrown lookup
  // error — same `set ? ... : ''` shape §6's export uses.
  const electiveSet = slot.elective_set_id ? electiveSetsAll.find(s => s.id === slot.elective_set_id) : null
  const electiveMemberCount = slot.elective_set_id ? (electiveMembersBySet?.get(slot.elective_set_id)?.length ?? 0) : 0
  const electiveLabel = slot.elective_set_id
    ? (electiveSet ? `${electiveSet.name}${electiveMemberCount ? ` (${electiveMemberCount})` : ''}` : 'Elective (removed)')
    : null
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
        {/* Merge-down button (T4, redesigned T92: always visible, quiet at rest) */}
        {hasMergeDown && !isMerged && (
          <button
            className="cell-action"
            title="Let this activity run into the next period"
            aria-label="Let this activity run into the next period"
            data-merge-hint={showMergeHint ? '' : undefined}
            onClick={e => { e.stopPropagation(); onMergeDown?.() }}
          ><ExpandGlyph direction="merge" /></button>
        )}
        {/* Split button (T4) — the keyboard-accessible equivalent of the
            interior-band click below (spec Interactions §4); not removed. */}
        {isMerged && (
          <button
            className="cell-action cell-action--split"
            title="Split this back into two periods"
            aria-label="Split this back into two periods"
            onClick={e => { e.stopPropagation(); onSplitSlot?.() }}
          ><ExpandGlyph direction="split" /></button>
        )}
        {/* T107 item 2 — interior-split bands. Band 1 is this cell's own head
            block and is never a split target (kept out of the DOM entirely,
            not merely non-interactive, since it would just duplicate the
            existing click-to-edit surface). Bands render only for a span
            (rowSpan > 1 with at least one covered tail). */}
        {rowSpan > 1 && spanTailBlockIds.length > 0 && (
          <div className="span-bands" aria-hidden="true">
            {spanTailBlockIds.map((blockId, i) => {
              const bandIndex = i + 2 // band 1 is the head, never rendered here
              const bandHeight = 100 / rowSpan
              return (
                <div
                  key={blockId}
                  className="span-band"
                  data-band-index={bandIndex}
                  tabIndex={-1}
                  style={{
                    top: `${bandHeight * (bandIndex - 1)}%`,
                    height: `${bandHeight}%`,
                  }}
                  title={`Split before this block`}
                  // Pointer guard (Red Hat 2026-08-21): stop pointerdown before
                  // it reaches the cell's dnd-kit listeners, or a tap-with-drift
                  // (≥8px, common on touch/trackpad) on a split band activates a
                  // whole-span drag instead of splitting. Mirrors the
                  // span-extend-handle's guard below.
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); onSplitAt?.(blockId) }}
                >
                  <div className="span-cut-line" />
                </div>
              )
            })}
          </div>
        )}
        {/* T107 item 1 — drag-to-extend handle. Rendered wherever the span
            could be lengthened (same gate as the merge-down button),
            regardless of current rowSpan — a plain N=1 activity cell is
            still extendable to N=2. pointerdown starts tracking immediately
            (Implementation Note #2 — no distance:8 disambiguation; nothing
            else on this 28x4px target is clickable). */}
        {hasMergeDown && onExtendGrab && (
          <div
            className="span-extend-handle"
            role="button"
            tabIndex={-1}
            aria-label="Drag to make this activity run longer"
            title="Drag to make this activity run longer"
            data-span-extend-hint={showExtendHint ? '' : undefined}
            onPointerDown={e => { e.preventDefault(); e.stopPropagation(); onExtendGrab() }}
          />
        )}
        {editing ? (
          <CellInlineEditor
            eligibleActivities={eligibleActivities}
            currentActivityName={activity?.name ?? electiveLabel ?? null}
            onPlace={(activityId) => { setEditing(false); onPlace?.(slot, activityId) }}
            onCreateNew={(name) => { setEditing(false); onCreateNew?.(slot, name) }}
            onCreateElective={onCreateElective ? (setName, memberNames) => { setEditing(false); onCreateElective(slot, setName, memberNames) } : undefined}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="cell-name" data-unassigned={!activity && !electiveLabel ? '' : undefined}>
            {showIdentityDot && activity && (
              <span className="identity-dot" style={{ background: color }} />
            )}
            {electiveLabel || activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned')}
          </div>
        )}
        {isOverlapping && (
          <div
            className="flag flag--overlap"
            style={{ background: FLAG_COLORS.OVERLAP }}
            title={flags.OVERLAP_reason || 'More groups booked in than this holds'}
          />
        )}
        {isWeekClosed && (
          <div
            className="flag flag--week-closed"
            style={{ background: FLAG_COLORS.WEEK_CLOSED }}
            title={flags.WEEK_CLOSED_reason || 'Marked not to run this week'}
          />
        )}
        {isUnfillable && (
          <div className="flag flag--unfillable" title="Unfillable">
            <UnfillableIcon />
          </div>
        )}
        {isContentRaced && (
          <button
            type="button"
            className="flag flag--content-race"
            style={{ background: FLAG_COLORS.CONTENT_RACE, border: 'none', padding: 0, cursor: 'pointer' }}
            title="This cell was changed by another device — dismiss"
            aria-label="This cell was changed by another device — dismiss"
            onClick={e => { e.stopPropagation(); onDismissContentRace?.() }}
          />
        )}
        {showOutdoorIcon && (
          <div className="flag flag--outdoor" title="Outdoor activity">
            <OutdoorIcon />
          </div>
        )}
      </div>
    </div>
  )
}
