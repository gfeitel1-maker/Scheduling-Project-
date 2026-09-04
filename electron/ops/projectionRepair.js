// Entity-scoped recovery for a projection that has fallen out of step with
// the op-log (docs/adr/2026-09-04-projection-failure-detection-and-recovery.md,
// "Recover: entity-scoped replay, not full-log rebuild"). Replays exactly one
// entity's ops, in the same seq order they were originally applied — the
// invariant applyProjection's mutually-exclusive-field eviction step depends
// on (docs/adr/2026-08-12-drag-live-write-serialization.md) — so the row is
// reconstructed exactly as replaying the whole log would have produced it,
// without touching any other entity's projected state.
//
// Callers: the automatic post-catch-up trigger in electron/sync/syncClient.js,
// and the Machine Access Program's MCP support surface (scripts/mcp/), gated
// there the same way ingest_commit already is (--allow-write). Not exposed as
// renderer-facing IPC in v1 (ADR "Product decisions" #3).
import { isBulkReplaceOp, applyBulkReplaceProjection } from './operations.js'
import { applyProjection } from './projections.js'

export function repairProjectionForEntity(db, entity, entity_id) {
  const ops = db
    .prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC')
    .all(entity, entity_id)

  let lastFailedOp = null
  let lastError = null

  for (const op of ops) {
    try {
      if (isBulkReplaceOp(op)) {
        applyBulkReplaceProjection(db, op) // already a self-contained delete+reinsert
      } else {
        db.transaction(() => applyProjection(db, op))()
      }
      lastFailedOp = null
      lastError = null
    } catch (err) {
      // Keep replaying later ops for this entity — don't abort the pass —
      // and report the LAST failure, mirroring the FK-delete scenario the
      // existing applyRemoteOp catch comment describes: something still
      // refers to a row this device can't yet delete; a later repair, run
      // after that referrer is itself resolved, succeeds.
      lastFailedOp = op
      lastError = err
    }
  }

  if (lastFailedOp) {
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(op_id) DO UPDATE SET error_message = excluded.error_message, failed_at = excluded.failed_at`
    ).run(
      lastFailedOp.id,
      lastFailedOp.entity,
      lastFailedOp.entity_id,
      lastFailedOp.field,
      lastError.message,
      new Date().toISOString()
    )
    return { ok: false, reason: lastError.message }
  }

  db.prepare(
    'UPDATE projection_failures SET resolved_at = ? WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL'
  ).run(new Date().toISOString(), entity, entity_id)
  return { ok: true }
}

// Read-side detection primitive (ADR §1, "Read side"). Cheap, indexed
// (idx_projection_failures_unresolved), safe to run on app boot or on-demand.
export function checkProjectionHealth(db) {
  const failures = db.prepare('SELECT * FROM projection_failures WHERE resolved_at IS NULL').all()
  return { failures }
}
