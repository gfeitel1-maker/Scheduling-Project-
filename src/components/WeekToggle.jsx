import { prefersReducedMotion } from '../styles/shared'

export default function WeekToggle({ on, label, onToggle }) {
  const reduced = prefersReducedMotion()
  const W = 32, H = 18, PAD = 2, KNOB = H - PAD * 2
  const knobLeft = on ? W - KNOB - PAD : PAD
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle() }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: W,
        height: H,
        borderRadius: H / 2,
        background: on ? 'var(--primary)' : 'var(--border)',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        transition: reduced ? 'none' : 'background-color 120ms ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        left: knobLeft,
        top: PAD,
        width: KNOB,
        height: KNOB,
        borderRadius: '50%',
        background: 'var(--surface-elevated)',
        transition: reduced ? 'none' : 'left 120ms ease',
      }} />
    </button>
  )
}
