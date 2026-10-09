// Carries the host-handoff state machine (electron/auth/hostHandoff.js) over /shoresh/handoff/1.0.0.
// Knows peers and streams; knows nothing about keys. Every exchange is request/reply on one stream:
// the reply is itself a protocol message and is fed back into the state machine, so the same handler
// serves a reply and a message that arrived on its own.
import { isHostDevice } from '../../auth/localAuth.js'
import { isAdminDevice } from '../../auth/hostHandoff.js'

const MAX_HOPS = 6

export function createHandoffWire({ db, service, sendHandoff, isPeerOnLan, listAdmittedPeers, retryMs = 3000, onChanged = () => {} }) {
  let retryTimer = null
  let stopped = false

  const peerIdForDevice = (deviceId) => listAdmittedPeers().find(([, d]) => d === deviceId)?.[0] ?? null
  const deviceIdForPeer = (peerId) => listAdmittedPeers().find(([p]) => p === String(peerId))?.[1] ?? null

  function notify() {
    try { onChanged() } catch { /* a listener must never break the handoff */ }
  }

  // The successor in `stored` holds a key it must never discard on its own: keep asking the giver.
  function scheduleRetry() {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(async () => {
      retryTimer = null
      const { handoff } = service.status()
      if (handoff?.role !== 'taker' || handoff.state !== 'stored') return
      const peerId = peerIdForDevice(handoff.peerDeviceId)
      if (peerId) await contactPeer(peerId)
      if (service.status().handoff?.state === 'stored') scheduleRetry()
    }, retryMs)
    retryTimer.unref?.()
  }

  // Send `first`, feed each reply back into the state machine, send whatever it answers, until it
  // has nothing more to say. Returns { ok, reason? }.
  async function converse(peerId, peerDeviceId, first) {
    let out = first
    let relaunch = false
    for (let hop = 0; out && hop < MAX_HOPS; hop++) {
      let reply
      try {
        reply = await sendHandoff(peerId, out)
      } catch {
        service.abandon(out.handoff_id, 'peer_unreachable')
        notify()
        if (relaunch) service.afterReplyFlushed({ relaunch })
        scheduleRetry()
        return { ok: false, reason: 'peer_unreachable' }
      }
      if (reply?.type === 'ERROR') {
        service.abandon(out.handoff_id, reply.reason ?? 'peer_refused')
        notify()
        return { ok: false, reason: reply.reason ?? 'peer_refused' }
      }
      const result = await service.handle(reply, { peerDeviceId })
      notify()
      if (!result.ok) {
        service.abandon(out.handoff_id, result.reason)
        notify()
        // Tell the peer why, so its control can say so too (best effort: the peer may be gone).
        try { await sendHandoff(peerId, { type: 'ERROR', handoff_id: reply?.handoff_id ?? out.handoff_id, reason: result.reason }) } catch { /* unreachable */ }
        // A successor still in `stored` (e.g. its activation write failed) keeps asking.
        scheduleRetry()
        return { ok: false, reason: result.reason }
      }
      if (result.relaunch) relaunch = true
      out = result.reply && result.reply.type !== 'ACK' ? result.reply : null
    }
    if (relaunch) service.afterReplyFlushed({ relaunch })
    return { ok: true }
  }

  async function contactPeer(peerId) {
    const peerDeviceId = deviceIdForPeer(peerId)
    if (!peerDeviceId) return
    const msg = service.contactMessage(peerDeviceId)
    if (!msg) return
    await converse(String(peerId), peerDeviceId, msg)
  }

  async function inbound(msg, { fromPeerId }) {
    const peerDeviceId = deviceIdForPeer(fromPeerId)
    if (!peerDeviceId) return { frame: { type: 'ERROR', reason: 'unknown_peer' } }
    const result = await service.handle(msg, { peerDeviceId })
    notify()
    if (!result.ok) return { frame: { type: 'ERROR', handoff_id: msg?.handoff_id, reason: result.reason } }
    return { frame: result.reply ?? { type: 'ACK' }, afterFlush: () => service.afterReplyFlushed(result) }
  }

  async function start(peerDeviceId) {
    const peerId = peerIdForDevice(peerDeviceId)
    if (!peerId || !isPeerOnLan(peerId)) {
      service.noteFailure(peerDeviceId, 'peer_not_on_lan')
      notify()
      return { ok: false, reason: 'peer_not_on_lan' }
    }
    const offer = service.offer(peerDeviceId)
    if (!offer.ok) {
      if (offer.reason !== 'handoff_in_progress') service.noteFailure(peerDeviceId, offer.reason)
      notify()
      return offer
    }
    notify()
    const result = await converse(peerId, peerDeviceId, offer.msg)
    return result.ok ? { ok: true } : result
  }

  async function accept() {
    const { handoff } = service.status()
    if (handoff?.role !== 'taker' || handoff.state !== 'offered') return { ok: false, reason: 'no_offer' }
    const peerId = peerIdForDevice(handoff.peerDeviceId)
    if (!peerId) return { ok: false, reason: 'peer_not_connected' }
    const accepted = await service.accept()
    if (!accepted.ok) return accepted
    notify()
    return converse(peerId, handoff.peerDeviceId, accepted.msg)
  }

  function decline() {
    service.decline()
    notify()
  }

  function eligibleDeviceIds() {
    if (!isHostDevice(db)) return []
    return listAdmittedPeers()
      .filter(([peerId, deviceId]) => isAdminDevice(db, deviceId) && isPeerOnLan(peerId))
      .map(([, deviceId]) => deviceId)
  }

  function status() {
    return { ...service.status(), isHost: isHostDevice(db), eligibleDeviceIds: eligibleDeviceIds() }
  }

  return {
    inbound,
    api: { start, accept, decline, status, eligibleDeviceIds, contactPeer },
    stop: () => { stopped = true; clearTimeout(retryTimer) },
  }
}
