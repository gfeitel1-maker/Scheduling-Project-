import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { SearchIcon } from '../icons'
import { isActivityEligibleForGroup } from '../../engine/eligibility'

function DraggablePaletteItem({ activity, scheduledCount, target, cap, atMax, draggable }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${activity.id}`,
    data: { paletteActivity: { id: activity.id } },
    disabled: atMax || !draggable,
  })

  const range = target > 0 ? `${target}\u2013${cap ?? '\u221e'}` : `${cap ?? '\u221e'}`

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
        // T52 follow-up (owner, 2026-09-12): the chip carries no activity
        // colour. Frequency is already stated as a number beside the name
        // (`2 / 3–5 wk`), so colouring the chip by the same fact was redundant —
        // it read as noise rather than signal. Neutral chrome; the only
        // colour left is state (at-max, dragging).
        border: '1.5px solid var(--border)',
        background: isDragging ? 'var(--surface-elevated)' : 'var(--surface)',
        cursor: !draggable ? 'default' : atMax ? 'not-allowed' : isDragging ? 'grabbing' : 'grab',
        opacity: atMax ? 0.45 : isDragging ? 0.6 : 1,
        userSelect: 'none',
        touchAction: draggable ? 'none' : undefined,
        transition: 'opacity var(--motion-fast) var(--ease-out)',
      }}
    >
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
      </span>
      <span data-testid={`palette-count-${activity.id}`} style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: atMax ? 'var(--danger)' : 'var(--text-secondary)',
        flexShrink: 0,
      }}>
        {scheduledCount} / {range} wk
      </span>
    </div>
  )
}

// Audit-2 A9: a reusable elective set as a rail chip. Dropped on a cell it
// places the set there (dragHandlers.js, `paletteElective`). Its count is the
// cells of the week it holds; a set has no weekly target to measure against.
function DraggableElectiveItem({ set, count, draggable }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-elective-${set.id}`,
    data: { paletteElective: { id: set.id, name: set.name } },
    disabled: !draggable,
  })
  return (
    <div
      ref={setNodeRef}
      data-palette-elective={set.id}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1.5px solid color-mix(in srgb, var(--secondary) 35%, var(--border))',
        background: isDragging ? 'var(--surface-elevated)' : 'var(--surface)',
        cursor: !draggable ? 'default' : isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.6 : 1,
        userSelect: 'none',
        touchAction: draggable ? 'none' : undefined,
        transition: 'opacity var(--motion-fast) var(--ease-out)',
      }}
    >
      <span title={set.name} style={{
        flex: 1,
        minWidth: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>{set.name}</span>
      <span data-testid={`palette-elective-count-${set.id}`} style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--text-secondary)',
        flexShrink: 0,
      }}>{count} wk</span>
    </div>
  )
}

// slots: the whole week. groupId scopes the count to one group; null counts
// the camp, against each weekly bound multiplied by the number of groups
// eligible for that activity (the engine's UNDERSERVED scope). A span counts
// once, at its head.
// draggable: whether chips can be dragged (false in non-manual views)
// collapsed / onToggleCollapse: sidebar collapse state
export default function ActivityPalette({
  activities,
  slots,
  groupId = null,
  groups = [],
  electiveSets = [],
  draggable = true,
  collapsed = false,
  onToggleCollapse,
}) {
  const nonFixedEventSlots = (slots || [])
    .filter(s => !s.is_fixed_event && s.is_span_head !== 0 && s.is_span_head !== false)
    .filter(s => groupId == null || s.group_id === groupId)
  const scaleFor = activity => groupId == null
    ? groups.filter(g => isActivityEligibleForGroup(activity, g)).length
    : 1
  const [filter, setFilter] = useState('')
  const durableSets = electiveSets.filter(s => Number(s.is_reusable) !== 0)

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
          title="Expand"
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
      {/* Audit E3 (2026-10-10) — the sets come FIRST. A camp has a handful of sets
          and up to dozens of activities; at the bottom of this 70vh scroller the sets
          were off-screen with 18 activities. Top rather than sticky: a sticky block
          would permanently cover activity rows in a narrow rail, and a short list of
          sets costs only a few rows above the activities. */}
      {durableSets.length > 0 && (
        <div data-testid="palette-zone-electives" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6, paddingBottom: 8, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={SECTION_LABEL}>Elective sets</span>
          {durableSets.map(set => (
            <DraggableElectiveItem
              key={set.id}
              set={set}
              count={nonFixedEventSlots.filter(s => s.elective_set_id === set.id).length}
              draggable={draggable}
            />
          ))}
        </div>
      )}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
        paddingBottom: 6,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={SECTION_LABEL}>Activities</span>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            title="Collapse"
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
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
              display: 'flex',
            }}><SearchIcon /></span>
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
            nonFixedEventSlots={nonFixedEventSlots}
            draggable={draggable}
            scaleFor={scaleFor}
          />
        </>
      )}
    </div>
  )
}

function PaletteLedger({ activities, filter, nonFixedEventSlots, draggable, scaleFor }) {
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
    const scheduledCount = nonFixedEventSlots.filter(s => s.activity_id === activity.id).length
    const scale = scaleFor(activity)
    const target = (activity.min_per_week ?? 0) * scale
    const cap = activity.max_per_week == null ? null : activity.max_per_week * scale
    return {
      activity,
      scheduledCount,
      target,
      cap,
      atMax: cap != null && scheduledCount >= cap,
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
          {stillNeeded.map(({ activity, scheduledCount, target, cap, atMax }) => (
            <DraggablePaletteItem
              key={activity.id}
              activity={activity}
              scheduledCount={scheduledCount}
              target={target}
              cap={cap}
              atMax={atMax}
              draggable={draggable}
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
          {placed.map(({ activity, scheduledCount, target, cap, atMax }) => (
            <DraggablePaletteItem
              key={activity.id}
              activity={activity}
              scheduledCount={scheduledCount}
              target={target}
              cap={cap}
              atMax={atMax}
              draggable={draggable}
            />
          ))}
        </div>
      )}
    </>
  )
}

const SECTION_LABEL = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 11,
  color: 'var(--text-secondary)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}
