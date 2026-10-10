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
import { createJoinTagAdvertiser } from './joinTagDiscovery.js'
import { startTransport } from './transport.js'
import { projectAll } from '../../automerge/projector.js'
import { reconcileAndRecordConflicts } from '../../automerge/reconcileForProjection.js'
import { synthesizeOpEvents } from './docDiffEvents.js'
import { evaluateAuthenticate, evaluatePairingRequest, evaluateLogin } from '../../auth/connectionAuth.js'
import { appendReceivedOps } from '../../automerge/historyLedger.js'
import { wireMutualAuth } from './mutualAuth.js'
import { createConnectivityEmitter } from './connectivityEvents.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { createBoundPeerTrust } from './peerIdentity.js'
import { rememberPeerAddress, redialTrustedPeers } from './peerAddressBook.js'
import { forgetRevokedPeer } from './punchIdentity.js'
import { getCurrentDoc, setCurrentDoc } from './liveDoc.js'
import { sharesGenesis } from '../../automerge/campDocument.js'
import { joinProof, verifyJoinProof, rejoinCampProof } from '../joinCode.js'
import { createHostHandoff } from '../../auth/hostHandoff.js'
import { createHandoffWire } from './hostHandoffWire.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { runRendezvousRotation } from './rendezvousRotation.js'

