import { randomUUID } from 'node:crypto'
import { PROJECTIONS, applyProjection } from './projections.js'

export function appendOp(db, { entity, entity_id, field, value, author_user_id, device_id, parent_op_id }) {
  const projection = PROJECTIONS[entity]
  if (projection && !projection.fields.includes(field)) {
    throw new Error('field not allowed for entity')
  }

  const id = randomUUID()
  const timestamp = new Date().toISOString()

  const run = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, entity, entity_id, field, value, author_user_id ?? null, device_id, timestamp, parent_op_id ?? null)

    const op = db.prepare('SELECT * FROM operations WHERE seq = ?').get(result.lastInsertRowid)
    applyProjection(db, op)
    return op
  })

  return run()
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
