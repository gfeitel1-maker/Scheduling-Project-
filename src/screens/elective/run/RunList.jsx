// T250 — the list of this camp's persisted elective runs, so a director can
// return to one. Before this, closing the screen lost the run: it stayed in the
// db but nothing re-displayed it.
import { useEffect, useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { S, RunError } from './RunStateRows.jsx'

const styles = {
  wrap: { marginBottom: 16 },
  row: { display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', marginBottom: 6, cursor: 'pointer' },
  name: { fontWeight: 600, fontSize: 13 },
  status: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' },
  source: { fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto' },
}

export default function RunList({ onOpen }) {
  const [runs, setRuns] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const out = await localClient.listElectiveRuns()
        if (!cancelled) setRuns(out ?? [])
      } catch (err) {
        if (!cancelled) setError(describeWriteFailure(err, 'The list of runs could not be read.'))
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (error) return <RunError message={error} />
  if (runs.length === 0) return null

  return (
    <div style={styles.wrap}>
      <div style={S.label}>Saved runs</div>
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          className="press-97"
          data-testid={`run-list-row-${run.id}`}
          style={styles.row}
          onClick={() => onOpen?.(run)}
        >
          <span style={styles.name}>{run.name}</span>
          <span style={styles.status}>{run.status === 'final' ? 'Final' : 'Draft'}</span>
          {run.source_filename ? <span style={styles.source}>{run.source_filename}</span> : null}
        </button>
      ))}
    </div>
  )
}
