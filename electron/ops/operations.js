import { randomUUID } from 'node:crypto'

export function appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id }) {
  const id = randomUUID()
  const timestamp = new Date().toISOString()

  const result = db
    .prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, entity, entity_id, field, value, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null)

  return db.prepare('SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
}

export function latestOp(db, entity, entity_id, field) {
  return db
    .prepare(
      `SELECT * FROM operations WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY seq DESC LIMIT 1`
    )
    .get(entity, entity_id, field)
}

export function detectConflict(db, incomingOp) {
  const existingOp = latestOp(db, incomingOp.entity, incomingOp.entity_id, incomingOp.field)
  if (!existingOp) return { conflict: false }
  if (existingOp.id === incomingOp.parent_op_id) return { conflict: false }
  return { conflict: true, existingOp }
}
