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

// Durably records a detected conflict so it can be rehydrated after an app
// restart — the live usePendingConflicts hook is fed exclusively by
// in-memory broadcast events, so without this a pending (or even a
// resolved-but-not-yet-dismissed) conflict would silently vanish on
// relaunch. Called from both conflict-detection sites: syncServer's
// handleSubmitOp (host-side detection) and syncClient's ws message handler
// (client-side receipt of an op_conflict from the host).
export function recordConflict(db, { incomingOp, existingOp }) {
  const id = randomUUID()
  const created_at = new Date().toISOString()
  db.prepare(
    `INSERT INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    id,
    existingOp.entity,
    existingOp.entity_id,
    existingOp.field,
    JSON.stringify(incomingOp),
    JSON.stringify(existingOp),
    existingOp.id,
    created_at
  )
  return id
}

// Reconstructs the current set of unresolved conflicts from the op-log at
// any point in time, rather than relying on a live broadcast. A conflict
// counts as resolved once ANY op exists in the log whose parent_op_id points
// at that conflict's existing_op_id — that is exactly what resolveConflict()
// in main.js writes when a user picks a side (regardless of which side was
// chosen, the resolution write's parent_op_id is always set to the losing
// existingOp's id — see main.js's resolveConflict). Lazily marks matching
// rows resolved_at as it goes, so repeated calls are cheap.
export function listPendingConflicts(db) {
  const rows = db.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at ASC').all()
  const pending = []
  const now = new Date().toISOString()
  for (const row of rows) {
    const resolvingOp = db
      .prepare(
        'SELECT id FROM operations WHERE entity = ? AND entity_id = ? AND field = ? AND parent_op_id = ? LIMIT 1'
      )
      .get(row.entity, row.entity_id, row.field, row.existing_op_id)
    if (resolvingOp) {
      db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?').run(now, row.id)
      continue
    }
    pending.push({
      type: 'op_conflict',
      incomingOp: JSON.parse(row.incoming_op),
      existingOp: JSON.parse(row.existing_op),
    })
  }
  return pending
}
