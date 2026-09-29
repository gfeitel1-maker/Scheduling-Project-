// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1/§3): the
// /shoresh/auth/1.0.0 protocol handler and the in-memory admission set it
// populates. Isolated from transport.js's doc-sync protocol registration so
// the admission mechanism (who may reach onDocReceived at all) is reviewable
// independent of the doc-sync wire format.
//
// Deliberately auth-semantics-free, exactly the way transport.js is
// Automerge-free: `onAuthenticate` is injected by the caller (syncNode.js,
// wired to localAuth.js's verifySessionToken via
// electron/auth/connectionAuth.js's evaluateAuthenticate) the same way
// transport.js's onDocReceived is injected. This module only knows "a JSON
// frame of {type:'authenticate', ...} arrived; call the injected decision
// function; admit or reject based on its answer."
//
// 5d-1 implemented the `authenticate` message only (an already-paired,
// already-logged-in device reconnecting with a live token — the ADR's
// "Order — reconnect" flow). Stage 5d-2b added `pairing_request` and `login`
// (the ADR's "Order — first pairing" flow), via the shared decision functions in
// electron/auth/connectionAuth.js (evaluatePairingRequest / evaluateLogin) — see
// those functions' doc comments for what stays transport-specific (rate limiting)
// vs. shared (the actual decision). _Prior: those two handlers were described as
// "mirroring syncServer.js's WS handling of the same two message types". That file
// was deleted at the Stage 6c cutover, so this file is no longer mirroring
// anything — it is the only implementation._
//
// `pairing_request` cannot be answered synchronously the way `authenticate`
// is: approval is a human (the director) making a decision in the
// renderer, which can take arbitrarily long — far longer than it is
// reasonable to hold one libp2p stream open. So this handler replies
// immediately (`pairing_approved` if already-approved — the idempotent
// re-delivery case — or `pairing_pending` otherwise) and closes the
// stream, remembering the requesting peer's id in `pendingPairingPeers`
// keyed by device_id. When the director's decision lands later (main.js
// calling the returned `sendPairingApproved`/`sendPairingDenied`), a NEW
// stream is dialed back to that remembered peer id, because the original stream
// is long gone by then. _Prior: this map was described as "mirroring
// syncServer.js's `pendingPairingConnections` map, just PeerId-addressed instead
// of ws-object-addressed"; that file and its map are deleted, so
// `pendingPairingPeers` here is the only one._
import { peerIdFromString } from '@libp2p/peer-id'
import { AUTH_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'
import { shouldThrottle, PAIRING_RATE_MS, LOGIN_MIN_INTERVAL_MS, SourceRateLimiter } from '../rateLimit.js'

// T288 round 3: per-source caps for the two count-based limiters below. A real camp runs maybe
// 2-20 devices, so a single source host legitimately produces at most a small handful of
// pairing/login attempts in any one minute (initial setup bursts, a director retyping a PIN a few
// times). An online grind of the 50-bit join secret needs millions of attempts to have any
// realistic odds — these caps are generous by orders of magnitude relative to real use and still
// bound a grind hard.
const PAIRING_MAX_ATTEMPTS_PER_SOURCE = 30
const PAIRING_SOURCE_WINDOW_MS = 60_000
const LOGIN_MAX_ATTEMPTS_PER_SOURCE = 60
const LOGIN_SOURCE_WINDOW_MS = 60_000

// Rate limiting for pairing_request/login on this transport: shouldThrottle /
// PAIRING_RATE_MS / LOGIN_MIN_INTERVAL_MS, plus the MAX_PENDING_PAIRING cap
// below. MAX_PENDING_PAIRING is a local constant because the cap protects THIS
// transport's own PeerId-dial-handle map — see connectionAuth.js's doc comments
// for why that bookkeeping is deliberately not shared.
//
// _Prior (HIGH finding, Stage 5d-2b re-review): the finding was that
// "syncServer.js's WS handling of pairing_request/login is rate-limited ... the
// libp2p path through this file called straight into evaluatePairingRequest/onLogin
// with NONE of that, despite the ADR's §6 explicitly claiming both transports
// 'carry these same caps forward unconditionally.'" It also explained that
// MAX_PENDING_PAIRING was "not imported from syncServer.js, which doesn't export
// it." syncServer.js was deleted at the Stage 6c cutover, so there is no second
// transport to carry caps forward to and nothing to import from. The limits stay
// because they are load-bearing on their own merits, not to match a WS
// counterpart — an unthrottled pairing/login path is a grind target regardless
// (see the T288 per-source caps below)._
const MAX_PENDING_PAIRING = 50

// T288 forward-finding (b), GOVERNOR OVERRIDE of the ADR addendum's Slice-E deferral: the
// identity-churn bypass on the throttles below is closable NOW (it does not depend on WAN join
// existing), and is a LOCKED Slice C requirement per owner handoff + T287. `fromPeerId` and the
// client-supplied `device_id` are both free for an attacker to mint fresh per attempt — a new
// Ed25519 keypair costs nothing, and `device_id` is client-asserted with no proof of prior
// registration. `connection.remoteAddr` (the network source host) is not attacker-forgeable
// without a genuinely different source, so it is added as a THIRD throttle key, additive to the
// existing two (defense-in-depth — see the throttle-keying comment above).
//
// org-source-verification: `@multiformats/multiaddr@13.0.3` (this repo's resolved version) has
// neither `.nodeAddress()` nor `.toOptions()` — both are absent from the installed package (the
// ADR addendum flagged this as unverified and asked Maker to re-check). The stable extraction API
// for this version is `.getComponents()`, returning `[{code, name, value}, ...]`. A multiaddr with
// no ip4/ip6 component (e.g. a bare /dns4/.../tcp/... form) falls back to the full remoteAddr
// string rather than throwing — a plausible-but-unproven address is still a valid throttle key,
// just a less precise one.
//
// KNOWN ACCEPTED LIMITATION (recorded, not fixed here): peers behind one NAT/CGNAT share a source
// IP and can be throttled together — a false-positive-adjacent cost, not a security hole,
// analogous to the Worker's own MAX_PEERS_PER_NAMESPACE doc comment accepting a similar tradeoff.
export function rateLimitKeyFor(connection) {
  const addr = connection?.remoteAddr
  if (!addr) return 'unknown'
  try {
    const components = addr.getComponents()
    const ipComponent = components.find((c) => c.name === 'ip4' || c.name === 'ip6')
    if (ipComponent) return `${ipComponent.name}:${ipComponent.value}`
  } catch {
    // fall through to the raw-string fallback below
  }
  return addr.toString()
}

// Throttle keying — the central design decision here, so it is spelled out
// once. Two Maps, keyed differently, and a frame is throttled if EITHER says
// "too soon":
//   - by `fromPeerId`: this connection's real libp2p identity, established
//     by the noise handshake and NOT client-forgeable without a fresh
//     connection. Closes "flood by rotating the claimed device_id every
//     frame on the SAME connection."
//   - by the claimed `device_id`: attacker-supplied over an unauthenticated
//     channel and free to change per-frame, but keeping it ALONGSIDE the
//     peer-keyed limit closes a different case — one peer sending frames for
//     many DIFFERENT claimed device_ids at the full unthrottled rate, each
//     still reaching evaluatePairingRequest/evaluateLogin (DB writes,
//     audit-log inserts) at up to once per PAIRING_RATE_MS/
//     LOGIN_MIN_INTERVAL_MS for every distinct device_id it invents.
// A peer that opens a BRAND NEW libp2p connection (a fresh noise handshake, and on many
// transports a fresh keypair) for every single frame gets a fresh `fromPeerId` each time and
// evades the peer-keyed half entirely — this is now ALSO throttled, by `rateLimitKeyFor`'s
// source-host key (see above), for as long as the churn stays behind the same network source.
// It is bounded elsewhere too — transport.js's MAX_CONNECTIONS ceiling and the real
// per-connection cost of a noise handshake — but is no longer unbounded by MAX_CONNECTIONS alone,
// as an earlier version of this comment claimed (T288).
// State is intentionally never cleared on peer:disconnect (unlike
// `authenticatedPeers` below): a peer that disconnects and immediately
// reconnects with the SAME identity must not get a clean rate-limit slate,
// and the memory cost of retaining it is bounded by however many distinct
// peer ids/device ids a peer can cheaply mint, which is exactly the limit
// just described, not a new one.

function encodeMessage(obj) {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function decodeMessage(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Registers the auth protocol handler and a peer:disconnect listener on
// `node`. `onAuthenticate(msg, { fromPeerId }) => { ok, reason }` decides
// admission for an `authenticate` message; it is only ever called for a
// parsed, well-formed JSON frame of that type — malformed input or any other
// message type never reaches it.
//
// Returns `authenticatedPeers`, a live Set<string> of peer-id strings
// currently admitted to dial the doc-sync protocol on THIS node. Populated on
// a successful authenticate frame; removed the moment libp2p reports the
// underlying peer connection gone (`peer:disconnect`), NOT left to the auth
// stream's own close — a stale entry surviving disconnect would let a
// future, unauthenticated re-connection from the same peer id skip the
// handshake entirely (the stale-entry hole the brief calls out).
// `onPeerAdmitted(peerId)` fires the moment a peer is added to authenticatedPeers. Stage 5f found
// via a real two-machine run that WITHOUT this, two devices that connect never exchange their
// EXISTING state: every broadcast is triggered by a local write or a received merge, so a peer that
// joins after a write never learns about it, and two devices that each have prior data both sit
// showing nothing until somebody happens to make a new edit. Admission is the correct trigger —
// it is the first moment we are both allowed to send to a peer and know they will accept it.
// T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md): `schemaVersion`, when
// supplied, is THIS device's own CURRENT_SCHEMA_VERSION, included in the `auth_ok` reply as a cheap,
// early, observability-only signal (the authoritative check lives in syncNode.js's
// `peerSchemaVersions` map / `isPeerSyncCompatible`, populated from the peer's own `authenticate`
// handshake at admission time — NOT read from the document; round 1's document-root carrier was
// removed as broken, see the ADR's round-3 revision). It never gates admission: a caller that omits
// it, or a peer whose `authenticate` frame omits its own schemaVersion (an older, pre-T271 build),
// is admitted exactly as before.
export function registerAuthGate(node, { onAuthenticate, onPairingRequest, onLogin, onPeerAdmitted, onPairingDecision, now = Date.now, schemaVersion } = {}) {
  const authenticatedPeers = new Set()
  // device_id -> PeerId string, for a pairing_request whose director
  // decision hasn't landed yet. See module comment above.
  const pendingPairingPeers = new Map()
  // device_id -> the Host's half of the join-code proof for THIS attempt, so
  // the director's decision (delivered later, on a new stream) still carries
  // it. Without this the joining device would have nothing to verify on the
  // approval path and would be back to trusting whoever answered.
  const pendingJoinConfirms = new Map()

  // Rate-limit bookkeeping (see the module-level comment above for the
  // keying rationale). `now` is injectable so the throttle tests can drive
  // time deterministically. _Prior: "exactly like syncServer.js's own `now`
  // option" — that file is deleted; the pattern is unchanged._
  const lastPairingRequestAtByPeer = new Map()
  const lastPairingRequestAtByDevice = new Map()
  const lastLoginAttemptAtByPeer = new Map()
  const lastLoginAttemptAtByDevice = new Map()
  // Count-based, not min-interval (T288 round 3): see rateLimit.js's SourceRateLimiter doc
  // comment for why a per-source THROTTLE was wrong — it throttled distinct co-located identities
  // against each other, which is exactly what the loopback integration harness (and a real
  // NAT/CGNAT) hits.
  const pairingRequestsBySource = new SourceRateLimiter({ maxAttempts: PAIRING_MAX_ATTEMPTS_PER_SOURCE, windowMs: PAIRING_SOURCE_WINDOW_MS })
  const loginAttemptsBySource = new SourceRateLimiter({ maxAttempts: LOGIN_MAX_ATTEMPTS_PER_SOURCE, windowMs: LOGIN_SOURCE_WINDOW_MS })

  node.addEventListener('peer:disconnect', (evt) => {
    authenticatedPeers.delete(evt.detail.toString())
  })

  node.handle(AUTH_PROTO, (stream, connection) => {
    const fromPeerId = connection.remotePeer.toString()

    receiveFramed(stream, async (bytes) => {
      let msg
      try {
        msg = decodeMessage(bytes)
      } catch {
        // Malformed frame: never reaches any handler below. Abort rather
        // than silently ignore — a peer sending junk to the auth protocol
        // gets no free retry loop on this stream.
        stream.abort(new Error('malformed_auth_frame'))
        return
      }

      if (!msg || typeof msg.type !== 'string') {
        stream.abort(new Error('unsupported_auth_message'))
        return
      }

      if (msg.type === 'authenticate') {
        // T271: observability-only — logged, never gates admission. A peer that omits it (an older,
        // pre-T271 build) is treated as "unknown" here, same as anywhere else this field is read.
        if (typeof msg.schemaVersion === 'number') {
          console.log(`authGate: peer ${fromPeerId} authenticated at schema v${msg.schemaVersion}`)
        }

        let result
        try {
          result = (await onAuthenticate?.(msg, { fromPeerId })) ?? { ok: false, reason: 'no_authenticator' }
        } catch (err) {
          console.error(`authGate: onAuthenticate threw — treating as denied: ${err?.message ?? err}`)
          result = { ok: false, reason: 'authenticator_error' }
        }

        if (result.ok) {
          authenticatedPeers.add(fromPeerId)
          // Fire-and-forget: an initial-sync send must never block or fail the admission itself.
          try {
            Promise.resolve(onPeerAdmitted?.(fromPeerId)).catch(() => {})
          } catch { /* a throwing callback must not un-admit a legitimately authenticated peer */ }
          try {
            await sendFramed(stream, encodeMessage({ type: 'auth_ok', ...(schemaVersion != null ? { schemaVersion } : {}) }))
          } catch {
            // Peer went away right after being admitted; admission still
            // stands — peer:disconnect will clean it up once libp2p notices.
          }
          await stream.close().catch(() => {})
        } else {
          // Carries the 4401/4402/4403/4404 code convention that
          // connectionAuth.js defines (_prior: also attributed to
          // "syncServer.js's handleAuthenticate", deleted at Stage 6c) as a
          // `reason` string on the frame, then hard-closes — libp2p streams
          // don't have numeric close codes, so the reason travels in-band
          // before the abort.
          try {
            await sendFramed(stream, encodeMessage({ type: 'auth_failed', reason: result.reason }))
          } catch {
            // ignore — aborting regardless
          }
          stream.abort(new Error(result.reason || 'auth_failed'))
        }
        return
      }

      if (msg.type === 'pairing_request') {
        const at = now()
        const sourceKey = rateLimitKeyFor(connection)
        const throttled =
          shouldThrottle(lastPairingRequestAtByPeer.get(fromPeerId), at, PAIRING_RATE_MS) ||
          (typeof msg.device_id === 'string' &&
            shouldThrottle(lastPairingRequestAtByDevice.get(msg.device_id), at, PAIRING_RATE_MS)) ||
          pairingRequestsBySource.attempt(sourceKey, at)
        if (throttled) {
          stream.abort(new Error('rate_limited'))
          return
        }
        lastPairingRequestAtByPeer.set(fromPeerId, at)
        if (typeof msg.device_id === 'string') lastPairingRequestAtByDevice.set(msg.device_id, at)

        if (pendingPairingPeers.size >= MAX_PENDING_PAIRING) {
          stream.abort(new Error('pending_pairing_full'))
          return
        }

        let result
        try {
          result = (await onPairingRequest?.(msg, { fromPeerId })) ?? { ok: false }
        } catch (err) {
          console.error(`authGate: onPairingRequest threw — treating as denied: ${err?.message ?? err}`)
          result = { ok: false }
        }

        try {
          if (result.ok && result.alreadyApproved) {
            await sendFramed(stream, encodeMessage({ type: 'pairing_approved', device_secret_identifier: result.device_secret_identifier, ...(result.joinConfirm ? { join_confirm: result.joinConfirm } : {}) }))
          } else if (result.ok) {
            // Remember this peer id so a later director decision can dial
            // back to it — the ORIGINAL stream is about to close and cannot
            // be held open for an arbitrarily long human decision.
            if (typeof msg.device_id === 'string') {
              pendingPairingPeers.set(msg.device_id, fromPeerId)
              if (result.joinConfirm) pendingJoinConfirms.set(msg.device_id, result.joinConfirm)
            }
            await sendFramed(stream, encodeMessage({ type: 'pairing_pending', ...(result.joinConfirm ? { join_confirm: result.joinConfirm } : {}) }))
          } else {
            await sendFramed(stream, encodeMessage({ type: 'pairing_denied' }))
          }
        } catch {
          // Peer went away before the reply landed — the caller's own
          // reconnect-and-resend is the recovery path. _Prior: "(mirroring
          // syncClient.js's pattern) ... same as the WS transport" — both deleted
          // at Stage 6c; the pattern is unchanged and is now only here._
        }
        await stream.close().catch(() => {})
        return
      }

      if (msg.type === 'login') {
        const at = now()
        const sourceKey = rateLimitKeyFor(connection)
        const throttled =
          shouldThrottle(lastLoginAttemptAtByPeer.get(fromPeerId), at, LOGIN_MIN_INTERVAL_MS) ||
          (typeof msg.device_id === 'string' &&
            shouldThrottle(lastLoginAttemptAtByDevice.get(msg.device_id), at, LOGIN_MIN_INTERVAL_MS)) ||
          loginAttemptsBySource.attempt(sourceKey, at)
        if (throttled) {
          stream.abort(new Error('rate_limited'))
          return
        }
        lastLoginAttemptAtByPeer.set(fromPeerId, at)
        if (typeof msg.device_id === 'string') lastLoginAttemptAtByDevice.set(msg.device_id, at)

        let result
        try {
          result = (await onLogin?.(msg, { fromPeerId })) ?? { ok: false }
        } catch (err) {
          console.error(`authGate: onLogin threw — treating as denied: ${err?.message ?? err}`)
          result = { ok: false }
        }

        try {
          if (result.ok) {
            await sendFramed(stream, encodeMessage({ type: 'login_ok', token: result.token, userId: result.userId, role: result.role, ...(result.camp ? { camp: result.camp } : {}), ...(result.hostDeviceId ? { host_device_id: result.hostDeviceId } : {}), ...(result.hostSchemaVersion != null ? { host_schema_version: result.hostSchemaVersion } : {}) }))
          } else {
            await sendFramed(
              stream,
              encodeMessage(
                result.locked
                  ? { type: 'login_failed', locked: true, retryAfterMs: result.retryAfterMs }
                  : { type: 'login_failed' }
              )
            )
          }
        } catch {
          // ignore — closing regardless
        }
        await stream.close().catch(() => {})
        return
      }

      // The RECEIVING half of deliverPairingDecision below — this is the
      // joining device's end of the dial-back, not the Host's.
      //
      // Stage 6 join flow (docs/adr/2026-09-08-libp2p-join-flow.md): before
      // this branch existed, a Host that approved a device dialed back, wrote
      // its `pairing_approved` frame, and the joining device fell through to
      // the `unsupported_auth_message` abort below — the approval was
      // delivered and thrown away. _Prior: "Under the op-log that did not matter,
      // because syncClient.js received the same decision over WS; once the op-log
      // is retired this is the ONLY way a device learns it was let in." The op-log
      // IS retired as a sync mechanism and syncClient.js is deleted (Stage 6c), so
      // the conditional has resolved:_ this is now the only way a device learns it
      // was let in.
      //
      // Deliberately NOT rate-limited, unlike pairing_request/login above.
      // Those are unauthenticated requests an attacker floods a HOST with;
      // this only ever arrives, and the callback's job (joinSession.js) is to
      // match it against a request this device actually made — an unsolicited
      // frame from a stranger is dropped there, on identity, which a rate
      // limit would not improve.
      if (msg.type === 'pairing_approved' || msg.type === 'pairing_denied') {
        try {
          await onPairingDecision?.(msg, { fromPeerId })
        } catch (err) {
          console.error(`authGate: onPairingDecision threw: ${err?.message ?? err}`)
        }
        await stream.close().catch(() => {})
        return
      }

      stream.abort(new Error('unsupported_auth_message'))
    }).catch(() => {
      // A peer closing/corrupting the stream mid-frame must not crash this
      // node — same defensive posture as transport.js's doc-sync handler.
    })
  })

  // Dials `deviceId`'s remembered PeerId (set by a prior pairing_request on
  // this node) on a NEW stream and delivers the director's decision.
  // Returns false (no-op) if this node has no pending pairing recorded for
  // that device — e.g. it was handled by a different transport (WS), or the
  // peer never asked THIS node.
  async function deliverPairingDecision(deviceId, frame) {
    const peerId = pendingPairingPeers.get(deviceId)
    if (!peerId) return false
    pendingPairingPeers.delete(deviceId)
    const joinConfirm = pendingJoinConfirms.get(deviceId) ?? null
    pendingJoinConfirms.delete(deviceId)
    const outgoing = joinConfirm && frame.type === 'pairing_approved'
      ? { ...frame, join_confirm: joinConfirm }
      : frame
    try {
      const stream = await node.dialProtocol(peerIdFromString(peerId), AUTH_PROTO, { runOnLimitedConnection: true })
      await sendFramed(stream, encodeMessage(outgoing))
      await stream.close().catch(() => {})
      return true
    } catch (err) {
      console.error(`authGate: failed to deliver pairing decision to ${deviceId} — ${err?.message ?? err}`)
      return false
    }
  }

  return {
    authenticatedPeers,
    sendPairingApproved: (deviceId, deviceSecretIdentifier) =>
      deliverPairingDecision(deviceId, { type: 'pairing_approved', device_secret_identifier: deviceSecretIdentifier }),
    sendPairingDenied: (deviceId) => deliverPairingDecision(deviceId, { type: 'pairing_denied' }),
  }
}
