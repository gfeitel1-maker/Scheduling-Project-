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
import DeleteRunDialog from './DeleteRunDialog.jsx'
import { A } from '../assignment/assignmentStyles.js'
import {
  RELEASE_LOCK_LABEL, camperDisambiguator, danglingMessage, occurrenceLabel, overCapacityMessage,
  satisfactionSummary, stalenessOfferMessage,
} from './runStateCopy.js'

const styles = {
  summary: { fontSize: 13, marginBottom: 14 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--border)' },
  offer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13, marginBottom: 14 },
  camperDisambiguator: { fontSize: 11, color: 'var(--text-secondary)' },
  actionsBand: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  actionsHint: { fontSize: 12, color: 'var(--text-secondary)' },
  findingsList: { margin: '8px 0 0', paddingLeft: 20, fontSize: 12 },
  // The pairing: the state, then its remedy, with nothing between them — same
  // shape as FinalRunView's own stale-generation pairing.
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

const FINALIZE_MESSAGES = {
  STALE_OUTER_SCHEDULE:
    "This run's schedule changed on another device since you last regenerated. Finalizing now would lock in an outdated version.",
  OUTER_RESOURCE_CONFLICT:
    'A location or activity this run depends on is now double-booked on the main schedule. Fix the conflict there, then finalize again.',
  ALREADY_FINAL: 'This run was already finalized — on this device or another. Reloading it now.',
}

