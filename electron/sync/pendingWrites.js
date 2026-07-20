// Durable backing store for syncClient's write queue (Task 10 round-5 Fix
// 1). See the pending_writes table comment in electron/db/schema.sql for
// why this exists: without it, a queued offline write's resolution choice
// vanished with zero trace if the app closed/crashed before flushQueue
// synced it, while the UI had already confidently shown "Saved".

export function insertPendingWrite(db, { pendingId, client_write_id, entity, entity_id, field, value, parent_op_id }) {
  db.prepare(
    `INSERT INTO pending_writes (pending_id, client_write_id, entity, entity_id, field, value, parent_op_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    pendingId,
    client_write_id,
    entity,
    entity_id,
    field,
    value ?? null,
    parent_op_id ?? null,
    new Date().toISOString()
  )
}

export function deletePendingWrite(db, pendingId) {
  db.prepare('DELETE FROM pending_writes WHERE pending_id = ?').run(pendingId)
}

export function listPendingWrites(db) {
  return db.prepare('SELECT * FROM pending_writes ORDER BY created_at ASC').all().map((row) => ({
    pendingId: row.pending_id,
    client_write_id: row.client_write_id,
    entity: row.entity,
    entity_id: row.entity_id,
    field: row.field,
    value: row.value,
    parent_op_id: row.parent_op_id,
  }))
}
