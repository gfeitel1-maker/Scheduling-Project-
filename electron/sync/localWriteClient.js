// The device-local write path: a write is appended to this device's own op-log
// and nothing is sent anywhere.
//
// This is not a new mechanism. It is the `!serverUrl` branch that has always
// existed inside `createSyncClient` — the branch a Host took for its own
// interactive edits — lifted out unchanged so that EVERY device can take it.
//
// Why every device, now. Under the op-log transport the two branches were
// genuinely different: a Host wrote locally, a Client submitted over a
// WebSocket and waited for the Host to decide. Under CRDT sync there is no such
// asymmetry. Every device holds the whole camp document, and replication is a
// consequence of the write rather than a step after it: `appendOp` calls
// `recordLocalWrite` (electron/ops/operations.js), which applies the same field
// to the shared Automerge document, which the sync node then merges to peers.
// So the Host's old local branch is simply what a write IS now, and the Client
// branch — lock, submit, await, retry — describes a negotiation that no longer
// happens.
//
// Consequences worth stating plainly, because they are the point rather than an
// oversight:
//
//   - No lock acquisition. Two devices editing the same field concurrently is
//     allowed; a genuine disagreement is surfaced to a human afterwards rather
//     than prevented beforehand
//     (docs/adr/2026-09-08-crdt-conflict-reconciliation.md).
//   - No offline queue. A write is never "queued pending connection", because
//     it is never in flight — it lands in this device's database immediately
//     and converges whenever a peer is next reachable. The `pending_writes`
//     table and the `{ status: 'queued' }` reply belong to the transport that
//     is being retired.
//   - No remote rejection. There is no Host left to reject a write, which is
//     also why role enforcement is now device-side — an accepted tradeoff,
//     recorded in SECURITY.md and docs/current/CRDT_SECURITY_GAPS.md.
//
// The one rejection that remains is local and stays: a unique-field collision
// is detected in this process, before `appendOp`, so the renderer still gets a
// typed rejection instead of a raw SQLITE_CONSTRAINT_UNIQUE.
import { randomUUID } from 'node:crypto'
import {
  appendOp,
  appendBulkReplaceOp,
  detectUniqueFieldCollision,
} from '../ops/operations.js'

// Shared shape for the collision payload handed to a caller/listener — matches
// the wire shape the op-log transport used (`existing: { id, name, capacity,
// notes }`), so a caller sees the same object regardless of which path produced
// it. Kept identical deliberately: the renderer's handling of this rejection is
// not part of what Stage 6 changes.
function pickExistingLocation(row) {
  return { id: row.id, name: row.name, capacity: row.capacity, notes: row.notes }
}

/**
 * @param db          this device's SQLite handle
 * @param device_id   this device's id, stamped on every op it authors
 * @param author_user_id  fallback author for callers with no signed-in user
 *                    (bootstrap and pairing, which are honestly unattributed).
 *                    Per-call `author_user_id` always wins — see the note on
 *                    write() below, which is there because getting this wrong
 *                    once made Trash and record history say "Unknown".
 * @param onOpWritten optional hook called with each op after it is appended.
 *                    Used by the op-log transport's Host to broadcast its own
 *                    edit to connected Clients; it has no purpose once that
 *                    transport is gone, and this parameter goes with it.
 */
export function createLocalWriteClient(db, { device_id, author_user_id = null, onOpWritten = null } = {}) {
  const opAppliedListeners = []
  const opConflictListeners = []
  // Mirrors opConflictListeners exactly
  // (docs/adr/2026-08-15-locations-concurrent-create-collision.md D3/D4).
  // A local write returns its rejection synchronously to its own caller, so
  // this listener is not how the caller finds out — it is how anything ELSE
  // that needs to know (a notice surface with no live caller waiting) does.
  const opRejectedListeners = []
  const fullSyncAppliedListeners = []

  function notifyOpApplied(op) {
    for (const listener of opAppliedListeners) listener(op)
  }

  function notifyOpRejected(msg) {
    for (const listener of opRejectedListeners) listener(msg)
  }

  return {
    // `author_user_id` MUST be a parameter (T22). It used to be absent here, so
    // the value main.js supplies per call — the signed-in user — was silently
    // discarded and the closure's value (null, fixed at construction before
    // anyone has logged in) was written instead. Every op through this path
    // recorded no author, which is why Trash and record history said "Unknown"
    // for almost everything. The closure value remains the fallback for callers
    // that genuinely have no user.
    async write({ entity, entity_id, field, value, parent_op_id = null, author_user_id: opAuthor, source = 'human' }) {
      // D2/D3 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
      // check BEFORE appendOp. Without it this would hit appendOp's
      // transaction, throw a raw SQLITE_CONSTRAINT_UNIQUE, and propagate
      // unhandled through main.js's write() IPC handler straight to the
      // renderer instead of a clean, typed rejection through the normal IPC
      // promise.
      const collision = detectUniqueFieldCollision(db, { entity, entity_id, field, value })
      if (collision) {
        const rejection = { status: 'rejected', reason: 'unique_field', existing: pickExistingLocation(collision) }
        notifyOpRejected(rejection)
        return rejection
      }
      const op = appendOp(db, {
        entity,
        entity_id,
        field,
        value,
        author_user_id: opAuthor ?? author_user_id,
        device_id,
        parent_op_id,
        // S2a: this is an interactive edit seam — DEFAULTS to human provenance
        // so a hand-edit is protected on re-import even though NULL would also
        // decode to human (ADR §2). S2b R1: a `stale`-accept resolution passes
        // source:'import' so the director's acceptance of an import value is
        // recorded import-owned and future re-imports update it quietly (§3a).
        // Stamping 'import' here is legitimate: this device is writing its own
        // data, and it owns the provenance of what it imports.
        source,
      })
      notifyOpApplied(op)
      if (onOpWritten) onOpWritten(op)
      return { status: 'applied', op }
    },
    // Same author_user_id reasoning as write() above, same consequence.
    //
    // No collision check, unlike write(): bulk_replace is a wholesale scope
    // replacement rather than a single-field edit, so per-field uniqueness
    // does not apply to it. (The op-log transport skipped per-field LOCKING
    // here for the same structural reason.)
    async writeBulkReplace({ entity, scope_id, rows, author_user_id: opAuthor }) {
      const op = appendBulkReplaceOp(db, {
        entity,
        scope_id,
        rows,
        author_user_id: opAuthor ?? author_user_id,
        device_id,
        client_write_id: randomUUID(),
      })
      notifyOpApplied(op)
      if (onOpWritten) onOpWritten(op)
      return { status: 'applied', op }
    },
    onOpApplied(callback) {
      opAppliedListeners.push(callback)
    },
    onOpConflict(callback) {
      opConflictListeners.push(callback)
    },
    onOpRejected(callback) {
      opRejectedListeners.push(callback)
    },
    onFullSyncApplied(callback) {
      fullSyncAppliedListeners.push(callback)
    },
    // These four report the absence of the op-log transport rather than the
    // state of CRDT sync. A local write is never queued, never in flight, and
    // never waiting on a connection, so there is genuinely nothing to report.
    //
    // Whether this device can currently REACH another device is a real question
    // with a real answer, but the answer lives in the libp2p sync node's peer
    // set, not here — `main.js`'s getSyncStatus is what asks it. Reporting
    // `false` from a module that is not a transport would be a lie the sidebar
    // would repeat.
    getQueuedOps() {
      return []
    },
    getPendingRestores() {
      return []
    },
    async drainPendingRestores() {},
    async flushQueue() {},
  }
}
