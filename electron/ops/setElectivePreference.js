// Editing ONE camper's elective preference for ONE cell, from inside the app
// (T297, docs/work/tickets/T297-edit-a-campers-elective-preferences.md).
//
// Before this, preferences entered by import and were read-only thereafter, so a
// camper changing their mind meant correcting the file and importing it again —
// and since T285 keys a submission by content hash, a corrected file is a
// DIFFERENT submission producing a NEW run rather than amending this one.
//
// Same conventions as its sibling setElectiveAssignment.js: every write goes
// through appendOp so it replicates and is undoable, the whole edit is ONE
// transaction, and refusals are RETURNED as {ok:false,error} rather than thrown.
//
// WHAT MAKES THIS AN EDIT AND NOT AN IMPORT — the part that matters.
//
// Every op here carries `source:'human'`. That is not decoration: it is what
// docs/adr/2026-09-09-field-provenance-in-the-document.md reads back through
// isHumanOwned(), and what commitElectiveRun now consults before overwriting a
// preference on a later import. A removal is an explicit `source:'human'`
// DELETE_FIELD op for the same reason, following ingest.js's rejectedSlotKeys:
// an import teardown's null-source delete is excluded from that by a `===` check,
// so a director's deliberate removal is distinguishable from the importer's own
// housekeeping.
//
// THE DIRECTOR CONFIRMS; THIS FUNCTION DECIDES NOTHING. `choiceId`, `rank` and
// `rankKind` are all stated by the caller. Nothing here infers an edit from a
// placement, a solve, or a near-miss label.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
import { deriveElectivePreferenceId } from './electiveDerivedIds.js'
import { coordinateOf, sameDayLabel, samePeriodLabel } from '../../src/ingest/preferenceCoordinateKeys.js'

const HUMAN = 'human'

// A camper this run actually contains. Preferences OR assignments, because the
// two populations are not identical: a camper whose every coordinate failed to
// bind has assignment rows and no usable preference row, and a camper the
// director has yet to place has the reverse. Either way they are in the run, and
// refusing to edit them would refuse exactly the cases most likely to need it.
function inRun(db, runId, camperId) {
  return !!db
    .prepare(
      `SELECT 1 FROM elective_preferences WHERE run_id = ? AND camper_id = ?
       UNION ALL
       SELECT 1 FROM elective_assignments WHERE run_id = ? AND camper_id = ?
       LIMIT 1`
    )
    .get(runId, camperId, runId, camperId)
}

function draftRun(db, runId) {
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  if (!run) return { error: 'run not found' }
  // A finalized run is immutable and there is no reopen (ADR decision (a)), the
  // same rule setElectiveAssignment.js enforces on the placement side.
  if (run.status === 'final') return { error: 'RUN_NOT_DRAFT' }
  return { run }
}

/**
 * The cell, named as the CAMP names it.
 *
 * Both halves are used: to find the stored rows this edit supersedes, and to
 * stamp the new row's coordinate columns. Stamping them is what keeps the row
 * legible when no template is loaded — an edit made against Monday/Period 1
 * should still say "Monday, Period 1" on a device that has never derived this
 * run's occurrences. The schema's "stored as the file wrote them" note is about
 * a FILE; an edit has no file, and the camp's own labels are the truthful
 * provenance for one.
 */
function cellOf(db, occurrenceId) {
  return db
    .prepare(
      `SELECT o.run_id, d.label AS day_label, t.name AS block_name
         FROM elective_occurrences o
         LEFT JOIN days_of_operation d ON d.id = o.day_id
         LEFT JOIN time_blocks t ON t.id = o.time_block_id
        WHERE o.id = ?`
    )
    .get(occurrenceId)
}

/**
 * The rows this edit replaces.
 *
 * A cell holds ONE chosen activity, so setting it must remove what was there or
 * the engine sees two rank-1 preferences for one cell and the correction merely
 * TIES with the value being corrected — a silent no-op, which is the defect class
 * this whole program exists to remove.
 *
 * Two shapes have to be recognised, and missing the second one is the trap:
 * commitElectiveRun persists the UNRESOLVED parsed sheet (AssignmentPanel's
 * commit() passes `parsed`, and coordinate->occurrence binding is solve-time and
 * template-scoped), so a planner-grid sheet's rows carry occurrence_id NULL and a
 * coordinate. Matching only on occurrence_id would leave every one of them live.
 *
 * DELIBERATELY NOT SUPERSEDING A BROADER ROW. A whole-run fallback (no
 * coordinate) and a half-coordinate row (which resolvePreferenceCoordinates
 * reports as COORDINATE_INCOMPLETE and leaves as a whole-run fallback) both say
 * something about more than this one cell. A director who edited one cell has
 * said nothing about those, and deleting them would be the app deciding.
 */
function supersededRows(db, { runId, camperId, occurrenceId, cell }) {
  return db
    .prepare('SELECT * FROM elective_preferences WHERE run_id = ? AND camper_id = ?')
    .all(runId, camperId)
    .filter((r) => {
      if (r.occurrence_id != null) return r.occurrence_id === occurrenceId
      if (r.coordinate_day_label == null || r.coordinate_period_label == null) return false
      return (
        sameDayLabel(r.coordinate_day_label, cell.day_label) &&
        samePeriodLabel(r.coordinate_period_label, cell.block_name)
      )
    })
}

