// T250 — the Draft state of a persisted elective run.
//
// Layout order is fixed by docs/work/specs/2026-09-25-t250-run-state-surface.md:
// identity line, satisfaction summary, run-state area (over-capacity rows, then
// dangling-manual-assignment rows), then the move/lock table.
//
// Mounted inside AssignmentPanel, which sits under ElectiveSetDetail. The
// admin gate is INHERITED from there (the participant entities are absent from
// permissions.js's ENTITIES, so authorize() default-denies staff) — this file
// deliberately does not re-implement a second gate, and nothing here is
// reachable from src/components/layout/navSections.js.
import { useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { S, RunStateArea, RunStateRow, RunIdentity, RunError } from './RunStateRows.jsx'
import { useRunState } from './useRunState.js'
import CamperWeekPanel from './CamperWeekPanel.jsx'
// T318 round 2 — this WRITE of a persisted rank_kind was the highest-
// consequence bare literal found in the sweep: a typo here stores a kind
// nothing recognises, and every reader's safe default then silently declines
// to show the ordinal. See src/engine/rankKind.js's header.
import { CELL_CHOICE } from '../../../engine/rankKind.js'
import {
  RELEASE_LOCK_LABEL, danglingMessage, occurrenceLabel, overCapacityMessage,
  satisfactionSummary, stalenessOfferMessage,
} from './runStateCopy.js'

const styles = {
  summary: { fontSize: 13, marginBottom: 14 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  offer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13, marginBottom: 14 },
}

export default function DraftRunView({
  run, danglingFindings = [], onRegenerate, onBack,
  activities = [], days = [], timeBlocks = [], templateOccurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [],
}) {
  const { state, setState, loaded, loadError, reload } = useRunState(run.id)
  const [error, setError] = useState(null)
  const [released, setReleased] = useState([])
  // T297 — set by a preference edit, and the ONLY thing that offers the re-solve
  // below. Session-scoped by design rather than by omission: the offer means
  // "you changed something and have not re-solved since", which is a fact about
  // this sitting. A durable "the preferences no longer match the placements"
  // signal would be a different claim needing a persisted marker to be honest,
  // and inventing one is not this ticket's.
  const [preferencesEdited, setPreferencesEdited] = useState(false)

  const rows = state.rows
  // T318 (b) — TWO labellers, because the two callers need different occurrence
  // sets and conflating them is exactly the bug this ticket fixes.
  //
  // labelForRunOccurrence: the over-capacity rows name a period THIS RUN ALREADY
  // PLACED people in, so they must look that occurrence up in the run's own
  // persisted set (state.occurrences, from getElectiveRun — always present,
  // including for a run opened cold from the run list). electron/main.js's own
  // comment on that query says this is the sanctioned use: "a consumer LOOKS UP
  // the occurrence named by an assignment row it already has" is sound even
  // though the list is the union of every generation's occurrences, which makes
  // it UNSOUND as "the current set".
  //
  // labelForTemplateOccurrence: the move dropdown below offers periods a camper
  // can be moved TO, which has to be the CURRENT template's set
  // (templateOccurrences, AssignmentPanel React state) — a superseded
  // occurrence from an earlier generation must not be offered as a destination.
  const labelForRunOccurrence = (o) => occurrenceLabel({ ...o, activities, occurrences: state.occurrences, days, timeBlocks })
  const labelForTemplateOccurrence = (o) => occurrenceLabel({ ...o, activities, occurrences: templateOccurrences, days, timeBlocks })

  function applyRow(assignmentId, patch) {
    setState((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === assignmentId ? { ...r, ...patch } : r)),
    }))
  }

  // One write path for every lock/move on this screen, so lock semantics do not
  // drift between the table and the "Release lock" button.
  async function writeAssignment({ camperId, occurrenceId, activityId, locked }) {
    setError(null)
    try {
      const out = await localClient.setElectiveAssignment({ runId: run.id, camperId, occurrenceId, activityId, locked })
      if (!out?.ok) {
        setError(out?.message ?? out?.error ?? 'That placement could not be saved.')
        return false
      }
      return true
    } catch (err) {
      setError(describeWriteFailure(err, 'That placement could not be saved.'))
      return false
    }
  }

  // T297 — the two preference writes, beside writeAssignment for the same
  // reason: one place per screen where a failure is turned into words, so the
  // describeWriteFailure rule cannot be half-applied. Both return a boolean so
  // the panel knows whether to close its editor, and both re-read the run so the
  // week shows what the database now holds rather than what the click intended.
  async function writePreference({ camperId, entry, choiceId }) {
    setError(null)
    // The statement being corrected, or null for an ADD (a placement the camper
    // ranked nothing for has no row to correct).
    const prior = entry.preferenceId == null
      ? null
      : (state.preferences ?? []).find((p) => p.id === entry.preferenceId) ?? null
    try {
      const out = await localClient.setElectivePreference({
        runId: run.id,
        camperId,
        occurrenceId: entry.occurrenceId,
        choiceId,
        // INHERITED FROM THE ROW BEING CORRECTED, never invented. Changing which
        // activity a camper asked for says nothing about where it sat in their
        // ordering, so the replaced row's rank and rank_kind carry over, and
        // `replacesPreferenceId` is what makes the op keep that row's SCOPE too.
        // Only a brand-new statement about a cell is 'cell-choice' at rank 1 —
        // which is what a cell CHOSEN means (schema v79's own note), not a guess.
        rank: prior ? prior.rank ?? null : 1,
        rankKind: prior ? prior.rank_kind ?? null : CELL_CHOICE,
        replacesPreferenceId: prior ? entry.preferenceId : null,
      })
      if (!out?.ok) {
        setError(out?.error ?? 'That preference could not be saved.')
        return false
      }
      await reload()
      setPreferencesEdited(true)
      return true
    } catch (err) {
      setError(describeWriteFailure(err, 'That preference could not be saved.'))
      return false
    }
  }

  async function removePreference({ entry }) {
    setError(null)
    try {
      const out = await localClient.removeElectivePreference({ runId: run.id, preferenceId: entry.preferenceId })
      if (!out?.ok) {
        setError(out?.error ?? 'That preference could not be removed.')
        return false
      }
      await reload()
      setPreferencesEdited(true)
      return true
    } catch (err) {
      setError(describeWriteFailure(err, 'That preference could not be removed.'))
      return false
    }
  }

  // RELEASING THE LOCK DOES NOT RESOLVE THE DANGLING CONDITION, so this row
  // must not disappear as though it had.
  //
  // setElectiveAssignment writes source:'manual' on EVERY write through that
  // path (electron/ops/setElectiveAssignment.js), and commitElectiveRun derives
  // DANGLING_MANUAL_ASSIGNMENT from source='manual' rows whose occurrence_id is
  // outside the derived occurrence set — keyed on `source`, never on
  // `is_locked`. Unlocking leaves `source` exactly where it was, so the very
  // next regenerate re-reports the identical row. Round 1 collapsed the row
  // away on a successful write, which told the director it was fixed.
  //
  // What the write DOES do is real and worth keeping: the lock is genuinely
  // released. So the action retires once performed and the row stays, stating
  // the condition that is still true. The spec chose this remedy without
  // knowing `source` stays 'manual'; a remedy that actually closes the
  // condition has to move the placement onto an occurrence this run still has,
  // which is a picker and copy this ticket was not asked to invent.
  async function releaseLock(finding) {
    const row = rows.find((r) => r.id === finding.assignment_id)
    const ok = await writeAssignment({
      camperId: finding.camper_id,
      occurrenceId: finding.occurrence_id,
      activityId: row?.activity_id ?? null,
      locked: false,
    })
    if (!ok) return
    setReleased((r) => [...r, finding.assignment_id])
  }

  // The seats the director locked by hand, which BOTH re-solve offers carry so a
  // regenerate cannot undo them. One definition: the staleness offer and the
  // preference offer had byte-identical copies.
  const lockedAssignments = rows
    .filter((r) => r.is_locked === 1 || r.is_locked === true)
    .map((r) => ({ camperId: r.camper_id, occurrenceId: r.occurrence_id, activityId: r.activity_id }))

  // T250 B1 — commitElectiveRun's `findings` mixes THREE kinds
  // (DANGLING_MANUAL_ASSIGNMENT, PREFERENCE_EDIT_HELD, BUNDLE_TIER_NOT_COVERED),
  // all three carrying camper_id. Only the first gets the dangling-placement
  // sentence and the Release lock action; the other two are real,
  // already-computed findings with their OWN message from commitElectiveRun,
  // rendered verbatim rather than hidden or mislabeled.
  const overCapacityRows = state.overCapacityOccurrences
  const danglingRows = danglingFindings.filter((f) => f.kind === 'DANGLING_MANUAL_ASSIGNMENT')
  const commitNotices = danglingFindings.filter((f) => f.kind !== 'DANGLING_MANUAL_ASSIGNMENT')
  const stateRowCount = overCapacityRows.length + danglingRows.length + commitNotices.length

  const stateRows = [
    ...overCapacityRows.map((o, i) => (
      <RunStateRow
        key={`oc-${o.occurrenceId}-${o.activityId}`}
        testId={`run-state-over-capacity-${o.occurrenceId}-${o.activityId}`}
        first={i === 0}
        last={i === stateRowCount - 1}
        message={overCapacityMessage({ label: labelForRunOccurrence(o), filled: o.filled, capacity: o.capacity })}
      />
    )),
    ...danglingRows.map((f, i) => {
      const index = overCapacityRows.length + i
      return (
        <RunStateRow
          key={`dm-${f.assignment_id}`}
          testId={`run-state-dangling-${f.assignment_id}`}
          first={index === 0}
          last={index === stateRowCount - 1}
          message={danglingMessage({ camperName: rows.find((r) => r.camper_id === f.camper_id)?.camper_name ?? f.camper_id })}
          action={released.includes(f.assignment_id) ? null : (
            <button className="press-97" style={S.btnSecondary} onClick={() => releaseLock(f)}>
              {RELEASE_LOCK_LABEL}
            </button>
          )}
        />
      )
    }),
    ...commitNotices.map((f, i) => {
      const index = overCapacityRows.length + danglingRows.length + i
      // A unique key per finding: PREFERENCE_EDIT_HELD carries preference_id,
      // BUNDLE_TIER_NOT_COVERED carries no per-row id at all (camper_id+label
      // is what commitElectiveRun groups on), so no single field is present on
      // both — the fallback below is what keeps two BUNDLE_TIER_NOT_COVERED
      // findings for the same camper from colliding.
      const noticeKey = f.preference_id ?? `${f.camper_id}-${f.label ?? f.kind}`
      return (
        <RunStateRow
          key={`notice-${noticeKey}`}
          testId={`run-state-notice-${noticeKey}`}
          first={index === 0}
          last={index === stateRowCount - 1}
          message={f.message}
        />
      )
    }),
  ]

  return (
    <div>
      {onBack ? <button className="press-97" style={{ ...S.btnUtility, marginBottom: 12 }} onClick={onBack}>Back to Runs</button> : null}
      <RunIdentity run={run} scheduleTemplates={scheduleTemplates} scheduleWeeks={scheduleWeeks} tiers={tiers} />
      <RunError message={error ?? loadError} />
      {loaded ? (
        <>
          <div data-testid="run-satisfaction-summary" style={styles.summary}>
            {satisfactionSummary({ rows, preferences: state.preferences, occurrences: state.occurrences, days, timeBlocks })}
          </div>

          <RunStateArea>{stateRows}</RunStateArea>

          {/* An offer, never a block: the table below stays fully usable.
              The FACT is stated whenever there is one, and the control appears
              only when this session can act on it — AssignmentPanel withholds
              onRegenerate for a run opened cold from the run list, which has no
              parsed sheet to re-derive against. Round 1 gated the whole block
              on the control, so the only in-UI remedy and the staleness itself
              vanished together, silently. */}
          {state.staleCount > 0 ? (
            <div data-testid="run-staleness-offer" style={styles.offer}>
              <span>{stalenessOfferMessage({ staleCount: state.staleCount })}</span>
              {onRegenerate ? (
                <button
                  className="press-97"
                  style={S.btnSecondary}
                  onClick={() => onRegenerate({ lockedAssignments })}
                >
                  Re-derive and regenerate
                </button>
              ) : null}
            </div>
          ) : null}

          {/* T297 — the other half of the ticket's loop. An edit changes what a
              camper asked for; the placements still reflect the previous answer
              until the run is solved again, and saying so is what makes the edit
              mean something. Same "offer, never a block" shape as the staleness
              offer above: the fact is stated whenever it is true, and the control
              appears only when this session can act on it (AssignmentPanel
              withholds onRegenerate for a run opened cold from the run list,
              which has no template occurrences to re-derive against).

              The re-solve carries `preferences` — the run's OWN rows, including
              the edit — so it solves from the database and not from the parsed
              sheet. That is the whole difference between an edit that lands and
              an edit that is written and then ignored. */}
          {preferencesEdited ? (
            <div data-testid="run-preference-edit-offer" style={styles.offer}>
              <span>
                A preference changed. The placements below still come from the previous solve.
              </span>
              {onRegenerate ? (
                <button
                  className="press-97"
                  data-testid="run-preference-resolve"
                  style={S.btnSecondary}
                  onClick={() => {
                    setPreferencesEdited(false)
                    onRegenerate({ preferences: state.preferences, choices: state.choices, lockedAssignments })
                  }}
                >
                  Solve again
                </button>
              ) : null}
            </div>
          ) : null}

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Camper</th>
                <th style={styles.th}>Placement</th>
                <th style={styles.th}>Locked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`placement-row-${r.id}`}>
                  <td style={styles.td}>{r.camper_name ?? r.camper_id}</td>
                  <td style={styles.td}>
                    <select
                      data-testid={`placement-occurrence-${r.id}`}
                      aria-label={`Placement for ${r.camper_name ?? r.camper_id}`}
                      value={r.occurrence_id}
                      onChange={async (e) => {
                        const occurrenceId = e.target.value
                        // A move made by hand is a manual, locked placement —
                        // the next regenerate must not undo the director.
                        if (await writeAssignment({ camperId: r.camper_id, occurrenceId, activityId: r.activity_id, locked: true })) {
                          applyRow(r.id, { occurrence_id: occurrenceId, is_locked: 1, source: 'manual' })
                        }
                      }}
                    >
                      {templateOccurrences.map((o) => (
                        <option key={o.id} value={o.id}>{labelForTemplateOccurrence({ occurrenceId: o.id, activityId: r.activity_id })}</option>
                      ))}
                    </select>
                  </td>
                  <td style={styles.td}>
                    <input
                      type="checkbox"
                      data-testid={`placement-lock-${r.id}`}
                      aria-label={`Lock ${r.camper_name ?? r.camper_id}'s placement`}
                      checked={r.is_locked === 1 || r.is_locked === true}
                      onChange={async (e) => {
                        const locked = e.target.checked
                        if (await writeAssignment({ camperId: r.camper_id, occurrenceId: r.occurrence_id, activityId: r.activity_id, locked })) {
                          applyRow(r.id, { is_locked: locked ? 1 : 0, source: 'manual' })
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* T296 — the same rows read per camper instead of per occurrence.
              BELOW the move/lock table, not instead of it: the table is where a
              director acts and this is where they check, and the ticket's own
              note is that the two views sit beside each other. It re-reads
              `state.rows`, so a move made in the table above is reflected here
              without another load. */}
          {/* state.occurrences, never templateOccurrences — CamperWeekPanel's
              header says why. */}
          <CamperWeekPanel
            rows={rows}
            occurrences={state.occurrences}
            activities={activities}
            days={days}
            timeBlocks={timeBlocks}
            preferences={state.preferences}
            choices={state.choices}
            onSetPreference={writePreference}
            onRemovePreference={removePreference}
          />
        </>
      ) : null}
    </div>
  )
}
