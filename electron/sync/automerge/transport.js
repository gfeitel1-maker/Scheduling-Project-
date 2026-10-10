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
import { PROTO, AUTH_PROTO, SYNC_PROTO, HANDOFF_PROTO, HANDOFF_MAX_FRAME_BYTES, sendFramed, receiveFramed } from './wireProtocol.js'
import { registerAuthGate, isLanMultiaddr } from './authGate.js'
import { makeConnectionRateLimiter, ipFromMultiaddr, connKeyFromMultiaddr } from './connectionRateLimiter.js'

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

// T340 precondition 5 (docs/work/security/2026-10-09-t340-p5-pending-slot-sizing.md). libp2p 3.3.11's
// default for maxIncomingPendingConnections is 10 (connection-manager/constants.defaults); it bounds
// inbound connections accepted but not yet through the whole upgrade (multistream, Noise, muxer). When
// full, libp2p refuses new inbound outright, LAN sources included. So the limiter caps PUBLIC sources at
// MAX_PUBLIC_PENDING_TOTAL (64) of the 256 slots, leaving LAN at least 192 however hard a scanner pushes.
// Per-source pending cap is 2 and the upgrade timeout 5s (see the ticket for the fd/memory sizing).
export const MAX_INCOMING_PENDING_CONNECTIONS = 256

// libp2p's inboundUpgradeTimeout (default 10s) bounds how long one pending slot is held, for the whole
// upgrade. A real WAN handshake is ~3-4 round trips (~1.2s at 300ms RTT); 5s halves a scanner's hold.
export const INBOUND_UPGRADE_TIMEOUT_MS = 5_000

// Slots that an un-admitted flood can never occupy. A camp is at most a few dozen devices; 32 is
// generous. The un-admitted ceiling is therefore MAX_CONNECTIONS - RESERVED_FLOOR = 168.
const RESERVED_FLOOR = 32

// libp2p's inboundUpgradeTimeout (INBOUND_UPGRADE_TIMEOUT_MS above) ends when the upgrade completes, and nothing bounds a connection that has
// finished Noise but never authenticates, so this deadline is new. 10s is ample: a real
// authenticate round-trip is tens of milliseconds on a LAN.
export const UNADMITTED_DEADLINE_MS = 10_000

