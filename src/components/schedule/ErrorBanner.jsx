import { useEffect, useRef, useState } from 'react'
import { S, useEnterTransition, prefersReducedMotion } from '../../styles/shared'

// The shared enter-transition implementation the spec called for (§ SPEC 1) —
// keyed to THIS component's mount, not ScheduleScreen's, so it actually plays
// for banners that mount after the screen (errors, week-deleted).
export default function ErrorBanner({ children, onDismiss, style }) {
  const enter = useEnterTransition('slideFade')
  const [dismissing, setDismissing] = useState(false)
  const dismissTimeoutRef = useRef(null)
  useEffect(() => () => clearTimeout(dismissTimeoutRef.current), [])

  const handleDismiss = () => {
    if (prefersReducedMotion()) {
      onDismiss()
      return
    }
    setDismissing(true)
    dismissTimeoutRef.current = setTimeout(() => {
      onDismiss()
    }, 140)
  }

  // Spread order is deliberate: `style` is for layout only and must not be able
  // to clobber the enter/dismiss motion, so the motion fragments come last.
  return (
    <div style={{ ...S.errorBanner, ...style, ...enter, ...(dismissing ? { opacity: 0, transition: 'opacity var(--motion-fast) var(--ease-out)' } : {}) }}>
      {children}
      {onDismiss && (
        <button onClick={handleDismiss} type="button" aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 16, lineHeight: 1 }}>×</button>
      )}
    </div>
  )
}
