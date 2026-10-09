// S3 / Rung 2 of the relay-less cross-network reconnect
// (docs/adr/2026-10-08-relayless-cross-network-reconnect.md, "Rung 2"): the real implementation of
// the {sendSignal(msg), onSignal(cb) => unsubscribe} interface S1's punchTransport.js injects.
//
// Carries the punch SDP/candidate messages over /shoresh/punch-signal/1, a libp2p protocol stream
// that is served ONLY to peers the authGate has admitted (and the local registry still trusts) -
// there is no pre-auth signalling surface. A signal travels either directly, or FORWARDED once by
// a reachable admitted camp peer that is connected to both ends.
//
// Every signal is an envelope SIGNED BY THE ORIGIN device (its T331 identity key) over
// [id, from, to, ts, payload]; the destination verifies it against the peer id its own registry
// has bound to `from`. A forwarder passes the envelope through byte-for-byte, so it cannot forge
// or alter one, and it cannot make a frame look direct: `relayed` sits OUTSIDE the signature, but a
// frame marked relayed is never forwarded again (hop limit 1), and a frame marked direct must come
// from the origin's own connection.
//
// A signal travels directly, or through a relay that has CONFIRMED (route probe on this same
// protocol) that it is itself connected to and admitted with the destination; with no such relay
// there is no route. Bounds: frame size cap (a bigger frame aborts the stream before it is
// buffered), per-peer and per-ORIGIN rate limits, a relay-forward timeout, freshness window,
// replay protection keyed on (from, id) that survives restart through a bounded file store with a
// TTL, and a payload cap above S1's own SDP limit.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { decode } from 'it-length-prefixed'
import { peerIdFromString } from '@libp2p/peer-id'
import { verifyMessageWithPeerId } from '../../automerge/authorityLogSignature.js'
import { sendFramed, receiveFramed } from './wireProtocol.js'
import { EVENTS } from './connectivityEvents.js'

export const PUNCH_SIGNAL_PROTO = '/shoresh/punch-signal/1'
export const MAX_FRAME_BYTES = 32 * 1024
export const MAX_PAYLOAD_CHARS = 20 * 1024
export const MAX_SKEW_MS = 2 * 60 * 1000
const SIGNAL_SIG_CONTEXT = 'shoresh-punch-signal-sig-v1'
const DEFAULT_LIMITS = { rateMax: 60, originRateMax: 30, rateWindowMs: 10_000, seenMax: 512, forwardFanout: 3, forwardTimeoutMs: 5000 }

export function canonicalEnvelope({ id, from, to, ts, payload }) {
  return `${SIGNAL_SIG_CONTEXT}\n${JSON.stringify([id, from, to, ts, payload])}`
}

const enc = (o) => new TextEncoder().encode(JSON.stringify(o))

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('punch-signal: timed out')), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Replay memory keyed on (from, id), each entry living only until its envelope can no longer pass
 * the freshness window (ts + MAX_SKEW_MS), bounded at `max`. With a filePath it is rewritten on every
 * accepted id so a restart cannot reopen the window; a missing or corrupt file starts empty.
 */
export function createReplayStore({ filePath, max = DEFAULT_LIMITS.seenMax, now = Date.now } = {}) {
  const seen = new Map()
  if (filePath) {
    try {
      for (const [k, exp] of JSON.parse(fs.readFileSync(filePath, 'utf8'))) if (typeof k === 'string' && Number.isFinite(exp)) seen.set(k, exp)
    } catch { /* first run or unreadable: start empty */ }
  }
  const prune = () => {
    const at = now()
    for (const [k, exp] of seen) if (exp <= at) seen.delete(k)
    while (seen.size > max) seen.delete(seen.keys().next().value)
  }
  return {
    remember(from, id, ts) {
      prune()
      const key = JSON.stringify([from, id])
      if (seen.has(key)) return false
      seen.set(key, ts + MAX_SKEW_MS)
      prune()
      if (filePath) {
        try {
          fs.writeFileSync(`${filePath}.tmp`, JSON.stringify([...seen]))
          fs.renameSync(`${filePath}.tmp`, filePath)
        } catch { /* persistence is best-effort; the in-memory window still holds */ }
      }
      return true
    },
    size() {
      prune()
      return seen.size
    },
  }
}

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max