const ADMITTED_TAG = 'shoresh-admitted'

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
// T336 (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §1): `directUpgradeServiceFactory`
// is the dcutr direct-upgrade service, injected the SAME way `relayServerFactory`/
// `relayTransportFactory` already are — a caller-supplied factory (e.g. `dcutr()` from
// '@libp2p/dcutr'), never imported here directly, so this module stays free of a direct import of
// that package and this capability's gate stays entirely caller-controlled (syncStarter.js, gated
// on `holePunchFoundationPresent()` + the `dcutr` capability's own signoff). The direct-upgrade
// attempt only ever runs over a connection that arrived via T337's already camp-admitted relay (see
// the design doc §1) — it needs no admission check of its own here, because it has no reachability
// path into this node that didn't already pass the relay's own `isPeerAdmittedForRelay` gate above.
// S1 (T347, docs/adr/2026-10-08-relayless-cross-network-reconnect.md "Integration ruling"):
// `punchTransportFactory` is the ICE data-channel libp2p transport, injected the same way and never
// imported here. Connections it forms enter libp2p's normal upgrader, so Noise + the auth gate
// below apply to them unchanged; no admission is re-implemented for it.
export async function startTransport({ deviceId: _deviceId, onDocReceived, onSyncMessageReceived, onHandoffMessage, handoffFaults = {}, listen, onAuthenticate, onPairingRequest, onLogin, onPeerAdmitted, onPairingDecision, peerDiscovery, now, connectionRateLimiter, privateKey, schemaVersion, relayServerFactory, relayTransportFactory, directUpgradeServiceFactory, punchTransportFactory, inboundConnectionThreshold, onRelayReservationRefused, maxConnections = MAX_CONNECTIONS, maxIncomingPendingConnections = MAX_INCOMING_PENDING_CONNECTIONS, inboundUpgradeTimeoutMs = INBOUND_UPGRADE_TIMEOUT_MS, reservedFloor = RESERVED_FLOOR, unadmittedDeadlineMs = UNADMITTED_DEADLINE_MS } = {}) {
  // Per-SOURCE-IP inbound rate limiting (blocker #2 of the WAN hardening; connectionRateLimiter.js).
  // Closes the connection-churn hole authGate.js documents: a peer opening a fresh connection (fresh
  // peer id) per frame evades per-peer throttling and is otherwise bounded only by MAX_CONNECTIONS.
  // This denies BEFORE the noise handshake (the earliest inbound hook), so it also bounds the
  // handshake cost of a flood. It exempts loopback + every private range, so it is INERT on the LAN
  // (all-private) and in tests (loopback) — it can only ever limit a PUBLIC source, which appears
  // only once internet transport is enabled. Injectable for tests; a real limiter by default.
  const rateLimiter = connectionRateLimiter ?? makeConnectionRateLimiter({ pendingTtlMs: inboundUpgradeTimeoutMs, ...(now ? { now } : {}) })
  // T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §A, §E): the camp-peer
  // circuit-relay-v2 coordination relay. `relayServerFactory`/`relayTransportFactory` are
  // injected factory functions (e.g. circuitRelayServer()/circuitRelayTransport() from
  // '@libp2p/circuit-relay-v2') — this module stays free of a direct import of that package, the
  // same discipline peerDiscovery already follows, so the capability stays entirely caller-
  // controlled (syncStarter.js, gated on SHORESH_RELAY_ENABLED + the `relay` capability's
  // signoff) and this file never branches on capability state itself.
  //
  // `isPeerAdmittedForRelay` is a reassignable closure, not a const, because the connectionGater
  // hooks below are evaluated by createLibp2p's config BEFORE registerAuthGate (further down)
  // produces `authenticatedPeers` — the gater closures are only ever CALLED later, once a real
  // HOP request arrives, by which point the reassignment below has already run. This is the
  // mechanism that makes §A's "restriction falls out of the mechanism" claim concrete: R's
  // circuitRelayServer refuses a RESERVE/CONNECT for any peer not in THIS node's own
  // authenticatedPeers set — the exact same set broadcastDoc already gates every send on.
  let isPeerAdmittedForRelay = () => false
  // T336 Precondition 2 — the CLIENT-side counterpart of the server-side restriction above: this
  // node's own circuitRelayTransport must never even ATTEMPT a reservation against a relay this
  // node has not itself admitted, independent of whether that relay would have granted it. The
  // transport's own RelayDiscovery only calls onConnect (which feeds its reservation attempts) for
  // a peer its topology `filter` reports as not-yet-seen (`filter.has(peerId) !== true`) — so
  // treating a non-admitted peer as "already seen" (closed over the SAME isPeerAdmittedForRelay
  // closure the server-side gater reads, not a second copy of "is X allowed") makes RelayDiscovery
  // structurally skip it, rather than relying entirely on the far side's own refusal to save us.
  // Wraps the caller-supplied factory rather than importing @libp2p/circuit-relay-v2 directly,
  // keeping this module's existing discipline of staying free of that import.
  //
  // One-shot caveat this wrapper alone does NOT handle: libp2p's registrar notifies a topology
  // listener (RelayDiscovery's onConnect) exactly ONCE per peer, at the moment identify completes
  // — which races the auth handshake, since a real admission normally lands a round-trip or two
  // AFTER identify, not before it. Blocking at that one-shot moment for a peer that is admitted
  // moments later would permanently skip a legitimate camp relay, not just a stray one. See
  // `retryClientRelayDiscoveryFor` below (called from the SAME onPeerAdmitted hook every admission
  // path already fires through) for the other half that makes this correct, not merely early.
  let clientRelayInstance = null
  function wrapClientRelayDiscoveryToCampOnly(factory) {
    return (components) => {
      const instance = factory(components)
      clientRelayInstance = instance
      // T336 Precondition 3 (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §4): every
      // reservation attempt this node's circuitRelayTransport ever makes — the library's own
      // internal 'relay:discover' listener (index.js), listener.js's configured-relay path, AND
      // our own retryClientRelayDiscoveryFor below — goes through this ONE addRelay method, so
      // wrapping it once here catches a refusal from any of those paths rather than only the one
      // this file calls directly. The original call is still made and its result/rejection still
      // propagates unchanged (the library's own '.catch' loggers downstream still run) — this only
      // OBSERVES a RESERVATION_REFUSED rejection in order to report it; it never swallows or
      // alters one. See reservation-store.js's #createReservation: a refusal throws a plain Error
      // whose message is `reservation failed with status ${status}`, there is no refusal EVENT.
      if (instance?.reservationStore?.addRelay) {
        const originalAddRelay = instance.reservationStore.addRelay.bind(instance.reservationStore)
        instance.reservationStore.addRelay = (peerId, type) => {
          const result = originalAddRelay(peerId, type)
          return Promise.resolve(result).catch((err) => {
            if (/RESERVATION_REFUSED/.test(String(err?.message))) {
              try {
                onRelayReservationRefused?.({
                  type: 'relay-reservation-refused',
                  peerId: peerId?.toString ? peerId.toString() : String(peerId),
                  reason: 'RESERVATION_REFUSED',
                  at: Date.now(),
                })
              } catch { /* a UI-notice callback must never break the reservation path itself */ }
            }
            throw err
          })
        }
      }
      if (instance?.discovery) {
        const seen = new Set()
        instance.discovery.filter = {
          has: (peerId) => {
            const id = peerId.toString()
            if (!isPeerAdmittedForRelay(id)) return true // treat as already-seen: never notify
            return seen.has(id)
          },
          add: (peerId) => {
            const id = peerId.toString()
            if (isPeerAdmittedForRelay(id)) seen.add(id)
          },
          remove: (peerId) => { seen.delete(peerId.toString()) },
        }
      }
      return instance
    }
  }
  // The retroactive half: a peer admitted AFTER its one-shot discovery notification was already
  // skipped (the ordinary case — admission follows identify) gets its reservation attempt redone
  // here, directly against the real ReservationStore, bypassing the registrar entirely. Best-
  // effort and silently ignored on failure (not connected, doesn't speak HOP, already have enough
  // relays, etc.) — exactly the same non-fatal handling circuitRelayTransport's own 'relay:discover'
  // listener already gives this call for the normal, non-retried path.
  function retryClientRelayDiscoveryFor(peerIdString) {
    if (!clientRelayInstance) return
    Promise.resolve(clientRelayInstance.reservationStore.addRelay(peerIdFromString(peerIdString), 'discovered')).catch(() => {})
  }
  const node = await createLibp2p({
    // T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §1): a
    // persistent per-device identity, loaded by the caller (syncNode.js's
    // startSyncNode via ensureDeviceIdentity) BEFORE this call — omitting it
    // (every existing test that doesn't pass one) falls back to libp2p's own
    // default of a fresh keypair per process start, unchanged from before.
    ...(privateKey ? { privateKey } : {}),
    addresses: { listen: listen ?? DEFAULT_LISTEN },
    transports: [tcp(), ...(relayTransportFactory ? [wrapClientRelayDiscoveryToCampOnly(relayTransportFactory)] : []), ...(punchTransportFactory ? [punchTransportFactory] : [])],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Security review backstop: bound how many peer connections this node will
    // hold at once. A camp LAN is a handful of devices; this generous ceiling
    // only exists to cap a connection-flood DoS, not to constrain normal use.
    // (Per-peer frame-RATE limiting — a token bucket ahead of A.merge — is a
    // Stage-5 pre-wiring item per the Security review; the frame-SIZE cap lives
    // in wireProtocol.js's MAX_FRAME_BYTES.)
    // `inboundConnectionThreshold` is test-only (libp2p's own default is 5 connections per
    // remote HOST — fine for a real camp LAN of distinct devices, but it refuses a test that
    // dials several real nodes from the single loopback host in quick succession). Production
    // never sets this; every existing caller omits it and gets libp2p's own default unchanged.
    connectionManager: { maxConnections, maxIncomingPendingConnections, inboundUpgradeTimeout: inboundUpgradeTimeoutMs, ...(inboundConnectionThreshold != null ? { inboundConnectionThreshold } : {}) },
    // Per-source-IP flood cap — see rateLimiter above. Returns true to DENY.
    connectionGater: {
      denyInboundConnection: (maConn) => {
        try {
          const addr = maConn?.remoteAddr?.toString()
          return !rateLimiter.allow(ipFromMultiaddr(addr), connKeyFromMultiaddr(addr))
        } catch {
          return false // never let a classification error block a connection (fail open)
        }
      },
      // T337 §A/§D — only wired when this node runs the relay server. Both hooks are
      // circuit-relay-v2's own extension points (server/index.js's handleReserve/handleConnect),
      // not something this app bolts on afterward: a RESERVE request from a peer this node has
      // not itself admitted is refused before any reservation is created, and a CONNECT request
      // naming a destination peer this node has not admitted is refused before any relayed
      // stream opens. `isPeerAdmittedForRelay` reads the SAME authenticatedPeers set as every
      // other admission check in this file — never a second copy of "is X allowed".
      ...(relayServerFactory
        ? {
            denyInboundRelayReservation: (peerId) => !isPeerAdmittedForRelay(peerId.toString()),
            // Both the REQUESTER (srcPeerId — "broker a coordination exchange FOR me") and the
            // DESTINATION (dstPeerId — the dst's own reservation already required it to be
            // admitted, but re-checked here rather than trusted from an earlier moment) must be
            // admitted. The organizer's non-negotiable is the requester side: R must decline to
            // broker for a non-admitted/revoked REQUESTER, not only refuse once the destination
            // turns out to be unreachable/unadmitted.
            denyOutboundRelayedConnection: (srcPeerId, dstPeerId) =>
              !isPeerAdmittedForRelay(srcPeerId.toString()) || !isPeerAdmittedForRelay(dstPeerId.toString()),
          }
        : {}),
    },
    services: {
      identify: identify(),
      ...(relayServerFactory ? { circuitRelay: relayServerFactory } : {}),
      ...(directUpgradeServiceFactory ? { dcutr: directUpgradeServiceFactory } : {}),
    },
    ...(peerDiscovery ? { peerDiscovery } : {}),
  })

  // An inbound connection that finished upgrading leaves the limiter's pending set and counts as
  // concurrent; only such connections ever reach connection:close below, so the two stay balanced.
  node.addEventListener('connection:open', (evt) => {
    try {
      if (evt.detail?.direction === 'inbound') {
        const addr = evt.detail?.remoteAddr?.toString()
        rateLimiter.upgraded?.(ipFromMultiaddr(addr), connKeyFromMultiaddr(addr))
      }
    } catch { /* must never throw into libp2p's event dispatch */ }
  })

  // Free a source's concurrent slot when an inbound connection closes. Only inbound connections were
  // counted (denyInboundConnection above), so only inbound closes release. Outbound closes are
  // ignored; a private/loopback ip is a no-op inside release().
  node.addEventListener('connection:close', (evt) => {
    try {
      if (evt.detail?.direction === 'inbound') {
        rateLimiter.release(ipFromMultiaddr(evt.detail?.remoteAddr?.toString()))
      }
    } catch { /* release must never throw into libp2p's event dispatch */ }
  })

  const { authenticatedPeers, isPairingConnection, sendPairingApproved, sendPairingDenied } = registerAuthGate(node, {
    onAuthenticate,
    onPairingRequest,
    onLogin,
    onPeerAdmitted: (id) => {
      setAdmittedTag(id, true)
      retryClientRelayDiscoveryFor(id)
      onPeerAdmitted?.(id)
    },
    onPairingDecision,
    ...(now ? { now } : {}),
    ...(schemaVersion != null ? { schemaVersion } : {}),
  })
  // See the connectionGater block above — this is the reassignment that makes the relay gater
  // hooks real once authenticatedPeers exists.
  isPeerAdmittedForRelay = (peerId) => authenticatedPeers.has(peerId)

  // L2a: a tag makes libp2p's ConnectionPruner close an admitted peer LAST when over maxConnections.
  // It is NOT a security control (revocation still works by removal from authenticatedPeers) and it
  // does nothing at exactly maxConnections, where the pruner never runs (see the L2b block below).
  // merge, never patch: patch would wipe the peer's other tags.
  const setAdmittedTag = (id, on) => {
    try {
      Promise.resolve(node.peerStore.merge(peerIdFromString(id), { tags: { [ADMITTED_TAG]: on ? { value: 100 } : undefined } })).catch(() => {})
    } catch { /* best-effort: a tagging failure must never affect admission */ }
  }
  node.addEventListener('peer:disconnect', (evt) => setAdmittedTag(evt.detail.toString(), false))

  // L2b, the real floor (ADR 2026-10-08-max-connections-dos-mitigation.md). Tags (L2a) cannot help at
  // exactly maxConnections: libp2p refuses an inbound by count before the Noise upgrade and its
  // pruner only runs on overshoot. So un-admitted INBOUND connections are capped at
  // maxConnections - reservedFloor, read LIVE at decision time (getConnections() minus
  // authenticatedPeers), and the newest one over the cap is aborted.
  //
  // Plus a deadline: an inbound connection whose peer is still not admitted after
  // unadmittedDeadlineMs is aborted (ungraceful, to free the slot at once). This is what bounds the
  // un-admitted bucket's turnover, and it defeats an attacker holding an authGate stream open, which
  // libp2p's safelyCloseConnectionIfUnused would otherwise skip.
  //
  // HONEST GUARANTEE: An ESTABLISHED admitted connection is never evicted by an un-admitted flood (hard
  // guarantee — the floor). A RECONNECTING camp device regains a slot LIKELY within an authGate-deadline
  // turnover cycle, but this is NOT guaranteed under a sustained distributed flood — it competes for the
  // recycling un-admitted slots. (Indistinguishable from the flood at connection:open, so not instant under an active
  // flood. Exemption: the SINGLE LAN connection that carried an accepted pairing_request is NOT
  // aborted by the deadline (pairing is LAN-only, owner ruling 2026-10-08), because the director's
  // decision is human-time. It is keyed to that connection, not the peer id, and cleared when it
  // closes. Bounded by MAX_PENDING_PAIRING; still counts against the un-admitted cap. Outbound connections are our own choice, so they are counted but never aborted here.
  const unadmittedCap = maxConnections - reservedFloor
  const deadlineTimers = new Map()
  node.addEventListener('connection:open', (evt) => {
    const connection = evt.detail
    if (connection.direction !== 'inbound' || authenticatedPeers.has(connection.remotePeer.toString())) return
    const unadmitted = node.getConnections().filter((c) => !authenticatedPeers.has(c.remotePeer.toString())).length
    if (unadmitted > unadmittedCap) {
      connection.abort(new Error('unadmitted_connection_cap'))
      return
    }
    const timer = setTimeout(() => {
      deadlineTimers.delete(connection)
      const peer = connection.remotePeer.toString()
      if (connection.status === 'open' && !authenticatedPeers.has(peer) && !isPairingConnection(connection)) {
        connection.abort(new Error('authgate_deadline'))
      }
    }, unadmittedDeadlineMs)
    timer.unref?.()
    deadlineTimers.set(connection, timer)
  })
  node.addEventListener('connection:close', (evt) => {
    clearTimeout(deadlineTimers.get(evt.detail))
    deadlineTimers.delete(evt.detail)
  })

  await node.handle(PROTO, (stream, connection) => {
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
    receiveFramed(stream, (bytes) => {
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
  }, { runOnLimitedConnection: true })
  // ^ T337 gate-fix round 2 (Code Reviewer LOW, FIX 3): without this opt-in, libp2p refuses to
  // even INVOKE this handler for a stream arriving over a "limited" connection (circuit-relay-v2's
  // relayed connections are always limited) — the stream is reset before authenticatedPeers is
  // ever consulted. That would make the admission check moot for exactly the arrival path T337
  // §D's carry-forward proofs are about, not merely redundant with it. Dial-side call sites
  // (sendDocTo, below) already pass this same option; it was previously missing on the listen
  // side, found while proving the end-to-end relayed-connection carry-forward in
  // relayEndToEndRevoke.test.js. Admission itself is still the same authenticatedPeers check,
  // unchanged — this only lets that check actually run over a relay.

  // Inbound half of the sync protocol — same admission gate as PROTO's handler above (Stage 5d-1's
  // ADR §3, threat #1/#4): an unauthenticated peer's bytes never reach A.receiveSyncMessage.
  await node.handle(SYNC_PROTO, (stream, connection) => {
    const fromPeerId = connection.remotePeer.toString()
    if (!authenticatedPeers.has(fromPeerId)) {
      stream.abort(new Error('unauthenticated'))
      return
    }
    receiveFramed(stream, (bytes) => {
      Promise.resolve(onSyncMessageReceived?.(bytes, { fromPeerId })).catch((err) => {
        console.error(`transport: onSyncMessageReceived handler rejected — isolated: ${err?.message ?? err}`)
      })
    }).catch(() => {
      // A malformed/adversarial peer closing or corrupting the stream must not crash this node.
    })
  }, { runOnLimitedConnection: true }) // same reasoning as PROTO's handler above

  // The planned host handoff (docs/adr/2026-10-09-host-succession-simple.md). Reachable only by a
  // peer THIS node has admitted (so it already passed evaluateAuthenticate) over a direct LAN
  // connection; the receiving state machine additionally requires the peer to be a recorded admin
  // device. Deliberately NOT runOnLimitedConnection: a relayed connection is never LAN, and the
  // handoff never travels over WAN or a relay. One request frame in, one reply frame out.
  //
  // `handoffFaults` (test seam, like syncNode's schema-version overrides) can drop the request before
  // it is handled or the reply after: the only way to produce "the stream broke right after step 5"
  // deterministically. Undefined in production.
  async function handleHandoffFrame(stream, fromPeerId, bytes) {
    let afterFlush
    try {
      let msg
      try {
        msg = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        stream.abort(new Error('malformed_handoff_frame'))
        return
      }
      if (handoffFaults.dropRequest?.(msg)) {
        stream.abort(new Error('handoff_request_dropped'))
        return
      }
      let out
      try {
        out = await onHandoffMessage?.(msg, { fromPeerId })
      } catch (err) {
        console.error(`transport: onHandoffMessage rejected — isolated: ${err?.message ?? err}`)
      }
      const frame = out?.frame ?? { type: 'ERROR', reason: 'handoff_error' }
      afterFlush = out?.afterFlush
      if (handoffFaults.dropReply?.(frame)) {
        stream.abort(new Error('handoff_reply_dropped'))
        return
      }
      await sendFramed(stream, new TextEncoder().encode(JSON.stringify(frame)))
      await stream.close().catch(() => {})
    } catch {
      // The peer went away mid-reply; the state machine already holds the outcome.
    } finally {
      try { afterFlush?.() } catch (err) { console.error(`transport: handoff afterFlush threw: ${err?.message ?? err}`) }
    }
  }

  await node.handle(HANDOFF_PROTO, (stream, connection) => {
    const fromPeerId = connection.remotePeer.toString()
    if (!authenticatedPeers.has(fromPeerId) || !isLanMultiaddr(connection.remoteAddr?.toString())) {
      stream.abort(new Error('handoff_not_permitted'))
      return
    }
    let seen = false
    receiveFramed(stream, (bytes) => {
      if (seen) return
      seen = true
      handleHandoffFrame(stream, fromPeerId, bytes)
    }, { maxDataLength: HANDOFF_MAX_FRAME_BYTES }).catch(() => {
      // A peer closing or corrupting the stream must not crash this node.
    })
  })

  async function sendHandoff(peerId, msg, { timeoutMs = 30_000 } = {}) {
    const target = String(peerId)
    if (!authenticatedPeers.has(target)) throw new Error('handoff_peer_not_admitted')
    const signal = AbortSignal.timeout(timeoutMs)
    const stream = await node.dialProtocol(toDialTarget(target), HANDOFF_PROTO, { signal })
    try {
      const reply = await new Promise((resolve, reject) => {
        let settled = false
        const settle = (fn, v) => { if (!settled) { settled = true; fn(v) } }
        signal.addEventListener('abort', () => settle(reject, signal.reason ?? new Error('handoff_timeout')), { once: true })
        receiveFramed(stream, (bytes) => {
          try { settle(resolve, JSON.parse(new TextDecoder().decode(bytes))) } catch (err) { settle(reject, err) }
        }, { maxDataLength: HANDOFF_MAX_FRAME_BYTES })
          .then(() => settle(reject, new Error('handoff_no_reply')))
          .catch((err) => settle(reject, err))
        sendFramed(stream, new TextEncoder().encode(JSON.stringify(msg))).catch((err) => settle(reject, err))
      })
      await stream.close().catch(() => {})
      return reply
    } catch (err) {
      try { stream.abort(err instanceof Error ? err : new Error('handoff_failed')) } catch { /* already closed */ }
      throw err
    }
  }

  function isPeerOnLan(peerId) {
    try {
      return node.getConnections(peerIdFromString(String(peerId))).some((c) => c.status === 'open' && !c.limits && isLanMultiaddr(c.remoteAddr?.toString()))
    } catch {
      return false
    }
  }

  async function sendDocTo(peerId, docBytes) {
    const stream = await node.dialProtocol(toDialTarget(peerId), PROTO, { runOnLimitedConnection: true })
    await sendFramed(stream, docBytes)
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
  // ORDER IS PART OF THE PROTOCOL. Automerge's sync protocol is a stateful
  // conversation per peer: each message is generated against the sync state
  // left by the previous one, and the receiver advances its own state in the
  // order messages arrive. Deliver two out of order and the receiver's state
  // moves past data it never got — it then believes the peer has nothing new
  // and stops asking. Convergence stalls silently, with both sides healthy and
  // connected and no error anywhere.
  //
  // Each send opens its OWN libp2p stream, so two concurrent sends to the same
  // peer race and arrive in whichever order the streams happen to settle. That
  // is routine, not exotic: any two near-simultaneous writes in a three-device
  // camp trigger it (the Host relays to every other admitted peer on each
  // merge). Found by the integration harness — scenario 08, two clients each
  // writing a different field of the same activity, which failed ~80% of runs
  // with the second field simply never arriving.
  //
  // So sends are serialised PER PEER: a chain per peer id, not one global
  // queue, because ordering only matters within a conversation and a slow or
  // unreachable peer must not hold up any other. The chain always continues on
  // failure — a dropped message is recoverable (the next trigger regenerates
  // from sync state), a wedged chain is not.
  const sendChains = new Map()

  async function sendSyncMessage(peerId, bytes) {
    const target = peerId.toString()
    if (!authenticatedPeers.has(target)) return
    const previous = sendChains.get(target) ?? Promise.resolve()
    const send = previous
      .catch(() => {})
      .then(async () => {
        // Re-checked inside the chain, not only before it: admission can be
        // lost (peer:disconnect) while this send was queued behind another.
        if (!authenticatedPeers.has(target)) return
        const stream = await node.dialProtocol(toDialTarget(peerId), SYNC_PROTO, { runOnLimitedConnection: true })
        await sendFramed(stream, bytes)
        await stream.close().catch(() => {})
      })
    sendChains.set(target, send)
    return send
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
  async function dial(multiaddrOrPeerId, options = {}) {
    return node.dial(toDialTarget(multiaddrOrPeerId), { runOnLimitedConnection: true, ...options })
  }

  // Dials the target peer's auth protocol and sends `msg` (e.g.
  // {type:'authenticate', token, device_id} — ADR §1's "reconnect" flow),
  // resolving with the peer's `auth_ok`/`auth_failed` response frame. Does
  // NOT itself admit anything on THIS node — admission is one-directional,
  // decided by whichever side ran onAuthenticate and populated its own
  // authenticatedPeers set.
  async function authenticateWith(peerId, msg, options = {}) {
    const stream = await node.dialProtocol(toDialTarget(peerId), AUTH_PROTO, { runOnLimitedConnection: true, ...options })
    // T230 round 2 (Red Hat finding 1): `options.signal` above only reaches libp2p's own
    // `mss.select` (connection.js's `newStream`) — once dialProtocol resolves, nothing downstream
    // reads it again. Without this, a peer that accepts the stream and then never replies (the
    // stall watchdog's documented case, mutualAuth.js) leaves the `receiveFramed` await below
    // running forever regardless of `controller.abort()`, because `receiveFramed`
    // (wireProtocol.js) is an unbounded `for await` with no signal of its own. Make the wrapping
    // Promise itself abort-aware so a post-negotiation abort actually settles it.
    const signal = options.signal
    let abortListener
    let abortedBySignal = false
    try {
      return await new Promise((resolve, reject) => {
        let settled = false
        const settleReject = (err) => {
          if (settled) return
          settled = true
          reject(err)
        }
        if (signal) {
          if (signal.aborted) {
            abortedBySignal = true
            settleReject(signal.reason ?? new Error('authenticateWith aborted'))
            return
          }
          abortListener = () => {
            abortedBySignal = true
            settleReject(signal.reason ?? new Error('authenticateWith aborted'))
          }
          signal.addEventListener('abort', abortListener)
        }
        receiveFramed(stream, (bytes) => {
          if (settled) return
          settled = true
          try {
            resolve(JSON.parse(new TextDecoder().decode(bytes)))
          } catch (err) {
            reject(err)
          }
        }).catch((err) => settleReject(err))
        sendFramed(stream, new TextEncoder().encode(JSON.stringify(msg))).catch((err) => settleReject(err))
      })
    } finally {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      // libp2p v3 (T215 migration): a Stream never auto-closes once its
      // consumer stops reading/writing — unlike the old pull-stream model,
      // where draining the source implicitly tore the stream down. Without
      // this, every authenticateWith call left its stream open, and the
      // connection's per-protocol outbound stream accounting reset earlier
      // ones out from under a caller that used this repeatedly (seen in
      // authGate.test.js's MAX_PENDING_PAIRING test, which dials AUTH_PROTO
      // 50+ times on one connection).
      //
      // T217 finding 1, settled empirically: this close CANNOT truncate the
      // unawaited `receiveFramed` iteration above. `AbstractStream.close()`
      // closes the WRITABLE half only — it never touches `readStatus` or
      // `readBuffer`; the method that discards unread inbound data is the
      // separate `closeRead()`, which this does not call. A second frame
      // pipelined on this stream is still delivered to the reader, even if it
      // arrives after the close. Pinned by
      // ./transportAuthCloseRace.test.js, which also exercises the teardowns
      // that DO truncate (`closeRead`, `abort`) so the result is not vacuous.
      //
      // T230 round 2 (Red Hat finding 1): when THIS call is the one that settled via
      // `abortedBySignal` above, a plain `close()` is exactly the T217 bug — it would leave the
      // still-pending `receiveFramed` read unresolved at the protocol level even though the JS
      // Promise above already rejected, so the stream (and the outbound-stream-count slot it
      // holds — libp2p's `DEFAULT_MAX_OUTBOUND_STREAMS`) never actually frees. `abort()` resets
      // both directions immediately, which is what an abort needs. See
      // ./transport.test.js's "rejects and tears down the stream" test, which observes this from
      // the RESPONDER's side (streams.length returning to 0) to prove the teardown actually
      // reaches the wire, not just this local Promise.
      if (abortedBySignal) {
        // Unlike close(), abort() is synchronous — it does not return a Promise.
        try {
          stream.abort(signal?.reason instanceof Error ? signal.reason : new Error('authenticateWith aborted'))
        } catch { /* best-effort teardown */ }
      } else {
        await stream.close().catch(() => {})
      }
    }
  }

  return {
    peerId: node.peerId.toString(),
    // S4c: the raw libp2p node, for the punch reconnect wiring only (punch-signal protocol handler).
    libp2pNode: node,
    getPeers: () => node.getPeers().map((p) => p.toString()),
    getMultiaddrs: () => node.getMultiaddrs(),
    // T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md): the observed remote
    // multiaddr for an already-connected peer, WITH its /p2p/<peerId> component so a later redial
    // of this address carries the identity libp2p's own Noise handshake will re-verify (see
    // peerAddressBook.js's module comment for why that is the stale-address-safety property).
    // Returns null for a peer with no live connection (never thrown) — syncNode.js's
    // onPeerAdmitted callback uses this only right after admission, when a connection exists, but
    // a best-effort null here is the honest answer if that ever changes.
    remoteAddrFor: (peerId) => {
      try {
        const conns = node.getConnections(peerIdFromString(peerId))
        const remoteAddr = conns[0]?.remoteAddr
        if (!remoteAddr) return null
        const addrStr = remoteAddr.toString()
        return addrStr.includes('/p2p/') ? addrStr : `${addrStr}/p2p/${peerId}`
      } catch {
        return null
      }
    },
    broadcastDoc,
    sendDocTo,
    sendSyncMessage,
    sendHandoff,
    isPeerOnLan,
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
    // WHY IT IS ACCEPTABLE. The trust anchor is human: the director typed THIS
    // camp's join code, the director approved THIS device on the Host's screen,
    // and the joining device just completed a PIN login against this peer's real
    // user table. From the next launch onward the device has
    // `signing_public_key` and every ordinary path verifies.
    //
    // _Prior: this also argued "it is the same anchor the WS path already relies
    // on ... the op-log's `full_sync` handed a Client its identity on exactly
    // that basis, with no cryptographic proof of the Host either — so this is
    // parity, not a new exposure." That transport was deleted at the Stage 6
    // cutover, so the parity comparison no longer has a live counterpart and
    // cannot carry the argument. The three human-anchor facts above are the whole
    // justification now; read it on those terms._
    //
    // WHAT IT IS NOT. It is not a way to skip authentication generally, and
    // it grants nothing on the HOST — the joiner still had to pair and log in
    // there. A caller that admits a peer it did not just authenticate ITSELF
    // to has defeated the admission gate; that is the misuse to review for.
    // The counterpart of admitPeer, and a SECURITY control rather than a tidy-up:
    // admission is granted once and otherwise only cleared on peer:disconnect,
    // so revoking a device that is still connected left it admitted and still
    // receiving documents until it happened to drop. The WS transport did not
    // have this gap — revocation closed the socket, which evicted it.
    //
    // Found by porting integration scenario 05 to libp2p; that is what the port
    // was for.
    //
    // LOAD-BEARING, T208 round 2 (Red Hat): this is the actual enforcement point for
    // revoking an already-authenticated peer. mutualAuth.js's `attempted` Set is never
    // cleared on a SUCCESSFUL authenticate, so `tryAuthenticate`'s `isPeerTrusted`
    // re-query (createBoundPeerTrust, peerIdentity.js) never runs again for that peer's
    // life in this process — it only gates a peer not yet in `attempted` (a new dial).
    // Revoking a live peer therefore does nothing without this call removing it from
    // `authenticatedPeers`, which is what `broadcastDoc` (above) gates every send on.
    // Do not remove this as "redundant with createBoundPeerTrust" — createBoundPeerTrust
    // only stops a future dial; this is what tears down an existing one.
    revokePeer: (peerId) => {
      authenticatedPeers.delete(String(peerId))
      setAdmittedTag(String(peerId), false)
      // Gate-fix round 2 (Red Hat HIGH, FIX 1c): denyOutboundRelayedConnection already blocks a
      // NEW CONNECT for a revoked peer, but a RESERVATION this peer made while still admitted
      // sits in R's ReservationStore occupying one of MAX_SIMULTANEOUS_RESERVATIONS slots until
      // its own TTL expires otherwise — reclaiming it here is defense-in-depth, not the load-
      // bearing control (that is still the gater, which runs on every CONNECT regardless of
      // whether this reclaim ever ran). Best-effort: a relay server not being configured, or the
      // library's internal shape changing, must never make revocation itself fail.
      if (relayServerFactory) {
        try {
          node.services.circuitRelay?.reservationStore?.removeReservation(peerIdFromString(String(peerId)))
        } catch (err) {
          console.error(`transport: failed to evict relay reservation for revoked peer ${peerId} (non-fatal — the CONNECT gater is the real control): ${err?.message ?? err}`)
        }
      }
    },
    // T337 pre-signoff hardening — test-support accessor, not production wiring: the number of
    // LIVE reservations currently held in R's ReservationStore (distinct from `getPeers()`, which
    // reflects libp2p CONNECTIONS — a peer can be connected without holding a reservation, e.g.
    // one refused for being over `maxReservations`). Only meaningful when `relayServerFactory` was
    // provided; returns 0 otherwise. Exists so a real-multi-node test can pin "refresh doesn't
    // grow the count, distinct peers do" against the actual ReservationStore rather than
    // inferring it from HOP response codes alone.
    getRelayReservationCount: () => node.services.circuitRelay?.reservationStore?.reservations?.size ?? 0,
    // Test-support accessor, same precedent as getRelayReservationCount above.
    isAdmittedTagged: async (peerId) => {
      try {
        return (await node.peerStore.get(peerIdFromString(String(peerId)))).tags.has(ADMITTED_TAG)
      } catch {
        return false
      }
    },
    admitPeer: (peerId) => {
      const id = String(peerId)
      if (authenticatedPeers.has(id)) return
      authenticatedPeers.add(id)
      setAdmittedTag(id, true)
      retryClientRelayDiscoveryFor(id)
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
    sendChains.delete(evt.detail.toString())
        cb(evt.detail.toString())
      })
    },
    stop: () => {
      for (const t of deadlineTimers.values()) clearTimeout(t)
      deadlineTimers.clear()
      return node.stop()
    },
  }
}
