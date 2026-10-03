// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §1.2) — a
// pure, total digest of the currently-revoked device set. No SQLite, no network, no document
// write: it only reads camp_authority_log via authorityReplay.js's existing replay. Sorting
// happens inside currentRevokedDeviceIds, so two devices holding the identical change set always
// produce the identical digest, regardless of merge order (see that function's own comment).
import { createHash } from 'node:crypto'
import { currentRevokedDeviceIds } from './authorityReplay.js'

// T335 gate finding (Red Hat LOW, round 2) — a bare `ids.join(',')` lets two different revoked
// sets collide if a device id itself contains a comma (['a,b', 'c'] and ['a', 'b,c'] both join to
// the same string). JSON.stringify of the (already sorted) array is unambiguous: it escapes any
// comma/quote inside an id, and array boundaries are explicit, so two different arrays can never
// serialize to the same string.
export function encodeRevokedIds(ids) {
  return JSON.stringify(ids)
}

export function revocationDigest(automerge, doc, opts = {}) {
  const ids = currentRevokedDeviceIds(automerge, doc, opts)
  return createHash('sha256').update(encodeRevokedIds(ids)).digest('hex')
}
