// T250 — the Draft state of a persisted elective run.
//
// Layout order was originally fixed by
// docs/work/specs/2026-09-25-t250-run-state-surface.md: identity line,
// satisfaction summary, run-state area (over-capacity rows, then
// dangling-manual-assignment rows), then the Finalize actions band, then the
// move/lock table. Owner/organizer ruling 2026-09-30 moved the actions band
// ABOVE the run-state area (so Finalize is never pushed below a long findings
// list) — current order: identity line, satisfaction summary, actions band,
// run-state area, move/lock table. See that spec's "Layout" section for the
// dated amendment note recording the divergence (Constitution Art. I: current
// human instruction outranks an approved spec).
//
// Mounted inside AssignmentPanel, which sits under ElectiveSetDetail. The
// admin gate is INHERITED from there (the participant entities are absent from
// permissions.js's ENTITIES, so authorize() default-denies staff) — this file
// deliberately does not re-implement a second gate, and nothing here is
// reachable from src/components/layout/navSections.js.
import { useEffect, useMemo, useRef, useState } from 'react'
import { localClient } from '../../../localClient'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { prefersReducedMotion } from '../../../styles/shared'
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
  DANGLING_MOVE_PLACEHOLDER, FINALIZE_MESSAGES, REMOVE_PLACEMENT_LABEL, danglingMessage, occurrenceLabel, overCapacityMessage,
  resolveCamperDisambiguators, satisfactionSummary, stalenessOfferMessage,
  groupBundleTierNotCoveredFindings, bundleTierNotCoveredGroupMessage, finalizeFindingMessage,
  sheetOnlyCampersMessage,
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
  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 3;
  // docs/work/specs/2026-09-30-t320-dangling-replace-picker.md).
  danglingMoveSelect: {
    fontFamily: 'inherit',
    fontSize: 13,
    padding: '5px 8px',
    borderRadius: 6,
    border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
    background: 'var(--surface)',
    color: 'var(--text)',
    maxWidth: 280,
    cursor: 'pointer',
  },
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
  // T320 round 2, F5 — the dangling row's removal on success, per the spec's
  // "Reduced motion" section: T250's existing collapse transition REUSED
  // verbatim (S.mergeCard's own `transition` string, src/styles/shared.js) —
  // not a new animation, not new token values. `overflow: hidden` is what
  // makes the max-height collapse actually hide the content rather than
  // just resize an already-visible box.
  danglingRowCollapse: {
    overflow: 'hidden',
    transition: S.mergeCard.transition,
  },
}

// var(--motion-settle), src/index.css — the collapse's own duration, kept in
// sync with the CSS transition above by hand (no DOM API cheaply reads a
// custom property's computed value before the transition needs to start).
const DANGLING_ROW_COLLAPSE_MS = 340

