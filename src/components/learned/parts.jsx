import { useState } from 'react'
import { flagStyle } from './learnedStyles.js'

// Spec 6: hover only where there is a real pointer.
let HOVER_OK = false
try { HOVER_OK = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) } catch { HOVER_OK = false }

export function Flag({ tone, children, title }) {
  return <span style={flagStyle(tone)} title={title}>{children}</span>
}

const INK = { primary: 'var(--primary)', danger: 'var(--danger)', secondary: 'var(--text-secondary)' }

// A quiet link-button (spec 0.5) with the async feedback of 0.3: pressed (the .press-97 class, which
// index.css already drops under reduced motion), then a present-participle label in place, heavier
// weight, aria-busy. The text and weight change is the feedback that survives reduced motion.
export function LinkButton({ tone = 'primary', busy = false, busyLabel, minWidth, onClick, children, ...rest }) {
  const [hover, setHover] = useState(false)
  const ink = INK[tone] ?? INK.primary
  return (
    <button
      type="button"
      className="press-97"
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      onMouseEnter={() => HOVER_OK && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none', background: hover && !busy ? `color-mix(in srgb, ${ink} 8%, transparent)` : 'none',
        padding: '4px 6px', fontFamily: 'inherit', fontSize: 12, fontWeight: busy ? 600 : 500, color: ink,
        cursor: busy ? 'wait' : 'pointer', pointerEvents: busy ? 'none' : 'auto', borderRadius: 6, minWidth,
        transition: 'background var(--motion-fast) var(--ease-out)',
      }}
      {...rest}
    >
      {busy ? (busyLabel ?? children) : children}
    </button>
  )
}

// A write that failed, on the row that failed (spec 0.4). "Try again" re-fires the same action.
export function FailureFlag({ message, onRetry }) {
  return (
    <div role="alert" style={{ marginTop: 6 }}>
      <span style={flagStyle('danger')}>
        {message}
        {onRetry && (
          <>
            {' '}
            <button
              type="button"
              onClick={onRetry}
              style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'var(--primary)', textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}
            >
              Try again
            </button>
          </>
        )}
      </span>
    </div>
  )
}
