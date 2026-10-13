import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import ConfirmDangerDialog from './ConfirmDangerDialog'

// "Undo last import" on Roots (director test 2026-10-12, blocker). The import screen's undo lasted a few
// minutes and then vanished without a word, so a director who came back later could not undo. The last
// import's undo is now kept on this device until the next import replaces it; this names it and offers it.
// A late undo is safe: undo re-checks every row and keeps anything edited since the import.

function when(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return `today ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

export default function LastImportUndo({ onUndone }) {
  const [last, setLast] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    localClient.lastImportUndo?.().then((v) => { if (live) setLast(v ?? null) }).catch(() => { if (live) setLast(null) })
    return () => { live = false }
  }, [])

  async function undo() {
    setBusy(true)
    setError(null)
    try {
      const res = await localClient.ingestUndo({ importRunId: last.importRunId, client_write_id: crypto.randomUUID() })
      const kept = Array.isArray(res?.kept) ? res.kept.length : 0
      setResult(kept > 0
        ? `Import undone. ${kept} ${kept === 1 ? 'thing' : 'things'} you changed after importing ${kept === 1 ? 'was' : 'were'} kept.`
        : 'Import undone.')
      setLast(null)
      onUndone?.()
    } catch (err) {
      setError(describeWriteFailure(err, 'That import could not be undone.'))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (result) return <div role="status" style={styles.card}>{result}</div>
  if (!last) return null
  const file = last.fileName || 'your file'
  return (
    <div style={styles.card}>
      <div>
        <div style={styles.title}>Last import: {file}{last.committedAt ? `, ${when(last.committedAt)}` : ''}</div>
        <div style={styles.body}>Undo removes what this import added and puts back what it changed. Anything you have edited since stays as it is.</div>
        {error && <div style={{ ...S.errorBanner, marginTop: 8, marginBottom: 0 }}>{error}</div>}
      </div>
      <button className="press-97" onClick={() => setConfirming(true)} style={{ ...S.btnSecondary, whiteSpace: 'nowrap' }}>Undo last import</button>
      {confirming && (
        <ConfirmDangerDialog
          title={`Undo the import of ${file}?`}
          body="What this import added is removed, and what it changed goes back to how it was."
          recovery="Anything you have edited since the import stays as it is."
          confirmLabel="Undo import"
          busy={busy}
          onConfirm={undo}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

const styles = {
  card: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
    padding: '12px 16px', marginTop: 'var(--space-4)', fontSize: 13, color: 'var(--text)',
  },
  title: { fontWeight: 600, marginBottom: 2 },
  body: { color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 },
}
