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
// 5d-1 implements the `authenticate` message only (an already-paired,
// already-logged-in device reconnecting with a live token — the ADR's
// "Order — reconnect" flow). `pairing_request`/`login` are 5d-2.
import { AUTH_PROTO, sendFramed, receiveFramed } from './wireProtocol.js'

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
export function registerAuthGate(node, { onAuthenticate } = {}) {
  const authenticatedPeers = new Set()

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
        // Malformed frame: never reaches onAuthenticate, never admitted.
        // Abort rather than silently ignore — a peer sending junk to the
        // auth protocol gets no free retry loop on this stream.
        stream.abort(new Error('malformed_auth_frame'))
        return
      }

      if (!msg || msg.type !== 'authenticate') {
        stream.abort(new Error('unsupported_auth_message'))
        return
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
    }).catch(() => {
      // A peer closing/corrupting the stream mid-frame must not crash this
      // node — same defensive posture as transport.js's doc-sync handler.
    })
  })

  return { authenticatedPeers }
}
