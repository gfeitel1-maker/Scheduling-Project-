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
import { joinCode as joinCodeFor, joinProof, verifyJoinProof } from '../joinCode.js'

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
export async function startSyncNode({ deviceId, db, doc, onProjected, onProjectionError, onRemoteOps, onPairingRequest, onPairingDecision, isJoinWindowOpen, peerDiscovery, onAuthRejected, listen, now } = {}) {
  // Stage 5f: this module no longer keeps a private `state.doc` — the doc lives in liveDoc.js's
  // `docRegistry`, keyed by THIS `db`, so that a local write (liveDoc.recordLocalWrite) and a
  // remote merge (handleReceived below) mutate the exact same document instead of two copies that
  // silently diverge (see liveDoc.js's module comment for the defect this closes). Seed the
  // registry from the caller's starting doc now, in case nothing has set one for this db yet
  // (production: main.js already seeded it via ensureAutomergeDocSeeded before calling here, so
  // this is a no-op re-set of the same value; tests that construct a doc directly and hand it to
  // startSyncNode need this to establish the registry entry in the first place).
  setCurrentDoc(db, doc)

  // Shared post-merge step (projectAll + onProjected/onRemoteOps + error handling), used by BOTH
  // the whole-doc receive path (handleReceived, below — kept for the adversarial-input tests and
  // syncNode's own applyLocal test API) and the new sync-protocol receive path (handleSyncMessage).
  // Pulled out so the two paths cannot silently diverge in what "a merge landed" means — same
  // ordering guarantee either way: project BEFORE onRemoteOps fires, never on a projection failure
  // (see this file's header comment for why).
  function projectAndNotify(merged, before, fromPeerId) {
    try {
      projectAll(db, merged)
      onProjected?.(merged)
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
  }

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
    // A.merge CONSUMES `currentDoc` — that handle is invalid from here on. The registry must
    // therefore be updated even when the merge brought nothing new, or the registry keeps a dead
    // handle and the next LOCAL write throws "Attempting to change an outdated document" and keeps
    // throwing until restart. Redundant frames are routine (peers relay, peers re-send, and a
    // newly-admitted peer is sent the whole doc), so this was not an edge case — it bricked local
    // edits in ordinary two-device operation. Found on a real two-machine run; in-process tests
    // never sent a no-op merge before a local write, so it was invisible in CI.
    const nothingNew = JSON.stringify(before) === JSON.stringify(A.getHeads(merged))
    setCurrentDoc(db, merged, { persist: !nothingNew })
    if (nothingNew) return

    // Project into SQLite. A merged doc can be valid CRDT state yet violate a
    // domain invariant the projector rejects — e.g. a child entity referencing
    // a parent another peer concurrently deleted (the Stage-2 rules-layer
    // boundary; projector.js:projectAll throws ATOMICALLY, leaving SQLite at
    // its last-good state). That throw must NOT crash the node or escape as an
    // unhandled rejection, and must NOT poison the node silently: the merged
    // doc stays as the CRDT truth we keep and relay, the SQLite divergence is
    // surfaced (onProjectionError + logged) for the Stage-2 rules layer to
    // repair, and sync continues. See docs/adr/2026-09-06 rules-layer section.
    projectAndNotify(merged, before, fromPeerId)

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

  // --- Stage 5f-2: real Automerge sync protocol ------------------------------------------------
  // Replaces the fire-and-forget whole-document push (broadcastDoc/sendDocTo, still used above by
  // handleReceived/applyLocal for direct-send and adversarial-input tests) as the mechanism for
  // initial-sync-on-connect and for relaying local writes. A.generateSyncMessage/
  // A.receiveSyncMessage is acknowledged and incremental: each message either side sends is only
  // the deltas the OTHER side's sync state says it doesn't have yet, and the exchange has a defined
  // settled state (both sides generate null) rather than "we sent something, hopefully it landed".
  //
  // Per-peer sync state (peerId -> Automerge sync state), initialized fresh on admission and
  // discarded on disconnect — see transport.js's onPeerDisconnected wiring below. Reconnecting
  // after a disconnect starts a new exchange from scratch (A.initSyncState()), which still
  // converges correctly, just without the efficiency of resuming exactly where a prior connection
  // left off.
  const syncStates = new Map()

  // Generate the next outbound sync message for `peerId` from the CURRENT doc and that peer's held
  // state, and send it if there is one. Called (a) the moment a peer is admitted — this is what
  // gives initial-sync-on-connect reliably, "for free", instead of the old whole-doc push's timing-
  // dependent delivery — and (b) after processing an inbound sync message, to keep the exchange
  // going until both sides are quiescent. A send failure (e.g. the peer hasn't admitted THIS node
  // back yet, or has disconnected) is swallowed: the other trigger point (the peer's own admission,
  // or its own next inbound message) will retry the exchange from the current state, and a real
  // disconnect will clear this peer's state via onPeerDisconnected below.
  function stepSync(peerId) {
    const state = syncStates.get(peerId) ?? A.initSyncState()
    const currentDoc = getCurrentDoc(db)
    const [nextState, msg] = A.generateSyncMessage(currentDoc, state)
    syncStates.set(peerId, nextState)
    if (!msg) return
    transport.sendSyncMessage(peerId, msg).catch((err) => {
      console.error(`syncNode: sync message send to ${peerId} failed (non-fatal, will retry on next trigger): ${err?.message ?? err}`)
    })
  }

  async function handleSyncMessage(bytes, { fromPeerId }) {
    const state = syncStates.get(fromPeerId) ?? A.initSyncState()
    const currentDoc = getCurrentDoc(db)
    const before = A.getHeads(currentDoc)
    let nextDoc, nextState
    try {
      // A.receiveSyncMessage CONSUMES `currentDoc`, exactly like A.merge above — the registry is
      // always updated below regardless of whether new heads landed, for the same reason
      // handleReceived's comment gives: an outdated handle throws on the next local change.
      ;[nextDoc, nextState] = A.receiveSyncMessage(currentDoc, state, bytes)
    } catch {
      // Untrusted peer input: a malformed sync message must not crash this node, same posture as
      // handleReceived's A.load catch above.
      return
    }
    syncStates.set(fromPeerId, nextState)
    const nothingNew = JSON.stringify(before) === JSON.stringify(A.getHeads(nextDoc))
    setCurrentDoc(db, nextDoc, { persist: !nothingNew })
    if (!nothingNew) {
      projectAndNotify(nextDoc, before, fromPeerId)
      // Relay to every OTHER admitted peer too (mirrors handleReceived's except-self broadcast) —
      // without this, a 3+ peer mesh only converges peer-pairwise with whoever sent the update,
      // not the whole mesh.
      for (const otherPeerId of transport.getPeers()) {
        if (otherPeerId !== fromPeerId && transport.isPeerAuthenticated(otherPeerId)) stepSync(otherPeerId)
      }
    }
    // Keep the exchange going: generate this side's next message (an ack, a reply carrying data
    // THIS node has that the peer doesn't, or null once both are quiescent).
    stepSync(fromPeerId)
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
    // Join-code proof (docs/adr/2026-09-08-libp2p-join-flow.md §5). A request
    // carrying a `join_nonce` is a first-join over the join-discovery tag, and
    // that tag is broadcast in the clear — so the nonce's proof is the only
    // thing separating the real joining device from anyone who mirrored the
    // tag. Verified BEFORE evaluatePairingRequest so a mirrored-tag peer never
    // reaches the director's screen at all.
    //
    // A request WITHOUT a nonce is an already-paired device reconnecting (the
    // camp-scoped path), which never had a code and is unchanged.
    let joinConfirm = null
    if (typeof msg.join_nonce === 'string') {
      // The director's Add-a-device window. This is a CONSENT boundary, not
      // the security boundary — the join-code proof below is what actually
      // separates the real joining device from a peer that mirrored the
      // public mDNS tag. It exists so a Host that nobody is standing at does
      // not put pairing prompts on screen. Hence the fail-open default: a
      // caller that does not pass it (every test, and any embedding that has
      // no such window) gets today's behavior, and loses nothing that was
      // protecting it.
      if (isJoinWindowOpen && !isJoinWindowOpen()) {
        return { ok: false, reason: 'join_window_closed' }
      }
      const campId = db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
      const code = campId ? joinCodeFor(campId) : null
      if (!code || !verifyJoinProof(code, msg.join_nonce, 'joiner', msg.join_proof)) {
        return { ok: false, reason: 'bad_join_proof' }
      }
      joinConfirm = joinProof(code, msg.join_nonce, 'host')
    }

    const result = evaluatePairingRequest(db, { device_id: msg.device_id, device_name: msg.device_name })
    if (result.ok && !result.alreadyApproved && typeof onPairingRequest === 'function') {
      onPairingRequest(msg.device_id, msg.device_name)
    }
    return joinConfirm ? { ...result, joinConfirm } : result
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
    listen,
    deviceId,
    onDocReceived: handleReceived,
    onSyncMessageReceived: handleSyncMessage,
    // Stage 5f-2: initial-sync-on-admission is back, this time built on the real sync protocol
    // (stepSync above) rather than a whole-document push. The prior attempt (Stage 5f) removed a
    // push-on-admission because it was fire-and-forget: a frame rejected by the peer's admission
    // gate doesn't throw on the sending side, and the two ends admit each other at different
    // moments, so the send landed or was silently dropped depending on timing. generateSyncMessage/
    // receiveSyncMessage is different in kind, not just retried harder: each side's sync state
    // tracks exactly what the other has acknowledged, a send failure here just means "try again at
    // the next trigger" (this peer's own admission event, or its next inbound message), and the
    // exchange has a real settled state instead of "sent, hopefully received".
    onPeerAdmitted: (peerId) => {
      syncStates.set(peerId, A.initSyncState())
      stepSync(peerId)
    },
    onAuthenticate,
    onPairingRequest: onPairingRequestMsg,
    onLogin,
    // Stage 6 join flow: the joining device's end of the Host's approval
    // dial-back. Only ever set by joinSession.js; a Host and an
    // already-paired Client both leave it unset and never receive one.
    onPairingDecision,
    peerDiscovery,
    // Threaded through to authGate.js's rate-limit clock (Stage 5d-2b re-
    // review, HIGH finding fix) — optional, tests only; production never
    // sets this and gets the real Date.now.
    ...(now ? { now } : {}),
  })

  // Discard this peer's sync progress the moment the connection is gone (see syncStates' own
  // comment above for why this is correct rather than merely tidy).
  transport.onPeerDisconnected((peerId) => {
    syncStates.delete(peerId)
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
    // First-join trust bootstrap — see transport.js's admitPeer comment. Only
    // joinSession.js calls this, and only right after logging in to that peer.
    admitPeer: transport.admitPeer,
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
    // Stage 5f item 2 (Stage 5f-2: now via the sync protocol, not a whole-doc push). The broadcast
    // half of a REAL local write. liveDoc.recordLocalWrite already applies the write to the shared
    // doc and debounces a save; main.js wires this function in as liveDoc's broadcast callback
    // (setLocalWriteBroadcaster) so that debounced window ALSO propagates to every connected peer
    // — no projectAll involved, since the op-log write that produced this doc change already
    // landed in this device's own SQLite via appendOp, before recordLocalWrite ever ran.
    //
    // `doc` (the argument) is not read directly — stepSync always reads the CURRENT doc via
    // getCurrentDoc(db), which is the same value liveDoc just set into the registry before calling
    // this, so the two are the same document; using getCurrentDoc keeps this one code path (shared
    // with admission/receive) as the only place that decides what "the current doc" means.
    broadcastLocalDoc: async () => {
      for (const peerId of transport.getPeers()) {
        if (transport.isPeerAuthenticated(peerId)) stepSync(peerId)
      }
    },
    stop: transport.stop,
  }
}
