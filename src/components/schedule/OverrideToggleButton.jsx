// T108 Phase 2 (Designer spec §1.2) — the "Override this day" entry control.
// Same visual family as .cell-action (reused verbatim, not reinvented): a
// 16x16 outline-pencil icon button. Used in three places: the day-column
// header (group/manual views), and the toolbar (day view) — one component so
// all three read as the same control.
import { PencilIcon } from '../icons'

export default function OverrideToggleButton({ active, onClick, showLabel = false }) {
  return (
    <button
      type="button"
      className="cell-action"
      aria-pressed={active}
      aria-label="Override this day"
      title="Override this day"
      onClick={e => { e.stopPropagation(); onClick?.() }}
      style={showLabel ? { position: 'static', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', opacity: active ? 1 : 0.55, color: active ? 'var(--primary)' : undefined } : undefined}
    >
      <PencilIcon />
      {showLabel && <span style={{ fontSize: 12 }}>Override this day</span>}
    </button>
  )
}
