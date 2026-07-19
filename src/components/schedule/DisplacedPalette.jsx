import { useDraggable } from '@dnd-kit/core'

const COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']

function DisplacedItem({ item, onDismiss }) {
  const { activityId, activityName, fromBlockName, dayLabel, colorIdx } = item
  const color = COLORS[colorIdx % COLORS.length]

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `displaced-${activityId}-${fromBlockName}`,
    data: { paletteActivity: { id: activityId, colorIdx } },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderRadius: 7,
        border: `1.5px solid ${color}55`,
        background: isDragging ? `${color}22` : `${color}11`,
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.6 : 1,
        userSelect: 'none',
        touchAction: 'none',
        position: 'relative',
      }}
    >
      <span style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-condensed)',
          fontWeight: 700,
          fontSize: 12,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activityName}
        </div>
        <div style={{
          fontFamily: 'var(--font-condensed)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          marginTop: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          displaced from {fromBlockName} · {dayLabel}
        </div>
      </div>
      <button
        onClick={e => {
          e.stopPropagation()
          onDismiss(activityId, fromBlockName)
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          fontSize: 14,
          lineHeight: 1,
          padding: '0 2px',
          flexShrink: 0,
          fontFamily: 'inherit',
        }}
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

export default function DisplacedPalette({ displacedItems, onDismiss }) {
  if (!displacedItems || displacedItems.length === 0) return null

  return (
    <div style={{
      position: 'fixed',
      right: 16,
      top: 120,
      width: 220,
      background: 'var(--surface-elevated)',
      border: '1.5px solid var(--border)',
      borderRadius: 10,
      padding: '10px 12px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.13)',
      zIndex: 200,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
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
      }}>
        Displaced Activities
      </div>
      {displacedItems.map((item, idx) => (
        <DisplacedItem
          key={`${item.activityId}-${item.fromBlockName}-${idx}`}
          item={item}
          onDismiss={onDismiss}
        />
      ))}
      <div style={{
        fontFamily: 'var(--font-condensed)',
        fontSize: 10,
        color: 'var(--text-secondary)',
        marginTop: 2,
      }}>
        Drag onto an empty cell or × to dismiss
      </div>
    </div>
  )
}
