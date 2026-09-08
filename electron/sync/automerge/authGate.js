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
// "Order — reconnect" flow). Stage 5d-2b adds `pairing_request` and `login`
// (the ADR's "Order — first pairing" flow), mirroring syncServer.js's WS
// handling of the same two message types via the SAME shared decision
// functions (electron/auth/connectionAuth.js's evaluatePairingRequest /
// evaluateLogin) — see those functions' doc comments for what stays
// transport-specific (rate limiting) vs. shared (the actual decision).
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
// stream is dialed back to that remembered peer id — mirroring
// syncServer.js's `pendingPairingConnections` map, just PeerId-addressed
// instead of ws-object-addressed, because the original stream is long gone
// by then.
import { peerIdFromString } from '@libp2p/peer-id'
import { AUTH_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'
import { shouldThrottle, PAIRING_RATE_MS, LOGIN_MIN_INTERVAL_MS } from '../rateLimit.js'

// HIGH finding, Stage 5d-2b re-review: syncServer.js's WS handling of
// pairing_request/login is rate-limited (shouldThrottle/PAIRING_RATE_MS/
// LOGIN_MIN_INTERVAL_MS, plus a MAX_PENDING_PAIRING cap) — the libp2p path
// through this file called straight into evaluatePairingRequest/onLogin with
// NONE of that, despite the ADR's §6 explicitly claiming both transports
// "carry these same caps forward unconditionally." This block is what
// actually makes that claim true. MAX_PENDING_PAIRING is kept as a local
// constant (not imported from syncServer.js, which doesn't export it) —
// connectionAuth.js's own doc comments already establish that this cap
// protects a transport's own connection/PeerId-dial-handle map, which has
// nothing to drift against a different transport's identical-by-coincidence
// number.
const MAX_PENDING_PAIRING = 50

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
// Explicit limit this does NOT close: a peer that opens a BRAND NEW libp2p
// connection (a fresh noise handshake, and on many transports a fresh
// keypair) for every single frame gets a fresh `fromPeerId` each time and
// evades the peer-keyed half entirely. That case is bounded elsewhere —
// transport.js's MAX_CONNECTIONS ceiling and the real per-connection cost of
// a noise handshake — not by anything in this file; don't overclaim it here.
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
export function registerAuthGate(node, { onAuthenticate, onPairingRequest, onLogin, onPeerAdmitted, onPairingDecision, now = Date.now } = {}) {
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
  // time deterministically, exactly like syncServer.js's own `now` option.
  const lastPairingRequestAtByPeer = new Map()
  const lastPairingRequestAtByDevice = new Map()
  const lastLoginAttemptAtByPeer = new Map()
  const lastLoginAttemptAtByDevice = new Map()

  node.addEventListener('peer:disconnect', (evt) => {
    authenticatedPeers.delete(evt.detail.toString())
  })

  node.handle(AUTH_PROTO, ({ stream, connection }) => {
    const fromPeerId = connection.remotePeer.toString()

    receiveFramed(stream.source, async (bytes) => {
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
            await sendFramed(stream.sink, encodeMessage({ type: 'auth_ok' }))
          } catch {
            // Peer went away right after being admitted; admission still
            // stands — peer:disconnect will clean it up once libp2p notices.
          }
          await stream.close().catch(() => {})
        } else {
          // Mirrors the WS 4401/4402/4403/4404 close-code convention
          // (syncServer.js's handleAuthenticate / connectionAuth.js) as a
          // `reason` string on the frame, then hard-closes — libp2p streams
          // don't have numeric close codes, so the reason travels in-band
          // before the abort.
          try {
            await sendFramed(stream.sink, encodeMessage({ type: 'auth_failed', reason: result.reason }))
          } catch {
            // ignore — aborting regardless
          }
          stream.abort(new Error(result.reason || 'auth_failed'))
        }
        return
      }

      if (msg.type === 'pairing_request') {
        const at = now()
        const throttled =
          shouldThrottle(lastPairingRequestAtByPeer.get(fromPeerId), at, PAIRING_RATE_MS) ||
          (typeof msg.device_id === 'string' &&
            shouldThrottle(lastPairingRequestAtByDevice.get(msg.device_id), at, PAIRING_RATE_MS))
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
            await sendFramed(stream.sink, encodeMessage({ type: 'pairing_approved', device_secret_identifier: result.device_secret_identifier, ...(result.joinConfirm ? { join_confirm: result.joinConfirm } : {}) }))
          } else if (result.ok) {
            // Remember this peer id so a later director decision can dial
            // back to it — the ORIGINAL stream is about to close and cannot
            // be held open for an arbitrarily long human decision.
            if (typeof msg.device_id === 'string') {
              pendingPairingPeers.set(msg.device_id, fromPeerId)
              if (result.joinConfirm) pendingJoinConfirms.set(msg.device_id, result.joinConfirm)
            }
            await sendFramed(stream.sink, encodeMessage({ type: 'pairing_pending', ...(result.joinConfirm ? { join_confirm: result.joinConfirm } : {}) }))
          } else {
            await sendFramed(stream.sink, encodeMessage({ type: 'pairing_denied' }))
          }
        } catch {
          // Peer went away before the reply landed — the caller's own
          // reconnect-and-resend (mirroring syncClient.js's pattern) is the
          // recovery path, same as the WS transport.
        }
        await stream.close().catch(() => {})
        return
      }

      if (msg.type === 'login') {
        const at = now()
        const throttled =
          shouldThrottle(lastLoginAttemptAtByPeer.get(fromPeerId), at, LOGIN_MIN_INTERVAL_MS) ||
          (typeof msg.device_id === 'string' &&
            shouldThrottle(lastLoginAttemptAtByDevice.get(msg.device_id), at, LOGIN_MIN_INTERVAL_MS))
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
            await sendFramed(stream.sink, encodeMessage({ type: 'login_ok', token: result.token, userId: result.userId, role: result.role, ...(result.camp ? { camp: result.camp } : {}) }))
          } else {
            await sendFramed(
              stream.sink,
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
      // delivered and thrown away. Under the op-log that did not matter,
      // because syncClient.js received the same decision over WS; once the
      // op-log is retired this is the ONLY way a device learns it was let in.
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
      await sendFramed(stream.sink, encodeMessage(outgoing))
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
