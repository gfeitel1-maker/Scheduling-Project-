import { EVENTS } from './connectivityEvents.js'

// S3 / Rung 2 (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): reconnect to a camp peer
// whose current address is known only from camp-peer gossip. Resolves the peer's verified gossip
// entry, requires a signalling route over the authenticated stream (punchSignaling.js), then dials
// each published candidate through the punch transport, whose signalling channel the caller wired
// to that same stream.
//
// No third party: this module never touches the rendezvous (rung 3) - the coordinator escalates
// to it only after this returns { ok: false }.
//
// highWater is REQUIRED (punchGossip.createHighWaterStore, persisted): without it the rollback
// check is silently absent, so the attempt refuses to run. readEntries(highWater) => Map<deviceId, entry> is punchGossip.readReflexive over the live document
// (signature, registry, revocation, TTL, size, public-address and rollback checks already enforced;
// its `.skewed` map names verified entries refused only for clock skew).
// signaling is createPunchSignaling; bindChannel(channel) hands the punch transport the
// {sendSignal, onSignal} channel to the target, so the dial's SDP/candidate exchange travels over the
// authenticated punch-signal stream - there is no path that dials without it. dial(multiaddrString)
// is the libp2p dial; emit(name, fields) is the connectivity emitter.
// Resolves { ok: true, candidate } or { ok: false, reason }; never throws.
export async function attemptRung2({ peerDeviceId, readEntries, signaling, bindChannel, dial, highWater, emit = () => {} }) {
  if (!highWater || typeof highWater.get !== 'function' || typeof highWater.set !== 'function') return { ok: false, reason: 'no-high-water-store' }
  let entries
  try {
    entries = readEntries(highWater)
  } catch {
    return { ok: false, reason: 'gossip-unreadable' }
  }
  const entry = entries.get(peerDeviceId)
  if (!entry) {
    const skewMs = entries.skewed?.get(peerDeviceId)
    if (skewMs === undefined) return { ok: false, reason: 'no-gossip-entry' }
    emit(EVENTS.CLOCK_SKEW, { source: 'punch-gossip', reason: 'future-dated-gossip', skewMs })
    return { ok: false, reason: 'clock-skew' }
  }
  if (typeof bindChannel !== 'function') return { ok: false, reason: 'no-signal-channel' }
  if (!(await signaling.hasRoute(peerDeviceId))) return { ok: false, reason: 'no-signal-route' }
  bindChannel(signaling.channelTo(peerDeviceId))
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
