// T250 — one load of a persisted run's state, shared by the Draft and Final
// screens. getElectiveRun (T244) is the single source for all four facts these
// screens render: the assignment rows, the stale-solver count, whether the run
// was finalized against a later generation, and which occurrences are over
// capacity.
import { useEffect, useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'

const EMPTY = { rows: [], staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [] }

export function useRunState(runId) {
  const [state, setState] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const out = await localClient.getElectiveRun({ runId })
        if (cancelled) return
        setState({ ...EMPTY, ...out })
        setLoaded(true)
      } catch (err) {
        if (cancelled) return
        // Per the spec's "Error" state: the run-state block itself renders
        // nothing when its data isn't available, but the failure is still said
        // out loud rather than swallowed.
        setLoadError(describeWriteFailure(err, 'This run could not be read.'))
      }
    })()
    return () => { cancelled = true }
  }, [runId])

  return { state, setState, loaded, loadError }
}
