import { readRecord, recordKey } from '../../automerge/campDocument.js'
// @vitest-environment node
//
// Stage 4c acceptance test (design doc's Test strategy points 3, 4, 6): the
// full edit -> transport -> merge -> SQLite path, across two SEPARATE SQLite
// databases, each behind its own libp2p node. This is Stage 4's mechanical
// equivalent of the WS protocol's scheduleE2E.sync.test.js parity proof.
//
// Stage 5d-1 update (docs/adr/2026-09-06-libp2p-membership-mapping.md §3):
// startSyncNode now gates doc-sync behind the auth-over-libp2p handshake, so
// every test below that exchanges doc bytes must authenticate first —
// setupAuthorizedDevicePair/authenticateBothWays do that using the SAME
// evaluateAuthenticate logic (via startSyncNode's real onAuthenticate wiring)
// production code uses, not a test-only bypass.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb, CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { setCurrentDoc } from './liveDoc.js'
import { mintRendezvousNamespace, readRendezvousNamespace } from './rendezvousNamespace.js'
import { mintRendezvousAddressKey, readRendezvousAddressKey } from './rendezvousAddressKey.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage4-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

// dbA plays the Host (holds host_signing_key, mints camp tokens); BOTH dbs
// get the same signing_public_key and BOTH devices marked authorized —
// mirroring what a real full-sync of camps/devices would already have
// replicated to a genuinely paired Client before this handshake runs.
function setupAuthorizedDevicePair(dbA, dbB) {
  const hostKey = ensureHostSigningKey(dbA)
  for (const db of [dbA, dbB]) {
    db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
    ).run('device-a', 'Device A', new Date().toISOString())
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
    ).run('device-b', 'Device B', new Date().toISOString())
  }
  return {
    tokenA: issueCampToken(dbA, 'user-a', 'device-a'),
    tokenB: issueCampToken(dbA, 'user-b', 'device-b'),
  }
}

// Each side must authenticate TO THE OTHER before that other side's doc-sync
// handler will accept frames from it — admission is one-directional per
// receiving node (transport.js's authenticatedPeers set), so a two-way
// broadcast relationship needs both handshakes.
async function authenticateBothWays(a, b, tokenA, tokenB) {
  await a.authenticateWith(b.peerId, { type: 'authenticate', token: tokenA, device_id: 'device-a', schemaVersion: CURRENT_SCHEMA_VERSION })
  await b.authenticateWith(a.peerId, { type: 'authenticate', token: tokenB, device_id: 'device-b', schemaVersion: CURRENT_SCHEMA_VERSION })
}

