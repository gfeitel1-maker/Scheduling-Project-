import { useEffect, useRef } from 'react'
import { S, useEnterTransition } from '../../styles/shared'

// Shared import overlay for the Roots setup screens. Previously each screen
// hand-rolled this ~50-line block; here it also gains focus management the
// per-screen copies lacked (focus-trap + Escape + initial focus).
export default function ImportModal({
  step, title, width = 520, columns, rows, readyCount, warnCount, result,
  importing, onConfirm, onCancel, renderCell,
  previewSubtitle, confirmLabel, doneSkippedSuffix, doneExtra,
}) {
  const dialogRef = useRef(null)
  const primaryRef = useRef(null)
  const enterStyle = useEnterTransition('liftFade')

  // Host screens pass an inline onCancel, so a new function identity arrives
  // on every re-render (e.g. `importing` toggling during confirm). Reading it
  // through a ref lets the effect below depend on [step] only — it must run
  // once per open, not once per host render, or focus gets yanked back to the
  // primary button mid-interaction.
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel })

  useEffect(() => {
    if (!step) return
    const prevFocus = document.activeElement
    // Initial focus lands on the primary action.
    primaryRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') { onCancelRef.current(); return }
      if (e.key !== 'Tab') return
      // Focus-trap: keep Tab within the dialog.
      const focusables = dialogRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prevFocus?.focus?.()
    }
  }, [step])

  if (!step) return null

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}
        style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width, maxHeight: '80vh', overflow: 'auto' }}>
        {step === 'preview' && (
          <>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
              {previewSubtitle ?? (
                <>{readyCount} ready{warnCount > 0 && `, ${warnCount} with warnings`}</>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                {columns.map(c => <th key={c.key} style={S.th}>{c.label}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ ...(r.warning ? S.importWarnRow : null), borderBottom: '1px solid var(--border)' }}>
                    {columns.map(c => (
                      <td key={c.key} style={{ ...S.td, ...(c.mono ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : null) }}>
                        {renderCell(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="press-97" onClick={onCancel} style={S.btnSecondary}>Cancel</button>
              <button ref={primaryRef} className="press-97" onClick={onConfirm} disabled={importing || readyCount === 0} style={S.btnPrimary}>
                {importing ? 'Importing…' : (confirmLabel ?? `Import ${readyCount}`)}
              </button>
            </div>
          </>
        )}
        {step === 'done' && (
          <>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>{title}</div>
            <div style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--success)', fontWeight: 600 }}>{result?.added ?? 0} added</span>
              {result?.skipped > 0 && (
                <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{result.skipped} skipped{doneSkippedSuffix ?? ''}</span>
              )}
              {doneExtra}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button ref={primaryRef} className="press-97" onClick={onCancel} style={S.btnPrimary}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
