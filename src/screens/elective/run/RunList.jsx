// T250 — the list of this camp's persisted elective runs, so a director can
// return to one. Before this, closing the screen lost the run: it stayed in the
// db but nothing re-displayed it.
import { useEffect, useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { S, RunError } from './RunStateRows.jsx'

const styles = {
  wrap: { marginBottom: 16 },
  // T296 consolidated this row and its trailing detail into S.listRow /
  // S.listRowMeta — CamperWeekPanel needed the identical shape, and a second
  // copy of it had already drifted.
  name: { fontWeight: 600, fontSize: 13 },
  status: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' },
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
          style={S.listRow}
          onClick={() => onOpen?.(run)}
        >
          <span style={styles.name}>{run.name}</span>
          <span style={styles.status}>{run.status === 'final' ? 'Final' : 'Draft'}</span>
          {run.source_filename ? <span style={S.listRowMeta}>{run.source_filename}</span> : null}
        </button>
      ))}
    </div>
  )
}