let dbA, dbB
let nodes = []
beforeEach(() => {
  dbA = freshDb('a')
  dbB = freshDb('b')
})
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()))
  nodes = []
  for (const db of [dbA, dbB]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function activityRow(db, id) {
  return db.prepare('SELECT id, name, location FROM activities WHERE id = ?').get(id)
}

describe('syncNode — Automerge merge + projector over a real transport', () => {
  it('an edit on node A projects into node B\'s OWN separate SQLite db', async () => {
    // Shared genesis doc (same ancestry -> clean merges), each node gets its
    // own clone so actor ids differ, exactly like the prototype's A.clone.
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    const changed = applyWrite(a.getDoc(), {
      entity: 'activities',
      entity_id: 'archery',
      field: 'name',
      value: 'Archery',
    })
    const changed2 = applyWrite(changed, {
      entity: 'activities',
      entity_id: 'archery',
      field: 'location',
      value: 'Field 1',
    })
    await a.applyLocal(changed2)

    await waitFor(() => activityRow(dbB, 'archery')?.location === 'Field 1')

    const rowA = activityRow(dbA, 'archery')
    const rowB = activityRow(dbB, 'archery')
    expect(rowB).toEqual(rowA)
    expect(rowB.name).toBe('Archery')
    expect(rowB.location).toBe('Field 1')
  })

  it('concurrent same-field edits on both nodes converge and surface via A.getConflicts', async () => {
    const genesis = createEmptyDoc()
    const seeded = applyWrite(genesis, {
      entity: 'activities',
      entity_id: 'archery',
      field: 'location',
      value: 'Gym',
    })
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(seeded) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(seeded) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Let the initial connection settle before diverging concurrently.
    await new Promise((r) => setTimeout(r, 100))

    // Fire both edits concurrently (not sequentially awaited) so neither side
    // has received the other's change before making its own — this is what
    // makes the two writes genuinely concurrent from Automerge's perspective.
    await Promise.all([
      a.applyLocal(
        applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Lake' })
      ),
      b.applyLocal(
        applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'location', value: 'Kiln' })
      ),
    ])

    // Poll until BOTH sides have independently merged the other's edit (each
    // side's own merge/projection is a separate async path — waiting on only
    // one side's doc can observe it mid-way through the other side's still-
    // in-flight merge, which is what made this assertion flaky).
    const hasConflict = (doc) => {
      // Conflicts live on the field's own document key (flat record shape).
      const conflicts = A.getConflicts(doc.activities, recordKey('archery', 'location'))
      return conflicts && Object.keys(conflicts).length >= 2
    }
    await waitFor(() => hasConflict(a.getDoc()) && hasConflict(b.getDoc()))

    // Conflicts live on the field's own document key now (flat record shape).
    const conflicts = A.getConflicts(a.getDoc().activities, recordKey('archery', 'location'))
    expect(conflicts && Object.keys(conflicts).length).toBeGreaterThanOrEqual(2)

    const rowA = activityRow(dbA, 'archery')
    const rowB = activityRow(dbB, 'archery')
    expect(rowA).toEqual(rowB)
  })

  it('logs the serialized doc size for a representative seed (evidence for Stage 5 planning)', async () => {
    let doc = createEmptyDoc()
    for (let i = 0; i < 20; i++) {
      doc = applyWrite(doc, { entity: 'activities', entity_id: `activity-${i}`, field: 'name', value: `Activity ${i}` })
      doc = applyWrite(doc, { entity: 'activities', entity_id: `activity-${i}`, field: 'location', value: `Field ${i}` })
    }
    for (let i = 0; i < 10; i++) {
      doc = applyWrite(doc, { entity: 'groups', entity_id: `group-${i}`, field: 'name', value: `Group ${i}` })
    }
    const bytes = A.save(doc)
    console.log(`[stage4 evidence] serialized doc size for 20 activities + 10 groups: ${bytes.length} bytes`)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('T331 gate B — a device revoked via authority_cache is refused on the PRODUCTION sync path (handleSyncMessage via stepSync/applyLocal), not just handleReceived', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Node A's own locally-verified-and-replayed derived cache (projector.js's
    // upsertCampAuthorityLogEntity) marks device-b as revoked — simulating that another admin's
    // quorum already removed it, WITHOUT touching devices.revoked_at at all (the whole point of
    // this ADR: distributed revocation does not route through the Host-local revokeDevice path).
    dbA.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(
      'device-b',
      'revoked',
      new Date().toISOString()
    )

    // device-b writes locally and syncs via the REAL production path: applyLocal -> stepSync ->
    // transport.sendSyncMessage -> node A's handleSyncMessage. If gate B is wired, this write
    // never lands in dbA's SQLite.
    const changed = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'revoked-write', field: 'name', value: 'Should Not Land' })
    await b.applyLocal(changed)

    // Give the exchange time to attempt delivery, then prove it was refused — not merely slow.
    await new Promise((r) => setTimeout(r, 300))
    expect(activityRow(dbA, 'revoked-write')).toBeUndefined()

    // Prove the connection itself is still alive and the refusal is SPECIFIC to device-b, not a
    // general breakage: an ordinary write from the non-revoked side (A) still converges to B.
    const okChange = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'ok-write', field: 'name', value: 'Fine' })
    await a.applyLocal(okChange)
    await waitFor(() => activityRow(dbB, 'ok-write')?.name === 'Fine')
  })

  it('T331 gate C — live teardown: a connected peer revoked via a real signed camp_authority_log entry is evicted from transport.getPeers()', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    await waitFor(() => b.getPeers().length > 0 && a.getPeers().length > 0)
    await new Promise((r) => setTimeout(r, 150))

    // Device A (the founder) mints a genesis entry naming itself, grants device-b admin, then
    // revokes it — all real signed entries, written as ordinary local document writes (exactly
    // how authorityLog.js's mint* helpers shape a multi-field entry) and propagated to node A's
    // OWN db via applyLocal, which runs projectAll -> upsertCampAuthorityLogEntity ->
    // tearDownRevokedConnectedPeers.
    const sign = (fields) => signAuthorityEntry(dbA, fields)
    function pushEntry(doc, fields, signed) {
      const id = `entry-${Math.random()}`
      let d = doc
      for (const [field, value] of Object.entries(fields)) {
        d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
      }
      if (signed) {
        const signature = sign({ id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
        d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
      }
      return d
    }

    let doc = a.getDoc()
    doc = pushEntry(doc, { kind: 'genesis', target_device_id: 'device-a', target_peer_id: a.peerId.toString() }, false)
    await a.applyLocal(doc)
    doc = pushEntry(a.getDoc(), { kind: 'grant', target_device_id: 'device-b', target_peer_id: b.peerId.toString(), signer_device_id: 'device-a' }, true)
    await a.applyLocal(doc)
    await new Promise((r) => setTimeout(r, 150))

    // device-b is still fully connected and syncing at this point.
    expect(a.getPeers().length).toBeGreaterThan(0)

    doc = pushEntry(a.getDoc(), { kind: 'revoke', target_device_id: 'device-b', signer_device_id: 'device-a' }, true)
    await a.applyLocal(doc)

    // The live teardown must de-admit device-b on node A's OWN transport (transport.revokePeer —
    // see its own comment: this is the actual enforcement point, since broadcastDoc/stepSync gate
    // every send on authenticatedPeers, not on the raw libp2p connection) — closing the third-
    // device residual. A never had to manually hang up; projecting the revocation did it
    // automatically.
    await waitFor(() => !a.isPeerAuthenticated(b.peerId.toString()))
  })

  it('WAN-ladder F1 round 2: a revoke projected on the elected device rotates the rendezvous secrets, and the revoked peer never receives them', async () => {
    let genesis = createEmptyDoc()
    genesis = mintRendezvousNamespace(genesis, 'camp-1').doc
    genesis = mintRendezvousAddressKey(genesis, 'camp-1').doc
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    function pushEntry(doc, fields, signed) {
      const id = `entry-${Math.random()}`
      let d = doc
      for (const [field, value] of Object.entries(fields)) d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
      if (signed) {
        const signature = signAuthorityEntry(dbA, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
        d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
      }
      return d
    }
    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'genesis', target_device_id: 'device-a', target_peer_id: a.peerId.toString() }, false))
    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'grant', target_device_id: 'device-b', target_peer_id: b.peerId.toString(), signer_device_id: 'device-a' }, true))
    expect(readRendezvousNamespace(a.getDoc(), 'camp-1').epoch).toBe(1)
    const oldKey = readRendezvousAddressKey(a.getDoc(), 'camp-1')

    await a.applyLocal(pushEntry(a.getDoc(), { kind: 'revoke', target_device_id: 'device-b', signer_device_id: 'device-a' }, true))

    expect(readRendezvousNamespace(a.getDoc(), 'camp-1').epoch).toBe(2)
    expect(readRendezvousAddressKey(a.getDoc(), 'camp-1')).not.toBe(oldKey)
    await new Promise((r) => setTimeout(r, 500))
    expect(readRendezvousNamespace(b.getDoc(), 'camp-1').epoch).toBe(1)
    expect(readRendezvousAddressKey(b.getDoc(), 'camp-1')).toBe(oldKey)
  })

  // WAN-ladder round 2 (Red Hat): stepSync itself refuses a revoked peer, so no send path
  // (broadcastLocalDoc does no projection and therefore no teardown) can hand it new state.
  it('stepSync gate: broadcastLocalDoc sends nothing to a peer revoked in authority_cache', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)
    await waitFor(() => a.isPeerAuthenticated(b.peerId.toString()))
    // Settle the exchange first so A already knows B's heads: the next change then goes out in a
    // single push with no reply needed, so gate B on the reply path cannot mask a missing gate here.
    setCurrentDoc(dbA, applyWrite(a.getDoc(), { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Before' }))
    await a.broadcastLocalDoc()
    await waitFor(() => readRecord(b.getDoc(), 'camps', 'camp-1')?.name === 'Before')
    await new Promise((r) => setTimeout(r, 300))

    dbA.prepare('INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run('device-b', 'revoked', new Date().toISOString())
    setCurrentDoc(dbA, applyWrite(a.getDoc(), { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Secret After Revoke' }))
    await a.broadcastLocalDoc()
    await new Promise((r) => setTimeout(r, 500))
    expect(readRecord(b.getDoc(), 'camps', 'camp-1')?.name).not.toBe('Secret After Revoke')
  })

  it('an adversarial malformed doc payload does not crash the receiving node', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Send garbage bytes directly through the underlying transport's protocol,
    // bypassing A.save — simulates a malformed/adversarial peer.
    await a.sendDocTo(b.peerId, new Uint8Array([0xff, 0x00, 0x13, 0x37]))
    await new Promise((r) => setTimeout(r, 200))

    // Node B must still be responsive: a subsequent valid edit still converges.
    const changed = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'x', field: 'name', value: 'X' })
    await a.applyLocal(changed)
    await waitFor(() => activityRow(dbB, 'x')?.name === 'X')
    expect(activityRow(dbB, 'x').name).toBe('X')
  })

  it('a VALID-merging but projector-incompatible peer doc does not crash or poison node B', async () => {
    // Red Hat blocker: a doc that A.load/A.merge accept but whose merged shape
    // violates a projector invariant (a child referencing a missing parent ->
    // real FK violation) must not become an unhandled rejection / process crash,
    // and must not silently poison the node. Expected: surfaced + SQLite
    // last-good + doc kept as CRDT truth + sync continues.
    const genesis = createEmptyDoc()
    const projErrors = []
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onProjectionError: (err, _doc, fromPeerId) => projErrors.push({ err, fromPeerId }),
    })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // Merges cleanly, but the anchor references a cohort that doesn't exist ->
    // projectAll (foreign_keys=ON) throws atomically.
    let bad = A.clone(genesis)
    bad = applyWrite(bad, { entity: 'fixed_events', entity_id: 'anc-1', field: 'name', value: 'Flagpole' })
    bad = applyWrite(bad, { entity: 'fixed_events', entity_id: 'anc-1', field: 'cohort_id', value: 'ghost-cohort' })
    await a.sendDocTo(b.peerId, A.save(bad))

    // Failure is surfaced, not swallowed or crashed.
    await waitFor(() => projErrors.length > 0)
    expect(projErrors[0].err).toBeInstanceOf(Error)
    // SQLite left at last-good: the bad anchor never partially materialized.
    expect(dbB.prepare('SELECT COUNT(*) AS c FROM fixed_events').get().c).toBe(0)
    // The merged doc is kept as CRDT truth (the merge was NOT reverted).
    expect(readRecord(b.getDoc(), 'fixed_events', 'anc-1')).toBeTruthy()

    // NOT poisoned: node B still receives + merges further syncs. A subsequent
    // valid edit still converges into B's DOC (SQLite stays blocked on the
    // unresolved anchor until the Stage-2 rules layer repairs it — documented).
    const good = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-ok', field: 'name', value: 'Swim' })
    await a.applyLocal(good)
    await waitFor(() => readRecord(b.getDoc(), 'activities', 'act-ok')?.name === 'Swim')
    expect(readRecord(b.getDoc(), 'activities', 'act-ok')?.name).toBe('Swim')
  })

  it('a peer doc carrying a FOREIGN camp_id surfaces onCrossCampRejected (not silent) and sync keeps converging', async () => {
    // board i-appendop-silent-camp-id-rejection (OWNER 2026-10-02): the tenant guard
    // refuses a peer's cross-camp camp_id write WITHOUT throwing — so it never reaches
    // onProjectionError. This pins that it is no longer silent: it reaches the dedicated
    // onCrossCampRejected surface, the guard behavior is unchanged (row keeps THIS
    // device's camp), and node B is not poisoned.
    const genesis = createEmptyDoc()
    const crossCamp = []
    const projErrors = []
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({
      deviceId: 'device-b',
      db: dbB,
      doc: A.clone(genesis),
      onProjectionError: (err, _doc, fromPeerId) => projErrors.push({ err, fromPeerId }),
      onCrossCampRejected: (failure, _doc, fromPeerId) => crossCamp.push({ failure, fromPeerId }),
    })
    nodes.push(a, b)
    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA, tokenB } = setupAuthorizedDevicePair(dbA, dbB)
    await authenticateBothWays(a, b, tokenA, tokenB)

    // A legit row (its name makes a row on B) that also carries a camp_id for ANOTHER camp.
    let bad = A.clone(genesis)
    bad = applyWrite(bad, { entity: 'activities', entity_id: 'act-x', field: 'name', value: 'Archery' })
    bad = applyWrite(bad, { entity: 'activities', entity_id: 'act-x', field: 'camp_id', value: 'other-camp' })
    await a.sendDocTo(b.peerId, A.save(bad))

    // Surfaced to the dedicated cross-camp sink, NOT to onProjectionError.
    await waitFor(() => crossCamp.length > 0)
    expect(projErrors).toHaveLength(0)
    expect(crossCamp[0].failure).toMatchObject({ entity: 'activities', entityId: 'act-x', field: 'camp_id', crossCamp: true, rejectedValue: 'other-camp' })
    // Guard behavior unchanged: the row projected keeping device B's OWN camp.
    expect(dbB.prepare("SELECT camp_id FROM activities WHERE id = 'act-x'").get().camp_id).toBe('camp-1')

    // Not poisoned: a subsequent valid edit still converges.
    const good = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-ok', field: 'name', value: 'Swim' })
    await a.applyLocal(good)
    await waitFor(() => readRecord(b.getDoc(), 'activities', 'act-ok')?.name === 'Swim')
    expect(readRecord(b.getDoc(), 'activities', 'act-ok')?.name).toBe('Swim')
  })
})

