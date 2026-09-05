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

  // Outstanding failures keyed by `field`, not a single "last" slot. This is
  // the fix for the falsely-resolved-entity defect: a success on op #7's
  // field must only supersede a prior failure on that SAME field (genuine
  // field-level last-write-wins) — it must never clear a failure recorded
  // for a DIFFERENT field, because that field's write is still missing from
  // the projected row regardless of what happened to other fields later in
  // the replay.
  //
  // DELETE_FIELD (the sentinel '__deleted__' from operations.js) falls out
  // of this same keying for free: applyProjection compares op.field to that
  // literal sentinel, so every delete op for this entity carries the exact
  // same field value ('__deleted__'), which never collides with any real
  // column name. A failed delete is therefore only superseded by a LATER
  // delete op that succeeds — never by an ordinary field write — which is
  // the correct semantics (the FK-blocked-delete scenario the ADR names: the
  // row must stay present, and reported as failed, until a delete actually
  // goes through).
  const outstanding = new Map() // field -> { op, error }

  for (const op of ops) {
    try {
      if (isBulkReplaceOp(op)) {
        applyBulkReplaceProjection(db, op) // already a self-contained delete+reinsert
      } else {
        db.transaction(() => applyProjection(db, op))()
      }
      outstanding.delete(op.field)
    } catch (err) {
      // Keep replaying later ops for this entity — don't abort the pass —
      // so a later op on a DIFFERENT field still gets applied even though
      // this one failed.
      outstanding.set(op.field, { op, error: err })
    }
  }

  if (outstanding.size > 0) {
    const now = new Date().toISOString()
    for (const { op, error } of outstanding.values()) {
      db.prepare(
        `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(op_id) DO UPDATE SET error_message = excluded.error_message, failed_at = excluded.failed_at`
      ).run(op.id, op.entity, op.entity_id, op.field, error.message, now)
    }
    const reasons = Array.from(outstanding.values())
      .map(({ error }) => error.message)
      .join('; ')
    return { ok: false, reason: reasons }
  }

  // Zero failures outstanding means every op in this entity's whole history
  // just replayed cleanly (in seq order) onto the projected row — a full,
  // clean rebuild of the entity's projected state, not merely "the last op
  // succeeded". That genuinely supersedes every previously-recorded failure
  // for this entity, including ones on fields that didn't fail THIS pass
  // (their earlier failure was on some now-fully-replayed field, and this
  // pass just replayed it successfully too, or it would still be in
  // `outstanding`). So resolving by entity/entity_id wholesale is correct
  // here, unlike the old code's version of the same wholesale resolve — the
  // difference is this line is now only reached when outstanding is empty.
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
