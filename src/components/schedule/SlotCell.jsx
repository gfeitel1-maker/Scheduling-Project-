import { useState } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { S } from '../../styles/shared'

const ACTIVITY_COLORS = ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
export const ANCHOR_COLOR = 'var(--anchor)'

export const FLAG_COLORS = {
  UNFILLABLE: 'var(--danger)',
  UNDERSERVED: 'var(--primary)',
  WEATHER_RISK: 'var(--accent)',
  DISTRIBUTION: 'var(--secondary)',
}

const REAL_FLAG_NAMES = new Set(Object.keys(FLAG_COLORS))

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }

function ExpandHandle({ groupId, dayId, blockId, activityId, cellHovered }) {
  const [hovered, setHovered] = useState(false)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `expand-${groupId}|${dayId}|${blockId}`,
    data: { expandDrag: { groupId, dayId, blockId, activityId } },
    activationConstraint: { distance: 12 },
  })

  const visible = cellHovered || isDragging

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={e => e.stopPropagation()}
      title={hovered || isDragging ? 'Drag to extend' : undefined}
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 10,
        borderRadius: '0 0 7px 7px',
        background: hovered || isDragging ? 'var(--primary)' : 'var(--border)',
        cursor: 'row-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.15s, opacity 0.15s',
        opacity: visible ? (hovered || isDragging ? 1 : 0.6) : 0,
        userSelect: 'none',
        touchAction: 'none',
        zIndex: 2,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <span style={{
        fontSize: 11,
        color: hovered || isDragging ? '#fff' : 'var(--text-secondary)',
        lineHeight: 1,
        pointerEvents: 'none',
      }}>
        {hovered || isDragging ? '↕' : '─'}
      </span>
    </div>
  )
}

