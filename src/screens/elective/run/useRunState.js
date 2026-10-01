// T250 — one load of a persisted run's state, shared by the Draft and Final
// screens. getElectiveRun (T244) is the single source for all four facts these
// screens render: the assignment rows, the stale-solver count, whether the run
// was finalized against a later generation, and which occurrences are over
// capacity.
//
// T296 adds a fifth: the run's own occurrence rows, which is what lets a run
// opened cold from the run list name the day and period of a placement instead
// of printing an occurrence id.
import { useCallback, useEffect, useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'

const EMPTY = {
  rows: [], staleCount: 0, finalizedAgainstStaleGeneration: false,
  overCapacityOccurrences: [], occurrences: [], preferences: [], choices: [],
  // T250 A0.2 — the run's own camper roster (with group_name resolved).
  campers: [],
  // T320 part 2 item 3 — a sheet camper with neither a preference nor an
  // assignment row, surfaced separately from eligibilityFindings; (C)(4)
  // names them in the run-state area rather than just counting them.
  sheetOnlyCampers: [],
  // T320 (docs/adr/2026-09-30-elective-run-durability.md) — durable across a
  // cold reopen, unlike the commit-response-only values this hook's own
  // callers used to hold in local React state.
  danglingFindings: [], eligibilityFindings: [], resourceConflicts: [],
  snapshotIncomplete: false, expectedSnapshotRows: null, heldSnapshotRows: null,
}

export function useRunState(runId) {
  const [state, setState] = useState(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)

  // T297 — the same read, callable again after a write. A preference edit changes
  // what the run holds, so the week has to be re-read rather than patched in
  // place: applyRow's optimistic patch is right for a placement (one known field
  // on one known row) and wrong here, because an edit can DELETE a row and add
  // another under a different id, which no local patch can reproduce faithfully.
  // ONE copy of the read, called by the mount effect and again after a write.
  // `isCurrent` is the only thing the two callers differ on: the effect must not
  // apply a result that arrived after the runId changed, while a post-write
  // reload is always current. Two copies would let a new field or a change to the
  // error copy land in one and not the other.
  const read = useCallback(async (isCurrent = () => true) => {
    try {
      const out = await localClient.getElectiveRun({ runId })
      if (!isCurrent()) return
      setState({ ...EMPTY, ...out })
      setLoaded(true)
    } catch (err) {
      if (!isCurrent()) return
      // Per the spec's "Error" state: the run-state block itself renders
      // nothing when its data isn't available, but the failure is still said
      // out loud rather than swallowed.
      setLoadError(describeWriteFailure(err, 'This run could not be read.'))
    }
  }, [runId])

  useEffect(() => {
    let cancelled = false
    // Wrapped rather than called directly: react-hooks flags a synchronous call
    // in an effect body that can reach setState ("cascading renders"), and it can
    // see through `read`. The await is what actually defers the state write.
    ;(async () => { await read(() => !cancelled) })()
    return () => { cancelled = true }
  }, [read])

  return { state, setState, loaded, loadError, reload: read }
}
