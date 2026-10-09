import { appendOp, DELETE_FIELD, runAtomic } from './operations.js'
import { deriveSpecialDayPlacementId } from './electiveDerivedIds.js'

// T350 slice 2 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D5, D8, D9).
//
// Bind ALWAYS writes all three fields in one runAtomic, a rebind included: that is what makes a
// concurrent rebind re-create a complete row over another device's unbind (add-wins, D5). The
// generic write() refuses this entity, so this is the only local writer.
//
// Returns { ok: true, id, ops } or the codebase's { ok: false, reason } refusal shape.
export function bindSpecialDay(db, { weekId, dayId, specialDayId, replace = false }, { author_user_id, device_id } = {}) {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!db.prepare('SELECT 1 FROM schedule_weeks WHERE id = ? AND camp_id = ?').get(weekId, camp?.id)) {
    return { ok: false, reason: 'unknown-week' }
  }
  if (!db.prepare('SELECT 1 FROM days_of_operation WHERE id = ? AND camp_id = ?').get(dayId, camp.id)) {
    return { ok: false, reason: 'unknown-day' }
  }
  if (!db.prepare('SELECT 1 FROM special_days WHERE id = ? AND camp_id = ?').get(specialDayId, camp.id)) {
    return { ok: false, reason: 'unknown-special-day' }
  }

  const id = deriveSpecialDayPlacementId(weekId, dayId)
  const current = db.prepare('SELECT special_day_id FROM special_day_placements WHERE id = ?').get(id)
  if (current && current.special_day_id !== specialDayId && !replace) {
    return { ok: false, reason: 'occupied', currentSpecialDayId: current.special_day_id }
  }

  const write = (field, value) =>
    appendOp(db, { entity: 'special_day_placements', entity_id: id, field, value, author_user_id, device_id })

  return runAtomic(db, () => ({
    ok: true,
    id,
    ops: [write('week_id', weekId), write('day_id', dayId), write('special_day_id', specialDayId)],
  }))
}

// Unbinding deletes the placement only; the special day and the week day's stored slots are kept
// (D4.6). Undo is re-binding: restore is refused for this entity (restore.js, D8).
export function unbindSpecialDay(db, { weekId, dayId }, { author_user_id, device_id } = {}) {
  const id = deriveSpecialDayPlacementId(weekId, dayId)
  if (!db.prepare('SELECT 1 FROM special_day_placements WHERE id = ?').get(id)) return { ok: true, ops: [] }
  return runAtomic(db, () => ({
    ok: true,
    ops: [appendOp(db, { entity: 'special_day_placements', entity_id: id, field: DELETE_FIELD, value: 1, author_user_id, device_id })],
  }))
}