export default function SlotCell({
  slot, activity, anchor, actColorIdx, weatherMode,
  onEdit, onRelease, onSelect,
  isLocked, isDndEnabled, rowSpan = 1, isExpandDragActive = false,
  isSelected = false, isMultiSelected = false, pasteMode = false,
  hasMergeDown = false, isMerged = false,
  onMergeDown, onSplitSlot,
}) {
  const [cellHovered, setCellHovered] = useState(false)
  const [splitHovered, setSplitHovered] = useState(false)
  const [pressed, setPressed] = useState(false)

  function triggerPress() {
    setPressed(true)
    setTimeout(() => setPressed(false), 110)
  }
  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity' && !isLocked
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

  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td ref={setRef} style={cellTd} rowSpan={rowSpan} onClick={() => { triggerPress(); onEdit(slot) }}>
        <div style={{
          background: 'color-mix(in srgb, var(--anchor) 12%, var(--surface))',
          border: '1.5px solid color-mix(in srgb, var(--anchor) 40%, transparent)',
          borderRadius: 8,
          padding: '10px 12px',
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
          transform: pressed ? 'scale(0.97)' : 'scale(1)',
          transition: 'transform 0.1s ease',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {anchor?.name || 'Anchor'}
          </div>
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return (
      <td ref={setRef} style={emptyTd} rowSpan={rowSpan}>
        <div style={{ background: 'var(--bg)', border: '1.5px dashed var(--border)', borderRadius: 8, minHeight: 56, opacity: 0.5 }} />
      </td>
    )
  }

  const flags = slot.flags || {}
  // Only render dots for real flag names (not _reason, _dismissed, etc.)
  const activeFlags = Object.keys(flags).filter(f => REAL_FLAG_NAMES.has(f) && !flags[`${f}_dismissed`])
  const hasFlags = activeFlags.length > 0
  const isOutdoor = flags.WEATHER_RISK && !flags.WEATHER_RISK_dismissed
  const color = activity ? activityColor(actColorIdx) : null
  const isWeatherHighlight = weatherMode && isOutdoor

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

  const lockedInnerStyle = {
    background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
    border: '2px solid var(--accent)',
    borderRadius: 8,
    padding: '10px 12px',
    minHeight: 56,
    position: 'relative',
    overflow: 'hidden',
  }

  const normalInnerStyle = activity
    ? {
        background: isOver && isExpandDragActive ? 'color-mix(in srgb, var(--success) 9%, transparent)' : `${color}1E`,
        border: isOver && isExpandDragActive
          ? '2px dashed var(--success)'
          : isWeatherHighlight ? '2px solid var(--accent)' : `1.5px solid ${color}55`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        opacity: isDragging ? 0.4 : 1,
        outline: isOver && isDndEnabled && !isExpandDragActive ? '2px solid var(--primary)' : 'none',
        outlineOffset: -2,
        position: 'relative',
      }
    : {
        background: 'var(--bg)',
        border: '1.5px dashed var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        position: 'relative',
      }

  const innerStyle = isLocked ? lockedInnerStyle : normalInnerStyle

  // Build tooltip: activity name + flag reasons
  const tooltipParts = [activity?.name || 'Unassigned']
  for (const f of activeFlags) {
    if (flags[`${f}_reason`]) tooltipParts.push(flags[`${f}_reason`])
  }
  const tooltipText = tooltipParts.join('\n')

  const selectionOutline = isSelected
    ? { outline: '2px solid var(--primary)', outlineOffset: -2 }
    : {}
  const pasteTargetStyle = pasteMode && !slot?.is_anchor
    ? { cursor: 'crosshair' }
    : {}

  return (
    <td
      ref={setRef}
      style={{
        ...cellTd,
        cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        ...selectionOutline,
        ...pasteTargetStyle,
        ...(isMultiSelected ? S.cellMultiSelectedFill : {}),
      }}
      rowSpan={rowSpan}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onPointerEnter={() => setCellHovered(true)}
      onPointerLeave={() => setCellHovered(false)}
      title={tooltipText}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
    >
      <div style={{
        ...innerStyle,
        ...(pasteMode && cellHovered && !slot?.is_anchor ? { border: '2px dashed var(--primary)', background: 'color-mix(in srgb, var(--primary) 12%, transparent)' } : {}),
        transform: pressed ? 'scale(0.97)' : 'scale(1)',
        transition: 'transform 0.1s ease',
      }}>
        {/* Amber corner triangle for locked cells */}
        {isLocked && (
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: 0, height: 0,
            borderTop: '12px solid var(--accent)',
            borderLeft: '12px solid transparent',
          }} />
        )}
        {/* Merge-down button (T4) */}
        {cellHovered && hasMergeDown && !isMerged && (
          <button
            style={S.cellActionBtn}
            title="Merge with block below"
            onClick={e => { e.stopPropagation(); onMergeDown?.() }}
          >↕</button>
        )}
        {/* Split button (T4) */}
        {cellHovered && isMerged && (
          <button
            style={{
              ...S.cellActionBtn,
              ...(splitHovered ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
            }}
            title="Split merged block"
            onClick={e => { e.stopPropagation(); onSplitSlot?.() }}
            onPointerEnter={() => setSplitHovered(true)}
            onPointerLeave={() => setSplitHovered(false)}
          >↕</button>
        )}
        <div style={{
          fontSize: 12,
          fontWeight: activity ? 700 : 500,
          color: isLocked ? 'color-mix(in srgb, var(--accent) 60%, var(--text))' : (activity ? color : 'var(--text-secondary)'),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activity?.name || <span style={{ fontSize: 11 }}>Unassigned</span>}
        </div>
        {hasFlags && !isLocked && (
          <div style={{ display: 'flex', gap: 2, marginTop: 4, flexWrap: 'wrap' }}>
            {activeFlags.map(f => (
              <span
                key={f}
                style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f], display: 'inline-block' }}
                title={flags[`${f}_reason`] || f}
              />
            ))}
          </div>
        )}
        {showExpandHandle && (
          <ExpandHandle
            groupId={slot.groupId}
            dayId={slot.dayId}
            blockId={slot.blockId}
            activityId={slot.activity_id}
            cellHovered={cellHovered}
          />
        )}
      </div>
    </td>
  )
}
