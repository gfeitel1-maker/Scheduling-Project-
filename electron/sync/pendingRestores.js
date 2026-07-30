// Durable backing store for the Client's restore queue (schema v25,
// docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md). See the
// pending_restores comment in electron/db/schema.sql for why the table is
// local-only and holds intent rather than data.
//
// Dumb SQL, deliberately — mirroring pendingWrites.js. Every decision about
// WHEN to insert, when to retry, and what counts as success lives in the
// drainer (syncClient.js), not here.

import { randomUUID } from 'node:crypto'

// INSERT OR IGNORE against UNIQUE(entity, entity_id): three presses of Restore
// while the Host is down produce ONE intent, and the first requester is
// recorded. This is only the cheap half of idempotency — the drainer still
// re-checks that the record is actually still deleted before sending.
export function insertPendingRestore(db, { entity, entity_id, requested_by }) {
  const pendingId = randomUUID()
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(pendingId, entity, entity_id, requested_by ?? null, new Date().toISOString())
  return { pendingId, inserted: result.changes > 0 }
}

export function deletePendingRestore(db, pendingId) {
  db.prepare('DELETE FROM pending_restores WHERE pending_id = ?').run(pendingId)
}

// A terminal failure has to live somewhere durable between the failed drain
// and the director next opening the screen — otherwise "must fail visibly"
// lasts only as long as the process does.
export function recordRestoreError(db, pendingId, error) {
  db.prepare('UPDATE pending_restores SET last_error = ? WHERE pending_id = ?').run(error ?? null, pendingId)
}

export function listPendingRestores(db) {
  return db
    .prepare('SELECT * FROM pending_restores ORDER BY requested_at ASC')
    .all()
    .map((row) => ({
      pendingId: row.pending_id,
      entity: row.entity,
      entity_id: row.entity_id,
      requested_by: row.requested_by,
      requested_at: row.requested_at,
      last_error: row.last_error,
    }))
}
