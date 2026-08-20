import { appendOp, DELETE_FIELD } from './operations.js'

// Permanently delete a special day and every row scoped to it, in one
// transaction, children before parent, every delete routed through the
// op-log so it replicates and is auditable — same cascade discipline as
// deleteWeek.js, mirrored here for T40 slice 1
// (docs/work/specs/2026-08-20-special-days-data-shape-design.md): "Deleting a
// special_days row (throwaway semantics) must tombstone its time blocks and
// slots ... no orphaned children remain."
//
// Cascade order — load-bearing, do not reorder:
//   1. special_day_slots       (no FK on group_id/activity_id/location_id,
//                                real FK on special_day_id — must go first
//                                regardless)
//   2. special_day_time_blocks (real FK -> special_days)
//   3. special_days             (the parent row itself, last)
//
// Not called from any IPC handler yet — the author UI that would call this
// (create/edit/delete a special day) is this slice's explicit non-goal. This
// is the cascade primitive the follow-on UI slice will wire up; exercised
// directly by deleteSpecialDay.test.js in this slice so the tombstone
// behavior is pinned before any caller exists.
//
// Returns { ops } for the caller to broadcast after commit,
// or { error: 'not-found' } if the special day doesn't exist.
export function deleteSpecialDay(db, { specialDayId }, { author_user_id, device_id } = {}) {
  if (typeof specialDayId !== 'string' || !specialDayId) return { error: 'not-found' }

  if (!db.prepare('SELECT 1 FROM special_days WHERE id = ?').get(specialDayId)) {
    return { error: 'not-found' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = db.transaction(() => {
    const ops = []

    const slots = db
      .prepare('SELECT id FROM special_day_slots WHERE special_day_id = ?')
      .all(specialDayId)
    for (const s of slots) ops.push(del('special_day_slots', s.id))

    const timeBlocks = db
      .prepare('SELECT id FROM special_day_time_blocks WHERE special_day_id = ?')
      .all(specialDayId)
    for (const tb of timeBlocks) ops.push(del('special_day_time_blocks', tb.id))

    ops.push(del('special_days', specialDayId))

    return { ok: true, ops }
  })()

  return outcome
}
