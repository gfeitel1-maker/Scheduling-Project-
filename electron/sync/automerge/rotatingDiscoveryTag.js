// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §1.2) — the
// rotating discovery tag: HMAC(campDhtSecret, sha256(sorted(revoked_device_ids))). Pure, total
// function over document state already present — no document write, no network, no wall-clock. HMAC
// (not scrypt): campDhtSecret is already 256 bits of randomness (rendezvousNamespace.js's
// mint-only `namespace` field), so there is no human-typed-code entropy gap to widen the way
// joinCode.js's scrypt derivation widens a 50-bit code — slowing this down would only cost every
// discovery tick for no security benefit.
//
// Mint-only: this module never calls rotateRendezvousNamespace (see rendezvousNamespace.js) and
// never writes to the document itself. It requires the camp's discovery secret to already be
// minted — the caller (syncStarter.js's startup path) mints once, synchronously, before any
// discovery tag is derived, exactly as rendezvousNamespace.js's own header anticipates for its
// wiring ticket. There is deliberately no silent fallback to an unminted/default secret: a camp
// either has a minted secret or the caller mints one first — see this ticket's §6 interface-
// contract note on "no observable unknown tag state."
import { createHmac } from 'node:crypto'
import { readRendezvousNamespace } from './rendezvousNamespace.js'
import { revocationDigest } from '../../automerge/authorityRevocationDigest.js'

export function rotatingDiscoveryDigest(automerge, doc, campId, opts = {}) {
  const existing = readRendezvousNamespace(doc, campId)
  if (!existing) {
    throw new Error(
      `rotatingDiscoveryDigest: no rendezvous/discovery secret minted yet for camp ${campId} — ` +
        'call mintRendezvousNamespace before deriving a discovery tag'
    )
  }
  const digest = revocationDigest(automerge, doc, opts)
  return createHmac('sha256', Buffer.from(existing.namespace, 'hex')).update(digest).digest('hex').slice(0, 32)
}
