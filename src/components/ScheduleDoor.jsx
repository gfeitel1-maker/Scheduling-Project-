import { prefersReducedMotion } from '../styles/shared'

// The canonical forward-to-schedule "door": a full-width, navy-tinted control
// with an animated arrow that nudges right on hover. Extracted from the Roots
// home "Schedule →" door so every forward-to-schedule hand-off shares ONE
// implementation (docs/work — Wave B3). Props: label (the door text), onClick,
// and an optional sublabel rendered under the label.
export function ScheduleDoor({ label, sublabel, onClick }) {
  return (
    <button
      className="press-97"
      onClick={onClick}
      onMouseEnter={(e) => doorHover(e, true)}
      onMouseLeave={(e) => doorHover(e, false)}
      style={styles.door}
    >
      <span>
        {label}
        {sublabel && <span style={styles.sublabel}>{sublabel}</span>}
      </span>
      <span data-arrow style={styles.arrow}>→</span>
    </button>
  )
}

function doorHover(e, on) {
  if (prefersReducedMotion()) return
  e.currentTarget.style.borderColor = on
    ? 'color-mix(in srgb, var(--primary) 40%, var(--border))'
    : 'color-mix(in srgb, var(--primary) 24%, var(--border))'
  e.currentTarget.style.transform = on ? 'translateY(-1px)' : 'none'
  const arrow = e.currentTarget.querySelector('[data-arrow]')
  if (arrow) arrow.style.transform = on ? 'translateX(var(--space-1))' : 'none'
}

const styles = {
  door: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    textAlign: 'left',
    padding: 'var(--space-4)',
    // A light navy tint weights this as the forward door, distinct from the
    // plain-surface cards around it. Resting fill/border only; press-97/hover
    // supply the motion.
    background: 'color-mix(in srgb, var(--primary) 6%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--primary) 24%, var(--border))',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text)',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-out)',
  },
  sublabel: {
    display: 'block',
    fontSize: 12.5,
    fontWeight: 400,
    color: 'var(--text-secondary)',
    marginTop: 2,
  },
  arrow: {
    display: 'inline-block',
    color: 'var(--primary)',
    fontSize: 17,
    fontWeight: 700,
    transition: 'transform var(--motion-fast) var(--ease-out)',
  },
}
