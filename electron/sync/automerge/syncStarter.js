// T276 — extracted out of main.js's `!process.env.VITEST`-gated
// isElectronEntryPoint() block so `startAutomergeSyncNodeIfEnabled` (here,
// `start()`) is importable and executable under Vitest. Before this
// extraction the function's TOCTOU latch and funnel guard could only be
// asserted on AST shape (mainSyncStartupWiring.test.js) — a regression that
// kept the shape (statement present, in a finally) while breaking the
// behaviour (wrapping either latch statement in a conditional) would still
// pass. See docs/work/tickets/T276-extract-sync-starter-for-executed-tests.md
// and memory note feedback_guard_the_choke_point_not_the_instance.
//
// This is a testability extraction, not a logic change: the body below is
// `startAutomergeSyncNodeIfEnabled` moved verbatim, with only `mainWindow` →
// `getMainWindow()`, `liveHandlers` → `getLiveHandlers()` (a getter is
// required — liveHandlers is reassigned by main.js's registerHandlers after
// this factory is constructed, so a captured value would go stale), and the
// dynamic `import('./syncNode.js')` made overridable via `startSyncNodeImpl`
// for tests.
import fs from 'node:fs'
import { isAutomergeEngine } from './syncEngineFlag.js'
import { migrationSpanFor } from '../../db/localDb.js'
import {
  resolvePendingDomainStateMigrations,
  syncRefusalForDomainMigration,
} from '../../db/migrationDomainState.js'
import * as Automerge from '@automerge/automerge'
import {
  getDocIfLoaded,
  ensureSeeded as ensureAutomergeDocSeeded,
  setLocalWriteBroadcaster as setAutomergeLocalWriteBroadcaster,
  setCurrentDoc as setCurrentAutomergeDoc,
} from './liveDoc.js'
import { loadDoc as loadAutomergeDoc, docPath as automergeDocPath } from './docStore.js'
import { resolveStartupDoc, dispatchRemoteOps, REMOTE_OPS_COALESCE_THRESHOLD } from './startupGuard.js'
import { createMdnsDiscovery, rotatingServiceTag } from './discovery.js'
import { mintRendezvousNamespace } from './rendezvousNamespace.js'
import { createVerifiedEntryTrust } from '../../automerge/authorityReplay.js'
import { readRendezvousConfig, createRendezvousDiscovery } from './rendezvousClient.js'
import { nextSequence } from './rendezvousSequence.js'
// NAMING WARNING (gate-fix round 3, Code Reviewer MEDIUM): do not rename either import below to
// name the hole-punch capability's own package/marker strings — transportBoundary.guard.test.js
// scans THIS file's source text for every still-blocked capability's forbidden markers, and this
// file has no legitimate reason to spell either one out literally. See relayEnablement.js's own
// naming-warning comment for the full reasoning (and what happened the one time this file did).
import { relayRuntimeEligible, holePunchFoundationPresent } from './relayEnablement.js'
import { punchRuntimeEligible, punchNativeLoadable } from './punchEnablement.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { recordAuditEvent } from '../../audit/auditLog.js'
import { issueDeviceToken } from '../../auth/localAuth.js'
import { recordDeviceHealthEvent, DEVICE_HEALTH } from '../../ops/deviceHealthEvents.js'
import { codeForAuthRejectedReason } from '../../authRejectedSender.js'
// sanitizeOpForIpc is defined in main.js (the sole exporter). This creates a
// circular import (main.js -> syncStarter.js -> main.js), which ESM tolerates
// here: sanitizeOpForIpc is a hoisted function declaration, never called at
// either module's top level, and only invoked once start() actually runs —
// long after both modules have finished initializing.
import { sanitizeOpForIpc } from '../../main.js'

// T335 gate finding (Security/Red Hat HIGH, round 2) — exported so the production wiring is
// directly testable without going through the whole start() sequence or a real libp2p node.
// Before this fix, syncStarter.js called `rotatingServiceTag(Automerge, doc, campId)` with NO
// opts, so currentRevokedDeviceIds fell through to its always-true default: the LIVE mDNS tag was
// computed over UNVERIFIED revoke entries, reopening the T329-F1 forgery class (an
// attacker-controlled synced peer could inject an unsigned kind:'revoke' entry and move the
// discovery tag network-wide). `createVerifiedEntryTrust` (authorityReplay.js) is the SAME
// signature-gate projector.js's own SQLite projection already relies on — one verification, not a
// second, looser one for discovery.
export function computeRotatingServiceTag(doc, campId) {
  const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc)
  return rotatingServiceTag(Automerge, doc, campId, { isEntryTrusted })
}

