// Durable backing store for the Client's restore queue (schema v25,
// docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md). See the
// pending_restores comment in electron/db/schema.sql for why the table is
// local-only and holds intent rather than data.
//
// ⚠️ VESTIGIAL as of the Stage 6c cutover. _Prior: "Dumb SQL, deliberately —
// mirroring pendingWrites.js. Every decision about WHEN to insert, when to
// retry, and what counts as success lives in the drainer (syncClient.js), not
// here." Both syncClient.js and pendingWrites.js were deleted at that cutover,
// and the drainer with them. `insertPendingRestore` has no caller outside tests,
// so nothing enqueues and nothing drains; electron/main.js imports only
// `listPendingRestores`, a read that can now only ever return rows written by a
// pre-cutover build. The queue existed so a Client could ask an unreachable Host
// to restore a record from ITS op log; there is no Host to ask, and each device
// restores from its own log (see electron/ops/restore.js). Whether the module and
// its table should be removed is a code and schema change, not a comment fix;
// T311 records it rather than acting on it._

import { randomUUID } from 'node:crypto'
import { lastKnownFields, nameFieldFor } from '../ops/restore.js'

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

// T18: `name` is resolved here rather than left to the screen, which used to
// render the raw entity_id — "Group . 8f3c1a02-..." — in the "Waiting on the
// main computer" list. A director cannot tell which group that is, so the row
// was unactionable. Same source as listDeleted, so the two lists cannot name
// the same record differently.
//
// The name comes from the op log, not from the live row: the record is deleted,
// so there is no row to read it from.
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
      name: lastKnownFields(db, row.entity, row.entity_id).get(nameFieldFor(row.entity)) ?? null,
    }))
}
