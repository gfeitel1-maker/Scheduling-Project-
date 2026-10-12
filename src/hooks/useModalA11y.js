import { useEffect, useRef } from 'react'

// Keyboard-first dialogs (design audit 2026-10-12 #2). Spread the returned props on the dialog CARD
// (not the scrim):
//
//   const cancelRef = useRef()
//   const a11y = useModalA11y({ onCancel, initialFocusRef: cancelRef })
//   <div style={S.overlay}><div {...a11y} style={...}>… <button ref={cancelRef}>Cancel</button></div></div>
//
// - role="dialog" + aria-modal, so assistive tech treats the rest of the page as inert.
// - On open, remembers what had focus and focuses `initialFocusRef` (the safe action, usually
//   Cancel), else the card's `[data-autofocus]` element, else the card itself (tabIndex -1, so it can hold focus without joining the tab order).
// - Escape calls onCancel, for the TOPMOST open dialog only (a confirm opened over another dialog
//   closes alone). Omit onCancel for a dialog that must not be dismissed (e.g. mid-operation).
// - On close, focus returns to what had it before, if that is still in the page.
const stack = []

export function useModalA11y({ onCancel, initialFocusRef } = {}) {
  const ref = useRef(null)
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel })

  useEffect(() => {
    const token = {}
    stack.push(token)
    // A field that already took focus inside the card (autoFocus) keeps it; the opener is then unknown.
    const focusedInside = ref.current?.contains(document.activeElement)
    const previous = focusedInside ? null : document.activeElement
    if (!focusedInside) (initialFocusRef?.current ?? ref.current?.querySelector('[data-autofocus]') ?? ref.current)?.focus?.()
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== token || !onCancelRef.current) return
      e.stopPropagation()
      onCancelRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      const i = stack.indexOf(token)
      if (i >= 0) stack.splice(i, 1)
      if (previous && previous !== document.body && previous.isConnected) previous.focus?.()
    }
    // Mount/unmount only: the dialog's open lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { ref, role: 'dialog', 'aria-modal': true, tabIndex: -1 }
}

