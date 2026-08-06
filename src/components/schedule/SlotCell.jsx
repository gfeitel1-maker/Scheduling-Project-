import { useState } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { S, prefersReducedMotion } from '../../styles/shared'
import { ANCHOR_COLOR, FLAG_COLORS, activityColor, cellTd, emptyTd } from './slotCellConstants'
import './scheduleGrid.css'

function ExpandHandle({ groupId, dayId, blockId, activityId, cellHovered, cssHover = false }) {
  const [hovered, setHovered] = useState(false)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `expand-${groupId}|${dayId}|${blockId}`,
    data: { expandDrag: { groupId, dayId, blockId, activityId } },
    activationConstraint: { distance: 12 },
  })

  const visible = cellHovered || isDragging
  const active = hovered || isDragging

  // In cssHover mode the .expand-handle class owns geometry and the
  // cell-hover -> visible gating; only the two data-derived colours stay
  // inline. That is what removes this handle from the cell's hover re-render.
  const layout = cssHover ? {} : {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 10,
    borderRadius: '0 0 7px 7px',
    cursor: 'row-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.15s, opacity 0.15s',
    opacity: visible ? (active ? 1 : 0.6) : 0,
    userSelect: 'none',
    touchAction: 'none',
    zIndex: 2,
    pointerEvents: visible ? 'auto' : 'none',
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cssHover ? 'expand-handle' : undefined}
      data-dragging={cssHover && isDragging ? '' : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={e => e.stopPropagation()}
      title={active ? 'Drag to extend' : undefined}
      style={{
        ...layout,
        background: active ? 'var(--primary)' : 'var(--border)',
      }}
    >
      <span style={{
        fontSize: 11,
        color: active ? '#fff' : 'var(--text-secondary)',
        lineHeight: 1,
        pointerEvents: 'none',
      }}>
        {active ? '↕' : '─'}
      </span>
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
  onEdit, onRelease, onSelect,
  isLocked, isDndEnabled, rowSpan = 1, isExpandDragActive = false,
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
  // TRANSITIONAL (T54 -> deleted in T56). SlotCell is shared by
  // ScheduleGroupView, ScheduleDayView and ManualBuildView. The latter two are
  // still <table>s, and a <div> inside a <tr> is hoisted out of the table by
  // the browser — so the default must stay 'td' until the last table caller
  // goes away. Only the converted CSS Grid view passes 'gridcell'.
  renderAs = 'td',
  gridRow,
  gridColumn,
  ariaColIndex,
  cellKey,
  // T55. The head block of this cell is collapsed: presentation only. A cell
  // that merely SPANS ACROSS a collapsed block never receives it — it keeps
  // normal presentation and simply gets shorter, because grid sums the tracks
  // it covers. Nothing about mounting, handlers or focusability changes.
  collapsed = false,
}) {
  const [cellHovered, setCellHovered] = useState(false)
  const [splitHovered, setSplitHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [reasonFocused, setReasonFocused] = useState(false)
  const isGrid = renderAs === 'gridcell'

  // In the gridcell branch every one of these is a CSS selector instead of
  // React state (spec §6): cellHovered/splitHovered/reasonFocused are only read
  // by the 'td' branch below. The useState calls themselves cannot be removed
  // while that branch exists — hooks are unconditional — but nothing in the
  // grid path subscribes to them, so hovering a grid cell re-renders nothing.
  const Shell = isGrid ? 'div' : 'td'

  function shellProps({ tdStyle }) {
    if (!isGrid) return { style: tdStyle, rowSpan }
    return {
      role: 'gridcell',
      className: 'cell',
      style: { gridRow, gridColumn },
      'aria-colindex': ariaColIndex,
      'aria-rowspan': rowSpan > 1 ? rowSpan : undefined,
      'data-cell-key': cellKey,
      'data-collapsed': collapsed ? '' : undefined,
    }
  }

  function triggerPress() {
    setPressed(true)
    setTimeout(() => setPressed(false), 110)
  }

  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked && Boolean(activity)
  const showExpandHandle = slot?.activity_id && !slot?.is_anchor && !isLocked

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id,
    disabled: !canDrag,
    data: { slot },
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${id}`,
    disabled: !isDndEnabled || Boolean(isLocked),
    data: { slot },
  })

  const setRef = el => { setDragRef(el); setDropRef(el) }

  if (!slot) return <Shell {...shellProps({ tdStyle: emptyTd })} />

  if (slot.type === 'anchor') {
    return (
      <Shell {...shellProps({ tdStyle: cellTd })} ref={setRef} onClick={() => { triggerPress(); onEdit(slot) }}>
        <div
          className={isGrid ? 'cell-inner cell-inner--anchor' : undefined}
          style={{
            ...S.cellStructuralBar(ANCHOR_COLOR),
            background: 'var(--surface)',
            ...(isGrid ? {} : {
              borderRadius: 8,
              padding: '10px 12px',
              minHeight: 56,
              display: 'flex',
              alignItems: 'center',
            }),
            transform: pressed ? 'scale(0.97)' : 'scale(1)',
            transition: 'transform 0.1s ease',
          }}
        >
          <div
            className={isGrid ? 'cell-name' : undefined}
            // The colour rides a custom property rather than `color` so the
            // collapsed rule can recolour it — an inline `color` would win.
            style={isGrid
              ? { '--cell-name-color': ANCHOR_COLOR, fontSize: 11 }
              : { fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {anchor?.name || 'Anchor'}
          </div>
        </div>
      </Shell>
    )
  }

  if (slot.type === 'unavailable') {
    return (
      <Shell {...shellProps({ tdStyle: emptyTd })} ref={setRef}>
        <div
          className={isGrid ? 'cell-inner cell-inner--fill' : undefined}
          style={isGrid ? S.cellUnavailableFill : { ...S.cellUnavailableFill, borderRadius: 8, minHeight: 56 }}
        />
      </Shell>
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
    onEdit(slot)
  }

  function handleDoubleClick() {
    if (isLocked) return
    onEdit(slot)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    onEdit(slot)
  }

  // The static half (radius, padding, min-height, flex box) is owned by
  // .cell-inner in the stylesheet for the grid branch; the 'td' branch keeps
  // it inline until T56 deletes that branch.
  const innerStatic = isGrid ? {} : {
    borderRadius: 8,
    padding: '10px 12px',
    minHeight: 56,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  }

  const innerStyle = {
    ...innerStatic,
    // Grid branch: .cell[aria-rowspan] .cell-inner owns this in the stylesheet,
    // because the collapsed rule has to override it and an inline value cannot
    // be overridden by a class.
    ...(isGrid ? {} : { justifyContent: rowSpan > 1 ? 'center' : 'flex-start' }),
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
    ...(isOver && isExpandDragActive
      ? { border: '2px dashed var(--success)', background: 'color-mix(in srgb, var(--success) 9%, transparent)' }
      : isOver && isDndEnabled && !isExpandDragActive
        ? { outline: '2px solid var(--primary)', outlineOffset: -2 }
        : {}),
    ...(isSelected
      ? (prefersReducedMotion() ? { boxShadow: S.cellSelected.boxShadow, outline: S.cellSelected.outline, outlineOffset: S.cellSelected.outlineOffset } : S.cellSelected)
      : {}),
    ...(isMultiSelected ? S.cellMultiSelectedFill : {}),
  }

  const tooltipText = activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned')

  const pasteTargetStyle = pasteMode && !slot?.is_anchor
    ? { cursor: 'crosshair' }
    : {}

  const isPasteTarget = pasteMode && !slot?.is_anchor

  // In the grid branch cursor is the only inline shell style left; hover,
  // paste-target hover and focus are all selectors.
  const gridShell = shellProps({ tdStyle: null })
  const shellStyle = isGrid
    ? { ...gridShell.style, cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : undefined }
    : {
        ...cellTd,
        cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        ...pasteTargetStyle,
      }

  return (
    <Shell
      ref={setRef}
      {...(isGrid
        ? { ...gridShell, style: shellStyle, 'data-paste-target': isPasteTarget ? '' : undefined }
        : { style: shellStyle, rowSpan })}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      {...(isGrid ? {} : {
        onPointerEnter: () => setCellHovered(true),
        onPointerLeave: () => setCellHovered(false),
        onFocus: () => setReasonFocused(true),
        onBlur: () => setReasonFocused(false),
      })}
      // Keyboard path to the same reason a mouse gets on hover — a lit cell is
      // focusable only while it is lit, so tab order is unchanged otherwise.
      // In the grid branch :focus-within on the cell does the revealing.
      tabIndex={isFlagHighlighted ? 0 : undefined}
      title={tooltipText}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
      // dnd-kit's `attributes` carry role="button", which on a <td> was inert
      // but on a grid child silently replaces role="gridcell" and collapses the
      // grid -> row -> gridcell tree. Spec §8 wants the gridcell; dnd-kit's
      // remaining attributes (tabIndex, aria-roledescription, aria-describedby)
      // are what actually carry the drag affordance, and they are kept.
      {...(isGrid ? { role: 'gridcell' } : {})}
    >
      <div className={isGrid ? 'cell-inner' : undefined} style={{
        ...innerStyle,
        ...(!isGrid && pasteMode && cellHovered && !slot?.is_anchor ? { border: '2px dashed var(--primary)', background: 'color-mix(in srgb, var(--primary) 12%, transparent)' } : {}),
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
        {isFlagHighlighted && highlightReason && (isGrid || cellHovered || reasonFocused) && (
          <div className={isGrid ? 'cell-reason' : undefined} style={S.cellReasonCallout} role="tooltip">{highlightReason}</div>
        )}
        {/* Merge-down button (T4) */}
        {(isGrid || cellHovered) && hasMergeDown && !isMerged && (
          <button
            className={isGrid ? 'cell-action' : undefined}
            style={isGrid ? undefined : S.cellActionBtn}
            title="Let this activity run into the next period"
            onClick={e => { e.stopPropagation(); onMergeDown?.() }}
          >↕</button>
        )}
        {/* Split button (T4) */}
        {(isGrid || cellHovered) && isMerged && (
          <button
            className={isGrid ? 'cell-action cell-action--split' : undefined}
            style={isGrid ? undefined : {
              ...S.cellActionBtn,
              ...(splitHovered ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
            }}
            title="Split this back into two periods"
            onClick={e => { e.stopPropagation(); onSplitSlot?.() }}
            {...(isGrid ? {} : {
              onPointerEnter: () => setSplitHovered(true),
              onPointerLeave: () => setSplitHovered(false),
            })}
          >↕</button>
        )}
        <div
          className={isGrid ? 'cell-name' : undefined}
          data-unassigned={isGrid && !activity ? '' : undefined}
          style={isGrid ? undefined : {
            fontSize: 12,
            fontWeight: activity ? 600 : 500,
            color: activity ? 'var(--text)' : 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {showIdentityDot && activity && (
            <span className={isGrid ? 'identity-dot' : undefined} style={isGrid ? { background: color } : { ...S.cellIdentityChip, background: color }} />
          )}
          {activity?.name || (isGrid ? (isUnfillable ? 'Unfillable' : 'Unassigned') : <span style={{ fontSize: 11 }}>{isUnfillable ? 'Unfillable' : 'Unassigned'}</span>)}
        </div>
        {isOverlapping && (
          <div
            className={isGrid ? 'flag flag--overlap' : undefined}
            style={isGrid ? { background: FLAG_COLORS.OVERLAP } : {
              position: 'absolute', top: 6, right: 6,
              width: 7, height: 7, borderRadius: '50%',
              background: FLAG_COLORS.OVERLAP,
              boxShadow: '0 0 0 1.5px var(--surface)',
            }}
            title={flags.OVERLAP_reason || 'More groups booked in than this holds'}
          />
        )}
        {isUnfillable && (
          <div className={isGrid ? 'flag flag--unfillable' : undefined} style={isGrid ? undefined : S.cellUnfillableIconStyle} title="Unfillable">
            <UnfillableIcon />
          </div>
        )}
        {showOutdoorIcon && (
          <div className={isGrid ? 'flag flag--outdoor' : undefined} style={isGrid ? undefined : S.cellOutdoorIconStyle} title="Outdoor activity">
            <OutdoorIcon />
          </div>
        )}
        {showExpandHandle && (
          <ExpandHandle
            groupId={slot.groupId}
            dayId={slot.dayId}
            blockId={slot.blockId}
            activityId={slot.activity_id}
            cellHovered={isGrid ? false : cellHovered}
            cssHover={isGrid}
          />
        )}
      </div>
    </Shell>
  )
}
