// Shared, dependency-free derivation of an opaque camp identifier for
// broadcast on the LAN.
//
// PRIVACY (the reason this module exists): mDNS is broadcast in the clear to
// every device on the network — a stranger's laptop in a shared building, a
// hotel, a JCC. Nothing broadcast may carry the camp's human-readable name.
// Both discovery paths (the live WS/Bonjour path in ../discovery.js and the
// libp2p path in ./automerge/discovery.js) therefore advertise a value
// derived from the camp id by this function, never `camps.name`.
//
// SHA-256 truncated to 16 hex chars: plenty of collision resistance for "how
// many camps are on one LAN", short enough to stay well inside a 63-char DNS
// label, and one-way — given the hash, neither the camp id nor the camp name
// (which this function never even sees) can be recovered.
import crypto from 'node:crypto'

export function campIdHash(campId) {
  if (typeof campId !== 'string' || campId.length === 0) {
    throw new Error('campIdHash requires a non-empty campId string')
  }
  return crypto.createHash('sha256').update(campId).digest('hex').slice(0, 16)
}