// T250 A2 — the inline refusal a Finalize attempt produced. One row per the
// verbatim copy the ticket specifies, `findings` rendered as a plain list
// (up to 3) with the remainder collapsed behind a native <details>/<summary>,
// the same idiom ParseSummary already uses for its own collapsible sections.
function FinalizeFindingsList({ findings }) {
  if (!findings || findings.length === 0) return null
  const shown = findings.slice(0, 3)
  const rest = findings.length - shown.length
  return (
    <>
      <ul style={styles.findingsList}>
        {shown.map((f, i) => (
          <li key={i}>{f.message ?? f.kind ?? JSON.stringify(f)}</li>
        ))}
      </ul>
      {rest > 0 ? (
        <details style={A.disclosure}>
          <summary style={A.disclosureSummary}>+{rest} more</summary>
          <ul style={styles.findingsList}>
            {findings.slice(3).map((f, i) => (
              <li key={i}>{f.message ?? f.kind ?? JSON.stringify(f)}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  )
}

function FinalizeRefusalRow({ refusal, onRegenerate, lockedAssignments }) {
  const { error, findings } = refusal
  const known = FINALIZE_MESSAGES[error]
  const message = known ?? `Finalizing failed: ${error}. Nothing was changed — try again, or contact support if this keeps happening.`

  if (error === 'STALE_OUTER_SCHEDULE') {
    return (
      <div data-testid="run-state-finalize-refusal" style={styles.pairing}>
        <RunStateRow testId="run-state-finalize-stale" message={<>{message}<FinalizeFindingsList findings={findings} /></>} first alert />
        {onRegenerate ? (
          <div style={styles.pairingAction}>
            <button className="press-97" style={S.btnSecondary} onClick={() => onRegenerate({ lockedAssignments })}>
              Re-derive and regenerate
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <RunStateRow
      testId="run-state-finalize-refusal"
      first last alert
      message={<>{message}<FinalizeFindingsList findings={findings} /></>}
    />
  )
}

export default function DraftRunView({
  run, danglingFindings = [], onRegenerate, onFinalized, onBack,
  activities = [], days = [], timeBlocks = [], templateOccurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [],
  // T250 A3 — true when `onRegenerate` is available because this session
  // HYDRATED a cold-opened run's state, never because it solved the run
  // itself. Drives the disclosure note beside the offer's button.
  coldRegenerate = false,
}) {
  const { state, setState, loaded, loadError, reload } = useRunState(run.id)
  const [error, setError] = useState(null)
  const [released, setReleased] = useState([])
  const [finalizing, setFinalizing] = useState(false)
  // { error, findings } for the refusal row, or null when nothing to say.
  const [finalizeRefusal, setFinalizeRefusal] = useState(null)
  // T250 A4 — the Delete run confirmation, shown on demand.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
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

  // T250 A1/A2 — locks this run. finalizeElectiveRun's real return shape
  // (electron/ops/finalizeElectiveRun.js): {ok:true, finalizedAt, snapshotRows}
  // | {ok:false, error:'ALREADY_FINAL'} | {ok:false, error:'STALE_OUTER_SCHEDULE'|
  // 'OUTER_RESOURCE_CONFLICT', findings} | {ok:false, error:<other string>}.
  async function finalizeRun() {
    setFinalizing(true)
    setFinalizeRefusal(null)
    try {
      const out = await localClient.finalizeElectiveRun({ runId: run.id })
      if (out?.ok) {
        onFinalized?.({ ...run, status: 'final', finalized_at: out.finalizedAt })
        return
      }
      if (out?.error === 'ALREADY_FINAL') {
        setFinalizeRefusal({ error: out.error, findings: [] })
        await reload()
        onFinalized?.({ ...run, status: 'final' })
        return
      }
      setFinalizeRefusal({ error: out?.error ?? 'unknown error', findings: out?.findings ?? [] })
    } catch (err) {
      setFinalizeRefusal({ error: describeWriteFailure(err, 'That could not be finalized.'), findings: [] })
    } finally {
      setFinalizing(false)
    }
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
    // T250 A2 — appended AFTER the over-capacity and dangling rows: whatever
    // refusal the last Finalize attempt produced, inline in the run's own
    // run-state area rather than a separate block.
    finalizeRefusal ? (
      <FinalizeRefusalRow
        key="finalize-refusal"
        refusal={finalizeRefusal}
        onRegenerate={onRegenerate}
        lockedAssignments={lockedAssignments}
      />
    ) : null,
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

          {/* T250 A1 — the actions band. Positioned directly below the
              run-state area and above the staleness/preference offers and the
              move/lock table, per the spec's layout order. */}
          <div style={styles.actionsBand}>
            <button
              className="press-97"
              style={S.btnPrimary}
              disabled={finalizing}
              onClick={finalizeRun}
            >
              {finalizing ? 'Finalizing…' : 'Finalize run'}
            </button>
            <span style={styles.actionsHint}>
              Locks this run. You&apos;ll see it as Final, and can always start a new version later.
            </span>
          </div>

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

          {/* T250 A3 — the reconstructed roster for a cold-open regenerate is
              "every camper with a preference or a placement on this run", not
              the original sheet's full roster — this says so rather than
              leaving it a silent gap (the "engine surfaces, never silently
              absorbs" rule). */}
          {onRegenerate && coldRegenerate ? (
            <div data-testid="run-cold-regenerate-note" style={styles.actionsHint}>
              Regenerating a reopened run reconsiders every camper who has a preference or a placement on it.
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
              {rows.map((r) => {
                // T250 B3 — two same-named campers on this table read
                // identically without something beside the name to tell them
                // apart. `state.campers` (A0.2) carries the resolved group
                // name and external_id; degrade order is
                // camperDisambiguator's own (group -> external_id -> nothing).
                const camper = (state.campers ?? []).find((c) => c.id === r.camper_id)
                const disambiguator = camper
                  ? camperDisambiguator({ groupName: camper.group_name, externalId: camper.external_id })
                  : null
                return (
                <tr key={r.id} data-testid={`placement-row-${r.id}`}>
                  <td style={styles.td}>
                    {r.camper_name ?? r.camper_id}
                    {disambiguator ? (
                      <div style={styles.camperDisambiguator}>{disambiguator}</div>
                    ) : null}
                  </td>
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
                )
              })}
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
            campers={state.campers}
            onSetPreference={writePreference}
            onRemovePreference={removePreference}
          />

          {/* T250 A4 — a quiet text-only trigger at the bottom, well separated
              from the actions band above. The loud part is the confirmation. */}
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
              placementCount={rows.length}
              onCancel={() => setConfirmingDelete(false)}
              onDeleted={() => onBack?.()}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
