// T250 — the Final state of a persisted elective run: read-only identity,
// export, and "start a revision". A finalized run is immutable and there is no
// reopen (ADR 2026-09-23, Q1/Q2), so nothing on this screen writes to it.
//
// THE BINDING CONDITION THIS FILE CARRIES. The owner accepted the immutability
// ruling AS A PACKAGE with `finalizedAgainstStaleGeneration` being RENDERED to
// the director (T250's ticket, "Owner ruling, 2026-09-23"). T244 computes it;
// if nothing showed it, the ruling would stand on one leg and the question
// returns to the owner. It renders below, inline in the run's own run-state
// area — not through the schedule findings vocabulary, which is week-scoped and
// has no run-level row (ADR "Amendment (2026-09-24)") — and it renders PAIRED
// with the START_REVISION_LABEL control, because that action is the remedy.
import { useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { buildChildScheduleExport } from '../export/exportChildSchedule.js'
import { S, RunStateArea, RunStateRow, RunIdentity, RunError } from './RunStateRows.jsx'
import { useRunState } from './useRunState.js'
import {
  START_REVISION_LABEL, STALE_GENERATION_COPY, occurrenceLabel, overCapacityMessage,
} from './runStateCopy.js'

const styles = {
  actions: { display: 'flex', gap: 10, marginTop: 4 },
  // The pairing: the state, then its remedy, with nothing between them.
  pairing: { marginBottom: 16 },
  pairingAction: {
    border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
    borderTop: 'none',
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
    background: 'color-mix(in srgb, var(--accent) 12%, var(--surface))',
    padding: '0 14px 10px',
  },
}

export default function FinalRunView({
  run, campers = [], onStartRevision, onBack,
  activities = [], days = [], timeBlocks = [], groups = [], occurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [],
}) {
  const { state, loadError } = useRunState(run.id)
  const [error, setError] = useState(null)

  async function exportChildSchedules() {
    setError(null)
    try {
      const out = await localClient.getElectiveRunOuterSchedule({ runId: run.id })
      const data = buildChildScheduleExport({
        run, campers, groups, days, timeBlocks, outerRows: out?.rows ?? [],
      })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `child-schedules-${run.id}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(describeWriteFailure(err, 'That export could not be produced.'))
    }
  }

  const startRevision = (
    <button className="press-97" style={S.btnSecondary} onClick={() => onStartRevision?.(run)}>
      {START_REVISION_LABEL}
    </button>
  )

  const stale = state.finalizedAgainstStaleGeneration === true
  const overCapacityRows = state.overCapacityOccurrences

  const stateRows = [
    stale ? (
      <div key="stale" data-testid="run-state-stale-pairing" style={styles.pairing}>
        <RunStateRow testId="run-state-stale-generation" message={STALE_GENERATION_COPY} first />
        <div style={styles.pairingAction}>{startRevision}</div>
      </div>
    ) : null,
    ...overCapacityRows.map((o, i) => (
      <RunStateRow
        key={`oc-${o.occurrenceId}-${o.activityId}`}
        testId={`run-state-over-capacity-${o.occurrenceId}-${o.activityId}`}
        first={i === 0}
        last={i === overCapacityRows.length - 1}
        message={overCapacityMessage({
          label: occurrenceLabel({ ...o, activities, occurrences, days, timeBlocks }),
          filled: o.filled,
          capacity: o.capacity,
        })}
      />
    )),
  ]

  return (
    <div>
      {onBack ? <button className="press-97" style={{ ...S.btnUtility, marginBottom: 12 }} onClick={onBack}>Back to Runs</button> : null}
      <RunIdentity run={run} scheduleTemplates={scheduleTemplates} scheduleWeeks={scheduleWeeks} tiers={tiers} />
      <RunError message={error ?? loadError} />

      <RunStateArea>{stateRows}</RunStateArea>

      <div style={styles.actions}>
        <button className="press-97" style={S.btnSecondary} onClick={exportChildSchedules}>Export</button>
        {/* One control per screen: when the stale row is showing, the button
            lives inside that pairing instead, never duplicated. */}
        {stale ? null : startRevision}
      </div>
    </div>
  )
}
