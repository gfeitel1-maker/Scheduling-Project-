import { useEffect, useRef } from 'react'
import { S, useEnterTransition } from '../styles/shared'

// Shared presentational danger-confirmation modal for delete-all and other
// destructive confirms that have no backend preview contract (unlike
// DeleteRecordDialog, which is driven by localClient.previewDelete). Six-part
// chrome matches DeleteRecordDialog and the per-screen single-delete clones
// exactly, so every delete confirmation in the app reads as one pattern. See
// docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md.
//
// Errors from a failed delete surface on the CALLING screen's own banner
// (matching the old window.confirm-era behavior, where the browser dialog
// was already dismissed before the delete ran) — this dialog has no error
// prop and does not attempt to show one inline.
export default function ConfirmDangerDialog({ title, body, recovery, confirmLabel, busy, onConfirm, onCancel }) {
  const enterStyle = useEnterTransition('liftFade')
  // Defeats a fast double-click firing onConfirm twice before the caller's
  // `busy` prop has propagated through a render — every deleteAll flow only
  // disables the button via `busy`, which is one render late. Resets once
  // `busy` returns to false so a failed delete can still be retried.
  const firedRef = useRef(false)

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  useEffect(() => {
    if (!busy) firedRef.current = false
  }, [busy])

  function handleConfirm() {
    if (firedRef.current) return
    firedRef.current = true
    onConfirm()
  }

  return (
    <div style={{ ...overlay, ...enterStyle }} onClick={() => !busy && onCancel()}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={titleStyle}>{title}</div>
        {body && <p style={bodyStyle}>{body}</p>}
        {recovery && <div style={recoveryStyle}>{recovery}</div>}
        <div style={actions}>
          <button className="press-97" onClick={onCancel} disabled={busy} style={S.btnSecondary}>Cancel</button>
          <button onClick={handleConfirm} disabled={busy} style={S.btnDanger}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const panel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 520,
  maxWidth: '100%',
}

const titleStyle = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 14,
}

const bodyStyle = { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px' }

const recoveryStyle = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const actions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 22,
}
