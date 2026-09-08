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
import { PROTO, AUTH_PROTO, SYNC_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'
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
// `onPairingRequest`/`onLogin` (Stage 5d-2b) are injected the same way
// `onAuthenticate` already is — this module stays auth-semantics-free and
// simply wires whatever the caller (syncNode.js) hands it into
// registerAuthGate. `peerDiscovery` accepts a libp2p peerDiscovery service
// array (e.g. createMdnsDiscovery from ./discovery.js) for real-LAN camp-
// scoped discovery; omitted by default so tests keep dialing directly over
// loopback (mDNS needs a real network interface — see discovery.js's own
// module comment).
export async function startTransport({ deviceId: _deviceId, onDocReceived, onSyncMessageReceived, listen, onAuthenticate, onPairingRequest, onLogin, onPeerAdmitted, onPairingDecision, peerDiscovery, now } = {}) {
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
    ...(peerDiscovery ? { peerDiscovery } : {}),
  })

  const { authenticatedPeers, sendPairingApproved, sendPairingDenied } = registerAuthGate(node, {
    onAuthenticate,
    onPairingRequest,
    onLogin,
    onPeerAdmitted,
    onPairingDecision,
    ...(now ? { now } : {}),
  })

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

  // Inbound half of the sync protocol — same admission gate as PROTO's handler above (Stage 5d-1's
  // ADR §3, threat #1/#4): an unauthenticated peer's bytes never reach A.receiveSyncMessage.
  await node.handle(SYNC_PROTO, ({ stream, connection }) => {
    const fromPeerId = connection.remotePeer.toString()
    if (!authenticatedPeers.has(fromPeerId)) {
      stream.abort(new Error('unauthenticated'))
      return
    }
    receiveFramed(stream.source, (bytes) => {
      Promise.resolve(onSyncMessageReceived?.(bytes, { fromPeerId })).catch((err) => {
        console.error(`transport: onSyncMessageReceived handler rejected — isolated: ${err?.message ?? err}`)
      })
    }).catch(() => {
      // A malformed/adversarial peer closing or corrupting the stream must not crash this node.
    })
  })

  async function sendDocTo(peerId, docBytes) {
    const stream = await node.dialProtocol(toDialTarget(peerId), PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream.sink, docBytes)
  }

  // Stage 5f-2: real Automerge sync protocol (initSyncState/generateSyncMessage/
  // receiveSyncMessage), on its own protocol id — see wireProtocol.js's SYNC_PROTO comment for why
  // it is not folded into PROTO. Each direction of the exchange is its own short-lived dial+frame,
  // exactly like sendDocTo/authenticateWith already do — there is no need for a held-open stream,
  // because the protocol is inherently a back-and-forth of independent messages: receiving one
  // triggers the caller (syncNode.js) to generate and send the next, until both sides produce null.
  //
  // Gated the SAME way broadcastDoc's outbound filter is gated (Security review precedent above):
  // never send doc-derived bytes to a peer THIS node has not itself admitted, even though the
  // caller (syncNode.js) only ever calls this for peers it just admitted or just heard from — the
  // check is enforced here, at the transport boundary, so it can't be bypassed by a future call
  // site forgetting it.
  async function sendSyncMessage(peerId, bytes) {
    const target = peerId.toString()
    if (!authenticatedPeers.has(target)) return
    const stream = await node.dialProtocol(toDialTarget(peerId), SYNC_PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream.sink, bytes)
    await stream.close().catch(() => {})
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
    sendSyncMessage,
    dial,
    authenticateWith,
    isPeerAuthenticated: (peerId) => authenticatedPeers.has(peerId),
    // FIRST-JOIN TRUST BOOTSTRAP — the one way into `authenticatedPeers` that
    // is not an `authenticate` frame, and the only caller is joinSession.js
    // immediately after a successful `login` to this exact peer. Read the
    // reasoning before using it anywhere else; it is a deliberate hole with a
    // narrow, argued shape, and MUST be covered by the security review the
    // join-flow ADR mandates.
    //
    // WHY IT HAS TO EXIST. Admission is mutual (Stage 5 finding 4): a node
    // only sends to peers that authenticated to IT, so the Host must
    // authenticate to the joining device before any document can flow. Every
    // token this codebase issues is Ed25519-signed by the Host's key and
    // verified against `camps.signing_public_key` — which a joining device
    // gets FROM the document it has not received yet. The Host therefore
    // cannot prove itself to a camp-less device by any cryptographic means
    // available at that moment. This is inherent to first pairing, not an
    // oversight.
    //
    // WHY IT IS ACCEPTABLE. The trust anchor is human, and it is the same
    // anchor the WS path already relies on: the director typed THIS camp's
    // join code, the director approved THIS device on the Host's screen, and
    // the joining device just completed a PIN login against this peer's real
    // user table. The op-log's `full_sync` handed a Client its identity on
    // exactly that basis, with no cryptographic proof of the Host either — so
    // this is parity, not a new exposure. From the next launch onward the
    // device has `signing_public_key` and every ordinary path verifies.
    //
    // WHAT IT IS NOT. It is not a way to skip authentication generally, and
    // it grants nothing on the HOST — the joiner still had to pair and log in
    // there. A caller that admits a peer it did not just authenticate ITSELF
    // to has defeated the admission gate; that is the misuse to review for.
    admitPeer: (peerId) => {
      const id = String(peerId)
      if (authenticatedPeers.has(id)) return
      authenticatedPeers.add(id)
      // Same follow-on an inbound `authenticate` gets: admission is what
      // starts the Automerge sync exchange (syncNode's onPeerAdmitted seeds a
      // sync state and steps it). Without this the joining device would sit
      // admitted but silent, waiting for the Host to speak first.
      onPeerAdmitted?.(id)
    },
    sendPairingApproved,
    sendPairingDenied,
    // Fires cb({ id, multiaddrs }) for every peer libp2p's discovery
    // mechanism (e.g. mDNS via createMdnsDiscovery) surfaces. Only relevant
    // when `peerDiscovery` was passed in above; a caller that never sets it
    // (every existing test, and any in-process direct-dial caller) simply
    // never sees this fire.
    onPeerDiscovery: (cb) => {
      node.addEventListener('peer:discovery', (evt) => {
        cb({ id: evt.detail.id.toString(), multiaddrs: evt.detail.multiaddrs })
      })
    },
    // Stage 5f-2: lets syncNode.js discard a peer's sync state (initSyncState/generateSyncMessage
    // progress) the moment the underlying connection is gone — mirrors authGate.js's own
    // `authenticatedPeers.delete` on the SAME event, for the SAME reason: a stale entry surviving
    // disconnect is meaningless (and, for sync state specifically, just wasted memory — reconnect
    // starts a fresh exchange either way, which converges correctly, just less efficiently, since
    // it doesn't know what was already exchanged before the ORIGINAL sync state was discarded).
    onPeerDisconnected: (cb) => {
      node.addEventListener('peer:disconnect', (evt) => {
        cb(evt.detail.toString())
      })
    },
    stop: () => node.stop(),
  }
}
