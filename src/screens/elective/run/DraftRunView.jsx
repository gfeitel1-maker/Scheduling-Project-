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
import { S, RunStateArea, RunStateRow, RunIdentity, RunError, COLLAPSE_MS } from './RunStateRows.jsx'
import { useRunState } from './useRunState.js'
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
  activities = [], days = [], timeBlocks = [], occurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [],
}) {
  const { state, setState, loaded, loadError } = useRunState(run.id)
  const [error, setError] = useState(null)
  const [resolved, setResolved] = useState([])
  const [collapsing, setCollapsing] = useState([])

  const rows = state.rows
  const labelFor = (o) => occurrenceLabel({ ...o, activities, occurrences, days, timeBlocks })

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
        setError(out?.error ?? 'That placement could not be saved.')
        return false
      }
      return true
    } catch (err) {
      setError(describeWriteFailure(err, 'That placement could not be saved.'))
      return false
    }
  }

  async function releaseLock(finding) {
    const row = rows.find((r) => r.id === finding.assignment_id)
    const ok = await writeAssignment({
      camperId: finding.camper_id,
      occurrenceId: finding.occurrence_id,
      activityId: row?.activity_id ?? null,
      locked: false,
    })
    if (!ok) return
    setCollapsing((c) => [...c, finding.assignment_id])
    setTimeout(() => setResolved((r) => [...r, finding.assignment_id]), COLLAPSE_MS)
  }

  const overCapacityRows = state.overCapacityOccurrences
  const danglingRows = danglingFindings.filter((f) => !resolved.includes(f.assignment_id))
  const stateRowCount = overCapacityRows.length + danglingRows.length

  const stateRows = [
    ...overCapacityRows.map((o, i) => (
      <RunStateRow
        key={`oc-${o.occurrenceId}-${o.activityId}`}
        testId={`run-state-over-capacity-${o.occurrenceId}-${o.activityId}`}
        first={i === 0}
        last={i === stateRowCount - 1}
        message={overCapacityMessage({ label: labelFor(o), filled: o.filled, capacity: o.capacity })}
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
          removing={collapsing.includes(f.assignment_id)}
          message={danglingMessage({ camperName: rows.find((r) => r.camper_id === f.camper_id)?.camper_name ?? f.camper_id })}
          action={
            <button className="press-97" style={S.btnSecondary} onClick={() => releaseLock(f)}>
              {RELEASE_LOCK_LABEL}
            </button>
          }
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
          <div data-testid="run-satisfaction-summary" style={styles.summary}>{satisfactionSummary(rows)}</div>

          <RunStateArea>{stateRows}</RunStateArea>

          {/* An offer, never a block: the table below stays fully usable. */}
          {state.staleCount > 0 && onRegenerate ? (
            <div data-testid="run-staleness-offer" style={styles.offer}>
              <span>{stalenessOfferMessage({ staleCount: state.staleCount })}</span>
              <button
                className="press-97"
                style={S.btnSecondary}
                onClick={() => onRegenerate({
                  lockedAssignments: rows
                    .filter((r) => r.is_locked === 1 || r.is_locked === true)
                    .map((r) => ({ camperId: r.camper_id, occurrenceId: r.occurrence_id, activityId: r.activity_id })),
                })}
              >
                Re-derive and regenerate
              </button>
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
                      {occurrences.map((o) => (
                        <option key={o.id} value={o.id}>{labelFor({ occurrenceId: o.id, activityId: r.activity_id })}</option>
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
        </>
      ) : null}
    </div>
  )
}
