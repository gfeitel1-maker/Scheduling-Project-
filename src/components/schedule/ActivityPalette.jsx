import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { activityColor } from './slotCellConstants'

function DraggablePaletteItem({ activity, scheduledCount, atMax, draggable, showTarget }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${activity.id}`,
    data: { paletteActivity: { id: activity.id } },
    disabled: atMax || !draggable,
  })

  const color = activityColor(activity.id)
  const target = activity.min_per_week ?? 0
  const met = scheduledCount >= target

  return (
    <div
      ref={setNodeRef}
      // Lets the FSM name the gesture's kind at pointer-down, before dnd-kit's
      // threshold has decided anything (T58).
      data-palette-activity={activity.id}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1.5px solid ${atMax ? 'var(--border)' : color}`,
        background: isDragging ? `${color}22` : atMax ? 'var(--surface)' : `${color}11`,
        cursor: !draggable ? 'default' : atMax ? 'not-allowed' : isDragging ? 'grabbing' : 'grab',
        opacity: atMax ? 0.45 : isDragging ? 0.6 : 1,
        userSelect: 'none',
        touchAction: draggable ? 'none' : undefined,
        transition: 'opacity var(--motion-fast) var(--ease-out)',
      }}
    >
      <span style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{activity.name}</span>
        {/* On a blank week the palette IS the to-do list. Met reads quiet, not
            celebrated — nothing here is an error, so nothing here is red. */}
        {showTarget && target > 0 && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: met ? 'color-mix(in srgb, var(--text-secondary) 55%, transparent)' : 'var(--text-secondary)',
            marginTop: 1,
          }}>{scheduledCount} of {target} this week</span>
        )}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: atMax ? 'var(--danger)' : 'var(--text-secondary)',
        flexShrink: 0,
      }}>
        {scheduledCount}/{activity.max_per_week ?? '∞'}
      </span>
    </div>
  )
}

// slots: pre-filtered by caller for the appropriate scope
// draggable: whether chips can be dragged (false in non-manual views)
// collapsed / onToggleCollapse: sidebar collapse state
export default function ActivityPalette({
  activities,
  slots,
  showTargets = false,
  draggable = true,
  collapsed = false,
  onToggleCollapse,
}) {
  const nonAnchorSlots = (slots || []).filter(s => !s.is_anchor)
  const [filter, setFilter] = useState('')

  if (collapsed) {
    return (
      <div style={{
        width: 28,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 8,
      }}>
        <button
          onClick={onToggleCollapse}
          title="Expand activity panel"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            padding: 0,
            lineHeight: 1,
          }}
        >»</button>
      </div>
    )
  }

  return (
    <div
      // Lets the drag FSM recognize a release over the palette as a distinct,
      // commit-worthy "clear the source slot" target — not just a resolved-to-
      // nothing pointer-up (drag-first-placement, 2026-08-09).
      data-activity-palette=""
      style={{
        width: 210,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingRight: 12,
        borderRight: '1px solid var(--border)',
        maxHeight: '70vh',
        overflowY: 'auto',
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
        paddingBottom: 6,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--font-condensed)',
          fontWeight: 700,
          fontSize: 11,
          color: 'var(--text-secondary)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>Activities</span>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            title="Collapse activity panel"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: 0,
              lineHeight: 1,
            }}
          >«</button>
        )}
      </div>

      {activities.length === 0 ? (
        <div style={{
          padding: '24px 0 0',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          textAlign: 'center',
          lineHeight: 1.6,
        }}>
          No activities defined.{'\n'}Go to Camp Setup to add some.
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', flexShrink: 0, marginBottom: 2 }}>
            <span style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
            }}>⌕</span>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter activities"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '5px 8px 5px 22px',
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                color: 'var(--text)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                outline: 'none',
              }}
            />
          </div>
          <PaletteLedger
            activities={activities}
            filter={filter}
            nonAnchorSlots={nonAnchorSlots}
            draggable={draggable}
            showTargets={showTargets}
          />
        </>
      )}
    </div>
  )
}

function PaletteLedger({ activities, filter, nonAnchorSlots, draggable, showTargets }) {
  const needle = filter.trim().toLowerCase()
  const matched = needle
    ? activities.filter(a => a.name.toLowerCase().includes(needle))
    : activities

  if (matched.length === 0) {
    return (
      <div style={{
        padding: '20px 0 0',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        textAlign: 'center',
      }}>
        No matches
      </div>
    )
  }

  const withCounts = matched.map(activity => {
    const scheduledCount = nonAnchorSlots.filter(s => s.activity_id === activity.id).length
    const target = activity.min_per_week ?? 0
    return {
      activity,
      scheduledCount,
      atMax: activity.max_per_week != null && scheduledCount >= activity.max_per_week,
      needed: target > 0 && scheduledCount < target,
    }
  })

  const byName = (a, b) => a.activity.name.localeCompare(b.activity.name)
  const stillNeeded = withCounts.filter(x => x.needed).sort(byName)
  const placed = withCounts.filter(x => !x.needed).sort(byName)

  return (
    <>
      {stillNeeded.length > 0 && (
        <div data-testid="palette-zone-needed" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {stillNeeded.map(({ activity, scheduledCount, atMax }) => (
            <DraggablePaletteItem
              key={activity.id}
              activity={activity}
              scheduledCount={scheduledCount}
              atMax={atMax}
              draggable={draggable}
              showTarget={showTargets}
            />
          ))}
        </div>
      )}
      {stillNeeded.length > 0 && placed.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0', flexShrink: 0 }} />
      )}
      {placed.length > 0 && (
        <div
          data-testid="palette-zone-placed"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.85 }}
        >
          {placed.map(({ activity, scheduledCount, atMax }) => (
            <DraggablePaletteItem
              key={activity.id}
              activity={activity}
              scheduledCount={scheduledCount}
              atMax={atMax}
              draggable={draggable}
              showTarget={showTargets}
            />
          ))}
        </div>
      )}
    </>
  )
}
