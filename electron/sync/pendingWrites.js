// Durable backing store for syncClient's write queue (Task 10 round-5 Fix
// 1). See the pending_writes table comment in electron/db/schema.sql for
// why this exists: without it, a queued offline write's resolution choice
// vanished with zero trace if the app closed/crashed before flushQueue
// synced it, while the UI had already confidently shown "Saved".

// Second SQLite bind site for a field-level op's `value`, reached only on the
// LAN-Client offline/unauthenticated path (syncClient's write() -> queue). It
// has the same object/boolean binding hazard appendOp does, and appendOp's
// coercion does NOT cover it — this INSERT happens on the Client long before
// the op ever reaches a Host's appendOp. `value` must therefore already be
// coerced (coerceOpValue) by the caller: syncClient.write() does it once, so
// the durable row here and the in-memory queue item hold the identical value.
// This stays a dumb writer — coercing here too would let those two diverge.
//
// S2a provenance (ADR §4, R4): pending_writes deliberately does NOT carry a
// `source` column. Every write that lands here comes from the interactive edit
// seam, whose provenance is 'human'; on reload the queued write re-enters the
// submit path (performWrite -> handleSubmitOp), which FORCES source:'human'
// regardless. A human->NULL degradation would also be safe (NULL decodes to
// human, §3), so nothing here can ever reload as 'import'. Adding a column
// would buy no correctness — the DECIDED choice is the documented degradation:
// pending_writes stores no source and the reloaded write is re-stamped 'human'
// by the submit path. 'import' writes never reach this queue (they are
// host-local commitPlan writes, never queued offline client edits).
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
