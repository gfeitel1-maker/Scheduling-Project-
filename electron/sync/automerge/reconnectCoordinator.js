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
// network, and never throws. The peer is re-checked after EVERY rung and just before rung 3: a connected peer ends
// the ladder and releases any rendezvous demand. When every rung fails (none merely erroring) it emits
// SAME_NETWORK_REQUIRED and retries that peer on its own backoff. A rung that errors
// RUNG_ERROR_LIMIT times in a row for a peer counts as failed (keeper ruling), so a permanently broken
// rung cannot hold the peer below rung 3; PUNCH_RUNG_ERROR is still emitted every time.
import { EVENTS } from './connectivityEvents.js'
import { backoffMs } from './punchBackoff.js'

export const RUNG3_WAIT_MS = 90_000
export const FIRST_SWEEP_DELAY_MS = 15_000
export const LAN_GRACE_MS = 30_000
export const RUNG_ERROR_LIMIT = 3

// peer: { peerId, deviceId }. deps: listPeers() -> every trusted camp peer
// other than this device, isConnected(peerId), attemptLan/attemptRung1/attemptRung2(peer) ->
// { ok } | boolean, waitMdnsPass() -> Promise resolved when the next mDNS pass completes,
// rendezvous: { request, release } | null, emit(name, fields).
export function createReconnectCoordinator({
  listPeers,
  isConnected,
  attemptLan,
  attemptRung1,
  attemptRung2,
  waitMdnsPass = () => new Promise(() => {}),
  rendezvous = null,
  emit = () => {},
  rung3WaitMs = RUNG3_WAIT_MS,
  lanGraceMs = LAN_GRACE_MS,
  firstSweepDelayMs = FIRST_SWEEP_DELAY_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
} = {}) {
  const inFlight = new Map()
  const waiters = new Map()
  const backoff = new Map()
  const lastConnected = new Map()
  const demanded = new Set()
  const rungErrors = new Map()
  let timer = null
  let timerDueAt = 0
  let stopped = false

  const CONNECTED = { ok: true, rung: 'connected' }

  const tryRung = async (fn, peer) => {
    try {
      const r = await fn(peer)
      if (r === true || r?.ok === true) return 'ok'
      return r?.reason === 'error' ? 'error' : 'fail'
    } catch {
      return 'error'
    }
  }

  const connectedNow = (peerId) => {
    let c = false
    try { c = isConnected(peerId) } catch { /* treat as not connected */ }
    if (c) release(peerId)
    return c
  }

  function request(peerId) {
    demanded.add(peerId)
    rendezvous?.request(peerId)
  }

  function release(peerId) {
    demanded.delete(peerId)
    rendezvous?.release(peerId)
  }

  // Resolves 'connected' at once if the peer already is, else 'connected' | 'timeout' | 'cancelled'.
  // `until` (optional) is a promise that ends the wait early with 'timeout'.
  function waitConnected(peerId, ms, until) {
    if (connectedNow(peerId)) return Promise.resolve('connected')
    return new Promise((resolve) => {
      const done = (v) => { clearTimer(t); waiters.delete(peerId); resolve(v) }
      const t = setTimer(() => done('timeout'), ms)
      waiters.set(peerId, done)
      until?.then(() => done('timeout'), () => done('timeout'))
    })
  }

  // The owner of the connection calls this when a peer is admitted; it ends a wait early.
  function peerConnected(peerId) {
    waiters.get(peerId)?.('connected')
    release(peerId)
  }

  async function reconnect(peer) {
    const id = peer.peerId
    if (connectedNow(id)) return CONNECTED
    if (await tryRung(attemptLan, peer) === 'ok') return { ok: true, rung: 'lan' }
    if (connectedNow(id)) return CONNECTED
    if (lanGraceMs > 0) {
      const outcome = await waitConnected(id, lanGraceMs, Promise.resolve().then(waitMdnsPass))
      if (outcome === 'cancelled') return { ok: false, reason: 'cancelled' }
      if (connectedNow(id)) return CONNECTED
    }
    let rungError = false
    for (const [n, fn] of [[1, attemptRung1], [2, attemptRung2]]) {
      const r = await tryRung(fn, peer)
      if (connectedNow(id) || r === 'ok') return r === 'ok' ? { ok: true, rung: `rung${n}` } : CONNECTED
      const key = `${id}:${n}`
      if (r === 'error') {
        const count = (rungErrors.get(key) ?? 0) + 1
        rungErrors.set(key, count)
        if (count < RUNG_ERROR_LIMIT) rungError = true
        emit(EVENTS.PUNCH_RUNG_ERROR, { peerId: id, rung: n })
      } else {
        rungErrors.delete(key)
      }
    }
    if (stopped) return { ok: false, reason: 'cancelled' }
    if (rungError) return { ok: false, reason: 'rung-error' }
    if (rendezvous) {
      if (connectedNow(id)) return CONNECTED
      if (!isCampPeer(id)) return { ok: false, reason: 'cancelled' }
      request(id)
      const outcome = await waitConnected(id, rung3WaitMs)
      if (outcome === 'cancelled') return { ok: false, reason: 'cancelled' }
      if (outcome === 'connected' || connectedNow(id)) {
        release(id)
        return { ok: true, rung: 'rung3' }
      }
      release(id)
    }
    emit(EVENTS.SAME_NETWORK_REQUIRED, { peerId: id, reason: rendezvous ? 'all-rungs-failed' : 'rungs-1-2-failed-no-rendezvous' })
    return { ok: false, reason: 'same-network-required' }
  }

  // Revocation can land during rungs 1-2; a removed peer must never be published to the rendezvous.
  function isCampPeer(peerId) {
    try { return listPeers().some((p) => p.peerId === peerId) } catch { return false }
  }

  function reconnectPeer(peer) {
    if (!inFlight.has(peer.peerId)) {
      inFlight.set(peer.peerId, reconnect(peer).finally(() => inFlight.delete(peer.peerId)))
    }
    return inFlight.get(peer.peerId)
  }

  function currentPeers() {
    let all = []
    try { all = listPeers() } catch { /* retry on the next sweep */ }
    const present = new Set(all.map((p) => p.peerId))
    for (const id of new Set([...backoff.keys(), ...lastConnected.keys(), ...demanded])) {
      if (present.has(id)) continue
      backoff.delete(id)
      lastConnected.delete(id)
      rungErrors.delete(`${id}:1`)
      rungErrors.delete(`${id}:2`)
      release(id)
      waiters.get(id)?.('cancelled')
    }
    return all
  }

  async function sweep() {
    if (timer) clearTimer(timer)
    timer = null
    if (stopped) return
    const all = currentPeers()
    const t = now()
    const due = all.filter((p) => (backoff.get(p.peerId)?.nextAt ?? 0) <= t)
    const results = await Promise.all(due.map((p) => reconnectPeer(p).then((r) => [p, r])))
    if (stopped) return
    const present = new Set(all.map((p) => p.peerId))
    for (const [p, r] of results) {
      if (!present.has(p.peerId) || r.reason === 'cancelled') continue
      if (r.ok) { backoff.delete(p.peerId); continue }
      const attempt = (backoff.get(p.peerId)?.attempt ?? -1) + 1
      backoff.set(p.peerId, { attempt, nextAt: now() + backoffMs(attempt, { random }) })
    }
    for (const p of all) {
      const c = connectedNow(p.peerId)
      lastConnected.set(p.peerId, c)
      if (c) backoff.delete(p.peerId)
    }
    if (backoff.size > 0) schedule(Math.max(0, Math.min(...[...backoff.values()].map((b) => b.nextAt)) - now()))
  }

  // An earlier due time replaces a pending later timer; a later one never postpones it.
  function schedule(delayMs) {
    if (stopped) return
    const dueAt = now() + delayMs
    if (timer && timerDueAt <= dueAt) return
    if (timer) clearTimer(timer)
    timerDueAt = dueAt
    timer = setTimer(() => { sweep().catch(() => {}) }, delayMs)
    timer.unref?.()
  }

  // A peer whose connected state changed gets a fresh backoff; the next sweep is pulled forward.
  function notifyPeersChanged() {
    if (stopped) return
    for (const p of currentPeers()) {
      const c = connectedNow(p.peerId)
      if (lastConnected.has(p.peerId) && lastConnected.get(p.peerId) !== c) backoff.delete(p.peerId)
      lastConnected.set(p.peerId, c)
    }
    schedule(firstSweepDelayMs)
  }

  return {
    reconnect: reconnectPeer,
    sweep,
    peerConnected,
    start: () => schedule(firstSweepDelayMs),
    notifyPeersChanged,
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      for (const w of [...waiters.values()]) w('cancelled')
      for (const id of [...demanded]) release(id)
    },
  }
}
