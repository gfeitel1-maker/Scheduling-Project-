import { appendOp, DELETE_FIELD } from './operations.js'

// Permanently delete an event and every row scoped to it, in one
// transaction, children before parent, every delete routed through the
// op-log so it replicates and is auditable — same cascade discipline as
// deleteSpecialDay.js, extended to THREE children (docs/adr/2026-08-22-
// event-internal-subschedule.md §3).
//
// Cascade order — load-bearing, do not reorder:
//   1. event_slots        (no FK on event_group_id/time_block_id/activity_id/
//                           location_id, real FK on event_id — must go first
//                           regardless)
//   2. event_time_blocks   (real FK -> events)
//   2. event_groups        (real FK -> events; order between this and
//                           event_time_blocks is unconstrained — neither FKs
//                           the other)
//   3. events               (the parent row itself, last)
//
// Not called from any IPC handler yet — Slice 1 shipped with no event-delete
// UI at all (restore.js: "events: refused: no delete UI yet"). This is the
// cascade primitive a future delete-UI slice will wire up; exercised
// directly by deleteEvent.test.js in this slice so the tombstone behavior is
// pinned before any caller exists.
//
// Returns { ops } for the caller to broadcast after commit,
// or { error: 'not-found' } if the event doesn't exist.
export function deleteEvent(db, { eventId }, { author_user_id, device_id } = {}) {
  if (typeof eventId !== 'string' || !eventId) return { error: 'not-found' }

  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) {
    return { error: 'not-found' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = db.transaction(() => {
    const ops = []

    const slots = db.prepare('SELECT id FROM event_slots WHERE event_id = ?').all(eventId)
    for (const s of slots) ops.push(del('event_slots', s.id))

    const timeBlocks = db.prepare('SELECT id FROM event_time_blocks WHERE event_id = ?').all(eventId)
    for (const tb of timeBlocks) ops.push(del('event_time_blocks', tb.id))

    const groups = db.prepare('SELECT id FROM event_groups WHERE event_id = ?').all(eventId)
    for (const g of groups) ops.push(del('event_groups', g.id))

    ops.push(del('events', eventId))

    return { ok: true, ops }
  })()

  return outcome
}
