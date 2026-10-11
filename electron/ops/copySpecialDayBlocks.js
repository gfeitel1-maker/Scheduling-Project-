import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'

// Copying a special day's time blocks and fixed-event cells as ONE write: a single runAtomic
// (one SQLite transaction, Automerge flushed once after commit), so a half-copied day cannot
// exist and an editor opened meanwhile sees all of it or none. Every row still goes through
// appendOp, so the op log, Trash and history record each creation like an ordinary write.
//
// The renderer decides WHAT to copy (which blocks, which cells); this decides what is free:
// a cell that already holds an activity is kept and reported, never overwritten.
//
// Returns { ok: true, blocksWritten, cellsWritten, skipped: [message] } or { ok: false, reason }.
export function copySpecialDayBlocks(db, { specialDayId, blocks = [], cells = [] }, { author_user_id, device_id } = {}) {
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!db.prepare('SELECT 1 FROM special_days WHERE id = ? AND camp_id = ?').get(specialDayId, camp?.id)) {
    return { ok: false, reason: 'unknown-special-day' }
  }
  const blockExists = db.prepare('SELECT 1 FROM special_day_time_blocks WHERE id = ?')
  if (blocks.some((b) => blockExists.get(b.id))) return { ok: false, reason: 'block-exists' }
  const incoming = new Set(blocks.map((b) => b.id))
  const ownBlock = db.prepare('SELECT 1 FROM special_day_time_blocks WHERE id = ? AND special_day_id = ?')
  if (cells.some((c) => !incoming.has(c.blockId) && !ownBlock.get(c.blockId, specialDayId))) {
    return { ok: false, reason: 'unknown-block' }
  }

  const write = (entity, id, field, value) =>
    appendOp(db, { entity, entity_id: id, field, value, author_user_id, device_id, source: 'human' })
  const slotAt = db.prepare('SELECT id, activity_id FROM special_day_slots WHERE special_day_id = ? AND group_id = ? AND time_block_id = ?')
  const activityName = db.prepare('SELECT name FROM activities WHERE id = ?')

  return runAtomic(db, () => {
    for (const b of blocks) {
      write('special_day_time_blocks', b.id, 'special_day_id', specialDayId)
      write('special_day_time_blocks', b.id, 'name', b.name)
      write('special_day_time_blocks', b.id, 'sort_order', b.sort_order ?? 0)
      if (b.start_time) write('special_day_time_blocks', b.id, 'start_time', b.start_time)
      if (b.end_time) write('special_day_time_blocks', b.id, 'end_time', b.end_time)
    }
    let cellsWritten = 0
    const skipped = []
    for (const c of cells) {
      const row = slotAt.get(specialDayId, c.groupId, c.blockId)
      if (row?.activity_id) {
        if (row.activity_id !== c.activityId) {
          const kept = activityName.get(row.activity_id)?.name ?? 'Another activity'
          skipped.push(`${kept} kept in ${c.groupName} ${c.blockLabel} — ${c.eventName} not added there`)
        }
        continue
      }
      const id = row?.id ?? randomUUID()
      if (!row) {
        write('special_day_slots', id, 'special_day_id', specialDayId)
        write('special_day_slots', id, 'group_id', c.groupId)
        write('special_day_slots', id, 'time_block_id', c.blockId)
      }
      write('special_day_slots', id, 'activity_id', c.activityId)
      if (c.locationId) write('special_day_slots', id, 'location_id', c.locationId)
      cellsWritten += 1
    }
    return { ok: true, blocksWritten: blocks.length, cellsWritten, skipped }
  })
}
