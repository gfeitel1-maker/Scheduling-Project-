// Stage 4c (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md):
// the glue between transport.js (opaque bytes) and the document/projection
// layer built in Stages 1-3 (electron/automerge/campDocument.js,
// electron/automerge/projector.js). This is the first place Stage 4's code
// touches Automerge or SQLite — isolated here so it can be reviewed
// separately from libp2p plumbing.
//
// On each received frame: A.merge the incoming bytes into the held doc; if
// heads advanced, projectAll into SQLite and re-broadcast to every OTHER
// connected peer (mirrors test-cr4-live.mjs's except-self broadcast, which is
// what lets a 3+ peer LAN mesh converge without a full connection graph).
import * as A from '@automerge/automerge'
import { startTransport } from './transport.js'
import { projectAll } from '../../automerge/projector.js'
import { synthesizeOpEvents } from './docDiffEvents.js'
import { evaluateAuthenticate, evaluatePairingRequest, evaluateLogin } from '../../auth/connectionAuth.js'
import { recordLibp2pPeerId } from './peerIdentity.js'
import { wireMutualAuth } from './mutualAuth.js'
import { getCurrentDoc, setCurrentDoc } from './liveDoc.js'

// Starts a transport node and wires it to `doc`/`db`. Returns a handle that
// exposes the current doc and the same lifecycle/broadcast surface as
// transport.js, so callers don't need to reach into the raw transport.
//
// `doc` is the caller's starting Automerge document (e.g. from
// createEmptyDoc() or loadDoc(savedBytes)). Stage 5f: the current doc is NOT held in a private
// closure variable here — it lives in liveDoc.js's `docRegistry`, keyed by `db`, so that this
// module's remote-merge path and liveDoc.recordLocalWrite's local-write path share exactly one
// document instead of silently diverging (see liveDoc.js's module comment for the defect this
// closes). `doc` just seeds that registry on startup via setCurrentDoc.
//
// `onRemoteOps` (Stage 5c, docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 3): fired
// with (events, { fromPeerId }) once per received frame that actually advanced the doc AND
// projected successfully — deliberately AFTER projectAll, never before and never on a projection
// failure. Firing before projectAll would race the renderer's reload against SQLite still being
// mid-write; firing on a projection failure would tell the renderer "reload, fresh data is here"
// while SQLite is actually stuck at last-good, which is worse than saying nothing. `events` is
// whatever synthesizeOpEvents (docDiffEvents.js) computed between the pre-merge and post-merge
// heads — the caller (main.js) is responsible for sanitizing/forwarding them over IPC; this module
// only computes and hands them off. Wrapped in try/catch so a consumer's own throw can never break
// sync or escape as an unhandled rejection — sync must keep converging regardless of what a push-
// event listener does with what it's handed.
export async function startSyncNode({ deviceId, db, doc, onProjected, onProjectionError, onRemoteOps, onPairingRequest, peerDiscovery, onAuthRejected, now } = {}) {
  // Stage 5f: this module no longer keeps a private `state.doc` — the doc lives in liveDoc.js's
  // `docRegistry`, keyed by THIS `db`, so that a local write (liveDoc.recordLocalWrite) and a
  // remote merge (handleReceived below) mutate the exact same document instead of two copies that
  // silently diverge (see liveDoc.js's module comment for the defect this closes). Seed the
  // registry from the caller's starting doc now, in case nothing has set one for this db yet
  // (production: main.js already seeded it via ensureAutomergeDocSeeded before calling here, so
  // this is a no-op re-set of the same value; tests that construct a doc directly and hand it to
  // startSyncNode need this to establish the registry entry in the first place).
  setCurrentDoc(db, doc)

  async function handleReceived(bytes, { fromPeerId }) {
    let incoming
    try {
      incoming = A.load(bytes)
    } catch {
      // Untrusted peer input: a malformed Automerge binary must not crash
      // this node (design doc's "what must NOT be trusted" section).
      return
    }
    const currentDoc = getCurrentDoc(db)
    const before = A.getHeads(currentDoc)
    const merged = A.merge(currentDoc, incoming)
    if (JSON.stringify(before) === JSON.stringify(A.getHeads(merged))) return // nothing new
    setCurrentDoc(db, merged)

    // Project into SQLite. A merged doc can be valid CRDT state yet violate a
    // domain invariant the projector rejects — e.g. a child entity referencing
    // a parent another peer concurrently deleted (the Stage-2 rules-layer
    // boundary; projector.js:projectAll throws ATOMICALLY, leaving SQLite at
    // its last-good state). That throw must NOT crash the node or escape as an
    // unhandled rejection, and must NOT poison the node silently: the merged
    // doc stays as the CRDT truth we keep and relay, the SQLite divergence is
    // surfaced (onProjectionError + logged) for the Stage-2 rules layer to
    // repair, and sync continues. See docs/adr/2026-09-06 rules-layer section.
    try {
      projectAll(db, merged)
      onProjected?.(merged)
      // Only synthesize/fire push events once SQLite actually reflects the merged doc — the
      // renderer re-reads SQLite on these events, so they must never lead the projection.
      if (onRemoteOps) {
        try {
          const events = synthesizeOpEvents(merged, before, A.getHeads(merged), { deviceId: fromPeerId ?? null })
          if (events.length > 0) onRemoteOps(events, { fromPeerId })
        } catch (err) {
          console.error(`syncNode: onRemoteOps consumer threw (non-fatal, sync continues): ${err?.message ?? err}`)
        }
      }
    } catch (err) {
      onProjectionError?.(err, merged, fromPeerId)
      console.error(
        `syncNode: projection failed for a merged doc from ${fromPeerId ?? 'unknown peer'} — ` +
          `SQLite left at last-good, doc kept as CRDT truth, rules-layer repair pending: ${err?.message ?? err}`
      )
    }

    // Relay the merged doc regardless of local projection outcome: it is valid
    // CRDT state, and withholding it would make this node a convergence
    // dead-end. Guard so a transport error can't escape as an unhandled
    // rejection either.
    try {
      await transport.broadcastDoc(A.save(merged), { exceptPeerId: fromPeerId })
    } catch (err) {
      console.error(`syncNode: re-broadcast after receive failed (non-fatal): ${err?.message ?? err}`)
    }
  }

  // Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1/§3): the
  // admission decision for the auth-over-libp2p `authenticate` message —
  // implements the ADR's "reconnect" flow only (an already-paired,
  // already-logged-in device presenting a live token). `pairing_request`/
  // `login` are 5d-2 and are not handled here; any other message type is
  // already rejected by authGate.js before this is even called.
  async function onAuthenticate(msg, { fromPeerId }) {
    const result = evaluateAuthenticate(db, { token: msg.token, device_id: msg.device_id })
    if (result.ok) recordLibp2pPeerId(db, msg.device_id, fromPeerId)
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  }

  // Stage 5d-2b (ADR §1's "first pairing" flow). `onPairingRequest` is
  // injected by the caller (main.js) — the SAME director-approval callback
  // already wired to the WS transport's `onPairingRequest`
  // (startSyncServer's option), since the approval decision itself
  // (director looks at a name, clicks approve/deny) is transport-
  // independent; only the decision function that runs FIRST
  // (evaluatePairingRequest, shared with syncServer.js) is this module's own
  // concern.
  async function onPairingRequestMsg(msg) {
    const result = evaluatePairingRequest(db, { device_id: msg.device_id, device_name: msg.device_name })
    if (result.ok && !result.alreadyApproved && typeof onPairingRequest === 'function') {
      onPairingRequest(msg.device_id, msg.device_name)
    }
    return result
  }

  // Stage 5d-2b: device-secret + PIN/lockout, shared with syncServer.js's
  // `login` handling via evaluateLogin (electron/auth/connectionAuth.js).
  async function onLogin(msg, { fromPeerId }) {
    const result = evaluateLogin(db, {
      device_id: msg.device_id,
      device_secret_identifier: msg.device_secret_identifier,
      name: msg.name,
      pin: msg.pin,
    })
    if (result.ok) recordLibp2pPeerId(db, msg.device_id, fromPeerId)
    return result
  }

  const transport = await startTransport({
    deviceId,
    onDocReceived: handleReceived,
    onAuthenticate,
    onPairingRequest: onPairingRequestMsg,
    onLogin,
    peerDiscovery,
    // Threaded through to authGate.js's rate-limit clock (Stage 5d-2b re-
    // review, HIGH finding fix) — optional, tests only; production never
    // sets this and gets the real Date.now.
    ...(now ? { now } : {}),
  })

  // Stage 5d-2b production wiring: this is what turns "nothing calls
  // authenticateWith outside tests" into a real running node. Only fires at
  // all once a token exists (`setAuthToken` below) — until then a
  // discovered peer is simply not dialed, matching mutualAuth.js's own
  // documented behavior for the not-logged-in-yet case. `peerDiscovery`
  // being unset (every existing test, and any caller that dials directly)
  // means `onPeerDiscovery` never fires, so this is a pure no-op for them.
  let authToken = null
  wireMutualAuth(
    { dial: transport.dial, authenticateWith: transport.authenticateWith, onPeerDiscovery: transport.onPeerDiscovery },
    { deviceId, getToken: () => authToken, onRejected: onAuthRejected }
  )

  return {
    peerId: transport.peerId,
    getPeers: transport.getPeers,
    getMultiaddrs: transport.getMultiaddrs,
    dial: transport.dial,
    authenticateWith: transport.authenticateWith,
    isPeerAuthenticated: transport.isPeerAuthenticated,
    sendPairingApproved: transport.sendPairingApproved,
    sendPairingDenied: transport.sendPairingDenied,
    onPeerDiscovery: transport.onPeerDiscovery,
    // Caller (main.js) supplies this device's own current valid session
    // token whenever it obtains or renews one (self-issued for a Host,
    // received from login/pairing for a Client) — see mutualAuth.js's own
    // doc comment for why a missing token just means "not dialed yet,"
    // never an error.
    setAuthToken: (token) => { authToken = token },
    // Exposed for adversarial-input tests (sending raw bytes that are not a
    // valid Automerge doc); not part of the normal edit/broadcast flow.
    sendDocTo: transport.sendDocTo,
    getDoc: () => getCurrentDoc(db),
    // Direct test/adversarial-scenario API: apply an already-changed doc (via the caller's own
    // A.change/applyWrite), project it locally, and broadcast the new bytes to every connected
    // peer. NOT the production local-write path — that's liveDoc.recordLocalWrite, which only
    // updates the shared doc and debounces a broadcast (see broadcastLocalDoc below); calling
    // projectAll per field-op here would be the "full delete-reconcile on every keystroke"
    // performance trap Stage 5f deliberately avoids for real local writes.
    applyLocal: async (newDoc) => {
      setCurrentDoc(db, newDoc)
      try {
        projectAll(db, newDoc)
        onProjected?.(newDoc)
      } catch (err) {
        onProjectionError?.(err, newDoc, null)
        console.error(`syncNode: local projection failed — SQLite left at last-good: ${err?.message ?? err}`)
      }
      await transport.broadcastDoc(A.save(newDoc))
    },
    // Stage 5f item 2: the broadcast half of a REAL local write. liveDoc.recordLocalWrite already
    // applies the write to the shared doc and debounces a save; main.js wires this function in as
    // liveDoc's broadcast callback (setLocalWriteBroadcaster) so that debounced window ALSO
    // broadcasts the resulting bytes to every connected peer — no projectAll involved, since the
    // op-log write that produced this doc change already landed in this device's own SQLite via
    // appendOp, before recordLocalWrite ever ran.
    broadcastLocalDoc: async (doc) => {
      try {
        await transport.broadcastDoc(A.save(doc))
      } catch (err) {
        console.error(`syncNode: local-write broadcast failed (non-fatal): ${err?.message ?? err}`)
      }
    },
    stop: transport.stop,
  }
}
