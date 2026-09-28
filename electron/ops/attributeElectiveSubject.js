// Naming an UNATTRIBUTED SUBJECT — the other half of T285's identity key.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// §14.1a ("we do not question the shape data arrives in — we LAND it, then RESOLVE
// it"). This is the RESOLVE half of that sentence for identity.
//
// A planner grid is one camper's own sheet and carries no name column, because the
// identity comes from the SUBMISSION rather than the page. When nothing names the
// child, the import lands the answers against a provisional subject keyed on the
// submission's content hash and flags it `is_unattributed`. The import's residue
// then promises: *"name the camper when you know them, and nothing needs
// re-importing."* **This module is what makes that sentence true** — before it,
// `is_unattributed` had one writer and ZERO readers, and the promise was false.
//
// WHY THIS IS A REKEY AND NOT AN UPDATE, which is the whole reason the module is
// non-trivial. `deriveCamperId` keys on `(external_id ?? display_name)`, so the
// provisional subject's id is derived from the submission hash and a named camper's
// id is derived from their name: they are DIFFERENT IDS for the same child. Simply
// writing the name onto the provisional row would leave a camper whose id says
// "submission 3f2a…" forever — invisible to every later import of that name, which
// would mint a second record. **That converts a merge bug into a FORK bug, and a
// fork is worse than a merge: a merged row is visibly wrong, while both halves of a
// fork look correct.** So the row is re-derived onto the canonical id, its
// preferences and assignments are moved, and the provisional row is deleted.
//
// Every write goes through appendOp, never a direct INSERT or UPDATE — that is what
// makes these rows replicate and what backs Trash, Restore and entity history. The
// whole rekey is ONE transaction: a half-moved subject would leave preferences
// pointing at a deleted camper, which no screen can render and no export can
// explain.

import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic, DELETE_FIELD } from './operations.js'
import { deriveCamperId, deriveElectivePreferenceId, deriveElectiveAssignmentId } from './electiveDerivedIds.js'

/**
 * @returns {{ok: true, camperId, moved: {preferences, assignments}, rekeyed: boolean}
 *          | {ok: false, error: string}}
 */
export function attributeElectiveSubject(db, {
  campId,
  deviceId,
  authorUserId = null,
  subjectId,
  displayName,
  externalId = null,
}) {
  const name = String(displayName ?? '').trim()
  if (!name) return { ok: false, error: 'a camper name is required to attribute this sheet' }

  const subject = db
    .prepare('SELECT id, display_name, group_id, division_label, is_unattributed FROM campers WHERE id = ?')
    .get(subjectId)
  if (!subject) return { ok: false, error: `no camper row ${subjectId} in this camp's database` }

  // ONLY a provisional subject may be attributed. An ordinary named camper is not a
  // subject awaiting a name, and letting this path rename one would re-key a real
  // child's identity as a side effect — silently orphaning them from every other
  // import of their name, which is the fork this module exists to prevent.
  if (subject.is_unattributed !== 1) {
    return {
      ok: false,
      error:
        `${subject.display_name || subjectId} is not an unattributed subject, so there is no name to ` +
        'fill in. Renaming a camper who is already identified would give them a new identity and ' +
        'disconnect them from their other records.',
    }
  }

  const camperId = deriveCamperId(campId, { externalId: externalId || null, displayName: name })

  const write = (entity, entity_id, fields) => {
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue
      appendOp(db, {
        entity, entity_id, field, value,
        author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
      })
    }
  }
  const remove = (entity, entity_id) =>
    appendOp(db, {
      entity, entity_id, field: DELETE_FIELD, value: 1,
      author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
    })

  // Read BEFORE the transaction so the moves are computed from a stable set.
  const preferences = db
    .prepare(
      `SELECT id, run_id, occurrence_id, choice_id, rank, rank_kind,
              coordinate_day_label, coordinate_period_label
         FROM elective_preferences WHERE camper_id = ?`
    )
    .all(subjectId)
  const assignments = db
    .prepare(
      `SELECT id, run_id, occurrence_id, activity_id, choice_id, preference_rank, source, solver_generation, is_locked
         FROM elective_assignments WHERE camper_id = ?`
    )
    .all(subjectId)

  // Already canonical: nothing to move, just stop calling them provisional. Reached
  // when a camp's roster genuinely has no external id and the submission hash
  // happened to be the key — rare, but a no-op must not delete the row it is
  // rekeying onto.
  if (camperId === subjectId) {
    try {
      runAtomic(db, () => write('campers', camperId, { display_name: name, is_unattributed: null }))
    } catch (e) {
      return { ok: false, error: e.message }
    }
    return { ok: true, camperId, moved: { preferences: 0, assignments: 0 }, rekeyed: false }
  }

  try {
    runAtomic(db, () => {
      // The named row first, so nothing is ever moved onto a camper that does not
      // exist yet.
      write('campers', camperId, {
        camp_id: campId,
        display_name: name,
        external_id: externalId || null,
        is_active: 1,
        // Carried, not dropped: whatever the import resolved about this child is
        // still true of them under their name.
        group_id: subject.group_id ?? undefined,
        division_label: subject.division_label ?? undefined,
        // Deliberately NOT written: absent means "an ordinary camper", which is what
        // this row now is. Writing 0 would make "attributed" a stored state that has
        // to be kept in step with the name.
      })

      for (const p of preferences) {
        // The preference id is derived from the camper id, so moving a preference is
        // re-deriving it. The coordinate goes back in because the `at` arm keys on
        // it — omitting it here would collapse a planner's cells onto the whole-run
        // fallback, which is the exact loss the coordinate columns were added for.
        const coordinate =
          p.coordinate_day_label != null || p.coordinate_period_label != null
            ? { dayName: p.coordinate_day_label, periodLabel: p.coordinate_period_label }
            : null
        write(
          'elective_preferences',
          deriveElectivePreferenceId(p.run_id, camperId, p.occurrence_id ?? null, p.choice_id, coordinate),
          {
            run_id: p.run_id,
            camper_id: camperId,
            occurrence_id: p.occurrence_id ?? null,
            choice_id: p.choice_id,
            rank: p.rank,
            rank_kind: p.rank_kind,
            coordinate_day_label: p.coordinate_day_label,
            coordinate_period_label: p.coordinate_period_label,
          }
        )
        remove('elective_preferences', p.id)
      }

      for (const a of assignments) {
        write('elective_assignments', deriveElectiveAssignmentId(a.run_id, camperId, a.occurrence_id), {
          run_id: a.run_id,
          occurrence_id: a.occurrence_id,
          camper_id: camperId,
          activity_id: a.activity_id,
          choice_id: a.choice_id,
          preference_rank: a.preference_rank,
          source: a.source,
          solver_generation: a.solver_generation,
          is_locked: a.is_locked,
        })
        remove('elective_assignments', a.id)
      }

      // The provisional row goes LAST, once nothing points at it.
      remove('campers', subjectId)
    })
  } catch (e) {
    // The transaction rolled back; nothing was written and the subject is untouched.
    return { ok: false, error: e.message }
  }

  return {
    ok: true,
    camperId,
    moved: { preferences: preferences.length, assignments: assignments.length },
    rekeyed: true,
  }
}
