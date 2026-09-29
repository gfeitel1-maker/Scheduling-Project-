import { DELETE_FIELD } from '../ops/operations.js'

// Shared action-derivation logic for the 3-way write dispatch described in
// docs/adr/2026-07-24-centralized-authorization-layer.md's IPC table. It has ONE
// caller: electron/main.js's write(). (electron/auth/permissions.js names it in a
// comment to record the same mapping, but does not call it.)
//
// _Prior: this was also "reused verbatim by the WS layer (submit_op /
// acquire_lock) per the ADR's WS table — a staff user must not be able to do via
// WS what they can't do via IPC, or vice versa, so both electron/main.js's
// write() and electron/sync/syncServer.js's handleSubmitOp/handleAcquireLock call
// this single function rather than each re-implementing the same three branches
// (Security flagged this exact duplication risk in the Task 2 review)." There is
// no WS layer: syncServer.js, submit_op and acquire_lock were all deleted at the
// Stage 6c cutover, so this function now has ONE derivation caller and the
// duplication risk Security flagged cannot currently arise. The ADR's WS table
// describes a retired transport. What has NOT changed is the reason the function
// exists — a write's action must be derived, not passed in by the caller — and a
// remote device's writes are no longer authorized per-op at all: they arrive as a
// merged document, so authorization happens at the connection layer
// (electron/auth/connectionAuth.js) rather than per write._
//
// - DELETE_FIELD sentinel -> '<entity>.delete'
// - camps.name -> 'camps.rename'
// - everything else -> '<entity>.write'
export function deriveWriteAction({ entity, field }) {
  if (field === DELETE_FIELD) {
    return `${entity}.delete`
  }
  if (entity === 'camps' && field === 'name') {
    return 'camps.rename'
  }
  return `${entity}.write`
}

// '<entity>.bulk_replace' — matches shoresh:bulk-replace's admin-only gate.
export function deriveBulkReplaceAction(entity) {
  return `${entity}.bulk_replace`
}