export function createAutomergeSyncStarter({
  deviceId,
  db,
  userDataPath,
  docCipher,
  getMainWindow,
  getLiveHandlers,
  startSyncNodeImpl,
  punchSignaling,
}) {
  // T347 (S1): set only when the punch transport was actually wired, so quit can tear down its
  // native state and an unwired build never loads the module.
  let punchModule = null
  // Declared here (ahead of automergeSyncNode's own definition further down)
  // so makeHandlers' chooseMode/login closures can reach whatever node is
  // running by the time THEY run, without makeHandlers needing to know
  // anything about libp2p/Automerge itself — same "handed a getter, not the
  // implementation" shape as getMainWindow above.
  let automergeSyncNode = null
  // T274 round 2 (Red Hat, MEDIUM): `if (automergeSyncNode) return` alone is
  // a TOCTOU race — it is checked synchronously, but `automergeSyncNode` is
  // not assigned until AFTER `await startSyncNode(...)` resolves, several
  // awaits later in the same function. Two concurrent calls (a join
  // completing while app.whenReady()'s own call is still in flight, an IPC
  // retry, a re-render) can both read `automergeSyncNode` as null and both
  // reach `startSyncNode`, producing two real libp2p nodes on this device's
  // one peer identity. This latch is set synchronously, before the first
  // await, so the second call's guard sees it immediately; cleared in
  // `finally` so a failed attempt can be retried. Also hardens the merged
  // T273 bootstrap path, which calls this same function.
  let automergeSyncNodeStarting = false
  // T268 — has a start() attempt finished (success, refusal, or failure)
  // since this process started? getSyncStatus reads this to decide between
  // "not yet attempted, so still read as 'host'" (avoids a boot flicker: the
  // node starts asynchronously after app.whenReady()) and "attempted and no
  // node is running, so 'host-not-syncing'". Set true on every exit path of
  // that function, never reset — a single process only ever attempts startup
  // once (the idempotency guard inside it prevents a second real attempt).
  let automergeStartupAttempted = false
  // T336 Precondition 3 — the most recent relay-reservation refusal this device's own transport
  // has observed, if any. getSyncStatus reads this via getRelayReservationRefused() the same way
  // it reads automergeStartupAttempted above: a plain in-memory flag, not persisted, because it
  // describes a live transport condition that resolves itself once a slot frees up — a director
  // reopening the app after a restart with no camps near capacity should not see a stale warning.
  let relayReservationRefused = null

  // A director approving or denying a pairing request doesn't know or care
  // how the request arrived. startSyncNode's onPairingRequest (below)
  // forwards to this one renderer IPC event.
  function notifyPairingRequest(deviceId_req, deviceName_req) {
    const mainWindow = getMainWindow()
    if (mainWindow) mainWindow.webContents.send('shoresh:pairing-request', { deviceId: deviceId_req, deviceName: deviceName_req })
  }

  // Stage 5c (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 2, § 3, § 5): read/receive-
  // path wiring for the flagged (SHORESH_SYNC_ENGINE=automerge) sync engine. Entirely inert when the
  // flag is off (isAutomergeEngine() is the ONLY gate — no branch below runs a single line of
  // libp2p/Automerge work otherwise). `startSyncNode` (electron/sync/automerge/syncNode.js) is
  // reached via a dynamic import() rather than a static one: it's the one module in this chain that
  // pulls in transport.js's libp2p dependency graph, which is all-ESM and heavy — a static import
  // would load it into every process regardless of the flag, defeating the point of gating.
  //
  // Stage 5e (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 5): seed-on-first-enable.
  // ensureAutomergeDocSeeded (liveDoc.js) seeds a fresh doc from this camp's CURRENT SQLite rows
  // and persists it immediately when no doc file exists yet, or loads the persisted one otherwise —
  // never a bare empty doc. It is order-independent with any write the renderer might already have
  // triggered before this function runs on THIS launch: liveDoc's seed-on-first-touch (its own
  // getDoc) is idempotent per camp per process, so whichever of "a write arrives" or "startup calls
  // this" happens first is the one that seeds, and the other sees the already-cached/persisted doc.
  //

  // Stage 5d-2b (docs/adr/2026-09-06-libp2p-membership-mapping.md §3): `peerDiscovery`
  // (camp-scoped mDNS, Stage 5d-2a's createMdnsDiscovery) and `onPairingRequest` (the SAME
  // director-approval IPC forwarder chooseMode's host branch already wires into the WS
  // transport's startSyncServer) are threaded through so the node actually authenticates on a
  // real LAN, instead of sitting there with authenticateWith wired up but nothing ever calling
  // it — the exact silent-failure gap this slice closes. `onAuthRejected` routes a legitimately-
  // paired device's rejected authenticate onto the SAME audit log evaluateAuthenticate's own
  // deny path already writes to (Red Hat finding on 5d-1: a console.error alone is not a
  // sufficiently surfaced signal) — see auditLog usage below.
  async function start() {
    // T268 round 2 (Finding 1): both early returns above are safe to leave
    // exempt from the `attempted` bookkeeping below, because getSyncStatus's
    // own condition (`!isAutomergeEngine() || getAutomergeNode() != null ||
    // !getAutomergeStartupAttemptedFn()`) short-circuits on the first two
    // clauses before ever consulting the flag — the engine-off and
    // already-running cases read as healthy regardless of what the flag says.
    if (!isAutomergeEngine()) return
    if (automergeSyncNode) return // idempotency guard: never leak a second libp2p node
    // T274 final — the one-funnel guard. Three rounds each closed the
    // double-identity class one CALLER at a time (joinAwaitData, joinCancel,
    // the joinStart auto-cancel), and Red Hat found a fourth: a temp join
    // node retained after a failed stop (joinCancel's own comment), left
    // live by a director backing out of the join screen, then bootstrapCamp
    // firing onCampBootstrapped UNCONDITIONALLY — bootstrapCamp never checked
    // activeJoin, because it has no way to see it. Rather than teach a
    // fourth (and every future) caller about join state, the invariant now
    // lives at the one place every caller already funnels through: every
    // path that starts the PERSISTENT node — onCampBootstrapped,
    // onCampJoined, app.whenReady() — calls this function and nothing else
    // ever calls startSyncNode for it (verified: the only other
    // `startSyncNode(` call site in main.js is joinSession's OWN temporary
    // node, a different function entirely). `liveHandlers` is the same
    // main-process-scope handle `isJoinWindowOpen` below already reads this
    // way — no getter needed beyond the one added to makeHandlers' return
    // object. Null on every path that must NOT be blocked (before any join;
    // after a successful join, which nulls `activeJoin` before firing
    // onCampJoined — see joinAwaitData); non-null only while a join is
    // genuinely still live or stuck-retained, which is exactly when a
    // second, persistent node on this device's same peer identity must not
    // start. Accepted trade: a stuck-retained session means the persistent
    // node stays off until restart (safe-degraded, same posture as every
    // other guard in this function) rather than risk the double node.
    if (getLiveHandlers()?.hasRetainedJoinSession?.()) {
      console.warn('automerge sync: a join session is still live or retained — sync node not started this run (resolves once it is stopped, or on restart)')
      return
    }
    // T274 round 2: the TOCTOU latch (see its declaration above). Checked and
    // set synchronously, in the same tick as the guard above — no await has
    // happened yet, so a concurrent call arriving before this one reaches its
    // own `await startSyncNode(...)` is guaranteed to see it set.
    if (automergeSyncNodeStarting) return
    automergeSyncNodeStarting = true
    // `attempted` tracks whether this run reached a point where a start could
    // actually have happened — distinct from "did this function run". A
    // fresh install has no camp yet at app.whenReady() (bootstrapCamp itself
    // requires a mode to already be chosen, so a first run can never have a
    // camp this early), and that is not a start attempt that could have
    // failed — it's "there was nothing to start yet". Starts `true`; the
    // no-camp-yet path below is the only one that flips it to `false`, so
    // getSyncStatus keeps reading a fresh Host as plain 'host' through its
    // first session instead of a false 'host-not-syncing' that nothing will
    // ever clear (nothing calls this function again after bootstrap).
    let attempted = true
    try {
      const campId = db.prepare('SELECT id FROM camps LIMIT 1').get()?.id ?? null
      if (!campId) {
        console.warn('automerge sync: no camp bootstrapped yet — sync node not started this run')
        attempted = false
        return
      }

      // Finding 1 (review round on Stage 5c, CRITICAL — data destruction): projectAll's
      // delete-reconcile treats the doc as an authoritative superset of SQLite (projector.js's own
      // CAUTION comment). ensureAutomergeDocSeeded (liveDoc.js) closes that gap: no doc file yet
      // for this camp means it seeds one from SQLite right now, synchronously, and persists it
      // before returning — so by the time resolveStartupDoc runs, a doc that is safe to project
      // against always exists for a bootstrapped camp. resolveStartupDoc (startupGuard.js) still
      // NEVER fabricates a doc itself (that contract is unchanged and unrelaxed) — it only resolves
      // between liveDoc's in-memory copy and the persisted file, both of which are now guaranteed
      // to exist because of the ensureSeeded call directly above it.
      // A DOMAIN-STATE MIGRATION RAN ON A LAUNCH WHERE A DOCUMENT ALREADY
      // EXISTS (migrationDomainState.js). SQLite now holds camp meaning the
      // document does not, and the document is the authority — so the next
      // merge's delete-reconcile would quietly undo the migration.
      //
      // Refuse to sync rather than replicate into that. The device keeps
      // working on its own, which is the whole point of local-first; what it
      // will not do is exchange state it is about to lose. Auto-repair is
      // deliberately not attempted: re-seeding the document from SQLite would
      // resurrect every tombstone the document holds and SQLite does not.
      //
      // Unreachable today by construction — every domain-state migration is
      // below v52, and a database with a document is already at v57+ — which is
      // exactly why it is cheap to put the guard in before it is needed.
      // T205 part D: TWO signals, not one. migrationSpanFor only reports the
      // launch that actually RAN a migration (its WeakMap is per-process, so
      // the next launch has from===to and reports nothing risky) — that was
      // the one-launch-only defect: a plain restart silently re-enabled sync
      // against a document that still held the rows a migration deleted.
      // unresolvedDomainStateMigrations reads a DURABLE marker instead, so
      // this refuses on every subsequent launch too, until something resolves
      // it by republishing the reconciled state through the document (no
      // auto-repair — see migrationDomainState.js's header).
      // migrationSpanFor kept here (not just inside the shared helper) because
      // the audit event's metadata.from/to wants the raw span, not just the
      // versions it produced.
      const migrationSpan = migrationSpanFor(db)
      // Checked BEFORE ensureAutomergeDocSeeded below (which creates the file
      // when missing) — this must stay "did a document already exist before
      // this launch touched anything", not "does one exist now".
      const docExists = fs.existsSync(automergeDocPath(userDataPath, campId))

      // T205 round 2, FIX 2: resolve BEFORE deciding to refuse, not after —
      // ensureAutomergeDocSeeded guarantees a document is available (seeded
      // fresh from current, already-migrated SQLite when none existed yet, or
      // loaded from disk otherwise), which is what resolvePendingDomainStateMigrations
      // needs to author a document-routed tombstone for each recorded loser id
      // (electron/db/migrationDomainState.js). Idempotent and safe to call on
      // every launch: a no-op when nothing is pending, and a retry (not a
      // permanent no-op) when a prior launch's resolve attempt didn't complete.
      // This is what turns "refuses forever" into "refuses until it can
      // reconcile, then resumes" — the SAME launch that resolves it, or a
      // later one.
      ensureAutomergeDocSeeded(db)
      resolvePendingDomainStateMigrations(db, { device_id: deviceId })

      // T268: the assembly (migrationSpanFor + unresolvedDomainStateMigrations +
      // shouldRefuseSyncForDomainMigration + the detail string) is now ONE
      // shared helper, also used read-only by getSyncStatus, so the two
      // readings of "is sync refused right now" cannot drift apart.
      const refusal = syncRefusalForDomainMigration(db, { docExists })

      if (refusal) {
        console.error(
          `automerge sync: NOT starting. A domain-state migration ran against a camp that already has a ` +
            `document (or is still unresolved from a prior launch): ${refusal.detail}. SQLite now holds camp meaning ` +
            `the document does not, and projecting the document would undo it. See electron/db/migrationDomainState.js.`
        )
        recordAuditEvent(db, {
          actorUserId: null,
          deviceId: null,
          action: 'sync.blocked_by_domain_migration',
          targetType: 'document',
          targetId: campId,
          outcome: 'deny',
          reason: refusal.detail,
          metadata: { from: migrationSpan?.from ?? null, to: migrationSpan?.to ?? null, versions: refusal.versions },
        })
        return
      }

      let doc = resolveStartupDoc({
        liveDoc: getDocIfLoaded(db),
        // Same cipher liveDoc was given above — this direct read is the second of the three
        // .automerge readers (assessment finding B), and all three must agree or an encrypted file
        // fails to load. docCipher is null when encryption is off (plaintext, unchanged).
        persistedDoc: loadAutomergeDoc(userDataPath, campId, docCipher),
      })
      if (!doc) {
        // Defense in depth, not the expected path: ensureAutomergeDocSeeded only returns null when
        // userDataDir isn't configured (can't happen here — set unconditionally above) or campId is
        // null (already checked above). Kept as a refusal, never a fallback to createEmptyDoc().
        console.warn(
          'automerge sync: no persisted document exists yet for this camp — sync node not started ' +
            'this run. Seeding (electron/sync/automerge/liveDoc.js ensureSeeded) did not produce a ' +
            'doc; starting anyway would risk deleting live data via projectAll\'s delete-reconcile.'
        )
        return
      }

      // Stage 5f: NO initial projection here (removed — was `projectAutomergeDoc(db, doc)`, see
      // docs/work/plans/2026-09-06-stage5-live-wiring-design.md §5's revision). At startup, SQLite
      // is ALREADY correct: it was built by this device's own committed writes (appendOp writes
      // SQLite and the document together) and, for any camp that has already synced, by prior
      // remote-merge projections that already landed via syncNode.handleReceived. Projecting `doc`
      // over an already-correct SQLite can only ever be a no-op (doc and SQLite agree) or
      // destructive (delete-reconcile removes a row SQLite has that `doc` is missing — exactly the
      // confirmed (c) defect: a persisted doc that lagged a remote merge by up to
      // SAVE_DEBOUNCE_MS, or across a whole prior session before Stage 5f's unification, silently
      // deleted live data on the next restart). It can never ADD correct information that SQLite
      // doesn't already have. Projection is genuinely needed only when a REMOTE merge brings new
      // state — handleReceived already does that, every time, going forward. So this call was pure
      // downside risk with no corresponding benefit, and is removed rather than guarded.
      // T288 — WAN discovery, additive to mDNS, gated on SHORESH_RENDEZVOUS_URL. Unset (the
      // default) means this array has exactly one entry, byte-identical to pre-T288 behaviour —
      // see transportBoundary.guard.test.js's LAN-only parity regression.
      // T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §4) —
      // mint the camp's discovery secret once, if it doesn't exist yet (mint-only; this never
      // calls rotateRendezvousNamespace), then derive the rotating mDNS tag from the document's
      // own current revocation state. `mintRendezvousNamespace` is idempotent against sequential
      // calls (its own header comment) — a camp that already minted a secret in a prior run gets
      // `minted: false` and `doc` is left untouched here.
      const dhtMint = mintRendezvousNamespace(doc, campId)
      if (dhtMint.minted) {
        doc = dhtMint.doc
        setCurrentAutomergeDoc(db, doc)
      }
      const rendezvousConfig = readRendezvousConfig(process.env)
      const peerDiscovery = [createMdnsDiscovery({ serviceTag: computeRotatingServiceTag(doc, campId) })]
      if (rendezvousConfig.enabled) {
        const { peerId: rendezvousPeerId, privateKey: rendezvousPrivateKey } = await ensureDeviceIdentity(db)
        peerDiscovery.push(
          createRendezvousDiscovery({
            campId,
            baseUrl: rendezvousConfig.baseUrl,
            doc: () => getDocIfLoaded(db),
            getPrivateKey: async () => rendezvousPrivateKey,
            peerId: rendezvousPeerId,
            nextSequence: () => nextSequence(db),
          })
        )
      }

      // T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §A, §E): the camp-peer
      // circuit-relay-v2 coordination capability. BLOCKED by THREE independent gates, deliberately
      // redundant: (1) the `relay` row's signoff in transportCapabilities.js is still null — this
      // import and wiring is exactly what transportBoundary.guard.test.js is supposed to catch
      // while that stays true, and it does (package presence AND this file's own `circuitRelay`
      // reference both trip it; see that test's "declares no un-signed-off internet-transport
      // dependency" and "references no marker of a still-blocked capability" assertions). (2)
      // SHORESH_RELAY_ENABLED defaults to unset/false. (3) — gate-fix round 2, Security-Assessment
      // F-1 — the flag ALONE is not sufficient: relayRuntimeEligible (relayEnablement.js) also
      // requires the NEXT rung of the WAN ladder (the hole-punch direct-upgrade capability this
      // coordination layer exists to bootstrap — see relayEnablement.js for exactly which
      // packages it probes for, deliberately not named here) to actually exist in this build, so
      // a bare flag flip can never promote relay to the PRIMARY data path on its own.
      //
      // reservationTtl is set explicitly rather than left at the library default
      // (DEFAULT_MAX_RESERVATION_TTL, 2 hours) — gate-fix round 2, Red Hat HIGH. CORRECTED claim
      // (gate-fix round 3, Red Hat MEDIUM — the round-2 comment here previously said this made
      // reservations "disposable, ~2 min" / "expires with the attempt," which is FALSE and has
      // been removed): the client transport auto-REFRESHES this reservation roughly every 30s for
      // as long as it stays connected to R (circuit-relay-v2's own refresh timer; with a 120000ms
      // TTL, max(120000−300000,30000)=30000), and the server's reserve() resets the TTL on each
      // refresh. A reservation is therefore a STANDING, perpetually-renewed camp-internal relay
      // slot, not a one-shot thing that expires after one coordination attempt. What this value
      // actually bounds is the per-STREAM data/time budget (defaultDurationLimit, same number,
      // deliberately) for each individual relayed exchange — the 128 KiB/2 min ADR cap — not how
      // long the underlying reachability-via-R lasts. See
      // docs/work/specs/2026-10-03-t337-coordination-layer-design.md §B's round-3 correction for
      // the full honest description; the standing-reservation acceptability question is the
      // owner's separate, still-pending decision.
      // maxReservations is set to a small, explicit camp-LAN-scaled number (not the library
      // default of 15, which was never chosen for this app's actual scale) — a camp is "a few
      // devices" (ADR). It caps how many NEW reservations R will grant; it does not cap how long
      // an EXISTING one may keep renewing (the library bypasses this cap on refresh).
      const COORDINATION_WINDOW_MS = 120000
      const MAX_SIMULTANEOUS_RESERVATIONS = 8
      const relayEnabled = process.env.SHORESH_RELAY_ENABLED === 'true'
      const relayEligible = relayRuntimeEligible({ relayEnabled, nextRungPresent: await holePunchFoundationPresent() })
      let relayServerFactory
      let relayTransportFactory
      if (relayEligible) {
        const { circuitRelayServer, circuitRelayTransport } = await import('@libp2p/circuit-relay-v2')
        relayServerFactory = circuitRelayServer({
          reservations: {
            defaultDataLimit: 131072n,
            defaultDurationLimit: COORDINATION_WINDOW_MS,
            reservationTtl: COORDINATION_WINDOW_MS,
            maxReservations: MAX_SIMULTANEOUS_RESERVATIONS,
          },
        })
        relayTransportFactory = circuitRelayTransport()
      }

      // T336 (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §1, "Activation trigger —
      // on-redial-failure, not eager"): the direct-upgrade (hole-punch) service only ever runs on a
      // connection that reached this node via T337's coordination relay — which itself only forms
      // after `redialTrustedPeers` has already exhausted its cached-address attempts (the existing
      // ladder ordering, unchanged by this wiring). So gating this on the SAME `relayEligible`
      // check the relay factories above use (rather than inventing a second gate) already encodes
      // "upgrade only after the relay step," not a separate eager/parallel trigger. This is the
      // ONLY capability this slice wires here — the reachability-probe service (AutoNAT) is NOT
      // wired at all: it was DROPPED (organizer ruling 2026-10-03) because the installed
      // probe-service package exposes no admission/connectionGater hook to camp-scope it with (so a
      // non-camp party could use this node as a probe server) and dcutr does not depend on it. See
      // the amendment banner in docs/work/specs/2026-10-03-t336-holepunch-build-design.md.
      let directUpgradeServiceFactory
      if (relayEligible) {
        const { dcutr } = await import('@libp2p/dcutr')
        directUpgradeServiceFactory = dcutr()
      }

      // T347 (S1, ticket docs/work/tickets/T347-*.md): the ICE data-channel libp2p transport. INERT by
      // default — wired only when SHORESH_PUNCH_ENABLED is exactly the string 'true' (no truthy
      // coercion), the native module actually loads here, and a signaling channel was injected (S1
      // builds none; the rung 2/3 channel lands in a later slice). Authorization is separate: the
      // capability row's signoff stays null until S5's T327 gate.
      let punchTransportFactory
      const listenAddrs = ['/ip4/0.0.0.0/tcp/0']
      const punchEnabled = process.env.SHORESH_PUNCH_ENABLED === 'true'
      if (punchRuntimeEligible({ punchEnabled, nativeLoadable: punchEnabled && punchSignaling != null && punchNativeLoadable() })) {
        punchModule = await import('./punchTransport.js')
        punchTransportFactory = punchModule.punchTransport({ signaling: punchSignaling })
        listenAddrs.push('/ip4/0.0.0.0/udp/0')
      }

      const startSyncNode = startSyncNodeImpl ? await startSyncNodeImpl() : (await import('./syncNode.js')).startSyncNode
      automergeSyncNode = await startSyncNode({
        deviceId,
        db,
        doc,
        relayServerFactory,
        directUpgradeServiceFactory,
        relayTransportFactory,
        punchTransportFactory,
        // Stage 5f, found on a real two-machine run: transport.js's DEFAULT_LISTEN is
        // '/ip4/127.0.0.1/tcp/0' — LOOPBACK ONLY. That default is correct for the in-process tests
        // it was written for (Stage 4 dialed over loopback deliberately), but it means a production
        // node can never accept a connection from another device: mDNS discovery succeeds, the peer
        // dials, and nothing can connect. Production must bind all interfaces. This is the single
        // line that makes LAN sync possible at all, and no in-process test could ever have caught
        // its absence, because loopback is exactly what those tests want.
        listen: listenAddrs,
        onRemoteOps: (events) => {
          // T292 round 2 FIX 2 — a remote merge never fires onOpApplied (that
          // listener only covers this device's OWN local write()/
          // writeBulkReplace() calls), so a receive-only device's camp data
          // document would otherwise never update. onRemoteOps fires AFTER
          // projectAll (see syncNode.js's own comment on this callback), so
          // SQLite is already current by the time schedule() reads it.
          // Scheduled unconditionally — this must happen even with no window
          // open, unlike the renderer push below.
          getLiveHandlers()?.scheduleCampDataRecord?.()
          const mainWindow = getMainWindow()
          if (!mainWindow) return
          dispatchRemoteOps(events, {
            send: (channel, payload) => mainWindow.webContents.send(channel, payload),
            sanitizeOpForIpc,
            threshold: REMOTE_OPS_COALESCE_THRESHOLD,
          })
        },
        // Camp-scoped mDNS (Stage 5d-2a) — a peer advertising a different
        // camp's tag is structurally never surfaced by @libp2p/mdns at all
        // (see discovery.js's own module comment), so it is never dialed.
        peerDiscovery,
        // The SAME director-approval forwarder the WS transport already
        // uses (defined in chooseMode's host branch, threaded here via the
        // module-scoped `notifyPairingRequest` below) — approving/denying a
        // device is transport-independent, so one callback serves both.
        onPairingRequest: notifyPairingRequest,
        // The director's Add-a-device window (see getJoinCode/setJoinWindow).
        // Only consulted for a first-join pairing_request; an already-paired
        // device reconnecting never carries a join nonce and is unaffected.
        isJoinWindowOpen: () => getLiveHandlers()?.isJoinWindowOpen?.() ?? false,
        // T286 — the current window-scoped join secret, mirroring
        // isJoinWindowOpen's own injection immediately above. Unlike that
        // gate, no secret ever fails CLOSED (see syncNode.js's own comment on
        // this option) rather than open — there is no "no join layer wired at
        // all, so let everything through" case for the value that IS the
        // security boundary.
        getJoinSecret: () => getLiveHandlers()?.getJoinSecret?.() ?? null,
        // A merged document that will not project leaves SQLite silently BEHIND
        // the authoritative document — the exact mirror of a document write that
        // fails after SQLite committed, and until now the only one of the pair
        // with no durable trace: syncNode logs it and calls this, and nothing was
        // ever wired to it (it existed only in syncNode.test.js). The doc stays
        // as CRDT truth and sync continues, by design; what was missing was any
        // way to find out afterwards that this device's tables are not what the
        // camp agreed on. `projection_failures` cannot hold it — its primary key
        // is an op id and a merge has no op — so it goes to the device's own
        // durable event log, which is where support reads from.
        onProjectionError: (err, _mergedDoc, fromPeerId) => {
          // T174: was recordAuditEvent with outcome:'error', which audit_events'
          // CHECK constraint rejects — the trace never landed. Its own table now.
          recordDeviceHealthEvent(db, {
            campId,
            kind: DEVICE_HEALTH.PROJECTION_FAILED,
            detail: JSON.stringify({ fromPeerId: fromPeerId ?? null, error: String(err?.message ?? err) }),
          })
        },
        // board i-appendop-silent-camp-id-rejection (OWNER 2026-10-02): a peer's merge
        // carried a `camp_id` write for a DIFFERENT camp. applyProjection's tenant guard
        // refused it without throwing (correct — a security rejection of a hostile/buggy
        // peer write must not break sync); this makes that refusal visible instead of
        // silent, via a durable device-health row support reads from.
        //
        // Deduped by a DETERMINISTIC id: the offending camp_id lives in the append-only
        // shared document, so this rejection re-fires on EVERY subsequent merge pass.
        // One row per distinct (entity, record, rejected value) — never one per pass.
        // The rejected value is peer-controlled, so it is bounded before it becomes a
        // primary key.
        //
        // No peer attribution on purpose: at projection time the merged document does
        // not record which device authored a field, and `fromPeerId` here is merely the
        // peer whose traffic TRIGGERED this pass — usually NOT the author — so blaming it
        // (as an earlier draft's audit 'deny' did) would be actively misleading during an
        // incident. The durable health row plus the guard's own console line are the
        // "log AND surface" the ruling asked for.
        onCrossCampRejected: (failure) => {
          const boundedValue = String(failure?.rejectedValue ?? '?').slice(0, 200)
          recordDeviceHealthEvent(db, {
            campId,
            kind: DEVICE_HEALTH.CROSS_CAMP_WRITE_REJECTED,
            id: `crosscamp:${failure?.entity ?? '?'}:${failure?.entityId ?? '?'}:${boundedValue}`,
            detail: JSON.stringify({
              entity: failure?.entity ?? null,
              entityId: failure?.entityId ?? null,
              rejectedValue: failure?.rejectedValue ?? null,
            }),
          })
        },
        onAuthRejected: (peerId, reply) => {
          console.error(`automerge sync: peer ${peerId} rejected our authenticate: ${JSON.stringify(reply)}`)
          recordAuditEvent(db, {
            actorUserId: null,
            deviceId: null,
            action: 'automerge.authenticate_rejected',
            outcome: 'deny',
            reason: reply?.reason ?? 'unknown',
            metadata: { peerId },
          })
          // Reconnects the renderer half of T87's onAuthRejected path (preload.js's onAuthRejected,
          // useDeviceMode.js's reasonForAuthRejectedCode), which had no sender at all from the Stage
          // 6 WS-layer deletion onward — the Host authoritatively rejecting THIS device's authenticate
          // was silently invisible to the director, sync just went dead. `reply` on the wire is
          // `{ type: 'auth_failed', reason }` (authGate.js's auth_failed frame) — there is no numeric
          // code on the wire, confirmed by reading authGate.js/mutualAuth.js directly — so it is
          // mapped to the close-code convention here via codeForAuthRejectedReason, mirroring
          // evaluateAuthenticate's own code choices (electron/auth/connectionAuth.js).
          const mainWindow = getMainWindow()
          if (mainWindow) mainWindow.webContents.send('shoresh:auth-rejected', { code: codeForAuthRejectedReason(reply?.reason) })
        },
        // T336 Precondition 3 — transport.js's wrapped addRelay observed a genuine
        // RESERVATION_REFUSED. Recorded here (not acted on further — this is a UI notice, not a
        // retry trigger) and pushed to the renderer the same way every other sync-status change
        // already is, via pushSyncStatus below.
        onRelayReservationRefused: (detail) => {
          relayReservationRefused = detail
          try { getLiveHandlers()?.pushSyncStatus?.() } catch { /* never break sync over a UI notice */ }
        },
      })

      // Stage 5f item 2: a local edit (appendOp -> liveDoc.recordLocalWrite) must reach connected
      // peers. liveDoc debounces its own field-write bursts (same timer as the doc save) and, for
      // any window that included a local write, calls whatever broadcaster is wired here — never a
      // per-field-op broadcast, and never a projectAll (recordLocalWrite only ever updates the
      // shared in-memory doc; the write already reached this device's own SQLite via appendOp).
      setAutomergeLocalWriteBroadcaster(db, automergeSyncNode.broadcastLocalDoc)

      // Stage 6c: the sidebar's connection copy now follows the libp2p peer
      // set. Pushed on change rather than polled, matching what the WebSocket
      // client's onConnectionChange used to do.
      automergeSyncNode.onPeersChanged?.(() => {
        try { getLiveHandlers()?.pushSyncStatus?.() } catch { /* never break sync over a UI notice */ }
      })

      // Host case: a device holding host_signing_key can self-issue its own
      // device-admission token on demand (same fact issueDeviceToken itself
      // relies on) — no login step needed, mirroring chooseMode's existing
      // Host auto-authorize precedent. A Client has no signing key and gets
      // its (camp) token instead from login()/chooseMode's client branch
      // below. Finding 2 fix: issueDeviceToken, not issueCampToken(db, null,
      // deviceId) — see the doc comment at the chooseMode call site above.
      try {
        automergeSyncNode.setAuthToken(issueDeviceToken(db, deviceId))
      } catch {
        // Not the Host — no host_signing_key row. Expected for a Client;
        // its token arrives later via login()/chooseMode.
      }
      console.log(`automerge sync: node started, listening on ${automergeSyncNode.getMultiaddrs?.().length ?? 0} address(es)`)
    } catch (err) {
      // A transport/libp2p startup failure (port in use, WASM/ESM load failure, etc.) must never
      // prevent the app from starting — the flag is default-off precisely so this path can fail
      // safely while the op-log path keeps working.
      console.error(`automerge sync: failed to start (non-fatal, app continues on op-log): ${err?.message ?? err}`)
    } finally {
      // T268 — every exit from the try above (success, the no-camp-yet
      // return, the refusal return, the no-doc return, and the catch) lands
      // here exactly once. This is what lets getSyncStatus distinguish "not
      // yet attempted" (still reads as plain 'host', avoiding a boot flicker
      // while the node starts asynchronously) from "attempted and still not
      // running" ('host-not-syncing'). Skipped when `attempted` was flipped
      // false above (no camp bootstrapped yet) — see that comment.
      if (attempted) automergeStartupAttempted = true
      // Cleared unconditionally (success or failure) so a failed attempt —
      // this run's own catch above, or the no-camp/refusal/no-doc returns —
      // can be retried by a later call rather than latching "starting"
      // forever.
      automergeSyncNodeStarting = false
      // A director already looking at the sidebar when this settles should
      // see it without reloading — wrapped so a UI push can never take sync
      // startup down with it.
      try { getLiveHandlers()?.pushSyncStatus?.() } catch { /* never break sync over a UI notice */ }
    }
  }

  return {
    start,
    getNode: () => automergeSyncNode,
    shutdownPunch: async () => { await punchModule?.shutdownPunchNative() },
    getStartupAttempted: () => automergeStartupAttempted,
    getRelayReservationRefused: () => relayReservationRefused,
  }
}
