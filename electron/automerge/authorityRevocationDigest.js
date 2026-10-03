// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §1.2) — a
// pure, total digest of the currently-revoked device set. No SQLite, no network, no document
// write: it only reads camp_authority_log via authorityReplay.js's existing replay. Sorting
// happens inside currentRevokedDeviceIds, so two devices holding the identical change set always
// produce the identical digest, regardless of merge order (see that function's own comment).
import { createHash } from 'node:crypto'
import { currentRevokedDeviceIds } from './authorityReplay.js'

export function revocationDigest(automerge, doc, opts = {}) {
  const ids = currentRevokedDeviceIds(automerge, doc, opts)
  return createHash('sha256').update(ids.join(',')).digest('hex')
}
