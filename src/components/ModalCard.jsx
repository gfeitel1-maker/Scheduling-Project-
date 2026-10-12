import { useLayoutEffect, useRef } from 'react'
import { useModalA11y } from '../hooks/useModalA11y'
import { useEnterTransition } from '../styles/shared'

// useModalA11y as a card element, for a dialog rendered inline inside a larger component (where the
// hook cannot be called conditionally). Mark the safe action with data-autofocus.
//
// Motion (design audit 2026-10-12 #6): the card lifts in (liftFade); the dialog's scrim only fades
// (useEnterTransition('fade') on the overlay). Pass enter={false} for a card that animates itself.
// On close, a static snapshot of the overlay fades out over --motion-fast, so a dialog leaves instead
// of vanishing in one frame. Parents keep unmounting the dialog at once; nothing waits on the fade.
export default function ModalCard({ onCancel, initialFocusRef, enter = true, style, children, ...rest }) {
  const a11y = useModalA11y({ onCancel, initialFocusRef })
  const lift = useEnterTransition('liftFade')
  useExitSnapshot(a11y.ref)
  return <div {...rest} {...a11y} style={enter ? { ...style, ...lift } : style}>{children}</div>
}

function useExitSnapshot(cardRef) {
  const overlayRef = useRef(null)
  const isScrimRef = useRef(false)
  useLayoutEffect(() => {
    // The scrim is the card's parent when it is a fixed full-screen overlay; otherwise the card alone.
    const card = cardRef.current
    const parent = card?.parentElement
    isScrimRef.current = Boolean(parent && getComputedStyle(parent).position === 'fixed')
    overlayRef.current = isScrimRef.current ? parent : card
    return () => {
      // Runs before React removes the nodes, so the overlay can still be copied.
      const node = overlayRef.current
      if (!node || !node.isConnected || typeof document === 'undefined') return
      const rect = isScrimRef.current ? null : node.getBoundingClientRect()
      const ghost = node.cloneNode(true)
      // After React's commit: a scrim that is still in the page was only re-keyed or had its card
      // swapped (ImportModal's steps, DeleteWeekDialog's loading card), so there is no exit to show.
      queueMicrotask(() => {
        if (node.isConnected) return
        // A closed shadow root keeps the copy's text out of page queries and the accessibility tree;
        // inline styles and inherited custom properties still render inside it.
        const host = document.createElement('div')
        host.setAttribute('aria-hidden', 'true')
        host.setAttribute('data-exit-snapshot', '')
        Object.assign(host.style, { position: 'fixed', zIndex: 1000, pointerEvents: 'none', transition: 'opacity var(--motion-fast) var(--ease-out)' })
        Object.assign(host.style, rect ? { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px` } : { inset: 0 })
        host.attachShadow({ mode: 'closed' }).appendChild(ghost)
        document.body.appendChild(host)
        requestAnimationFrame(() => { host.style.opacity = '0' })
        const remove = () => host.remove()
        host.addEventListener('transitionend', remove, { once: true })
        setTimeout(remove, 400) // also when no transition runs (jsdom, a hidden tab)
      })
    }
  }, [cardRef])
}
