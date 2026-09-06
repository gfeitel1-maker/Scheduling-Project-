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
// membership check. Protocol-gating (node.handle(PROTO, ...) below) is
// necessary but not sufficient as camp isolation — see the design doc's
// "Security surface" section. Stage 5 maps privileged roles onto peer ids;
// this module does not.
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { peerIdFromString } from '@libp2p/peer-id'
import { PROTO, sendFramed, receiveFramed } from './wireProtocol.js'

// Accept either a PeerId/Multiaddr object (as returned by getPeers()'s
// underlying node, or by getMultiaddrs()) or transport.js's own stringified
// peer id — so callers of the public API (sendDocTo) can pass back a string
// obtained from getPeers(), while dial() also accepts a raw Multiaddr object
// for direct-dial tests (mirrors test-cr4-live.mjs's own dial pattern).
function toDialTarget(peerIdOrMultiaddr) {
  return typeof peerIdOrMultiaddr === 'string' ? peerIdFromString(peerIdOrMultiaddr) : peerIdOrMultiaddr
}

const DEFAULT_LISTEN = ['/ip4/127.0.0.1/tcp/0']

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
export async function startTransport({ deviceId: _deviceId, onDocReceived, listen } = {}) {
  const node = await createLibp2p({
    addresses: { listen: listen ?? DEFAULT_LISTEN },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })

  await node.handle(PROTO, ({ stream, connection }) => {
    receiveFramed(stream.source, (bytes) => {
      onDocReceived?.(bytes, { fromPeerId: connection.remotePeer.toString() })
    }).catch(() => {
      // A malformed/adversarial peer closing or corrupting the stream must not
      // crash this node — see design doc's "what must NOT be trusted" section.
    })
  })

  async function sendDocTo(peerId, docBytes) {
    const stream = await node.dialProtocol(toDialTarget(peerId), PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream.sink, docBytes)
  }

  async function broadcastDoc(docBytes, { exceptPeerId } = {}) {
    const peers = node.getPeers()
    await Promise.all(
      peers
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

  return {
    peerId: node.peerId.toString(),
    getPeers: () => node.getPeers().map((p) => p.toString()),
    getMultiaddrs: () => node.getMultiaddrs(),
    broadcastDoc,
    sendDocTo,
    dial,
    stop: () => node.stop(),
  }
}
