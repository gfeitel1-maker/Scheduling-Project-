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
// WIRE COMPATIBILITY — read before changing anything below. This output is a
// protocol surface, not an implementation detail. Both discovery paths derive
// their advertised identifier from it (the Bonjour service name in
// ../discovery.js, and @libp2p/mdns's serviceTag via
// ./automerge/discovery.js's campDiscoveryTag), and mDNS matches on that
// string exactly: a node only ever sees answers from nodes advertising the
// identical value. So changing the algorithm, the truncation length, or the
// input changes what goes on the wire, and two devices running different app
// versions would simply stop discovering each other — with no error, no
// warning, and nothing in a log. The symptom a director reports is "the iPad
// can't find the office computer any more" after one device updates.
// campIdHash.test.js pins a fixed vector for exactly this reason; if that
// test fails, the correct response is almost never to update the expectation.
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
