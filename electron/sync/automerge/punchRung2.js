// S3 / Rung 2 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): reconnect to a camp peer
// whose current address is known only from camp-peer gossip. Resolves the peer's verified gossip
// entry, requires a signalling route over the authenticated stream (punchSignaling.js), then dials
// each published candidate through the punch transport, whose signalling channel the caller wired
// to that same stream.
//
// No third party: this module never touches the rendezvous (rung 3) - the coordinator escalates
// to it only after this returns { ok: false }.
//
// readEntries() => Map<deviceId, entry> is punchGossip.readReflexive over the live document
// (signature, registry, revocation, TTL and size already enforced). dial(multiaddrString) is the
// libp2p dial. Resolves { ok: true, candidate } or { ok: false, reason }; never throws.
export async function attemptRung2({ peerDeviceId, readEntries, signaling, dial }) {
  let entry
  try {
    entry = readEntries().get(peerDeviceId)
  } catch {
    return { ok: false, reason: 'gossip-unreadable' }
  }
  if (!entry) return { ok: false, reason: 'no-gossip-entry' }
  if (!signaling.hasRoute(peerDeviceId)) return { ok: false, reason: 'no-signal-route' }
  for (const candidate of entry.candidates) {
    try {
      await dial(`${candidate}/p2p/${entry.peerId}`)
      return { ok: true, candidate }
    } catch {
      // try the next published candidate
    }
  }
  return { ok: false, reason: 'dial-failed' }
}
