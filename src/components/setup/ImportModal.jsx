import { useEffect, useRef } from 'react'
import { S, useEnterTransition } from '../../styles/shared'
import ModalCard from '../ModalCard'

// Shared import overlay for the Roots setup screens. Previously each screen
// hand-rolled this ~50-line block; here it also gains focus management the
// per-screen copies lacked (focus-trap + Escape + initial focus).
// Every setup screen's import preview had the same `if (c.key === 'status')`
// line pasted into its renderCell — seven identical copies of one span. The
// column is not screen-specific: a row either carries a warning or it is
// ready. So the modal renders it, and a screen only writes a renderCell case
// for a column that genuinely differs.
//
// The fallback triggers on `undefined` specifically, not on any falsy value:
// a caller that deliberately returns null for a cell still gets an empty one.
function statusFallback(rendered, row, column) {
  if (rendered !== undefined || column.key !== 'status') return rendered
  return (
    <span style={row.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      {row.warning || '\u2713 Ready'}
    </span>
  )
}

export default function ImportModal({
  step, title, width = 520, columns, rows, readyCount, warnCount, result,
  importing, onConfirm, onCancel, renderCell,
  previewSubtitle, confirmLabel, confirmDisabled, doneSkippedSuffix, doneExtra,
}) {
  const dialogRef = useRef(null)
  const primaryRef = useRef(null)
  const enterStyle = useEnterTransition('fade') // the scrim fades; ModalCard lifts the card

  // Initial focus (the primary action), Escape and focus restore come from ModalCard (useModalA11y);
  // it is keyed on `step`, so moving from preview to done refocuses that step's primary button.
  // What stays here is the focus trap: Tab and Shift+Tab cycle within the dialog.
  useEffect(() => {
    if (!step) return
    function onKey(e) {
      if (e.key !== 'Tab') return
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
    return () => document.removeEventListener('keydown', onKey)
  }, [step])

  if (!step) return null

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
      <ModalCard key={step} onCancel={onCancel} initialFocusRef={primaryRef} aria-label={title}
        style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width, maxHeight: '80vh', overflow: 'auto' }}>
        <div ref={dialogRef}>
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
                        {statusFallback(renderCell(r, c), r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="press-97" onClick={onCancel} style={S.btnSecondary}>Cancel</button>
              <button ref={primaryRef} className="press-97" onClick={onConfirm} disabled={importing || readyCount === 0 || !!confirmDisabled} style={S.btnPrimary}>
                {importing ? 'Importing…' : (confirmLabel ?? `Import ${readyCount}`)}
              </button>
            </div>
          </>
        )}
        {step === 'done' && (
          <>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>{title}</div>
            <div style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--success)', fontWeight: 600 }}>{result?.added ?? 0} new</span>
              {result?.updated > 0 && (
                <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{result.updated} updated</span>
              )}
              {result?.unchanged > 0 && (
                <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{result.unchanged} unchanged</span>
              )}
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
      </ModalCard>
    </div>
  )
}
