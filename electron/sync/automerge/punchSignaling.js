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
// Bounds: frame size cap (a bigger frame aborts the stream before it is buffered), per-peer rate
// limit, freshness window, bounded replay cache, and a payload cap above S1's own SDP limit.
import { randomBytes } from 'node:crypto'
import { peerIdFromString } from '@libp2p/peer-id'
import { verifyMessageWithPeerId } from '../../automerge/authorityLogSignature.js'
import { sendFramed, receiveFramed } from './wireProtocol.js'

export const PUNCH_SIGNAL_PROTO = '/shoresh/punch-signal/1'
export const MAX_FRAME_BYTES = 32 * 1024
export const MAX_PAYLOAD_CHARS = 20 * 1024
export const MAX_SKEW_MS = 2 * 60 * 1000
const SIGNAL_SIG_CONTEXT = 'shoresh-punch-signal-sig-v1'
const DEFAULT_LIMITS = { rateMax: 60, rateWindowMs: 10_000, seenMax: 512, forwardFanout: 3 }

export function canonicalEnvelope({ id, from, to, ts, payload }) {
  return `${SIGNAL_SIG_CONTEXT}\n${JSON.stringify([id, from, to, ts, payload])}`
}

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max

function parseFrame(bytes) {
  let frame
  try {
    frame = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
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
export function createPunchSignaling({ node, selfDeviceId, isAdmitted, registry, sign, now = Date.now, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const listeners = new Map()
  const seen = new Map()
  const rate = new Map()

  const eligible = (peerId) => isAdmitted(peerId) && registry.deviceIdForPeer(peerId) != null
  const connected = (peerId) => node.getPeers().some((p) => p.toString() === peerId)
  const fresh = (env) => Math.abs(now() - env.ts) <= MAX_SKEW_MS

  function verified(env) {
    const originPeerId = registry.peerIdForDevice(env.from)
    return originPeerId != null && verifyMessageWithPeerId(originPeerId, canonicalEnvelope(env), env.sig)
  }

  function overRate(peerId) {
    const at = now()
    const r = rate.get(peerId)
    if (!r || at - r.start >= lim.rateWindowMs) {
      rate.set(peerId, { start: at, count: 1 })
      return false
    }
    return ++r.count > lim.rateMax
  }

  function remember(id) {
    if (seen.has(id)) return false
    seen.set(id, true)
    if (seen.size > lim.seenMax) seen.delete(seen.keys().next().value)
    return true
  }

  async function sendFrame(peerId, frame) {
    const stream = await node.dialProtocol(peerIdFromString(peerId), PUNCH_SIGNAL_PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream, new TextEncoder().encode(JSON.stringify(frame)))
    await stream.close().catch(() => {})
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

  async function onFrame(bytes, senderPeerId) {
    if (!eligible(senderPeerId) || overRate(senderPeerId)) return
    const frame = parseFrame(bytes)
    if (!frame || !fresh(frame.env)) return
    const { relayed, env } = frame
    const senderDeviceId = registry.deviceIdForPeer(senderPeerId)
    if (env.to === selfDeviceId) {
      if (!relayed && env.from !== senderDeviceId) return
      if (!verified(env) || !remember(env.id)) return
      deliver(env)
      return
    }
    if (relayed || env.from !== senderDeviceId || env.to === env.from) return
    const toPeerId = registry.peerIdForDevice(env.to)
    if (!toPeerId || !eligible(toPeerId) || !connected(toPeerId) || !verified(env)) return
    await sendFrame(toPeerId, { v: 1, relayed: true, env })
  }

  async function send(toDeviceId, msg) {
    const payload = JSON.stringify(msg)
    if (payload.length > MAX_PAYLOAD_CHARS) throw new Error(`punch-signal: payload over size cap (${MAX_PAYLOAD_CHARS} chars)`)
    const env = { id: randomBytes(16).toString('hex'), from: selfDeviceId, to: toDeviceId, ts: now(), payload }
    env.sig = sign(canonicalEnvelope(env))
    const toPeerId = registry.peerIdForDevice(toDeviceId)
    if (toPeerId && eligible(toPeerId) && connected(toPeerId)) {
      await sendFrame(toPeerId, { v: 1, relayed: false, env })
      return
    }
    const relays = node.getPeers().map(String).filter((p) => p !== toPeerId && eligible(p)).slice(0, lim.forwardFanout)
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
          receiveFramed(stream, (bytes) => { onFrame(bytes, peerId).catch(() => {}) }, { maxDataLength: MAX_FRAME_BYTES })
            .catch(() => stream.abort(new Error('bad_signal_frame')))
        },
        { runOnLimitedConnection: true }
      )
    },
    async stop() {
      await node.unhandle(PUNCH_SIGNAL_PROTO)
    },
    hasRoute(toDeviceId) {
      const toPeerId = registry.peerIdForDevice(toDeviceId)
      if (toPeerId && eligible(toPeerId) && connected(toPeerId)) return true
      return node.getPeers().map(String).some((p) => p !== toPeerId && eligible(p))
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