// T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md): pure, directly-testable
// predicate deciding whether a PEER's schema version (learned from its own `authenticate` handshake
// — see `peerSchemaVersions` below, NOT a document field; round 1 shipped a document-root carrier
// and it was wrong, see the ADR's round-3 revision) is safe to sync/merge with. Owner-ruled: STRICT
// exact-match only. `incomingVersion` of null/undefined ("unknown" — a peer that never sent the
// field, or sent a non-numeric value) is treated as incompatible, not as an automatic pass — see
// isSyncCompatible.test.js.
export function isSyncCompatible(incomingVersion, localVersion) {
  return typeof incomingVersion === 'number' && incomingVersion === localVersion
}

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
// `localSchemaVersion` (T271): defaults to this build's real CURRENT_SCHEMA_VERSION for every
// production caller. Overridable ONLY so the integration harness can simulate a device running a
// different schema version without needing an actually-different installed build — mirroring the
// `startSyncNode` substitution seam this module's callers already use for the same cross-version
// testing need (see harnessAutomerge.js's AmHost/AmClient constructor comment). May be a plain
// number (the common case) or a zero-arg function re-read on every gate check — the function form
// is what lets an integration test simulate "this device just upgraded" on the SAME live
// node/connection: bumping what THIS device now requires re-evaluates against a peer's ALREADY-
// recorded (round 3: handshake-sourced, not document-sourced) version with no new dial, no new
// authenticate, proving the self-resolve is automatic.
//
// `handshakeSchemaVersion` (T271 round 3): what THIS device itself ANNOUNCES in its own outbound
// `authenticate` frame (mutualAuth.js). Defaults to `localSchemaVersion` — in production these are
// the same fact ("my build's schema version"), so a caller that doesn't pass this gets today's
// natural behavior. Kept as a DISTINCT, independently-overridable seam (rather than always reusing
// `localSchemaVersion`) only for the integration harness, which cannot literally run two different
// installed builds in one process: overriding this alone lets a test node ANNOUNCE a version other
// than this checkout's real CURRENT_SCHEMA_VERSION, to construct a genuine peer-version mismatch
// without needing a second codebase.
export async function startSyncNode({ deviceId, db, doc, onProjected, onNothingNew, onProjectionError, onCrossCampRejected, onRemoteOps, onPairingRequest, onPairingDecision, isJoinWindowOpen, getJoinSecret, peerDiscovery, joinDiscoveryFor, onAuthRejected, isPeerTrusted, listen, now, localSchemaVersion = CURRENT_SCHEMA_VERSION, handshakeSchemaVersion = localSchemaVersion, relayServerFactory, relayTransportFactory, directUpgradeServiceFactory, punchTransportFactory, onPunchPeerAdmitted, onRelayReservationRefused, relaunch, onHandoffChanged, handoffRetryMs, handoffFaults } = {}) {
  const getLocalSchemaVersion = () =>
    typeof localSchemaVersion === 'function' ? localSchemaVersion() : localSchemaVersion
  const getHandshakeSchemaVersion = () =>
    typeof handshakeSchemaVersion === 'function' ? handshakeSchemaVersion() : handshakeSchemaVersion
  // Stage 5f: this module no longer keeps a private `state.doc` — the doc lives in liveDoc.js's
  // `docRegistry`, keyed by THIS `db`, so that a local write (liveDoc.recordLocalWrite) and a
  // remote merge (handleReceived below) mutate the exact same document instead of two copies that
  // silently diverge (see liveDoc.js's module comment for the defect this closes). Seed the
  // registry from the caller's starting doc now, in case nothing has set one for this db yet
  // (production: main.js already seeded it via ensureAutomergeDocSeeded before calling here, so
  // this is a no-op re-set of the same value; tests that construct a doc directly and hand it to
  // startSyncNode need this to establish the registry entry in the first place).
  setCurrentDoc(db, doc)

  // T162 (docs/adr/2026-09-14-device-identity-and-token-binding.md §1/§2):
  // load (or generate, on first run) this device's persistent libp2p
  // identity BEFORE startTransport, so its PeerId is stable across restarts
  // — the precondition bindOrVerifyPeerIdentity's TOFU bind depends on.
  // Red Hat finding, 2026-09-17: main.js catches every startSyncNode failure with a
  // single console.error whose comment frames it as a transport problem ("port in use,
  // WASM/ESM load failure") that is safe to shrug off. An identity failure is NOT that
  // class of event: a transport failure is transient, while a device that cannot
  // establish or read its own keypair can never sync until someone fixes the disk or
  // the row — and both look identical to a director, who sees only that nothing
  // syncs. Re-throw with a message that names the cause unmistakably, so the log says
  // which of the two happened.
  //
  // NOT fixed here, and deliberately: there is still no director-facing surface for
  // this. Giving it one is the same product decision as rendering a 4405
  // peer_identity_mismatch legibly, and it is recorded as an owner question in
  // docs/work/tickets/T162-device-identity-and-token-binding.md rather than invented
  // inside this seam.
  let deviceIdentityPrivateKey
  try {
    ({ privateKey: deviceIdentityPrivateKey } = await ensureDeviceIdentity(db))
  } catch (err) {
    throw new Error(
      `device identity could not be established, so this device cannot sync at all ` +
      `(this is NOT a transient transport failure — see electron/auth/deviceIdentity.js): ` +
      `${err?.message ?? err}`,
      { cause: err }
    )
  }

  // Shared post-merge step (projectAll + onProjected/onRemoteOps + error handling), used by BOTH
  // the whole-doc receive path (handleReceived, below — kept for the adversarial-input tests and
  // syncNode's own applyLocal test API) and the new sync-protocol receive path (handleSyncMessage).
  // Pulled out so the two paths cannot silently diverge in what "a merge landed" means — same
  // ordering guarantee either way: project BEFORE onRemoteOps fires, never on a projection failure
  // (see this file's header comment for why).
  // Reconcile BEFORE projecting, and return whatever document reconciliation
  // produced — the caller must adopt it, or a recovered field would be written
  // to SQLite and then lost again on the next save
  // (docs/adr/2026-09-08-crdt-conflict-reconciliation.md).
  //
  // Two jobs, deliberately different: fields nobody needs to adjudicate are
  // unioned silently, and a genuine disagreement between two people is recorded
  // for a human to settle. `projectAll` then refuses any document carrying a
  // conflict this did not record — which is what makes "the system cannot be in
  // a state where a conflict went unhandled" a property of the code rather than
  // of whoever remembers to call this. Shared with the other projectAll callers
  // (rebuildSupportCommand.js, purgeSupportCommand.js) via reconcileForProjection.js —
  // see that module's header for why it had to stop being private to this file.
  function reconcileForProjection(merged) {
    return reconcileAndRecordConflicts(db, merged)
  }

  // T331 gate C, third enforcement point (docs/adr/2026-10-02-distributed-revocation-authority.md)
  // — "live teardown on projection": the moment THIS device's own derived authority_cache
  // (just recomputed by the projectAll call above, via upsertCampAuthorityLogEntity) shows a
  // CURRENTLY-CONNECTED peer as revoked, tear that connection down now rather than waiting for it
  // to drop on its own — closing the third-device residual (a device revoked by two OTHER admins'
  // quorum, propagated here by ordinary merge, must not keep its live connection to THIS device
  // either). Mirrors T330's identical teardown argument; `transport.revokePeer` already exists and
  // is idempotent (safe to call on a peer that is already disconnected).
  function tearDownRevokedConnectedPeers() {
    for (const [peerId, deviceId] of peerDeviceIds) {
      const status = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status
      if (status === 'revoked') {
        transport.revokePeer(peerId)
        try { forgetRevokedPeer(db, peerId) } catch (err) { console.error(`syncNode: failed to clear punch state for revoked ${peerId}: ${err?.message ?? err}`) }
      }
    }
  }

  function projectAndNotify(merged, before, fromPeerId) {
    try {
      const contained = projectAll(db, merged)
      tearDownRevokedConnectedPeers()
      runRendezvousRotation(db, { deviceId, broadcast: syncAllAuthenticatedPeers })
      onProjected?.(merged)
      // Containment (round 3) made a bad row non-fatal — projectAll no longer throws for it, so
      // the app must learn about it here instead of only in projection_failures/the console
      // (T194 round 6, Defect 1). Reuses the same onProjectionError callback the fatal path below
      // already calls: one row per contained failure, never fatal, sync keeps converging either way.
      if (contained?.length) {
        for (const failure of contained) {
          try {
            // A cross-camp camp_id rejection is a security refusal of a peer write, not a
            // projection failure (the row itself projected fine). Route it to its own
            // surface; everything else is a contained projection failure as before.
            if (failure.crossCamp) {
              onCrossCampRejected?.(failure, merged, fromPeerId)
            } else {
              onProjectionError?.(failure.error, merged, fromPeerId)
            }
          } catch (err) {
            console.error(`syncNode: projection-failure consumer threw (non-fatal, sync continues): ${err?.message ?? err}`)
          }
        }
      }
      // Synthesized once and used twice: the local history ledger writes rows
      // for what arrived, and the renderer is notified. Computing the diff
      // separately for each would be wasted work on the receive path, which a
      // joining device runs once for an entire camp.
      let events = null
      try {
        events = synthesizeOpEvents(merged, before, A.getHeads(merged), { deviceId: fromPeerId ?? null })
      } catch (err) {
        console.error(`syncNode: could not synthesize op events (non-fatal, sync continues): ${err?.message ?? err}`)
      }
      if (events && events.length > 0) {
        // The op-log is retired as a SYNC mechanism, not as a record. Without
        // this a device could see a record it had no history for and could not
        // restore — see electron/automerge/historyLedger.js.
        //
        // Deliberately inside its own try: a ledger failure must never cost the
        // data, which is already correctly in SQLite by this point.
        try {
          appendReceivedOps(db, events, { fromPeerId, doc: merged })
        } catch (err) {
          console.error(
            `syncNode: history ledger write failed (non-fatal — data is projected and correct, ` +
              `only Trash/Restore history for this merge is missing): ${err?.message ?? err}`
          )
        }
        if (onRemoteOps) {
          try {
            onRemoteOps(events, { fromPeerId })
          } catch (err) {
            console.error(`syncNode: onRemoteOps consumer threw (non-fatal, sync continues): ${err?.message ?? err}`)
          }
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
    // A document that does not share our genesis is not a peer's view of this
    // camp, and merging it is destructive rather than merely useless: the two
    // roots' collections collide as map keys, Automerge keeps one side, and the
    // loser's ENTIRE collection disappears — nondeterministically, so it takes
    // this device's rows on some runs and not others. The projector then
    // delete-reconciles those rows out of SQLite.
    //
    // The admission gate cannot catch this: the sender is a legitimately
    // admitted peer. Found by porting integration scenario 14 to libp2p.
    if (!sharesGenesis(incoming)) {
      console.error(
        `syncNode: refused a document from ${fromPeerId ?? 'an unknown peer'} that does not share ` +
          `this camp's genesis — merging it could discard this device's own collections`
      )
      return
    }

    // T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md): a same-genesis
    // document can still be a different, incompatible field encoding if it was sent by a peer on a
    // different schema version (e.g. a renaming migration where two devices write two different
    // document keys for the same logical field — both survive the CRDT merge, one silently stale).
    // Sourced from `peerSchemaVersions` (recorded at authentication time from the peer's OWN
    // handshake — round 1 read this off document CONTENT instead, which is shared/racy CRDT state
    // and answers the wrong question; see the ADR's round-3 revision for why that was wrong).
    // Refuse the MERGE, not the peer's authentication/connection (owner-ruled Decision 3): this
    // device stays admitted and trusted, only THIS specific document delivery is declined, and the
    // very next delivery — automatically, once either device upgrades — merges normally. Silent per
    // owner ruling: a console.error dev-log line only, mirroring the sharesGenesis refusal directly
    // above, no connectivity event, no director-facing surface.
    if (!isPeerSyncCompatible(fromPeerId)) {
      console.error(
        `syncNode: refused a document from ${fromPeerId ?? 'an unknown peer'} — ` +
          `${describeSchemaMismatch(fromPeerId)}; merge skipped, will retry once versions match`
      )
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

    // A.change inside reconcile CONSUMES `merged`, exactly like A.merge above,
    // so `merged` is a dead handle from here and only `reconciled` may be used
    // or stored. The registry is re-set because a recovered field written into
    // SQLite but not into the registry would be lost on the next save.
    const reconciled = reconcileForProjection(merged)
    if (reconciled !== merged) setCurrentDoc(db, reconciled, { persist: true })

    // Project into SQLite. A merged doc can be valid CRDT state yet violate a
    // domain invariant the projector rejects — e.g. a child entity referencing
    // a parent another peer concurrently deleted (the Stage-2 rules-layer
    // boundary; projector.js:projectAll throws ATOMICALLY, leaving SQLite at
    // its last-good state). That throw must NOT crash the node or escape as an
    // unhandled rejection, and must NOT poison the node silently: the merged
    // doc stays as the CRDT truth we keep and relay, the SQLite divergence is
    // surfaced (onProjectionError + logged) for the Stage-2 rules layer to
    // repair, and sync continues. See docs/adr/2026-09-06 rules-layer section.
    projectAndNotify(reconciled, before, fromPeerId)

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

  // T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md, Decision 2): the
  // AUTHORITATIVE compatibility signal — peerId -> the schema version that peer reported in its OWN
  // `authenticate` handshake (`onAuthenticate` below), recorded once at authentication time. This
  // replaced a round-1 design that read a document-ROOT field instead, which Red Hat/Security found
  // was shared/racy CRDT state that froze every pre-existing camp document's sync forever and
  // answered the wrong question ("has this document ever seen a higher version" instead of "is the
  // peer that sent me THESE bytes compatible with me"). A live, per-connection, freshly-
  // authenticated fact has none of those problems: it cannot be stale relative to the peer that
  // actually sent the bytes, and a document created before this field existed has nothing for this
  // map to be missing FROM (there is no document-level state at all). Cleared on disconnect, same
  // lifecycle as `syncStates` directly above — see transport.js's onPeerDisconnected wiring below.
  const peerSchemaVersions = new Map()

  // T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) gate B support: this peer's
  // AUTHENTICATED device id, recorded the moment `authenticate` succeeds (same lifecycle as
  // peerSchemaVersions directly above — never trusted from a self-report after that point,
  // populated once from `evaluateAuthenticate`'s own verified token). `isPeerRevoked` below reads
  // this to resolve a peerId to the deviceId whose status this device's own locally-verified-
  // and-replayed `authority_cache` (projector.js's upsertCampAuthorityLogEntity) actually tracks —
  // never from devices.libp2p_peer_id, the mutable routing-only column.
  const peerDeviceIds = new Map()

  // Mirrors isPeerSyncCompatible's shape exactly (T271 pattern) — the literal T329 finding this
  // ADR exists to close: gated on the PRODUCTION path (handleSyncMessage below), not merely
  // handleReceived. A peer never authenticated (no entry in peerDeviceIds) is NOT revoked by this
  // check — admission already requires a live, non-revoked token at authenticate time; this is an
  // ADDITIONAL check for a device revoked by another admin's quorum AFTER it was admitted, while
  // its connection is still open.
  function isPeerRevoked(peerId) {
    const deviceId = peerDeviceIds.get(String(peerId))
    if (!deviceId) return false
    const status = db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status
    return status === 'revoked'
  }

  // Thin, pure(-ish — reads two closure-local values, no side effects) wrapper around
  // isSyncCompatible: what the peer announced (peerSchemaVersions, `null` if never recorded — a
  // peer that hasn't authenticated yet, or omitted the field) vs. what THIS device currently
  // requires (`getLocalSchemaVersion()`, function-form-aware so a test can simulate an upgrade
  // without a new connection — see startSyncNode's doc comment). Used at all THREE places this
  // module touches an Automerge merge/sync primitive for a remote peer: `stepSync`,
  // `handleSyncMessage`, and `handleReceived` below — round 1 only gated `handleReceived`, which
  // the comment two blocks above already states is direct-send/adversarial-test-only; the real
  // production path (`stepSync`/`handleSyncMessage`) had no gate at all until round 3.
  // Peers currently (or most recently) found incompatible — used only to force a truly FRESH
  // A.initSyncState() the moment a peer transitions back to compatible, rather than resuming
  // whatever state existed before/during the mismatch. This matters because Automerge's sync state
  // tracks what THIS side believes it has told the peer OPTIMISTICALLY, the instant
  // A.generateSyncMessage is called — NOT once the peer confirms it applied the bytes. A peer that
  // sent data while genuinely believing itself compatible (it has no way to know the OTHER side
  // refused) has therefore already advanced its OWN local bookkeeping past that data, even though
  // the receiving side never applied it; left alone, that side would never re-offer it once
  // versions converge. Resetting the RECEIVING side's state on recovery is what makes the resumed
  // exchange re-request everything from scratch instead of trusting either side's stale belief.
  const pendingVersionReset = new Set()

  function isPeerSyncCompatible(peerId) {
    const compatible = isSyncCompatible(peerSchemaVersions.get(peerId) ?? null, getLocalSchemaVersion())
    if (!compatible) {
      pendingVersionReset.add(peerId)
    } else if (pendingVersionReset.has(peerId)) {
      pendingVersionReset.delete(peerId)
      syncStates.delete(peerId)
    }
    return compatible
  }

  // T271 round 3 cleanup (Code Reviewer): under fail-closed, "no version was ever recorded for this
  // peer" and "a version was recorded and genuinely mismatches" produce IDENTICAL silent-forever
  // refusal behavior — but they have completely different causes. The first means an admission path
  // forgot to populate `peerSchemaVersions` (the bug hit twice this ticket: the join path bypassing
  // onAuthenticate entirely), which is a wiring defect a developer needs to go fix; the second is the
  // gate working exactly as designed on an honest version skew. Distinguishing them in the one-shot
  // refusal logs (handleSyncMessage/handleReceived) is what lets whoever debugs a peer that never
  // syncs tell which case they're in without re-deriving it from scratch.
  function describeSchemaMismatch(peerId) {
    const recorded = peerSchemaVersions.get(peerId)
    return recorded === undefined
      ? 'no schema version was ever recorded for this peer (an admission path likely forgot to ' +
          'populate peerSchemaVersions)'
      : `recorded schema version ${recorded} does not match this device's ${getLocalSchemaVersion()}`
  }

  // Stage 6c: who this device can currently reach is a question the renderer
  // asks (main.js's getSyncStatus, for the sidebar's connection copy). Under
  // the WebSocket transport the answer came from a socket's open/close events;
  // here it changes exactly when a peer is admitted or drops, so those two
  // places are the only ones that fire this.
  const peersChangedListeners = []
  function notifyPeersChanged() {
    for (const listener of peersChangedListeners) {
      try { listener() } catch { /* a listener must never break sync */ }
    }
  }

  // Generate the next outbound sync message for `peerId` from the CURRENT doc and that peer's held
  // state, and send it if there is one. Called (a) the moment a peer is admitted — this is what
  // gives initial-sync-on-connect reliably, "for free", instead of the old whole-doc push's timing-
  // dependent delivery — and (b) after processing an inbound sync message, to keep the exchange
  // going until both sides are quiescent. A send failure (e.g. the peer hasn't admitted THIS node
  // back yet, or has disconnected) is swallowed: the other trigger point (the peer's own admission,
  // or its own next inbound message) will retry the exchange from the current state, and a real
  // disconnect will clear this peer's state via onPeerDisconnected below.
  function stepSync(peerId) {
    // T271 round 3: do not even BEGIN a sync exchange with an incompatible peer — no sync state is
    // created or advanced for it, so there is nothing for the peer to be later marked "caught up"
    // on. Deliberately SILENT, not even a log line (unlike the one-shot refusals in
    // handleSyncMessage/handleReceived below): this fires on EVERY sync trigger for the duration of
    // a mismatch (peer admission, every subsequent local write, every inbound message from other
    // peers), and logging each occurrence would be exactly the unbounded-repeat log noise this
    // project already guards against elsewhere (mutualAuth.js's DISCOVERY_EMIT_WINDOW_MS precedent
    // for the same class of problem) — being incompatible is not a new fact each time this runs.
    if (!isPeerSyncCompatible(peerId)) return
    // Never generate a message for a revoked peer, whatever path asked: once the authority cache
    // says revoked, a push of settled state needs no reply, so gate B alone would not stop it.
    if (isPeerRevoked(peerId)) return
    const state = syncStates.get(peerId) ?? A.initSyncState()
    const currentDoc = getCurrentDoc(db)
    const [nextState, msg] = A.generateSyncMessage(currentDoc, state)
    syncStates.set(peerId, nextState)
    if (!msg) return
    transport.sendSyncMessage(peerId, msg).catch((err) => {
      console.error(`syncNode: sync message send to ${peerId} failed (non-fatal, will retry on next trigger): ${err?.message ?? err}`)
    })
  }

  function syncAllAuthenticatedPeers() {
    for (const peerId of transport.getPeers()) {
      if (transport.isPeerAuthenticated(peerId)) stepSync(peerId)
    }
  }

  async function handleSyncMessage(bytes, { fromPeerId }) {
    // T331 gate B (docs/adr/2026-10-02-distributed-revocation-authority.md) — the LITERAL T329
    // finding this ADR exists to close: a revoked device's sync must be refused on THIS production
    // path (handleSyncMessage, the real stepSync<->handleSyncMessage round trip), not merely
    // handleReceived (the test-only/direct-send path). Checked FIRST, before the schema-
    // compatibility check below and before any syncStates.set, same "never mark a refused
    // exchange as caught-up" discipline isPeerSyncCompatible's own check already uses — a device
    // revoked mid-connection must not be able to keep syncing until it happens to disconnect.
    if (isPeerRevoked(fromPeerId)) {
      console.error(`syncNode: refused a sync message from ${fromPeerId} — this device is revoked (T331 enforcement)`)
      return
    }
    // T271 round 3: refuse to APPLY an incoming sync message from a schema-version-incompatible
    // peer — this is the production path round 1 missed entirely (see peerSchemaVersions' comment
    // above). The check happens BEFORE any syncStates.set for this exchange, which is the load-
    // bearing property: it means the sync state is NEVER advanced/acked for bytes that were never
    // applied, so the SENDER's own state (once it re-triggers stepSync, e.g. on its next
    // authentication after upgrading) still shows this peer as behind and re-offers the same data.
    // A refused delivery must not mark the peer caught-up, or the mismatched write would never be
    // retried once versions converge.
    if (!isPeerSyncCompatible(fromPeerId)) {
      console.error(
        `syncNode: refused a sync message from ${fromPeerId} — ${describeSchemaMismatch(fromPeerId)}; ` +
          `sync paused for this peer, will resume once versions match`
      )
      return
    }
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
    if (nothingNew) onNothingNew?.(fromPeerId)
    if (!nothingNew) {
      // Same consume-and-adopt contract as handleReceived above.
      const reconciled = reconcileForProjection(nextDoc)
      if (reconciled !== nextDoc) setCurrentDoc(db, reconciled, { persist: true })
      projectAndNotify(reconciled, before, fromPeerId)
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
    // T162: peerId binding now happens INSIDE evaluateAuthenticate
    // (bindOrVerifyPeerIdentity) — recordLibp2pPeerId's unconditional
    // overwrite is no longer called here, since it would let a reinstalled/
    // impostor device bypass the mismatch check.
    const result = evaluateAuthenticate(db, { token: msg.token, device_id: msg.device_id, peerId: fromPeerId, appliedTombstones: msg.appliedTombstones })
    if (result.ok) {
      // T271 round 3 (docs/adr/2026-09-26-schema-version-gate-before-merge.md, Decision 2): record
      // this peer's OWN reported schema version — the authoritative signal for isPeerSyncCompatible
      // above — the moment admission succeeds. A message that omits the field (a hypothetical
      // pre-T271 peer) or sends a non-numeric value is recorded as `null`/"unknown", which
      // isSyncCompatible treats as incompatible, never as an automatic pass. This does NOT gate
      // authentication itself (Decision 3: identity/trust and data-merge-compatibility are kept
      // independent) — admission succeeds or fails purely on `evaluateAuthenticate`'s own result.
      // String(...) for key symmetry with recordPeerSchemaVersion's own String(peerId) below —
      // currently harmless (transport.js already stringifies fromPeerId before calling in), but a
      // future admission path passing a non-string peerId would otherwise create a second,
      // never-matched entry that, under fail-closed, refuses a legitimate peer forever.
      peerSchemaVersions.set(String(fromPeerId), typeof msg.schemaVersion === 'number' ? msg.schemaVersion : null)
      // T331 gate B support: record THIS peer's authenticated device id, so isPeerRevoked above
      // can resolve a later revocation against the exact device that proved itself at this moment
      // — never the client-supplied msg.device_id directly (result.verified.deviceId is the
      // value evaluateAuthenticate itself validated the token against).
      peerDeviceIds.set(String(fromPeerId), result.verified.deviceId)
    }
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  }

  // Stage 5d-2b (ADR §1's "first pairing" flow). `onPairingRequest` is injected by
  // the caller (main.js), since the approval decision itself (director looks at a
  // name, clicks approve/deny) is transport-independent; the decision function
  // that runs FIRST (evaluatePairingRequest, electron/auth/connectionAuth.js) is
  // this module's own concern.
  //
  // _Prior: the callback was described as "the SAME director-approval callback
  // already wired to the WS transport's `onPairingRequest` (startSyncServer's
  // option)", and evaluatePairingRequest as "shared with syncServer.js". The WS
  // transport and startSyncServer were deleted at the Stage 6c cutover, so this
  // is now the only caller of either._
  async function onPairingRequestMsg(msg) {
    // Join-code proof (docs/adr/2026-09-08-libp2p-join-flow.md §5). A request
    // carrying a `join_nonce` is a first-join over the join-discovery tag, and
    // that tag is broadcast in the clear — so the nonce's proof is the only
    // thing separating the real joining device from anyone who mirrored the
    // tag. Verified BEFORE evaluatePairingRequest so a mirrored-tag peer never
    // reaches the director's screen at all.

    // Every real pairing request carries a code proof (joinSession.js always sends one). A
    // nonce-less request is refused outright: it would otherwise reach evaluatePairingRequest
    // without proving anything, and learn from the answer whether a device id is known, revoked,
    // or already approved (the stored secret was re-delivered to it).
    if (typeof msg.join_nonce !== 'string') return { ok: false, reason: 'code_proof_required' }
    let joinConfirm = null
    {
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
      // T286 — the join secret is Host-minted and window-scoped (never derived
      // from campId; see joinCode.js's module comment), so this module has no
      // way to compute it itself. `getJoinSecret` is the seam main.js's
      // getJoinCode/setJoinWindow lifecycle feeds through (mirrors
      // isJoinWindowOpen's own injection immediately above). No secret
      // available — window never opened, already closed, or the caller simply
      // doesn't wire one — means no proof can ever verify, which is the
      // correct fail-closed default for a value that IS the security boundary
      // (unlike isJoinWindowOpen, which is consent-only and fails open).
      const code = getJoinSecret ? getJoinSecret() : null
      if (!code || !verifyJoinProof(code, msg.join_nonce, 'joiner', msg.join_proof)) {
        return { ok: false, reason: 'bad_join_proof' }
      }
      joinConfirm = joinProof(code, msg.join_nonce, 'host')
    }

    // Pair again rides only on a code-proven request: a reconnecting peer cannot claim it.
    const rejoin = msg.rejoin === true
    const ownCampId = rejoin ? db.prepare('SELECT id FROM camps LIMIT 1').get()?.id : null
    const sameCamp = Boolean(ownCampId && typeof msg.camp_proof === 'string' && msg.camp_proof === rejoinCampProof(getJoinSecret(), ownCampId))
    const result = evaluatePairingRequest(db, {
      device_id: msg.device_id,
      device_name: msg.device_name,
      rejoin,
      sameCamp,
      schemaCompatible: !rejoin || isSyncCompatible(msg.schema_version, localSchemaVersion),
    })
    if (result.reason === 'schema_mismatch') return { ...result, joinConfirm, hostSchemaVersion: localSchemaVersion }
    if (result.ok && !result.alreadyApproved && typeof onPairingRequest === 'function') {
      onPairingRequest(msg.device_id, msg.device_name)
    }
    return joinConfirm ? { ...result, joinConfirm } : result
  }

  // Stage 5d-2b: device-secret + PIN/lockout via evaluateLogin
  // (electron/auth/connectionAuth.js). _Prior: "shared with syncServer.js's
  // `login` handling" — that file was deleted at the Stage 6c cutover, so this is
  // evaluateLogin's only caller._
  async function onLogin(msg, { fromPeerId }) {
    // `hostDeviceId` is THIS node's own device id — the one it will present in
    // its `authenticate` frames — so a joining device can record it as trusted
    // locally. Taken from the node rather than the database because that is
    // what the peer will actually see.
    //
    // Found by the integration harness, and a real defect rather than a
    // fixture gap: evaluateAuthenticate re-checks the RECEIVING side's own
    // `devices` row for the peer and admits only an AUTHORIZED one, inserting
    // a 'pending' row for an unknown peer and then refusing it. A joined
    // device with no row for its Host therefore syncs for the length of the
    // join (admitPeer bootstraps that session) and never again after a
    // restart, in one direction, with nothing logged on either side. Every
    // earlier test seeded this row by hand, which is why nothing caught it.
    // T162: peerId binding now happens INSIDE evaluateLogin
    // (bindOrVerifyPeerIdentity), same reasoning as onAuthenticate above.
    const result = evaluateLogin(db, {
      device_id: msg.device_id,
      device_secret_identifier: msg.device_secret_identifier,
      name: msg.name,
      pin: msg.pin,
      peerId: fromPeerId,
    })
    // T271 round 3: this Host's own schema version, relayed to the joining device via the
    // `login_ok` reply (authGate.js) — the ONLY way that device ever learns it. A first-joining
    // device's node.admitPeer(hostPeerId) (joinSession.js) admits the Host WITHOUT ever processing
    // an inbound `authenticate` message from it (the Host cannot authenticate back before the
    // document — carrying its signing key — has arrived), so onAuthenticate's normal
    // peerSchemaVersions recording never runs for this direction. joinSession.js records this value
    // manually (node.recordPeerSchemaVersion) at the same point it calls admitPeer.
    // The camp's verified purge tombstones travel with the login reply, so a device re-pairing after
    // being offline through a purge can apply them to its own document BEFORE it merges (Pair again).
    const tombstones = result.ok ? db.prepare('SELECT id, entity, version, sig FROM tombstones').all() : []
    return result.ok ? { ...result, hostDeviceId: deviceId, hostSchemaVersion: getHandshakeSchemaVersion(), tombstones } : result
  }

  // The planned host handoff (docs/adr/2026-10-09-host-succession-simple.md). `transport` is assigned
  // just below; the wire only reaches it through these closures, after the node is up.
  const handoffService = createHostHandoff({
    db,
    deviceId,
    getDeviceIdentity: () => ensureDeviceIdentity(db),
    relaunch: relaunch ?? (() => {}),
  })
  handoffService.recoverOnStartup()
  const handoffWire = createHandoffWire({
    db,
    service: handoffService,
    sendHandoff: (peerId, msg) => transport.sendHandoff(peerId, msg),
    isPeerOnLan: (peerId) => transport.isPeerOnLan(peerId),
    listAdmittedPeers: () => [...peerDeviceIds].filter(([peerId]) => transport.isPeerAuthenticated(peerId)),
    retryMs: handoffRetryMs,
    onChanged: onHandoffChanged,
  })

  // The Host advertises the code-derived join tag only while Add-a-device is open
  // (joinTagDiscovery.js). Only a node that can hold a join secret (the Host) gets one;
  // the joining device's own node (joinSession.js) passes no getJoinSecret.
  const joinTag = getJoinSecret ? createJoinTagAdvertiser(joinDiscoveryFor ? { discoveryFor: joinDiscoveryFor } : {}) : null
  if (joinTag) peerDiscovery = [...(peerDiscovery ?? []), joinTag.factory]

  const transport = await startTransport({
    listen,
    deviceId,
    privateKey: deviceIdentityPrivateKey,
    onDocReceived: handleReceived,
    onSyncMessageReceived: handleSyncMessage,
    onHandoffMessage: handoffWire.inbound,
    handoffFaults,
    schemaVersion: getHandshakeSchemaVersion(),
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
      // T271 round 3: do NOT pre-seed syncStates here — stepSync itself lazily initializes
      // (`syncStates.get(peerId) ?? A.initSyncState()`) only when it actually proceeds. Seeding it
      // here unconditionally, before stepSync's own compatibility check runs, would create sync
      // state for an incompatible peer regardless of what stepSync decides — exactly the bookkeeping
      // hole the ADR's round-3 revision calls out ("no sync state is created or advanced for an
      // incompatible peer, so there is nothing for it to be marked caught up on").
      stepSync(peerId)
      notifyPeersChanged()
      // A handoff left half-done by a restart resumes the moment its counterpart is reachable again.
      handoffWire.api.contactPeer(peerId).catch(() => {})
      // T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md): remember this
      // peer's observed address, keyed to its (now-authenticated) peer id, for a future direct
      // reconnect attempt before discovery — see redialTrustedPeers below and
      // peerAddressBook.js. Best-effort and never fatal: a failure here must not un-admit a
      // peer that already passed the real admission gate.
      try {
        const addr = transport.remoteAddrFor(peerId)
        if (addr) rememberPeerAddress(db, peerId, addr)
      } catch (err) {
        console.error(`syncNode: failed to remember peer address for ${peerId} (non-fatal): ${err?.message ?? err}`)
      }
      // T348: the punched session that led to this admission, if any, is remembered only now.
      try {
        onPunchPeerAdmitted?.(peerId)
      } catch (err) {
        console.error(`syncNode: failed to remember punch session for ${peerId} (non-fatal): ${err?.message ?? err}`)
      }
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
    // T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md): the camp-peer
    // circuit-relay-v2 coordination capability, gated behind SHORESH_RELAY_ENABLED (default
    // false — see syncStarter.js) and the `relay` capability's signoff (transportCapabilities.js,
    // currently null). Omitted by every caller that doesn't pass it (every existing test, and
    // production while the flag is unset), so this is byte-identical to pre-T337 behavior
    // until BOTH the flag is set AND the capability is signed off.
    relayServerFactory,
    relayTransportFactory,
    // T336 — same gating discipline as relayServerFactory/relayTransportFactory immediately above:
    // omitted by every caller that doesn't pass it, byte-identical to pre-T336 behavior until the
    // same relay-eligibility gate (syncStarter.js) opens.
    directUpgradeServiceFactory,
    // T347 (S1) — the ICE data-channel transport; same omitted-by-default discipline as above.
    punchTransportFactory,
    // T336 Precondition 3 — a direct passthrough to transport.js, same discipline as
    // onPairingRequest/onLogin above (a plain caller-supplied callback, not a listener registry
    // like onPeersChanged below): syncStarter.js is the only real caller and reports this straight
    // to pushSyncStatus, so there is exactly one subscriber and no need for the registry machinery
    // onPeersChanged exists for (multiple potential subscribers across this module's lifetime).
    onRelayReservationRefused,
  })

  // Discard this peer's sync progress the moment the connection is gone (see syncStates' own
  // comment above for why this is correct rather than merely tidy). peerSchemaVersions is cleared
  // the same way, same reasoning, same lifecycle (T271 round 3) — a reconnecting peer re-runs
  // `authenticate` and its version is recorded fresh, so a stale entry here would only ever be
  // wrong, never merely stale-but-harmless.
  transport.onPeerDisconnected((peerId) => {
    syncStates.delete(peerId)
    peerSchemaVersions.delete(peerId)
    peerDeviceIds.delete(peerId)
    pendingVersionReset.delete(peerId)
    notifyPeersChanged()
  })

  // Stage 5d-2b production wiring: this is what turns "nothing calls
  // authenticateWith outside tests" into a real running node. Only fires at
  // all once a token exists (`setAuthToken` below) — until then a
  // discovered peer is simply not dialed, matching mutualAuth.js's own
  // documented behavior for the not-logged-in-yet case. `peerDiscovery`
  // being unset (every existing test, and any caller that dials directly)
  // means `onPeerDiscovery` never fires, so this is a pure no-op for them.
  // T208 (docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md). The
  // default `isPeerTrusted` is now a real check: createBoundPeerTrust(db) (peerIdentity.js)
  // trusts a discovered peer id only when it is bound (bindOrVerifyPeerIdentity's
  // TOFU bind, on the admission path) to a `devices` row that is authorized and not
  // revoked. This replaces the earlier `lanTopologyTrust` stub (`() => true`), which
  // trusted every mDNS-discovered peer and relied solely on multicast being
  // link-local for its safety.
  //
  // WHY DENY-BY-DEFAULT AT THIS SEAM DOES NOT BREAK JOIN. First contact never goes
  // through this predicate: joinSession.js's login() dials the Host directly
  // (`node.authenticateWith(hostPeerId, ...)`), records the Host's peer id
  // (`recordLibp2pPeerId`) and calls `node.admitPeer(hostPeerId)` itself — all before
  // this device has ever run `wireMutualAuth`'s discovery-driven dial against the
  // Host. By the time mDNS discovery re-announces the Host later, the Host's peer id
  // is already bound and authorized, so createBoundPeerTrust admits it. T162 made
  // peer ids stable across restarts, which is the precondition this needed — before
  // T162, a restart minted a fresh peer id and a bound-peer-id check would have
  // rejected every legitimate device after any restart.
  //
  // RESIDUAL: this seam still does not, and was never able to, establish direct
  // client-to-client sync — but NOT because a client "has no devices row" for another
  // client. connectionAuth.js's evaluateAuthenticate self-registers a `pairing_status:
  // 'pending'` `devices` row for ANY device id presenting a valid camp/device-type
  // session token (INSERT OR IGNORE, unconditional on authorization), so a second
  // client authenticating against a client DOES get a row. What actually blocks it is
  // that the self-registered row has `authorized_at` unset, so deviceTrustStatus
  // reports `authorized: false` and createBoundPeerTrust denies it — and this holds
  // symmetrically on both sides, so in practice neither client ever gets far enough to
  // dial the other in the first place: wireMutualAuth runs the identical predicate on
  // every node, so client A's createBoundPeerTrust(peerB) and client B's
  // createBoundPeerTrust(peerA) both return false before either token is sent. That
  // symmetry, not the absence of a row, is why this limitation predates T208 and is
  // unchanged by it.
  let authToken = null
  // T212 (docs/work/tickets/T212-wan-connectivity-measurement.md): the env read is deliberately
  // HERE, not inside connectivityEvents.js or mutualAuth.js — both stay dependency-free and
  // unit-testable with an injected emitter. Default (unset) keeps addresses classified, never
  // literal, in shipped behavior; an operator running the WAN test matrix by hand opts in.
  const emitter = createConnectivityEmitter({ verboseAddrs: process.env.SHORESH_CONNECTIVITY_LOG_ADDRS === '1' })
  // T322 S3a: this device's own self-report, read fresh on every dial/authenticate attempt
  // (mutualAuth.js's own discipline for getSchemaVersion) — `tombstones` is this device's set of
  // verified-and-projected purge tombstones, exactly the fact a peer's onAuthenticate persists
  // into ITS OWN peer_tombstone_reports about THIS device.
  const getAppliedTombstones = () => db.prepare('SELECT id, version FROM tombstones').all()
  // T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md): attempt a direct dial
  // to every currently-trusted peer's remembered address BEFORE wireMutualAuth below wires up
  // discovery-driven dialing (mDNS/rendezvous) — a reconnect to a still-reachable peer no longer
  // depends on mDNS being on the same segment. Idempotent (skips a peer transport.getPeers()
  // already reports connected) and fire-and-forget: a slow or failed dial must never delay
  // startup or block wiring discovery. Each attempt's own failure handling (including the
  // stale-address-safety case) lives in redialTrustedPeers/peerAddressBook.js.
  redialTrustedPeers(db, {
    dial: transport.dial,
    isConnected: (peerId) => transport.getPeers().includes(peerId),
  }).catch((err) => {
    console.error(`syncNode: redialTrustedPeers failed (non-fatal, discovery still proceeds): ${err?.message ?? err}`)
  })
  wireMutualAuth(
    { dial: transport.dial, authenticateWith: transport.authenticateWith, onPeerDiscovery: transport.onPeerDiscovery },
    { deviceId, getToken: () => authToken, onRejected: onAuthRejected, isPeerTrusted: isPeerTrusted ?? createBoundPeerTrust(db), emitter, getSchemaVersion: getHandshakeSchemaVersion, getAppliedTombstones }
  )

  return {
    peerId: transport.peerId,
    libp2pNode: transport.libp2pNode,
    getPeers: transport.getPeers,
    getMultiaddrs: transport.getMultiaddrs,
    dial: transport.dial,
    authenticateWith: transport.authenticateWith,
    isPeerAuthenticated: transport.isPeerAuthenticated,
    // First-join trust bootstrap — see transport.js's admitPeer comment. Only
    // joinSession.js calls this, and only right after logging in to that peer.
    // Security control — see transport.js. main.js calls this when a director
    // revokes a device, so a still-connected peer stops being admitted at once
    // rather than when it next drops.
    revokePeer: transport.revokePeer,
    admitPeer: transport.admitPeer,
    // T271 round 3: manual counterpart to onAuthenticate's normal peerSchemaVersions recording, for
    // the one admission path that bypasses onAuthenticate entirely — a joining device's
    // admitPeer(hostPeerId) (joinSession.js), which cannot rely on processing an inbound
    // `authenticate` FROM the Host (see onLogin's comment above for why). `version` of
    // null/non-numeric is recorded as `null`/incompatible, same fail-closed handling as everywhere
    // else this value is read.
    recordPeerSchemaVersion: (peerId, version) => {
      peerSchemaVersions.set(String(peerId), typeof version === 'number' ? version : null)
    },
    sendPairingApproved: transport.sendPairingApproved,
    sendPairingDenied: transport.sendPairingDenied,
    onPeerDiscovery: transport.onPeerDiscovery,
    // Fires when this device's reachable-peer set changes (admission or
    // disconnect). main.js pushes a fresh sync status to the renderer from it.
    onPeersChanged: (cb) => { peersChangedListeners.push(cb) },
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
    // Read-only: true once this device holds every change `peerId` last advertised (its heads from
    // the sync exchange). Pair again settles deletes only then, never on a partial delivery.
    isCaughtUpWith: (peerId) => {
      const theirHeads = syncStates.get(peerId)?.theirHeads
      return Array.isArray(theirHeads) && A.getMissingDeps(getCurrentDoc(db), theirHeads).length === 0
    },
    // T271 round 3 test-only accessor (docs/adr/2026-09-26-schema-version-gate-before-merge.md,
    // Verification item 2): a byte snapshot of `peerId`'s current sync state (null if none exists
    // yet), for a test to capture BEFORE and AFTER a refused exchange and assert byte-for-byte
    // equality — proving the bookkeeping was left exactly as untouched as no attempt at all, not
    // merely that no message was applied. Not used by any production code path.
    getSyncStateBytesForTest: (peerId) => {
      const state = syncStates.get(peerId)
      return state ? A.encodeSyncState(state) : null
    },
    // Direct test/adversarial-scenario API: apply an already-changed doc (via the caller's own
    // A.change/applyWrite), project it locally, and broadcast the new bytes to every connected
    // peer. NOT the production local-write path — that's liveDoc.recordLocalWrite, which only
    // updates the shared doc and debounces a broadcast (see broadcastLocalDoc below); calling
    // projectAll per field-op here would be the "full delete-reconcile on every keystroke"
    // performance trap Stage 5f deliberately avoids for real local writes.
    applyLocal: async (newDoc) => {
      // A local write cannot create a conflict on its own, but the document it
      // is built on may already carry one — and projectAll now refuses a
      // document with an unrecorded conflict. Reconciling here keeps that
      // assertion a guard against a missing code path rather than something a
      // legitimate local edit can trip over.
      const doc = reconcileForProjection(newDoc)
      setCurrentDoc(db, doc)
      try {
        projectAll(db, doc)
        tearDownRevokedConnectedPeers()
        runRendezvousRotation(db, { deviceId, broadcast: null })
        onProjected?.(doc)
      } catch (err) {
        onProjectionError?.(err, doc, null)
        console.error(`syncNode: local projection failed — SQLite left at last-good: ${err?.message ?? err}`)
      }
      // Propagate via the SYNC PROTOCOL, not a whole-document push.
      //
      // This used to be `transport.broadcastDoc(A.save(newDoc))`, which is the
      // mechanism Stage 5 already found and documented as not reliably
      // deliverable: a frame the peer's admission gate rejects does not throw
      // on the sender, so a push can vanish with nothing observable on either
      // side. Stage 5f removed it from initial-sync for exactly that reason and
      // replaced it with generateSyncMessage/receiveSyncMessage — but left it
      // here, where it stayed invisible because in-process tests wrote from one
      // device at a time.
      //
      // The integration harness made it visible: scenario 08 (two clients each
      // writing a different field of the same activity) lost the second write
      // ~80% of the time, with both clients connected, admitted, and healthy.
      // Using the same acknowledged, incremental exchange the rest of this
      // module uses makes the two write paths — this one and broadcastLocalDoc
      // — the same mechanism, which is the point: there is no longer a second,
      // weaker way for a local write to reach a peer.
      syncAllAuthenticatedPeers()
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
    broadcastLocalDoc: async () => syncAllAuthenticatedPeers(),
    handoff: handoffWire.api,
    sendHandoff: transport.sendHandoff,
    // main.js's setJoinWindow: the live code while Add-a-device is open, null when it closes.
    setJoinCode: (code) => joinTag?.setCode(code) ?? Promise.resolve(),
    stop: async () => {
      handoffWire.stop()
      return transport.stop()
    },
  }
}
