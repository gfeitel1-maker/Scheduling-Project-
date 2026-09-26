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
import { buildElectiveRunProjectionExport } from '../export/exportElectiveRunProjection.js'
import { exportElectiveRunWorkbookFile } from '../export/exportElectiveRunWorkbook.js'
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
  const { state, loaded, loadError } = useRunState(run.id)
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

  // F6 (round 2): the combined JSON projection (child schedules, activity roster, exceptions,
  // summary — exportElectiveRunProjection.js) and the XLSX workbook (exportElectiveRunWorkbook.js)
  // were built and unit-tested in round 1 but wired to no caller, so the real data path never
  // exercised them. This is that caller. `state.rows`/`state.staleCount`/
  // `state.overCapacityOccurrences` are already loaded by useRunState; preferences are camp-scoped
  // (localClient.list, same pattern as ElectiveSetDetail.jsx) and filtered to this run client-side.
  async function exportFullReport() {
    setError(null)
    try {
      const [outer, allPreferences] = await Promise.all([
        localClient.getElectiveRunOuterSchedule({ runId: run.id }),
        localClient.list('elective_preferences'),
      ])
      const input = {
        run, campers, groups, days, timeBlocks, occurrences,
        outerRows: outer?.rows ?? [],
        preferences: (allPreferences ?? []).filter((p) => p.run_id === run.id),
        assignments: state.rows,
        staleCount: state.staleCount,
        capacityRows: state.overCapacityOccurrences,
        generatedAt: new Date().toISOString(),
      }
      const data = buildElectiveRunProjectionExport(input)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `elective-run-report-${run.id}.json`
      a.click()
      URL.revokeObjectURL(url)
      exportElectiveRunWorkbookFile(input, `elective-run-report-${run.id}.xlsx`)
    } catch (err) {
      setError(describeWriteFailure(err, 'That report could not be produced.'))
    }
  }

  const startRevision = (
    <button className="press-97" style={S.btnSecondary} onClick={() => onStartRevision?.(run)}>
      {START_REVISION_LABEL}
    </button>
  )

  // AN UNKNOWN IS NOT "NOT STALE". useRunState's EMPTY default carries
  // all-clear values and a thrown getElectiveRun leaves it in place, while
  // RunStateArea renders nothing when it has nothing to say — so reading
  // `state` without first establishing that the read SUCCEEDED paints an
  // unread run as a clean one, with Export and the revision action both live.
  // That is this ticket's own failure ("a detection nobody renders is
  // functionally no detection") one layer up, and it is the reason everything
  // below the identity line is gated on `loaded`, exactly as DraftRunView is.
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

      {loaded ? (
        <>
          <RunStateArea>{stateRows}</RunStateArea>

          <div style={styles.actions}>
            <button className="press-97" style={S.btnSecondary} onClick={exportChildSchedules}>Export</button>
            <button className="press-97" style={S.btnSecondary} onClick={exportFullReport}>Export Full Report</button>
            {/* One control per screen: when the stale row is showing, the button
                lives inside that pairing instead, never duplicated. */}
            {stale ? null : startRevision}
          </div>
        </>
      ) : null}
    </div>
  )
}
