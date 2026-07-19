import { useDraggable } from '@dnd-kit/core'

const COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']

function DraggablePaletteItem({ activity, colorIdx, scheduledCount, atMax }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${activity.id}`,
    data: { paletteActivity: { id: activity.id, colorIdx } },
    disabled: atMax,
  })

  const color = COLORS[colorIdx % COLORS.length]

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: `1.5px solid ${atMax ? 'var(--border)' : color}`,
        background: isDragging ? `${color}22` : atMax ? 'var(--surface)' : `${color}11`,
        cursor: atMax ? 'not-allowed' : isDragging ? 'grabbing' : 'grab',
        opacity: atMax ? 0.45 : isDragging ? 0.6 : 1,
        userSelect: 'none',
        touchAction: 'none',
        transition: 'opacity 0.15s',
      }}
    >
      <span style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text)',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>{activity.name}</span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: atMax ? '#F0585D' : 'var(--text-secondary)',
        flexShrink: 0,
      }}>
        {scheduledCount}/{activity.max_per_week ?? '∞'}
      </span>
    </div>
  )
}

export default function ActivityPalette({ activities, slots, selectedGroupId }) {
  const groupSlots = slots.filter(s => s.group_id === selectedGroupId && !s.is_anchor)

  return (
    <div style={{
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
        fontFamily: 'var(--font-condensed)',
        fontWeight: 700,
        fontSize: 11,
        color: 'var(--text-secondary)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom: 4,
        paddingBottom: 6,
        borderBottom: '1px solid var(--border)',
      }}>Activities</div>
      {activities.map((activity, i) => {
        const scheduledCount = groupSlots.filter(s => s.activity_id === activity.id).length
        const atMax = activity.max_per_week != null && scheduledCount >= activity.max_per_week
        return (
          <DraggablePaletteItem
            key={activity.id}
            activity={activity}
            colorIdx={i}
            scheduledCount={scheduledCount}
            atMax={atMax}
          />
        )
      })}
    </div>
  )
}