/**
 * State one camper's preference, either by CORRECTING an existing row or by
 * adding one for a cell that has none.
 *
 * THE SCOPE IS INHERITED, NOT IMPOSED, and getting this wrong makes the whole
 * feature a no-op on half the sheets this app reads.
 *
 * `replacesPreferenceId` names the row the director is correcting, and the new
 * row takes over THAT row's scope — its occurrence_id and its coordinate. The
 * reason is the engine's own precedence: `rankAt` prefers an occurrence-scoped
 * rank over a whole-run fallback for the SAME choice, but two DIFFERENT choices
 * both at rank 1 simply tie. So correcting a whole-run ranked list ("Gaga 1st,
 * Archery 2nd") by writing a cell-scoped Ceramics row would leave the Gaga
 * fallback live at rank 1 and the solver would have no reason to prefer either —
 * the director's correction would tie with the value being corrected and might
 * well lose. Inheriting the scope means a whole-run statement is corrected by a
 * whole-run statement and a cell by a cell, which is also the honest reading:
 * a director fixing one row has not said anything about the camper's other
 * answers.
 *
 * With no `replacesPreferenceId` this is an ADD, for the case the panel makes
 * visible in bronze — a camper placed in an activity they never requested has a
 * placement and no preference row to correct.
 *
 * @returns {{ok:true, preferenceId:string, supersededIds:string[]}
 *  | {ok:false, error:'RUN_NOT_DRAFT'|'CAMPER_NOT_IN_RUN'|'CHOICE_NOT_IN_RUN'
 *                    |'OCCURRENCE_NOT_IN_RUN'|'PREFERENCE_NOT_IN_RUN'|string}}
 */
export function setElectivePreference(db, {
  runId, camperId, occurrenceId, choiceId, rank, rankKind,
  replacesPreferenceId = null, authorUserId = null, deviceId,
}) {
  const { run, error } = draftRun(db, runId)
  if (!run) return { ok: false, error }

  const cell = cellOf(db, occurrenceId)
  if (!cell || cell.run_id !== runId) return { ok: false, error: 'OCCURRENCE_NOT_IN_RUN' }
  if (!inRun(db, runId, camperId)) return { ok: false, error: 'CAMPER_NOT_IN_RUN' }

  // A preference names a CHOICE, and a run's choices are the labels its sheet's
  // population actually asked for. Minting a new choice here would change what
  // the sheet said, which is the label-resolution surface's business (T298), not
  // this one's — so an unknown choice is refused rather than created.
  const choice = db
    .prepare('SELECT 1 FROM elective_choices WHERE id = ? AND run_id = ?')
    .get(choiceId, runId)
  if (!choice) return { ok: false, error: 'CHOICE_NOT_IN_RUN' }

  let replaced = null
  if (replacesPreferenceId != null) {
    replaced = db
      .prepare('SELECT * FROM elective_preferences WHERE id = ? AND run_id = ? AND camper_id = ?')
      .get(replacesPreferenceId, runId, camperId)
    // Scoped to the camper too: correcting one child's row through another
    // child's id is not a thing to be forgiving about.
    if (!replaced) return { ok: false, error: 'PREFERENCE_NOT_IN_RUN' }
  }

  // The scope the new row carries. Inherited wholesale from the replaced row,
  // including a NULL occurrence_id and NULL coordinate (a whole-run fallback,
  // which must stay one).
  const scope = replaced
    ? {
      occurrence_id: replaced.occurrence_id,
      coordinate_day_label: replaced.coordinate_day_label,
      coordinate_period_label: replaced.coordinate_period_label,
    }
    : {
      occurrence_id: occurrenceId,
      coordinate_day_label: cell.day_label ?? null,
      coordinate_period_label: cell.block_name ?? null,
    }

  // No try/catch: deriveElectivePreferenceId throws only for a coordinate object
  // carrying neither key, and coordinateOf returns either null or an object with
  // both.
  const preferenceId = deriveElectivePreferenceId(
    runId, camperId, scope.occurrence_id, choiceId, coordinateOf(scope)
  )

  // Computed before the transaction so the id being written is never itself
  // tombstoned — re-stating the same choice (a director correcting only the
  // rank, or simply confirming) must land on the existing row rather than delete
  // it and write it back.
  //
  // A REPLACE supersedes exactly the named row and nothing else: the director
  // corrected one statement, so exactly one statement changes. An ADD supersedes
  // whatever already names that cell, which is what keeps a planner-grid sheet's
  // coordinate-keyed row from surviving alongside the new one.
  const superseded = (replaced ? [replaced] : supersededRows(db, { runId, camperId, occurrenceId, cell }))
    .filter((r) => r.id !== preferenceId)

  try {
    runAtomic(db, () => {
      for (const row of superseded) {
        appendOp(db, {
          entity: 'elective_preferences', entity_id: row.id, field: DELETE_FIELD, value: 1,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
          source: HUMAN,
        })
      }
      const fields = {
        run_id: runId,
        camper_id: camperId,
        choice_id: choiceId,
        rank,
        rank_kind: rankKind,
        ...scope,
      }
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, {
          entity: 'elective_preferences', entity_id: preferenceId, field, value,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
          source: HUMAN,
        })
      }
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true, preferenceId, supersededIds: superseded.map((r) => r.id) }
}

/**
 * Withdraw one preference the director says is not wanted.
 *
 * @returns {{ok:true} | {ok:false, error:'RUN_NOT_DRAFT'|'PREFERENCE_NOT_IN_RUN'|string}}
 */
export function removeElectivePreference(db, { runId, preferenceId, authorUserId = null, deviceId }) {
  const { run, error } = draftRun(db, runId)
  if (!run) return { ok: false, error }

  const row = db
    .prepare('SELECT 1 FROM elective_preferences WHERE id = ? AND run_id = ?')
    .get(preferenceId, runId)
  if (!row) return { ok: false, error: 'PREFERENCE_NOT_IN_RUN' }

  try {
    runAtomic(db, () => {
      appendOp(db, {
        entity: 'elective_preferences', entity_id: preferenceId, field: DELETE_FIELD, value: 1,
        author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        source: HUMAN,
      })
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true }
}
