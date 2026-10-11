import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../styles/shared'

// Spec 6 Accordion / Collapse. A grid-row transition (0fr to 1fr) so content that grows while open
// (Show 25 more) is never clipped. Content unmounts once closed. Reduced motion: instant.
export default function Collapse({ open, ms = 340, children, id }) {
  const reduced = prefersReducedMotion()
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      const a = setTimeout(() => setMounted(true), 0)
      const b = setTimeout(() => setShown(true), reduced ? 0 : 20)
      return () => { clearTimeout(a); clearTimeout(b) }
    }
    const a = setTimeout(() => setShown(false), 0)
    const b = setTimeout(() => setMounted(false), reduced ? 0 : ms)
    return () => { clearTimeout(a); clearTimeout(b) }
  }, [open, ms, reduced])
  if (!mounted) return null
  return (
    <div
      id={id}
      style={{
        display: 'grid', gridTemplateRows: shown ? '1fr' : '0fr', opacity: shown ? 1 : 0,
        transition: reduced ? 'none' : `grid-template-rows ${ms}ms var(--ease-out), opacity var(--motion-base) var(--ease-out)`,
      }}
    >
      <div style={{ overflow: 'hidden', minHeight: 0 }}>{children}</div>
    </div>
  )
}