// T322 S3a (docs/adr/2026-09-19-multi-device-erasure-propagation.md's "Addendum
// (2026-10-01, Architect, T322 S3a)"): a peer self-reports, in its `authenticate`
// frame, the set of (tombstone id, version) pairs it has verified-and-projected.
// onAuthenticate must thread `msg.appliedTombstones` through to evaluateAuthenticate
// unmodified, which persists it into peer_tombstone_reports ONLY after the
// trust/revocation gate passes.
describe('syncNode — onAuthenticate threads appliedTombstones through to the admission decision', () => {
  it('persists the authenticating peer\'s self-reported applied tombstones, keyed by its verified device id', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA } = setupAuthorizedDevicePair(dbA, dbB)

    // Device A authenticates TO B, self-reporting one verified tombstone.
    await a.authenticateWith(b.peerId, {
      type: 'authenticate',
      token: tokenA,
      device_id: 'device-a',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    const row = dbB.prepare('SELECT * FROM peer_tombstone_reports WHERE device_id = ? AND tombstone_id = ?').get('device-a', 'camper-x')
    expect(row).toBeTruthy()
    expect(row.version).toBe(1)
    expect(row.reported_at).toBeTruthy()
  })

  it('leaves no row for a tombstone id the peer never reported', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const { tokenA } = setupAuthorizedDevicePair(dbA, dbB)

    await a.authenticateWith(b.peerId, {
      type: 'authenticate',
      token: tokenA,
      device_id: 'device-a',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedTombstones: [{ id: 'camper-x', version: 1 }],
    })

    const row = dbB.prepare('SELECT * FROM peer_tombstone_reports WHERE device_id = ? AND tombstone_id = ?').get('device-a', 'camper-never-seen')
    expect(row).toBeUndefined()
  })
})
