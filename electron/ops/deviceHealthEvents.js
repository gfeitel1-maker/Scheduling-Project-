// Every event where this device failed to write something down, and had no op id
// to hang the record from. Two of them are what T148 believed it was already
// recording; the third is T173's import journal.
//
// WHAT WENT WRONG, because the shape of the mistake is the useful part.
//
// T148 closed a class of defect: a write reaching SQLite but not the
// authoritative Automerge document, with nothing durable to show for it. Two of
// its three paths had no op id to key on — a merged document that will not
// project (a merge has no op) and a debounced save that fails on disk (the
// window is gone by the time it fails) — so both were routed to `audit_events`
// with `outcome: 'error'`.
//
// `audit_events.outcome` is CHECK-constrained to ('allow','deny'). Every one of
// those inserts was rejected by the constraint; `recordAuditEvent` caught the
// violation and turned it into a console line, exactly as it is designed to (an
// audit failure must never break the action it is recording). So the "durable
// trace" never landed a single row, and `check_projection_health` read those two
// actions back, found nothing, and reported HEALTHY.
//
// Absence read as success — inside the fix written to remove absence read as
// success. Measured 2026-09-15 with a three-row probe: the two 'error' rows were
// rejected, the 'deny' control landed.
//
// THE LESSON WORTH KEEPING: `recordAuditEvent` never throwing is correct, and it
// is also why nobody noticed for a week. A swallow-everything writer needs a
// caller that can ask "did that actually land?" — which is why
// `documentWriteFailureRecorded` exists on the other path, and why this module's
// tests assert the row is READ BACK rather than that the call returned.
import { randomUUID } from 'node:crypto'

export const DEVICE_HEALTH = Object.freeze({
  DOCUMENT_SAVE_FAILED: 'document_save_failed',
  PROJECTION_FAILED: 'projection_failed',
  // T173 slice 1. The import journal is diagnostics about diagnostics: it
  // records what the importer asked the director, and a failure to record THAT
  // must not fail an import. Same shape as the two above — host-local, no op id
  // to hang from, written on a failure path — which is exactly why it lives
  // here rather than in a third table of its own (see the v64 migration).
  IMPORT_JOURNAL_WRITE_FAILED: 'import_journal_write_failed',
  // A merge from a peer carried a `camp_id` write for a DIFFERENT camp than this
  // device belongs to. applyProjection's tenant guard (electron/ops/projections.js)
  // refuses it — correctly, and without throwing: it is a security rejection of a
  // hostile or buggy peer write, not a local failure, so sync must keep converging.
  // The refusal used to be a console line nobody watches; routing it here makes it
  // a durable, support-readable surface (board i-appendop-silent-camp-id-rejection,
  // OWNER 2026-10-02: "log it AND surface it so the refusal is actually seen"). It
  // is deliberately NOT `projection_failed` — a cross-camp write is not a repairable
  // projection failure; re-projecting the same document rejects it again by design.
  CROSS_CAMP_WRITE_REJECTED: 'cross_camp_write_rejected',
  // The elected device failed to rotate the rendezvous namespace/key after the revocation set
  // changed (electron/sync/automerge/rendezvousRotation.js). The revoked device may still be able
  // to read rendezvous records until a later check succeeds.
  RENDEZVOUS_ROTATION_FAILED: 'rendezvous_rotation_failed',
})

/**
 * Record one health event. Never throws — the caller is already handling a
 * failure and must not acquire a second one.
 *
 * Returns true when the row landed. Unlike `recordAuditEvent`, the answer is
 * reported rather than assumed, because assuming it is what hid the original
 * defect for a week.
 */
export function recordDeviceHealthEvent(db, { campId, kind, detail, incident, id } = {}) {
  if (!db || !kind) return false
  try {
    // INSERT OR IGNORE so a caller that supplies a DETERMINISTIC `id` (e.g. a
    // cross-camp rejection keyed by entity+record+value) collapses onto one row
    // instead of accumulating a new row on every occurrence. This matters for
    // recurring events: a bad write lives in the append-only shared Automerge
    // document, so its rejection re-fires on every merge pass
    // (DEVICE_HEALTH.CROSS_CAMP_WRITE_REJECTED) — without dedup that is unbounded
    // row growth. The default `id` is a fresh random UUID, which never collides,
    // so every existing (unkeyed) caller is unaffected and still lands its row.
    const result = db.prepare(
      `INSERT OR IGNORE INTO device_health_events (id, camp_id, kind, detail, incident, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id ?? randomUUID(),
      campId ?? null,
      kind,
      detail == null ? null : String(detail).slice(0, 4000),
      incident ?? null,
      new Date().toISOString()
    )
    // Honest report of whether a NEW row landed: a deduped (already-present) keyed
    // event returns false, matching this module's "the answer is reported, not
    // assumed" contract.
    return result.changes > 0
  } catch (err) {
    // The disk that just refused the document save can refuse this too. Nothing
    // can be done about that here; what matters is not CLAIMING it worked.
    console.error(`[${incident ?? 'device-health'}] could not record a sync health event (${kind}):`, err?.message ?? err)
    return false
  }
}

/** Unresolved health events, newest first — what `check_projection_health` reports. */
export function listDeviceHealthEvents(db, { limit = 50 } = {}) {
  try {
    return db
      .prepare(
        `SELECT id, camp_id, kind, detail, incident, occurred_at FROM device_health_events
         WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT ?`
      )
      .all(limit)
  } catch {
    return []
  }
}
