import { appendOp, DELETE_FIELD } from './operations.js'

// Permanently delete an elective set and every row scoped to it, in one
// transaction, children before parent, every delete routed through the
// op-log so it replicates and is auditable — same cascade discipline as
// deleteSpecialDay.js, mirrored here for T41 slice 1
// (docs/work/specs/2026-08-20-group-electives-design.md): "Deleting an
// elective_sets row cascades its elective_set_activities".
//
// template_slots rows pointing at a deleted elective set are deliberately
// NOT touched here — the design doc calls this out explicitly: "any
// template_slots pointing at a deleted set render empty (soft, like any
// deleted reference)". Render resolves elective_set_id by id at read time
// (like every other slot reference), so a dangling id just renders nothing;
// no cascade write into template_slots is needed or correct.
//
// Cascade order — load-bearing, do not reorder:
//   1. elective_set_activities (real FK -> elective_sets, must go first)
//   2. elective_sets            (the parent row itself, last)
//
// Not called from any IPC handler yet — the setup-CRUD UI that would call
// this (create/edit/delete an elective set) is this slice's explicit
// non-goal. This is the cascade primitive the follow-on slice 2 UI will wire
// up; exercised directly by deleteElectiveSet.test.js in this slice so the
// tombstone behavior is pinned before any caller exists.
//
// Returns { ops } for the caller to broadcast after commit,
// or { error: 'not-found' } if the elective set doesn't exist.
export function deleteElectiveSet(db, { electiveSetId }, { author_user_id, device_id } = {}) {
  if (typeof electiveSetId !== 'string' || !electiveSetId) return { error: 'not-found' }

  if (!db.prepare('SELECT 1 FROM elective_sets WHERE id = ?').get(electiveSetId)) {
    return { error: 'not-found' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = db.transaction(() => {
    const ops = []

    const members = db
      .prepare('SELECT id FROM elective_set_activities WHERE elective_set_id = ?')
      .all(electiveSetId)
    for (const m of members) ops.push(del('elective_set_activities', m.id))

    ops.push(del('elective_sets', electiveSetId))

    return { ok: true, ops }
  })()

  return outcome
}
