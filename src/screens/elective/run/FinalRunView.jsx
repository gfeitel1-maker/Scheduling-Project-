// T250 — the Final state of a persisted elective run: read-only identity,
// export, and "start a new version". A finalized run is immutable and there is no
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
import { useEnterTransition } from '../../../styles/shared'
import { buildChildScheduleExport } from '../export/exportChildSchedule.js'
import { buildElectiveRunProjectionExport } from '../export/exportElectiveRunProjection.js'
import { exportElectiveRunWorkbookFile } from '../export/exportElectiveRunWorkbook.js'
import { S, RunStateArea, RunStateRow, RunIdentity, RunError } from './RunStateRows.jsx'
import { useRunState } from './useRunState.js'
import CamperWeekPanel from './CamperWeekPanel.jsx'
import DeleteRunDialog from './DeleteRunDialog.jsx'
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
  activities = [], days = [], timeBlocks = [], groups = [], templateOccurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [],
  // T250 A1 — true ONLY for the in-session Finalize -> Final transition
  // (AssignmentPanel sets it after a successful finalizeRun call and clears
  // it on any other mount). A Final run opened cold from the run list must
  // render at rest, per T250 round 2 FIX 4's standing rule — the hook is
  // always called (rules of hooks) but its style is applied only here.
  justFinalized = false,
}) {
  const { state, loaded, loadError } = useRunState(run.id)
  const enter = useEnterTransition('liftFade')
  const [error, setError] = useState(null)
  // T250 A4 — a final run is deletable (D10 rules on editing an immutable
  // run's content, not on removing the run itself).
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
        run, campers, groups, days, timeBlocks, occurrences: templateOccurrences,
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
          // T318 (b) — the run's own persisted occurrences (state.occurrences),
          // never templateOccurrences: this row names a period the run already
          // placed people in, and templateOccurrences is empty for a run opened
          // cold from the run list. This screen has no move dropdown, so there
          // is only the one labeller to get right (contrast DraftRunView, which
          // keeps templateOccurrences for its move-TO dropdown).
          label: occurrenceLabel({ ...o, activities, occurrences: state.occurrences, days, timeBlocks }),
          filled: o.filled,
          capacity: o.capacity,
        })}
      />
    )),
  ]

  return (
    <div data-testid="final-run-view" style={justFinalized ? enter : undefined}>
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

          {/* T296 — the camper-centric read of the same rows, so a finalized
              run answers "what did this child get" without exporting the
              workbook. Below the export actions on purpose: those are what a
              director came here to do, and this is what they came here to
              check. */}
          {/* state.occurrences, never templateOccurrences — CamperWeekPanel's
              header says why. */}
          {/* T318 — preferences (read-only, no onSetPreference/onRemovePreference
              here — a finalized run is immutable) so rankLabel can tell a
              genuinely ordered choice from one it has no evidence for. Omitting
              this would not be a safe default, it would be a WRONG one: the
              rank_kind join comes back empty regardless of what the database
              actually holds, and every entry reads as "One of their choices"
              even when the camper's sheet really was ordered. */}
          <CamperWeekPanel
            rows={state.rows}
            occurrences={state.occurrences}
            activities={activities}
            days={days}
            timeBlocks={timeBlocks}
            preferences={state.preferences}
            campers={state.campers}
          />

          {/* T250 A4 — a quiet text-only trigger at the bottom, well
              separated from the export/revision actions above. */}
          <button
            className="press-97"
            style={{ ...S.btnUtility, marginTop: 20 }}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete run
          </button>
          {confirmingDelete ? (
            <DeleteRunDialog
              run={run}
              camperCount={(state.campers ?? []).length}
              placementCount={state.rows.length}
              onCancel={() => setConfirmingDelete(false)}
              onDeleted={() => onBack?.()}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