function parseFrame(bytes) {
  let frame
  try {
    frame = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (frame?.v === 1 && frame.probe === true) return str(frame.to, 128) ? { probe: true, to: frame.to } : null
  const env = frame?.env
  if (frame?.v !== 1 || typeof frame.relayed !== 'boolean' || !env || typeof env !== 'object') return null
  if (!str(env.id, 64) || !str(env.from, 128) || !str(env.to, 128) || !str(env.sig, 200)) return null
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return null
  if (!str(env.payload, MAX_PAYLOAD_CHARS)) return null
  return { relayed: frame.relayed, env: { id: env.id, from: env.from, to: env.to, ts: env.ts, payload: env.payload, sig: env.sig } }
}

/**
 * node: a libp2p node. isAdmitted(peerId): the authGate's admitted set. registry:
 * deviceRegistryFromDb (trusted devices only). sign(message): signs with this device's identity key.
 */
export function createPunchSignaling({ node, selfDeviceId, isAdmitted, registry, sign, now = Date.now, limits = {}, replayStore, emit = () => {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const listeners = new Map()
  const replay = replayStore ?? createReplayStore({ max: lim.seenMax, now })
  const rate = new Map()

  const eligible = (peerId) => isAdmitted(peerId) && registry.deviceIdForPeer(peerId) != null
  const connected = (peerId) => node.getPeers().some((p) => p.toString() === peerId)
  const fresh = (env) => Math.abs(now() - env.ts) <= MAX_SKEW_MS

  function verified(env) {
    const originPeerId = registry.peerIdForDevice(env.from)
    return originPeerId != null && verifyMessageWithPeerId(originPeerId, canonicalEnvelope(env), env.sig)
  }

  function overRate(key, max = lim.rateMax) {
    const at = now()
    const r = rate.get(key)
    if (!r || at - r.start >= lim.rateWindowMs) {
      rate.set(key, { start: at, count: 1 })
      return false
    }
    return ++r.count > max
  }

  async function sendFrame(peerId, frame) {
    const stream = await node.dialProtocol(peerIdFromString(peerId), PUNCH_SIGNAL_PROTO, {
      runOnLimitedConnection: true,
      signal: AbortSignal.timeout(lim.forwardTimeoutMs),
    })
    await sendFramed(stream, enc(frame), { drainTimeoutMs: lim.forwardTimeoutMs })
    await stream.close().catch(() => {})
  }

  const routableHere = (deviceId) => {
    const peerId = registry.peerIdForDevice(deviceId)
    return peerId != null && eligible(peerId) && connected(peerId)
  }

  async function probeRelay(relayPeerId, toDeviceId) {
    const run = async () => {
      const stream = await node.dialProtocol(peerIdFromString(relayPeerId), PUNCH_SIGNAL_PROTO, {
        runOnLimitedConnection: true,
        signal: AbortSignal.timeout(lim.forwardTimeoutMs),
      })
      try {
        await sendFramed(stream, enc({ v: 1, probe: true, to: toDeviceId }))
        for await (const chunk of decode(stream, { maxDataLength: 1024 })) {
          return JSON.parse(new TextDecoder().decode(chunk.subarray())).routable === true
        }
        return false
      } finally {
        await stream.close().catch(() => {})
      }
    }
    return withTimeout(run(), lim.forwardTimeoutMs).catch(() => false)
  }

  async function confirmedRelays(toDeviceId) {
    const toPeerId = registry.peerIdForDevice(toDeviceId)
    const candidates = node.getPeers().map(String).filter((p) => p !== toPeerId && eligible(p)).slice(0, lim.forwardFanout)
    const answers = await Promise.all(candidates.map((p) => probeRelay(p, toDeviceId)))
    return candidates.filter((_, i) => answers[i])
  }

  function deliver(env) {
    let msg
    try {
      msg = JSON.parse(env.payload)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    for (const cb of listeners.get(env.from) ?? []) {
      try { cb(msg) } catch { /* a listener must never break the signal stream */ }
    }
  }

  async function onFrame(bytes, senderPeerId, stream) {
    if (!eligible(senderPeerId) || overRate(`peer:${senderPeerId}`)) return
    const frame = parseFrame(bytes)
    if (!frame) return
    if (frame.probe) {
      await sendFramed(stream, enc({ v: 1, routable: routableHere(frame.to) }))
      return
    }
    const { relayed, env } = frame
    const senderDeviceId = registry.deviceIdForPeer(senderPeerId)
    if (!fresh(env)) {
      if (env.to === selfDeviceId && verified(env)) emit(EVENTS.CLOCK_SKEW, { peerId: senderPeerId, source: 'punch-signal', reason: 'stale-or-future-signal', skewMs: now() - env.ts })
      return
    }
    if (env.to === selfDeviceId) {
      if (!relayed && env.from !== senderDeviceId) return
      if (!verified(env) || overRate(`origin:${env.from}`, lim.originRateMax) || !replay.remember(env.from, env.id, env.ts)) return
      deliver(env)
      return
    }
    if (relayed || env.from !== senderDeviceId || env.to === env.from) return
    const toPeerId = registry.peerIdForDevice(env.to)
    if (!toPeerId || !eligible(toPeerId) || !connected(toPeerId) || !verified(env) || overRate(`origin:${env.from}`, lim.originRateMax)) return
    await withTimeout(sendFrame(toPeerId, { v: 1, relayed: true, env }), lim.forwardTimeoutMs)
  }

  async function send(toDeviceId, msg) {
    const payload = JSON.stringify(msg)
    if (payload.length > MAX_PAYLOAD_CHARS) throw new Error(`punch-signal: payload over size cap (${MAX_PAYLOAD_CHARS} chars)`)
    const env = { id: randomBytes(16).toString('hex'), from: selfDeviceId, to: toDeviceId, ts: now(), payload }
    env.sig = sign(canonicalEnvelope(env))
    if (routableHere(toDeviceId)) {
      const toPeerId = registry.peerIdForDevice(toDeviceId)
      await sendFrame(toPeerId, { v: 1, relayed: false, env })
      return
    }
    const relays = await confirmedRelays(toDeviceId)
    const results = await Promise.allSettled(relays.map((p) => sendFrame(p, { v: 1, relayed: false, env })))
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('punch-signal: no route to ' + toDeviceId)
  }

  return {
    async start() {
      await node.handle(
        PUNCH_SIGNAL_PROTO,
        (stream, connection) => {
          const peerId = connection.remotePeer.toString()
          if (!eligible(peerId)) {
            stream.abort(new Error('unauthenticated'))
            return
          }
          receiveFramed(stream, (bytes) => { onFrame(bytes, peerId, stream).catch(() => {}) }, { maxDataLength: MAX_FRAME_BYTES })
            .catch(() => stream.abort(new Error('bad_signal_frame')))
        },
        { runOnLimitedConnection: true }
      )
    },
    async stop() {
      await node.unhandle(PUNCH_SIGNAL_PROTO)
    },
    async hasRoute(toDeviceId) {
      if (routableHere(toDeviceId)) return true
      return (await confirmedRelays(toDeviceId)).length > 0
    },
    channelTo(remoteDeviceId) {
      return {
        sendSignal: (msg) => send(remoteDeviceId, msg),
        onSignal(cb) {
          if (!listeners.has(remoteDeviceId)) listeners.set(remoteDeviceId, new Set())
          listeners.get(remoteDeviceId).add(cb)
          return () => listeners.get(remoteDeviceId)?.delete(cb)
        },
      }
    },
  }
}
