/**
 * Scenario 35 (libp2p): T271 round 3 — schema-version gate before Automerge merge, REWRITTEN
 * (docs/adr/2026-09-26-schema-version-gate-before-merge.md, docs/work/tickets/
 * T271-schema-version-gate-before-merge.md).
 *
 * Round 1 shipped a gate that read a document-ROOT `schemaVersion` field and only checked it in
 * `handleReceived` — the whole-document push path this module's own Stage 5f-2 comment says is
 * used ONLY for direct-send and adversarial-input tests. Red Hat and Security found this was wrong
 * in three ways: (1) the document-root field was never backfilled onto a pre-existing document, so
 * EVERY camp created before the fix shipped would freeze forever; (2) the field was shared/racy
 * CRDT state, answering "has this document ever seen a higher version" rather than "is the peer
 * that sent me these bytes compatible with me"; (3) the REAL production sync mechanism — the
 * incremental `A.generateSyncMessage`/`A.receiveSyncMessage` exchange (`stepSync`/
 * `handleSyncMessage`, triggered from `onPeerAdmitted`) — had NO gate at all. This file is REWRITTEN
 * (not extended) because its round-1 construction planted a doc-root `schemaVersion` field that no
 * longer exists after round 3.
 *
 * Round 3's carrier is a per-device fact learned at authentication time (`peerSchemaVersions`,
 * keyed by peerId, populated from the peer's own `authenticate` handshake — never from document
 * content) and checked at ALL THREE places `syncNode.js` touches a remote merge/sync primitive:
 * `stepSync` (never even BEGIN an exchange with an incompatible peer), `handleSyncMessage` (the
 * real, incremental production path — refuse to apply, and critically never advance `syncStates`
 * for the refused exchange), and `handleReceived` (the direct-send/adversarial path, same shape).
 *
 * This scenario constructs the mismatch by bumping the HOST's OWN required version
 * (`localSchemaVersion`, function-form) AFTER a normal, fully-converged join — deliberately, rather
 * than making the CLIENT announce a different version from the start: `join()` blocks on
 * `session.waitForCamp()`, so a mismatch present at join time would make the initial camp-data
 * transfer itself refuse, hanging the join. Bumping the receiver's own requirement afterward
 * produces an identical, equally real mismatch from the gate's point of view (peerSchemaVersions
 * still holds the CLIENT's real, unchanged, truthfully-announced version; only what the HOST now
 * requires has changed) without that risk. `harnessAutomerge.js`'s `AmHost`/`AmClient` also support
 * an independent `handshakeSchemaVersion` override (what a node ANNOUNCES, separate from what it
 * REQUIRES) for a scenario that needs a peer to lie about its version from the start; this one
 * doesn't need it, so it isn't used here — see AmHost's constructor comment.
 *
 * RECOVERY MECHANISM, verified against the real dependency rather than assumed (org-source-
 * verification): Automerge 3.4.1's sync state is asymmetric-optimistic — the SENDING side's local
 * state advances the instant `A.generateSyncMessage` runs, independent of whether the receiver ever
 * applies the bytes (confirmed with a minimal Automerge-only repro against no other code in this
 * repo). A receiving side that resets ITS OWN state on becoming compatible again (this file's
 * `pendingVersionReset` mechanism in syncNode.js) is therefore necessary but NOT sufficient to
 * reconverge a write the OTHER side already (successfully, from its own point of view) sent once
 * during the mismatch: the sender has no way to learn its earlier send was silently refused, so its
 * own state keeps believing that data was already delivered. This is why recovery here goes through
 * an actual `restart()` + `reconnect()` — genuinely tearing down and re-establishing the connection
 * — rather than a same-connection version flip: this is also the literal mechanism the ADR's own
 * Decision 2/3 describe ("upgrading this Electron app requires restarting the process... which
 * tears down and re-establishes the libp2p connection, which re-runs the authenticate handshake"),
 * and it is what actually converges, verified directly rather than assumed from the ADR's prose.
 */
