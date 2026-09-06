// Stage 4b (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md):
// libp2p node lifecycle — start/stop, protocol handler, dial, broadcast.
//
// Deliberately Automerge-free: this module hands raw Uint8Array doc bytes up
// to its caller via onDocReceived and never calls A.load/A.merge itself (see
// syncNode.js for the glue that does). That split keeps this module testable
// with plain byte arrays and keeps the one place with real domain
// consequences — merge-then-project — reviewable without libp2p internals.
//
// Every libp2p peer here is symmetric: no Host/Client distinction, no camp-
// membership check beyond the auth admission gate below. Protocol-gating
// (node.handle(PROTO, ...) below) is necessary but not sufficient as camp
// isolation on its own — see the design doc's "Security surface" section.
//
// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §3) closes the
// gap that comment used to describe: the doc-sync protocol handler now
// refuses any peer that has not completed the auth handshake
// (electron/sync/automerge/authGate.js) ON THIS SAME libp2p connection. This
// module still knows nothing about tokens/PIN/device-trust semantics —
// `onAuthenticate` is injected by the caller (syncNode.js) exactly the way
// `onDocReceived` already is, keeping this module testable with a fake
// authenticator.
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { peerIdFromString } from '@libp2p/peer-id'
import { PROTO, AUTH_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'
import { registerAuthGate } from './authGate.js'

// Accept either a PeerId/Multiaddr object (as returned by getPeers()'s
// underlying node, or by getMultiaddrs()) or transport.js's own stringified
// peer id — so callers of the public API (sendDocTo) can pass back a string
// obtained from getPeers(), while dial() also accepts a raw Multiaddr object
// for direct-dial tests (mirrors test-cr4-live.mjs's own dial pattern).
function toDialTarget(peerIdOrMultiaddr) {
  return typeof peerIdOrMultiaddr === 'string' ? peerIdFromString(peerIdOrMultiaddr) : peerIdOrMultiaddr
}

const DEFAULT_LISTEN = ['/ip4/127.0.0.1/tcp/0']

// Connection-flood DoS backstop (Security review). A camp LAN is a few devices;
// this ceiling is deliberately generous and only caps a flood.
const MAX_CONNECTIONS = 200

// Start a libp2p node. mDNS discovery is deliberately NOT wired in here (that
// is discovery.js, slice 4d) — tests and in-process callers dial directly.
//
// onDocReceived(bytes, { fromPeerId }) fires once per received frame, for
// peers that dialed PROTO. A peer speaking a different protocol never
// triggers it — that is the protocol-gating security property.
// `deviceId` is accepted (not yet used) to keep the call-site shape stable
// for Stage 5/6, which will need it once Host-privileged-role mapping onto
// libp2p PeerIds is designed — see the design doc's "Host stays privileged"
// section. Every libp2p peer here is symmetric today.
export async function startTransport({ deviceId: _deviceId, onDocReceived, listen, onAuthenticate } = {}) {
  const node = await createLibp2p({
    addresses: { listen: listen ?? DEFAULT_LISTEN },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Security review backstop: bound how many peer connections this node will
    // hold at once. A camp LAN is a handful of devices; this generous ceiling
    // only exists to cap a connection-flood DoS, not to constrain normal use.
    // (Per-peer frame-RATE limiting — a token bucket ahead of A.merge — is a
    // Stage-5 pre-wiring item per the Security review; the frame-SIZE cap lives
    // in wireProtocol.js's MAX_FRAME_BYTES.)
    connectionManager: { maxConnections: MAX_CONNECTIONS },
    services: { identify: identify() },
  })

  const { authenticatedPeers } = registerAuthGate(node, { onAuthenticate })

  await node.handle(PROTO, ({ stream, connection }) => {
    const fromPeerId = connection.remotePeer.toString()
    // Stage 5d-1 admission gate (ADR §3, threat #1/#4): a peer that has not
    // completed the auth handshake on THIS connection never reaches
    // receiveFramed — its bytes never reach A.load/A.merge at all. This is a
    // coarse connection-admission check, not a re-derivation of
    // authorize()-style per-action permissions; see the ADR for why the two
    // don't collapse into one gate.
    if (!authenticatedPeers.has(fromPeerId)) {
      stream.abort(new Error('unauthenticated'))
      return
    }
    receiveFramed(stream.source, (bytes) => {
      // onDocReceived is async and invoked fire-and-forget here; a rejection
      // from it (e.g. the consumer's projection/merge throwing) must never
      // become an unhandled promise rejection — which in Electron's main
      // process could crash the app. Isolate it per-frame. The consumer
      // (syncNode) also guards internally; this is defense in depth.
      Promise.resolve(onDocReceived?.(bytes, { fromPeerId })).catch(
        (err) => {
          console.error(`transport: onDocReceived handler rejected — isolated: ${err?.message ?? err}`)
        }
      )
    }).catch(() => {
      // A malformed/adversarial peer closing or corrupting the stream must not
      // crash this node — see design doc's "what must NOT be trusted" section.
    })
  })

  async function sendDocTo(peerId, docBytes) {
    const stream = await node.dialProtocol(toDialTarget(peerId), PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream.sink, docBytes)
  }

  // Security review, Stage 5d-1 (CRITICAL): the admission gate must be
  // SYMMETRIC. Gating only the inbound PROTO handler stops an unauthenticated
  // peer's bytes from reaching A.merge, but does nothing to stop THIS node's
  // bytes reaching an unauthenticated peer — and node.getPeers() returns every
  // libp2p-connected peer, including one that merely completed a noise
  // handshake and never dialed AUTH_PROTO at all. Without this filter, any
  // stranger on the LAN who opens a connection receives the full serialized
  // camp document (roster, schedule, everything) on every local write and every
  // relayed merge. Noise proves a secure channel, not camp membership.
  //
  // Filtering here (rather than inside sendDocTo) keeps the direct-send path
  // usable by the adversarial-input tests, which deliberately send to a peer
  // that has NOT authenticated in order to prove the inbound gate rejects it.
  async function broadcastDoc(docBytes, { exceptPeerId } = {}) {
    const peers = node.getPeers()
    await Promise.all(
      peers
        .filter((p) => authenticatedPeers.has(p.toString()))
        .filter((p) => !exceptPeerId || p.toString() !== exceptPeerId)
        .map((p) => sendDocTo(p, docBytes).catch(() => {
          // Best-effort: a peer that has gone away since getPeers() shouldn't
          // fail the whole broadcast for the peers still reachable.
        }))
    )
  }

  // Accepts a raw Multiaddr object (e.g. from another node's getMultiaddrs())
  // for direct-dial tests, or a stringified peer id once already connected.
  async function dial(multiaddrOrPeerId) {
    return node.dial(toDialTarget(multiaddrOrPeerId), { runOnLimitedConnection: true })
  }

  // Dials the target peer's auth protocol and sends `msg` (e.g.
  // {type:'authenticate', token, device_id} — ADR §1's "reconnect" flow),
  // resolving with the peer's `auth_ok`/`auth_failed` response frame. Does
  // NOT itself admit anything on THIS node — admission is one-directional,
  // decided by whichever side ran onAuthenticate and populated its own
  // authenticatedPeers set.
  async function authenticateWith(peerId, msg) {
    const stream = await node.dialProtocol(toDialTarget(peerId), AUTH_PROTO, { runOnLimitedConnection: true })
    return new Promise((resolve, reject) => {
      let settled = false
      receiveFramed(stream.source, (bytes) => {
        if (settled) return
        settled = true
        try {
          resolve(JSON.parse(new TextDecoder().decode(bytes)))
        } catch (err) {
          reject(err)
        }
      }).catch((err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      sendFramed(stream.sink, new TextEncoder().encode(JSON.stringify(msg))).catch((err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
  }

  return {
    peerId: node.peerId.toString(),
    getPeers: () => node.getPeers().map((p) => p.toString()),
    getMultiaddrs: () => node.getMultiaddrs(),
    broadcastDoc,
    sendDocTo,
    dial,
    authenticateWith,
    isPeerAuthenticated: (peerId) => authenticatedPeers.has(peerId),
    stop: () => node.stop(),
  }
}