// T250 A2 — the inline refusal a Finalize attempt produced. One row per the
// verbatim copy the ticket specifies, `findings` rendered as a plain list
// (up to 3) with the remainder collapsed behind a native <details>/<summary>,
// the same idiom ParseSummary already uses for its own collapsible sections.
function FinalizeFindingsList({ findings, days = [], timeBlocks = [] }) {
  if (!findings || findings.length === 0) return null
  const shown = findings.slice(0, 3)
  const rest = findings.length - shown.length
  return (
    <>
      <ul style={styles.findingsList}>
        {shown.map((f, i) => (
          <li key={i}>{finalizeFindingMessage(f, { days, timeBlocks })}</li>
        ))}
      </ul>
      {rest > 0 ? (
        <details style={A.disclosure}>
          <summary style={A.disclosureSummary}>+{rest} more</summary>
          <ul style={styles.findingsList}>
            {findings.slice(3).map((f, i) => (
              <li key={i}>{finalizeFindingMessage(f, { days, timeBlocks })}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  )
}

// C1 (board item 9b) — one grouped BUNDLE_TIER_NOT_COVERED row for a
// (label, tier) pair, instead of the raw per-camper findings commitElectiveRun
// emits. The sentence states the LABEL, the TIER (or a truthful division-only
// phrasing when no tier resolved), and the COUNT; every named camper stays
// reachable behind the SAME disclosure idiom FinalizeFindingsList uses — never
// dropped, only collapsed.
function BundleMismatchGroupNames({ names }) {
  return (
    <details style={A.disclosure}>
      <summary style={A.disclosureSummary}>{names.length === 1 ? names[0] : `${names.length} campers`}</summary>
      <ul style={styles.findingsList}>
        {names.map((name, i) => <li key={i}>{name}</li>)}
      </ul>
    </details>
  )
}

function FinalizeRefusalRow({ refusal, onRegenerate, lockedAssignments, days, timeBlocks }) {
  const { error, findings } = refusal
  const known = FINALIZE_MESSAGES[error]
  const message = known ?? `Finalizing failed: ${error}. Nothing was changed — try again, or contact support if this keeps happening.`

  if (error === 'STALE_OUTER_SCHEDULE') {
    return (
      <div data-testid="run-state-finalize-refusal" style={styles.pairing}>
        <RunStateRow testId="run-state-finalize-stale" message={<>{message}<FinalizeFindingsList findings={findings} days={days} timeBlocks={timeBlocks} /></>} first alert />
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
      message={<>{message}<FinalizeFindingsList findings={findings} days={days} timeBlocks={timeBlocks} /></>}
    />
  )
}

// T320 round 2, F5 — renders nothing; owns exactly one collapse timer, tied
// to ITS OWN mount/unmount via a `[]`-deps effect. Deliberately a component,
// not a ref-backed function in DraftRunView's body: a plain function that
// mutates a shared ref from an event-handler call chain trips eslint-plugin-
// react-hooks' `refs` rule (refs should only be touched inside an effect or
// a DOM event handler, never a function reachable from render that isn't
// itself one of those) — one timer component per collapsing row sidesteps
// that by keeping ref-equivalent state (the timer id) local to an effect
// that only ever runs once, cleanly tied to this row's own lifetime rather
// than a ref array shared — and mutated — across every row.
function DanglingRowCollapseTimer({ assignmentId, setMovedAway, setCollapsingRows }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      setMovedAway((m) => [...m, assignmentId])
      setCollapsingRows((c) => c.filter((f) => f.assignment_id !== assignmentId))
    }, DANGLING_ROW_COLLAPSE_MS)
    return () => clearTimeout(timer)
    // assignmentId is this row's own stable key and setMovedAway/
    // setCollapsingRows are useState setters (React guarantees their
    // identity is stable across renders) — the effect is meant to run
    // exactly once, on mount.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export default function DraftRunView({
  run, danglingFindings = [], onRegenerate, onFinalized, onBack,
  activities = [], days = [], timeBlocks = [], templateOccurrences = [],
  scheduleTemplates = [], scheduleWeeks = [], tiers = [], groups = [],
  // T250 A3 — true when `onRegenerate` is available because this session
  // HYDRATED a cold-opened run's state, never because it solved the run
  // itself. Drives the disclosure note beside the offer's button.
  coldRegenerate = false,
}) {
  const { state, setState, loaded, loadError, reload } = useRunState(run.id)
  const [error, setError] = useState(null)
  // T320 — a picker MOVE/REMOVE result, tracked separately from the (now
  // removed) "Release lock" session-state: a distinct array rather than
  // overloading a differently-named one, per the spec's own instruction ("a
  // reader of released.includes(id) today reasonably expects 'the lock was
  // released'"). Used only as the pre-`loaded` fallback filter — see
  // danglingRows below.
  const [movedAway, setMovedAway] = useState([])
  // T320 round 2, F5 — findings currently mid-collapse (select/button
  // succeeded, the row is animating out but has not yet left the DOM).
  // Stores the FINDING, not just its id: `reload()` fires in the same tick
  // as the collapse timer starts, and the durable read it brings back no
  // longer contains this finding at all — without a locally-held copy,
  // `danglingRows` below would lose the row (and its animation) the instant
  // the reload resolves, well before the transition has had time to run.
  const [collapsingRows, setCollapsingRows] = useState([])
  // The one place a successful move/remove turns into the row's departure —
  // reduced motion skips straight to the end state (spec's "Reduced motion"),
  // everyone else gets the shared collapse transition first. No timer is
  // started here: `DanglingRowCollapseTimer` below owns that, one instance
  // per collapsing row, so each timer's lifecycle is tied to that ONE row's
  // own mount/unmount rather than to a ref shared across every row (which
  // would need its bookkeeping mutated from a plain function, not an effect
  // — see that component's own comment).
  function scheduleDanglingRowRemoval(finding) {
    if (prefersReducedMotion()) {
      setMovedAway((m) => [...m, finding.assignment_id])
      return
    }
    setCollapsingRows((c) => [...c, finding])
  }
  // Per-row in-flight guard for the move/remove select or button — keyed to
  // one assignment id so one row's write does not disable every other row's
  // control.
  const [movingId, setMovingId] = useState(null)
  // T320 spec "Keyboard and focus" — a director keyboard-focused on a
  // dangling row's control loses their focus target when the row is removed
  // on success; this gives them a stable landing spot, mirroring
  // RunStateRow's own alert-row ref.focus() precedent.
  const summaryRef = useRef(null)
  const [finalizing, setFinalizing] = useState(false)
  // { error, findings } for the refusal row, or null when nothing to say.
  const [finalizeRefusal, setFinalizeRefusal] = useState(null)
  // F4 (Red Hat round 3) — a monotonic id, bumped every time a NEW refusal is
  // reported, used as FinalizeRefusalRow's `key` below. Without it, two
  // refusals that render through the SAME branch (every error except
  // STALE_OUTER_SCHEDULE, which alone gets a different wrapping shape) keep
  // the identical React element position/type across the state change, so
  // the row's own RunStateRow instance is never unmounted — and its
  // `useEffect(..., [alert])` focus/announce effect, keyed only on the
  // boolean `alert` (which stays `true` the whole time), never re-fires. A
  // real repro: guardedRegenerate's cold-status check calls
  // `setFinalizeRefusal({ error: 'FINALIZED_ELSEWHERE', ... })` directly (no
  // intervening null, unlike finalizeRun()'s own reset), so a director who
  // sees an OUTER_RESOURCE_CONFLICT refusal and then separately clicks the
  // staleness offer's regenerate button got a silently-updated row with no
  // re-announcement and no refocus. Forcing a `key` change on every report
  // guarantees a genuine remount — and therefore a genuine mount-effect
  // re-run — regardless of whether the two refusals happen to share a shape.
  const [finalizeRefusalSeq, setFinalizeRefusalSeq] = useState(0)
  function reportFinalizeRefusal(refusal) {
    setFinalizeRefusalSeq((s) => s + 1)
    setFinalizeRefusal(refusal)
  }
  // T250 A4 — the Delete run confirmation, shown on demand.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // T297 — set by a preference edit, and the ONLY thing that offers the re-solve
  // below. Session-scoped by design rather than by omission: the offer means
  // "you changed something and have not re-solved since", which is a fact about
  // this sitting. A durable "the preferences no longer match the placements"
  // signal would be a different claim needing a persisted marker to be honest,
  // and inventing one is not this ticket's.
  const [preferencesEdited, setPreferencesEdited] = useState(false)
  // Round 2 FIX 5(c) (Code Reviewer, LOW) — the synchronous re-entrancy guard
  // AssignmentPanel's commit() already carries as `committingRef`, added here
  // for the identical reason (see that comment): `disabled={finalizing}` only
  // closes the gap once React has re-rendered, which is not synchronous with
  // the click — a tablet double-tap can land both taps before that render,
  // and both would call finalizeElectiveRun.
  const finalizingRef = useRef(false)

  const rows = state.rows
  // Round 2 FIX 3 — resolved once per state.campers change, across the WHOLE
  // roster, so a tier value is only used when it actually tells two
  // same-named campers apart (see resolveCamperDisambiguators' own comment).
  const camperDisambiguators = useMemo(
    () => resolveCamperDisambiguators(
      (state.campers ?? []).map((c) => ({ id: c.id, name: c.display_name, groupName: c.group_name, externalId: c.external_id }))
    ),
    [state.campers]
  )
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
  async function writeAssignment({ camperId, occurrenceId, activityId, locked, replacesAssignmentId = null }) {
    setError(null)
    try {
      const out = await localClient.setElectiveAssignment({
        runId: run.id, camperId, occurrenceId, activityId, locked, replacesAssignmentId,
      })
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

  // T320 item 3 (docs/adr/2026-09-30-elective-run-durability.md;
  // docs/work/specs/2026-09-30-t320-dangling-replace-picker.md; Governor
  // rulings R6/R7) — THE ACTUAL REMEDY. "Release lock" alone left `source`
  // unchanged, so the identical row re-reported on the next regenerate; a
  // MOVE routes through `replacesAssignmentId`, which tombstones the source
  // row in the same transaction as the destination write
  // (setElectiveAssignment.js), so the finding clears mechanically — no
  // second regenerate needed.
  //
  // `locked: true`, not `false` — mirrors the move/lock table's own
  // manual-move convention: a move made by hand must survive the next
  // regenerate, not be handed straight back to the solver.
  async function moveDangling(finding, occurrenceId) {
    const row = rows.find((r) => r.id === finding.assignment_id)
    setMovingId(finding.assignment_id)
    const ok = await writeAssignment({
      camperId: finding.camper_id,
      occurrenceId,
      activityId: row?.activity_id ?? null,
      locked: true,
      replacesAssignmentId: finding.assignment_id,
    })
    setMovingId(null)
    if (!ok) return
    scheduleDanglingRowRemoval(finding)
    summaryRef.current?.focus()
    await reload()
  }

  // R7 — the zero-live-occurrence branch: a control that can genuinely
  // resolve the condition (unlike the old "Release lock", which never could)
  // via setElectiveAssignment's remove-only shape
  // (occurrenceId: null, activityId: null, replacesAssignmentId given).
  async function removeDangling(finding) {
    setMovingId(finding.assignment_id)
    const ok = await writeAssignment({
      camperId: finding.camper_id,
      occurrenceId: null,
      activityId: null,
      replacesAssignmentId: finding.assignment_id,
    })
    setMovingId(null)
    if (!ok) return
    scheduleDanglingRowRemoval(finding)
    summaryRef.current?.focus()
    await reload()
  }

  // T250 A1/A2 — locks this run. finalizeElectiveRun's real return shape
  // (electron/ops/finalizeElectiveRun.js): {ok:true, finalizedAt, snapshotRows}
  // | {ok:false, error:'ALREADY_FINAL'} | {ok:false, error:'STALE_OUTER_SCHEDULE'|
  // 'OUTER_RESOURCE_CONFLICT', findings} | {ok:false, error:<other string>}.
  async function finalizeRun() {
    // Round 2 FIX 5(c) — synchronous guard; see finalizingRef's own comment.
    if (finalizingRef.current) return
    finalizingRef.current = true
    setFinalizing(true)
    setFinalizeRefusal(null)
    try {
      const out = await localClient.finalizeElectiveRun({ runId: run.id })
      if (out?.ok) {
        // Round 2 FIX 5(d) (Code Reviewer, LOW) — KNOWN GAP: no finalized_by
        // here, because finalizeElectiveRun's success shape does not return
        // it, so RunIdentity shows "finalized <date>" with no "by <user>"
        // until this run is reopened. RunIdentity itself already renders
        // that absence coherently (finalized_by is its own independently
        // Boolean-filtered segment) — not fixed by widening the IPC return,
        // which would be a bigger change than this gap needs.
        onFinalized?.({ ...run, status: 'final', finalized_at: out.finalizedAt })
        return
      }
      if (out?.error === 'ALREADY_FINAL') {
        reportFinalizeRefusal({ error: out.error, findings: [] })
        await reload()
        onFinalized?.({ ...run, status: 'final' })
        return
      }
      reportFinalizeRefusal({ error: out?.error ?? 'unknown error', findings: out?.findings ?? [] })
    } catch (err) {
      reportFinalizeRefusal({ error: describeWriteFailure(err, 'That could not be finalized.'), findings: [] })
    } finally {
      setFinalizing(false)
      finalizingRef.current = false
    }
  }

  // Round 2 FIX 4 (Red Hat, MEDIUM) — viewRun is a snapshot captured when
  // this screen opened and is NEVER re-synced, so a run another device
  // finalized after that still renders here as Draft with a live Regenerate.
  //
  // T320 part 2 item 2 — commitElectiveRun NOW refuses a commit onto an
  // already-final run ({ ok: false, error: 'RUN_IS_FINAL' }, before any
  // write). That is the guarantee; this re-read is the COURTESY, and it is
  // why it stays: it stops the solve before the director waits for it, rather
  // than letting them sit through a regenerate that will be refused at the
  // end.
  //
  // Scoped to the COLD path (coldRegenerate) only: a run this session
  // itself just solved or hydrated moments ago finalizing elsewhere in that
  // same instant is not the case this guards, and checking on every regen
  // would cost a read this ticket does not need to spend.
  //
  // listElectiveRuns, not a widened getElectiveRun/commitElectiveRun
  // contract — that IPC already returns every run's current `status` for
  // this camp, so this is a read this app already had, not a new seam.
  async function guardedRegenerate(args) {
    if (coldRegenerate) {
      try {
        const current = (await localClient.listElectiveRuns())?.find((r) => r.id === run.id)
        if (current?.status === 'final') {
          reportFinalizeRefusal({ error: 'FINALIZED_ELSEWHERE', findings: [] })
          onFinalized?.({ ...run, status: 'final' })
          return
        }
      } catch {
        // Best-effort: an unreadable status check must not block a
        // regenerate that would otherwise be fine — commitElectiveRun's own
        // RUN_IS_FINAL refusal stands behind this at commit time, and its
        // finalizedAgainstStaleGeneration check at finalize/export time.
      }
    }
    onRegenerate?.(args)
  }
  const regenerate = onRegenerate ? guardedRegenerate : undefined

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
  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 2, open
  // question 1) — the RENDERING SOURCE is now the durable getElectiveRun-
  // returned `state.danglingFindings`, which survives a cold reopen; the
  // `danglingFindings` PROP (commitElectiveRun's own session-scoped response
  // field) is used only as an immediate pre-refresh fallback, before this
  // screen's own read has completed (`loaded` false). Once loaded, the
  // durable value wins even if it is empty — an empty durable read
  // legitimately means "nothing dangling right now", which must not be
  // shadowed by a stale prop from an earlier action this session.
  const durableDanglingRows = (loaded
    ? state.danglingFindings
    : danglingFindings.filter((f) => f.kind === 'DANGLING_MANUAL_ASSIGNMENT')
  // `movedAway` filters here too: the moment a move/remove succeeds the row
  // must vanish immediately once its collapse animation completes.
  ).filter((f) => !movedAway.includes(f.assignment_id))
  // T320 round 2, F5 — `reload()` (called right after scheduleDanglingRowRemoval
  // starts the collapse) resolves with a durable read that ALREADY excludes
  // this finding, well before the collapse animation has had time to run.
  // Without this merge, the row would vanish from `durableDanglingRows` the
  // instant reload() settles — skipping the animation this fix exists to add.
  // `collapsingRows` keeps a local copy so the row stays rendered (and
  // visually collapsing) until its own timer moves it into `movedAway`. Kept
  // as a SEPARATE array (not spread into `durableDanglingRows`) and rendered
  // by its OWN `.map()` below — a collapsing row is already disabled and
  // needs no live `onChange`/`onClick` handler, and keeping it out of the
  // array that `.map()` iterates alongside `moveDangling`/`removeDangling`
  // calls avoids an eslint-plugin-react-hooks `refs`-rule false positive
  // this exact merge tripped in testing (see git history if it recurs).
  const collapsingOnlyRows = collapsingRows.filter(
    (f) => !movedAway.includes(f.assignment_id) && !durableDanglingRows.some((r) => r.assignment_id === f.assignment_id)
  )
  const danglingRows = durableDanglingRows
  // C1 — BUNDLE_TIER_NOT_COVERED is GROUPED (see BundleMismatchGroupNames and
  // runStateCopy.js's groupBundleTierNotCoveredFindings); PREFERENCE_EDIT_HELD
  // and DANGLING_MANUAL_ASSIGNMENT keep their current per-camper rows (T232/D6
  // require naming the child there).
  const commitNotices = danglingFindings.filter((f) => f.kind !== 'DANGLING_MANUAL_ASSIGNMENT' && f.kind !== 'BUNDLE_TIER_NOT_COVERED')
  const bundleMismatchGroups = useMemo(
    () => groupBundleTierNotCoveredFindings({ findings: danglingFindings, campers: state.campers, groups, tiers }),
    [danglingFindings, state.campers, groups, tiers]
  )
  // (C)(4) — SHEET_CAMPER_WITHOUT_PREFERENCE (sheetOnlyCampers,
  // electron/ops/getElectiveRun.js — deliberately excluded from
  // eligibilityFindings, T320 part 2 item 3) must be NAMED, not just counted.
  // Resolved through `state.campers`, which this screen already holds (the
  // run's own camper universe includes every sheet-only camper per T320 part
  // 2 item 3) — no new IPC.
  const sheetOnlyCamperNames = useMemo(() => {
    const camperById = new Map((state.campers ?? []).map((c) => [c.id, c]))
    return (state.sheetOnlyCampers ?? []).map((id) => camperById.get(id)?.display_name ?? id)
  }, [state.campers, state.sheetOnlyCampers])
  const stateRowCount = overCapacityRows.length + danglingRows.length + collapsingOnlyRows.length + commitNotices.length
    + bundleMismatchGroups.length + (sheetOnlyCamperNames.length > 0 ? 1 : 0)

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
      const camperName = rows.find((r) => r.camper_id === f.camper_id)?.camper_name ?? f.camper_id
      // T320 round 2, F5 — a collapsing row is still mid-write's aftermath
      // visually, so its control stays disabled through the animation too.
      const isCollapsing = collapsingRows.some((r) => r.assignment_id === f.assignment_id)
      const isMoving = movingId === f.assignment_id || isCollapsing
      // R6 (spec "What replaces Release lock") — mutually exclusive per row
      // render: a picker when this run has a live occurrence to move into,
      // else the R7 "Remove placement" action. Never both. (A row that was
      // just moved/removed this session is already excluded from
      // danglingRows above, so no `movedAway` check is needed here.)
      const action = templateOccurrences.length > 0 ? (
        <select
          data-testid={`run-state-dangling-move-${f.assignment_id}`}
          aria-label={`Move ${camperName}'s placement`}
          style={styles.danglingMoveSelect}
          disabled={isMoving}
          value=""
          onChange={(e) => {
            const occurrenceId = e.target.value
            if (occurrenceId) moveDangling(f, occurrenceId)
          }}
        >
          <option value="" disabled>{DANGLING_MOVE_PLACEHOLDER}</option>
          {templateOccurrences.map((o) => (
            <option key={o.id} value={o.id}>{labelForTemplateOccurrence(o)}</option>
          ))}
        </select>
      ) : (
        <button
          className="press-97"
          style={S.btnSecondary}
          data-testid={`run-state-dangling-remove-${f.assignment_id}`}
          disabled={isMoving}
          onClick={() => removeDangling(f)}
        >
          {REMOVE_PLACEMENT_LABEL}
        </button>
      )
      return (
        // T320 round 2, F5 — the collapse wrapper. RunStateRow itself is
        // untouched (its own header explains why nothing there animates by
        // default); this one row re-earns motion by wrapping it, not by
        // changing the shared component.
        <div
          key={`dm-wrap-${f.assignment_id}`}
          data-testid={`run-state-dangling-collapse-${f.assignment_id}`}
          style={{
            ...styles.danglingRowCollapse,
            maxHeight: isCollapsing ? 0 : 200,
            opacity: isCollapsing ? 0 : 1,
          }}
        >
          <RunStateRow
            testId={`run-state-dangling-${f.assignment_id}`}
            first={index === 0}
            last={index === stateRowCount - 1}
            message={danglingMessage({ camperName })}
            action={action}
          />
          {isCollapsing ? (
            <DanglingRowCollapseTimer
              assignmentId={f.assignment_id}
              setMovedAway={setMovedAway}
              setCollapsingRows={setCollapsingRows}
            />
          ) : null}
        </div>
      )
    }),
    // T320 round 2, F5 — the write already succeeded and `reload()` already
    // dropped this finding from the durable read; only the exit animation is
    // still playing. No `onChange`/`onClick` here at all — there is nothing
    // left to do with a row that is already gone, durably, and disabled is
    // indistinguishable from absent-of-handler for a control the director
    // can no longer usefully interact with.
    ...collapsingOnlyRows.map((f, i) => {
      const index = overCapacityRows.length + danglingRows.length + i
      const camperName = rows.find((r) => r.camper_id === f.camper_id)?.camper_name ?? f.camper_id
      return (
        <div
          key={`dm-wrap-${f.assignment_id}`}
          data-testid={`run-state-dangling-collapse-${f.assignment_id}`}
          style={{ ...styles.danglingRowCollapse, maxHeight: 0, opacity: 0 }}
        >
          <RunStateRow
            testId={`run-state-dangling-${f.assignment_id}`}
            first={index === 0}
            last={index === stateRowCount - 1}
            message={danglingMessage({ camperName })}
          />
          <DanglingRowCollapseTimer
            assignmentId={f.assignment_id}
            setMovedAway={setMovedAway}
            setCollapsingRows={setCollapsingRows}
          />
        </div>
      )
    }),
    ...commitNotices.map((f, i) => {
      const index = overCapacityRows.length + danglingRows.length + collapsingOnlyRows.length + i
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
          // F6 (Code Reviewer round 3) — routed through the SAME copy table
          // FinalizeFindingsList uses: `f.message ?? f.kind ?? JSON.stringify(f)`
          // printed a raw finding kind code to a director in this
          // ALWAYS-VISIBLE run-state area the moment a future kind without a
          // `.message` reached it — the same defect class this screen's own
          // Finalize-refusal fix (C2) already closed on the adjacent surface.
          // Every kind reaching commitNotices today (PREFERENCE_EDIT_HELD)
          // always carries `.message`, so this changes nothing for them; it
          // only changes what an unrecognised future kind degrades to.
          message={finalizeFindingMessage(f, { days, timeBlocks })}
        />
      )
    }),
    // C1 — one row per (label, tier) group, each camper named reachable
    // behind BundleMismatchGroupNames' disclosure rather than dropped.
    ...bundleMismatchGroups.map((g, i) => {
      const index = overCapacityRows.length + danglingRows.length + collapsingOnlyRows.length + commitNotices.length + i
      const testId = `run-state-bundle-mismatch-${g.label}-${g.tierId ?? 'unresolved'}`
      return (
        <RunStateRow
          key={`bundle-mismatch-${g.label}-${g.tierId ?? 'unresolved'}`}
          testId={testId}
          first={index === 0}
          last={index === stateRowCount - 1}
          message={<>{bundleTierNotCoveredGroupMessage(g)} <BundleMismatchGroupNames names={g.names} /></>}
        />
      )
    }),
    // (C)(4) — one row, the count, names behind the same disclosure idiom.
    // No banner for the clean case: nothing renders when the list is empty.
    sheetOnlyCamperNames.length > 0 ? (() => {
      const index = overCapacityRows.length + danglingRows.length + collapsingOnlyRows.length + commitNotices.length + bundleMismatchGroups.length
      return (
        <RunStateRow
          key="sheet-only-campers"
          testId="run-state-sheet-only-campers"
          first={index === 0}
          last={index === stateRowCount - 1}
          message={<>{sheetOnlyCampersMessage(sheetOnlyCamperNames.length)} <BundleMismatchGroupNames names={sheetOnlyCamperNames} /></>}
        />
      )
    })() : null,
    // T250 A2 — appended AFTER the over-capacity and dangling rows: whatever
    // refusal the last Finalize attempt produced, inline in the run's own
    // run-state area rather than a separate block.
    finalizeRefusal ? (
      <FinalizeRefusalRow
        // F4 — keyed on the report sequence, not a static string, so EVERY
        // reported refusal is a genuine remount (see finalizeRefusalSeq's
        // own comment above).
        key={`finalize-refusal-${finalizeRefusalSeq}`}
        refusal={finalizeRefusal}
        onRegenerate={regenerate}
        lockedAssignments={lockedAssignments}
        days={days}
        timeBlocks={timeBlocks}
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
          <div data-testid="run-satisfaction-summary" style={styles.summary} ref={summaryRef} tabIndex={-1}>
            {satisfactionSummary({ rows, preferences: state.preferences, occurrences: state.occurrences, days, timeBlocks })}
          </div>

          {/* Owner/organizer ruling, 2026-09-30 — the actions band is
              positioned ABOVE the run-state area, so Finalize is never pushed
              below a long findings list. This CONTRADICTS the layout order
              docs/work/specs/2026-09-25-t250-run-state-surface.md originally
              fixed ("Layout"); that spec has a dated amendment note recording
              the change — see its "Layout" section. */}
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
              {regenerate ? (
                <button
                  className="press-97"
                  style={S.btnSecondary}
                  onClick={() => regenerate({ lockedAssignments })}
                >
                  Re-derive and regenerate
                </button>
              ) : null}
            </div>
          ) : null}

          {/* T320 part 2 item 3 — the roster for a cold-open regenerate is now
              the SHEET's own, sourced from elective_run_findings
              (SHEET_CAMPER_WITHOUT_PREFERENCE), so a camper who ranked nothing
              and was placed nowhere is still in scope. T250 A3's sentence here
              said "not the original sheet's full roster", which was honest of
              the old (preferences ∪ assignments) derivation and is no longer
              true. */}
          {regenerate && coldRegenerate ? (
            <div data-testid="run-cold-regenerate-note" style={styles.actionsHint}>
              Regenerating a reopened run reconsiders every camper this run's sheet named — including anyone
              with no ranked choice and no placement.
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
              {regenerate ? (
                <button
                  className="press-97"
                  data-testid="run-preference-resolve"
                  style={S.btnSecondary}
                  onClick={() => {
                    setPreferencesEdited(false)
                    regenerate({ preferences: state.preferences, choices: state.choices, lockedAssignments })
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
                // T250 B3 / Round 2 FIX 3 — two same-named campers on this
                // table read identically without something beside the name
                // to tell them apart, and the value shown must actually
                // distinguish them (resolveCamperDisambiguators is computed
                // over the whole roster above, not per row).
                const disambiguator = camperDisambiguators.get(r.camper_id) ?? null
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
