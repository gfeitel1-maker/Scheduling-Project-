// S4c (docs/adr/2026-10-08-relayless-cross-network-reconnect.md): the reconnect ladder for a camp
// peer this device is not connected to, in the owner's order and strictly on failure:
//   LAN (mDNS + remembered LAN addresses) -> rung 1 (remembered reflexive, zero signaling)
//   -> rung 2 (camp-peer gossip + signaling) -> rung 3 (rendezvous) ONLY when all of those fail.
// Rung 3 is never contacted while rung 1 or 2 can succeed, and `rendezvous` is null when
// SHORESH_RENDEZVOUS_URL is unset, so the ladder is then LAN and rungs 1-2 only. Rung 3 is a demand
// handle: request(peerId) starts rendezvous publish/poll, release(peerId) ends it once the peer is
// reached, so a camp whose peers are all reachable makes no rendezvous call at all.
//
// Every collaborator is injected: this module imports nothing from libp2p, the transport or the
// network, and never throws. When every rung fails it emits SAME_NETWORK_REQUIRED (an event for a
// later UI) and retries the ladder on a backoff.
import { EVENTS } from './connectivityEvents.js'
import { backoffMs } from './punchBackoff.js'

export const RUNG3_WAIT_MS = 90_000
export const FIRST_SWEEP_DELAY_MS = 15_000

// peer: { peerId, deviceId }. deps: listPeers() -> every trusted camp peer
// other than this device, isConnected(peerId), attemptLan/attemptRung1/attemptRung2(peer) ->
// { ok } | boolean, rendezvous: { request, release } | null, emit(name, fields).
export function createReconnectCoordinator({
  listPeers,
  isConnected,
  attemptLan,
  attemptRung1,
  attemptRung2,
  rendezvous = null,
  emit = () => {},
  rung3WaitMs = RUNG3_WAIT_MS,
  firstSweepDelayMs = FIRST_SWEEP_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
} = {}) {
  const inFlight = new Map()
  const waiters = new Map()
  let timer = null
  let attempt = 0
  let stopped = false

  const succeeded = async (fn, peer) => {
    try {
      const r = await fn(peer)
      return r === true || r?.ok === true
    } catch {
      return false
    }
  }

  function waitConnected(peerId, ms) {
    return new Promise((resolve) => {
      const done = (v) => { clearTimer(t); waiters.delete(peerId); resolve(v) }
      const t = setTimer(() => done(false), ms)
      waiters.set(peerId, done)
    })
  }

  // The owner of the connection calls this when a peer is admitted; it ends a rung-3 wait early.
  function peerConnected(peerId) {
    waiters.get(peerId)?.(true)
    rendezvous?.release(peerId)
  }

  async function reconnect(peer) {
    if (isConnected(peer.peerId)) { rendezvous?.release(peer.peerId); return { ok: true, rung: 'connected' } }
    if (await succeeded(attemptLan, peer)) return { ok: true, rung: 'lan' }
    if (await succeeded(attemptRung1, peer)) return { ok: true, rung: 'rung1' }
    if (await succeeded(attemptRung2, peer)) return { ok: true, rung: 'rung2' }
    if (rendezvous) {
      rendezvous.request(peer.peerId)
      if (await waitConnected(peer.peerId, rung3WaitMs)) {
        rendezvous.release(peer.peerId)
        return { ok: true, rung: 'rung3' }
      }
    }
    emit(EVENTS.SAME_NETWORK_REQUIRED, { peerId: peer.peerId, reason: rendezvous ? 'all-rungs-failed' : 'rungs-1-2-failed-no-rendezvous' })
    return { ok: false, reason: 'same-network-required' }
  }

  function reconnectPeer(peer) {
    if (!inFlight.has(peer.peerId)) {
      inFlight.set(peer.peerId, reconnect(peer).finally(() => inFlight.delete(peer.peerId)))
    }
    return inFlight.get(peer.peerId)
  }

  async function sweep() {
    timer = null
    if (stopped) return
    let all = []
    try { all = listPeers() } catch { /* retry on the next sweep */ }
    const results = await Promise.all(all.map(reconnectPeer))
    if (stopped) return
    if (results.some((r) => !r.ok)) {
      schedule(backoffMs(attempt++, { random }))
    } else {
      attempt = 0
    }
  }

  function schedule(delayMs) {
    if (stopped || timer) return
    timer = setTimer(() => { sweep().catch(() => {}) }, delayMs)
    timer.unref?.()
  }

  return {
    reconnect: reconnectPeer,
    sweep,
    peerConnected,
    // A disconnect or a fresh start: look for unreachable peers after the first-sweep delay.
    start: () => schedule(firstSweepDelayMs),
    notifyPeersChanged: () => schedule(firstSweepDelayMs),
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      for (const w of [...waiters.values()]) w(false)
    },
  }
}