import * as A from '@automerge/automerge'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(`${tmpDir}/docs`)

    // The Host's OWN required schema version is a MUTABLE simulated value (a function, not a plain
    // number) — this is what lets the mismatch phase below flip compatibility WITHOUT any new dial
    // or authenticate (the Client's earlier, genuinely-compatible-from-its-own-perspective write is
    // refused purely because the Host now requires something else). Recovery (Verification item 3,
    // below) is a REAL restart+reconnect, not a further flip of this variable — see this file's
    // header comment for why a same-connection flip alone does not reconverge a write the sender
    // already believes it delivered.
    let hostRequiredVersion = 76
    host = new AmHost(`${tmpDir}/host.db`, { localSchemaVersion: () => hostRequiredVersion })
    await host.start()
    await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    // Real handshake, both sides currently at 76 — join must succeed normally; this is also
    // Verification item 4 (pre-existing document, no backfill needed): createEmptyDoc() carries no
    // schemaVersion field of any kind after round 3 (there is no longer a document-root field at
    // all), so THIS ordinary join/seed setup already IS "a document the way a pre-T271 camp's
    // document would look" — no migration step, no backfill call, no special-casing anywhere here.
    await client.join(host)

    // --- Verification item 1: same-genesis, MATCHING versions, real incremental path -------------
    // Non-regression — the "when someone comes online, they sync" case must stay unaffected.
    await client.write({ entity: 'activities', entity_id: 'match-from-client', field: 'name', value: 'Archery' })
    await waitFor(() => !!host.domainRow('activities', 'match-from-client'), 8000)
    await host.write({ entity: 'activities', entity_id: 'match-from-host', field: 'name', value: 'Swimming' })
    await waitFor(() => !!client.domainRow('activities', 'match-from-host'), 8000)

    // --- Verification item 2: same-genesis, MISMATCHED versions, real incremental path ------------
    // Bump the Host's own requirement above the Client's real, unchanged, truthfully-announced
    // version (still 76 — the Client never lied about anything). From here on the Host requires 77;
    // the Client is still genuinely, honestly at 76.
    hostRequiredVersion = 77

    const hostSyncStateBefore = host.node.getSyncStateBytesForTest(client.node.peerId)
    const clientSyncStateBefore = client.node.getSyncStateBytesForTest(host.node.peerId)

    // --- handleSyncMessage's gate: the Client, still genuinely compatible from ITS OWN point of
    // view (it doesn't know the Host just became pickier), sends this write over the normal sync
    // protocol; the HOST's handleSyncMessage must refuse to apply it. Heads/rows captured
    // immediately before THIS write only — a later assertion about the Host's own local write
    // (below) must not be confused with this one, since a device's OWN local write legitimately
    // advances its OWN heads regardless of any peer's compatibility.
    const hostHeadsBeforeClientWrite = A.getHeads(host.getDoc())
    const hostRowsBeforeClientWrite = host.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n
    await client.write({ entity: 'activities', entity_id: 'mismatch-1', field: 'name', value: 'Should Never Land' })
    await new Promise((r) => setTimeout(r, 300))

    // (a) The Host's document heads never advanced from the Client's refused write.
    if (JSON.stringify(A.getHeads(host.getDoc())) !== JSON.stringify(hostHeadsBeforeClientWrite)) {
      throw new Error('the Host applied a schema-version-mismatched sync message — heads advanced')
    }
    // (b) SQLite projection on the receiving side is untouched.
    if (host.domainRow('activities', 'mismatch-1')) {
      throw new Error('a schema-version-mismatched write was projected into the Host\'s SQLite')
    }
    const hostRowsAfterClientWrite = host.db.prepare('SELECT COUNT(*) AS n FROM activities').get().n
    if (hostRowsAfterClientWrite !== hostRowsBeforeClientWrite) {
      throw new Error(`Host activities row count changed (${hostRowsBeforeClientWrite} -> ${hostRowsAfterClientWrite}) despite the refused exchange`)
    }

    // --- stepSync's gate: the Host's OWN local write must not even attempt to reach the Client
    // once the Host considers it incompatible — nothing is generated, let alone sent. The Host's
    // OWN heads legitimately advance here (it's a local edit); what must NOT happen is the Client
    // ever receiving it.
    const clientHeadsBeforeHostWrite = A.getHeads(client.getDoc())
    await host.write({ entity: 'activities', entity_id: 'host-side-during-mismatch', field: 'name', value: 'Also Should Not Land' })
    await new Promise((r) => setTimeout(r, 300))
    if (client.domainRow('activities', 'host-side-during-mismatch')) {
      throw new Error('the Host sent a sync message to an incompatible peer — stepSync\'s gate did not hold')
    }
    if (JSON.stringify(A.getHeads(client.getDoc())) !== JSON.stringify(clientHeadsBeforeHostWrite)) {
      throw new Error('the Client\'s document heads advanced from the Host\'s write despite the version mismatch')
    }
    // (c) No exception escaped — both writes above already ran to completion without throwing.
    // (d) The peer connection and authenticated/trusted state SURVIVE — refuse the merge/sync, not
    // the auth (Decision 3).
    if (!host.admits(client.node.peerId)) {
      throw new Error('the Host revoked/dropped the Client\'s admission after a mismatched exchange — must refuse the SYNC, not the AUTHENTICATION')
    }
    if (!client.node.getPeers().includes(host.node.peerId)) {
      throw new Error('the connection to the Host did not survive a schema-mismatched exchange')
    }
    // (e) THE LOAD-BEARING ASSERTION: syncStates for this peer pair never advanced past whatever it
    // held before the refused exchange, on EITHER side — proving a refused delivery does not mark
    // the peer caught-up, which is what makes the recovery below (a fresh write, not a resumed
    // stale exchange) actually re-offer the withheld data instead of silently suppressing it.
    const hostSyncStateAfter = host.node.getSyncStateBytesForTest(client.node.peerId)
    const clientSyncStateAfter = client.node.getSyncStateBytesForTest(host.node.peerId)
    if (JSON.stringify(hostSyncStateAfter) !== JSON.stringify(hostSyncStateBefore)) {
      throw new Error('the Host\'s sync-state bookkeeping for the Client advanced despite the refused exchange — a refused delivery marked the peer caught-up')
    }
    if (JSON.stringify(clientSyncStateAfter) !== JSON.stringify(clientSyncStateBefore)) {
      throw new Error('the Client\'s sync-state bookkeeping for the Host advanced despite the refused exchange')
    }
    // (f) Nothing observable is emitted beyond a developer log line — this scenario deliberately
    // wires no connectivity-event listener and no onProjectionError/onRemoteOps callback, and still
    // passes, proving no such callback fires for this path.

    // --- handleReceived's gate: the direct-send/adversarial-input path (Decision 3's third site,
    // used in production only for direct-send/adversarial-input tests per syncNode.js's Stage 5f-2
    // comment — the real production traffic is the incremental path above). Same shape, sourced
    // from the same peerSchemaVersions map, exercised directly via sendDocTo/A.save rather than the
    // sync protocol, mirroring how round 1's scenario 35 (and scenario 14) probed this path.
    const hostHeadsBeforeDirectSend = A.getHeads(host.getDoc())
    const phantomDoc = A.change(A.clone(client.getDoc()), (d) => {
      d.activities['phantom-1'] = { name: { value: 'Should Never Land Via Direct Send' } }
    })
    await client.node.sendDocTo(host.node.peerId, A.save(phantomDoc))
    await new Promise((r) => setTimeout(r, 300))
    if (JSON.stringify(A.getHeads(host.getDoc())) !== JSON.stringify(hostHeadsBeforeDirectSend)) {
      throw new Error('the Host merged a schema-version-mismatched document sent directly via sendDocTo — handleReceived\'s gate did not hold')
    }
    if (host.domainRow('activities', 'phantom-1')) {
      throw new Error('a schema-version-mismatched direct-send document was projected into the Host\'s SQLite')
    }

    // --- Verification item 3: recovery, real incremental path -------------------------------------
    // Part A — same connection, no re-dial: the Host's OWN previously-withheld write
    // (host-side-during-mismatch) self-resolves the moment the Host becomes compatible again,
    // because syncNode.js's `pendingVersionReset` mechanism resets the HOST's OWN outbound sync
    // state for the Client the instant `isPeerSyncCompatible` flips back to true — no disconnect, no
    // re-authenticate, just the Host's own next trigger (another local write). This is the direction
    // the ADR's "no re-discovery/re-dial needed" language is actually true of.
    hostRequiredVersion = 76
    await new Promise((r) => setTimeout(r, 500))
    await host.write({ entity: 'activities', entity_id: 'trigger-recovery', field: 'name', value: 'Trigger' })
    await waitFor(() => !!client.domainRow('activities', 'host-side-during-mismatch'), 8000)
      .catch(() => { throw new Error('the Host\'s own withheld write did not self-resolve on the same connection') })

    // Part B — the Client's previously-refused write (mismatch-1) needs the OTHER direction of
    // recovery: the CLIENT's own sync state already (from its own point of view) marked that write
    // as sent — it has no way to learn the Host silently refused it — so nothing on the Host's side
    // alone can make the Client re-offer it. This is precisely why production recovery goes through
    // an app restart (this file's header comment): restarting tears down the connection, which
    // clears BOTH sides' per-peer sync bookkeeping via the ordinary peer:disconnect path, and the
    // ensuing reconnect+re-authenticate starts the exchange genuinely fresh on both ends.
    await client.restart(`${tmpDir}/docs`, client.campId)
    await client.reconnect(host)
    await waitFor(() => !!host.domainRow('activities', 'mismatch-1'), 8000)
      .catch(() => { throw new Error('the previously-withheld write did not converge after a genuine restart+reconnect') })

    // --- Harness test-fidelity regression check (Red Hat + Code Reviewer, round-3 cleanup):
    // harnessAutomerge.js's `reconnect()` builds its own authenticate frames rather than going
    // through startSyncNode's wireMutualAuth wiring, so it must independently honor a
    // `handshakeSchemaVersion` override on reconnect, not just at initial join — otherwise a
    // scenario combining an override with restart+reconnect would silently announce the real
    // CURRENT_SCHEMA_VERSION instead and false-pass. A fresh device (its own db, its own join) keeps
    // this isolated from the host/client pair above rather than disturbing already-asserted state.
    let secondClient
    try {
      secondClient = new AmClient(`${tmpDir}/second-client.db`, { handshakeSchemaVersion: 999 })
      secondClient.open()
      await secondClient.join(host)
      hostRequiredVersion = 999 // matches ONLY what the override should announce on reconnect
      await secondClient.reconnect(host)
      await secondClient.write({ entity: 'activities', entity_id: 'override-honored', field: 'name', value: 'Z' })
      await waitFor(() => !!host.domainRow('activities', 'override-honored'), 8000)
        .catch(() => { throw new Error('reconnect() did not announce the handshakeSchemaVersion override — it would have silently announced the real CURRENT_SCHEMA_VERSION instead') })
    } finally {
      hostRequiredVersion = 76
      await secondClient?.close()
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
