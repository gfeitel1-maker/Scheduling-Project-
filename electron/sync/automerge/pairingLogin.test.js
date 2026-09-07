// @vitest-environment node
//
// Stage 5d-2b (docs/adr/2026-09-06-libp2p-membership-mapping.md §1/§2): the
// pairing_request/login handshake over /shoresh/auth/1.0.0, plus mutual
// (both-ways) authentication and the wireMutualAuth production-wiring
// module — all against REAL SQLite dbs and REAL libp2p transports, exactly
// like syncNode.test.js's harness, so nothing here is a fake-decision-only
// proof (that's authGate.test.js's job).
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken, issueLocalToken, issueDeviceToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { wireMutualAuth } from './mutualAuth.js'

// Inserts a user directly (bypassing localAuth.js's createUser, which
// requires a live op-log `write` callback — overkill for these tests, which
// only need attemptLogin's PIN check to succeed). Mirrors createUser's own
// hashing exactly (scryptSync, 64-byte key) so evaluateLogin's real
// attemptLogin call verifies it.
function insertUser(db, { camp_id, name, pin, role }) {
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = scryptSync(pin, salt, 64).toString('hex')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, camp_id, name, pin_hash, salt, role)
  return { id, name, role }
}

let files = []
function freshDb(tag, campId = 'camp-1') {
  const f = path.join(os.tmpdir(), `shoresh-5d2b-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  return db
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

describe('pairing_request + login over libp2p (Stage 5d-2b)', () => {
  it('first-time pairing_request gets pairing_pending, then approval on a NEW stream, then login succeeds', async () => {
    // dbA is the Host: holds the signing key, has the user account.
    ensureHostSigningKey(dbA)
    insertUser(dbA, { camp_id: 'camp-1', name: 'Director', pin: '1234', role: 'admin' })

    const genesis = createEmptyDoc()
    const host = await startSyncNode({ deviceId: 'host-device', db: dbA, doc: A.clone(genesis) })
    const client = await startSyncNode({ deviceId: 'client-device', db: dbB, doc: A.clone(genesis) })
    nodes.push(host, client)

    await client.dial(host.getMultiaddrs()[0])
    await waitFor(() => client.getPeers().length > 0)

    const pending = await client.authenticateWith(host.peerId, {
      type: 'pairing_request',
      device_id: 'client-device',
      device_name: 'Client Laptop',
    })
    expect(pending).toEqual({ type: 'pairing_pending' })

    // Director approves — mirrors main.js's approveDevice handler.
    const secret = randomBytes(32).toString('hex')
    dbA.prepare(
      "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
    ).run(new Date().toISOString(), secret, 'client-device')
    const delivered = await host.sendPairingApproved('client-device', secret)
    expect(delivered).toBe(true)

    const loginReply = await client.authenticateWith(host.peerId, {
      type: 'login',
      device_id: 'client-device',
      device_secret_identifier: secret,
      name: 'Director',
      pin: '1234',
    })
    expect(loginReply.type).toBe('login_ok')
    expect(loginReply.userId).toBeTruthy()
    expect(loginReply.role).toBe('admin')

    // libp2p_peer_id was written on the Host's own row for the Client on
    // both the pairing_request's implicit devices-upsert and the login.
    const row = dbA.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('client-device')
    expect(row.libp2p_peer_id).toBe(client.peerId)
  })

  it('an already-approved device gets pairing_approved immediately (idempotent re-delivery)', async () => {
    ensureHostSigningKey(dbA)
    const secret = randomBytes(32).toString('hex')
    dbA.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status, device_secret_identifier) VALUES (?, ?, ?, 'authorized', ?)"
    ).run('client-device', 'Client', new Date().toISOString(), secret)

    const genesis = createEmptyDoc()
    const host = await startSyncNode({ deviceId: 'host-device', db: dbA, doc: A.clone(genesis) })
    const client = await startSyncNode({ deviceId: 'client-device', db: dbB, doc: A.clone(genesis) })
    nodes.push(host, client)

    await client.dial(host.getMultiaddrs()[0])
    await waitFor(() => client.getPeers().length > 0)

    const reply = await client.authenticateWith(host.peerId, {
      type: 'pairing_request',
      device_id: 'client-device',
      device_name: 'Client',
    })
    expect(reply).toEqual({ type: 'pairing_approved', device_secret_identifier: secret })
  })

  it('wrong PIN is rejected and lockout applies exactly like the WS path (same attemptLogin)', async () => {
    ensureHostSigningKey(dbA)
    insertUser(dbA, { camp_id: 'camp-1', name: 'Director', pin: '1234', role: 'admin' })
    const secret = randomBytes(32).toString('hex')
    dbA.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status, device_secret_identifier) VALUES (?, ?, ?, 'authorized', ?)"
    ).run('client-device', 'Client', new Date().toISOString(), secret)

    // Stage 5d-2b re-review (HIGH finding fix): authGate.js now rate-limits
    // 'login' frames on the same connection (LOGIN_MIN_INTERVAL_MS), exactly
    // like syncServer.js's WS path already did. This test is specifically
    // about attemptLogin's OWN lockout (a distinct, longer-lived mechanism —
    // see localAuth.js's LOGIN_MAX_ATTEMPTS/LOGIN_LOCKOUT_MS), so it advances
    // an injected fake clock well past LOGIN_MIN_INTERVAL_MS between attempts
    // so the new per-connection throttle never interferes with what it's
    // actually testing.
    let t = 1_000_000
    const genesis = createEmptyDoc()
    const host = await startSyncNode({ deviceId: 'host-device', db: dbA, doc: A.clone(genesis), now: () => t })
    const client = await startSyncNode({ deviceId: 'client-device', db: dbB, doc: A.clone(genesis), now: () => t })
    nodes.push(host, client)

    await client.dial(host.getMultiaddrs()[0])
    await waitFor(() => client.getPeers().length > 0)

    let lastReply
    for (let i = 0; i < 5; i++) {
      t += 1000
      lastReply = await client.authenticateWith(host.peerId, {
        type: 'login',
        device_id: 'client-device',
        device_secret_identifier: secret,
        name: 'Director',
        pin: 'wrong',
      })
      expect(lastReply.type).toBe('login_failed')
    }

    // 5th bad attempt should trip the SAME lockout attemptLogin enforces for
    // the WS path (LOGIN_MAX_ATTEMPTS) — proving evaluateLogin really is
    // attemptLogin, not a re-implementation of it.
    t += 1000
    const lockedReply = await client.authenticateWith(host.peerId, {
      type: 'login',
      device_id: 'client-device',
      device_secret_identifier: secret,
      name: 'Director',
      pin: '1234', // even the CORRECT pin is rejected while locked
    })
    expect(lockedReply.type).toBe('login_failed')
    expect(lockedReply.locked).toBe(true)
  })
})

describe('mutual authentication over libp2p (Stage 5d-2b production wiring)', () => {
  it('two nodes converge BOTH WAYS when wireMutualAuth authenticates each to the other', async () => {
    const hostKey = ensureHostSigningKey(dbA)
    for (const db of [dbA, dbB]) {
      db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'device-a', 'Device A', new Date().toISOString()
      )
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'device-b', 'Device B', new Date().toISOString()
      )
    }
    const tokenA = issueCampToken(dbA, 'user-a', 'device-a')
    const tokenB = issueCampToken(dbA, 'user-b', 'device-b')

    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    // Each node runs the SAME production wiring against the other — this is
    // what makes admission symmetric in practice: no special-cased "and now
    // dial back" step, just both sides independently doing the identical
    // thing.
    const mutualA = wireMutualAuth(a, { deviceId: 'device-a', getToken: () => tokenA })
    const mutualB = wireMutualAuth(b, { deviceId: 'device-b', getToken: () => tokenB })

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    await waitFor(() => b.getPeers().length > 0)

    // In production, mDNS discovery (Stage 5d-2a's createMdnsDiscovery,
    // wired into transport.js's peerDiscovery option in main.js) fires
    // wireMutualAuth's onPeerDiscovery listener independently on EACH side
    // once it discovers the other. This test exercises real dial/
    // authenticate, so it drives that same entry point directly on both
    // sides (mutualAuth.test.js proves the discovery-event wiring itself
    // with a fake handle) rather than standing up real mDNS in CI.
    await mutualA.tryAuthenticate(b.peerId)
    await mutualB.tryAuthenticate(a.peerId)

    await waitFor(() => b.isPeerAuthenticated(a.peerId))
    await waitFor(() => a.isPeerAuthenticated(b.peerId))

    // A edits -> B projects it (A -> B direction).
    const docA = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })
    await a.applyLocal(docA)
    await waitFor(() => !!activityRow(dbB, 'act-1'))
    expect(activityRow(dbB, 'act-1').name).toBe('Swim')

    // B edits -> A projects it (B -> A direction) — proves BOTH directions,
    // not just the one the test happened to dial first.
    const docB = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Archery' })
    await b.applyLocal(docB)
    await waitFor(() => !!activityRow(dbA, 'act-2'))
    expect(activityRow(dbA, 'act-2').name).toBe('Archery')
  })

  // Finding 2 fix, end-to-end proof (Stage 5d-2b re-review): before this fix,
  // dbA (the Host) could mint issueCampToken(dbA, null, deviceA) but that
  // token could NEVER verify (verifySessionToken always rejects a null
  // userId) — so the Host side of mutual auth was silently, permanently
  // broken; only a Client's real user-backed camp token ever worked. This
  // reproduces the real production shape: the Host self-issues a device
  // token (exactly as main.js's chooseMode/startAutomergeSyncNodeIfEnabled
  // now do via issueDeviceToken) with NO user logged in on that side, while
  // the Client authenticates with an ordinary user-backed camp token — and
  // proves convergence works in BOTH directions.
  it('Host self-issued device token + Client camp token mutually authenticate and converge BOTH ways', async () => {
    const hostKey = ensureHostSigningKey(dbA)
    for (const db of [dbA, dbB]) {
      db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'host-device', 'Host', new Date().toISOString()
      )
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'client-device', 'Client', new Date().toISOString()
      )
    }
    const hostDeviceToken = issueDeviceToken(dbA, 'host-device')
    const clientCampToken = issueCampToken(dbA, 'user-client', 'client-device')

    const genesis = createEmptyDoc()
    const host = await startSyncNode({ deviceId: 'host-device', db: dbA, doc: A.clone(genesis) })
    const client = await startSyncNode({ deviceId: 'client-device', db: dbB, doc: A.clone(genesis) })
    nodes.push(host, client)

    const mutualHost = wireMutualAuth(host, { deviceId: 'host-device', getToken: () => hostDeviceToken })
    const mutualClient = wireMutualAuth(client, { deviceId: 'client-device', getToken: () => clientCampToken })

    await host.dial(client.getMultiaddrs()[0])
    await waitFor(() => host.getPeers().length > 0)
    await waitFor(() => client.getPeers().length > 0)

    await mutualHost.tryAuthenticate(client.peerId)
    await mutualClient.tryAuthenticate(host.peerId)

    await waitFor(() => client.isPeerAuthenticated(host.peerId))
    await waitFor(() => host.isPeerAuthenticated(client.peerId))

    // Host -> Client direction.
    const docHost = applyWrite(host.getDoc(), { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })
    await host.applyLocal(docHost)
    await waitFor(() => !!activityRow(dbB, 'act-1'))
    expect(activityRow(dbB, 'act-1').name).toBe('Swim')

    // Client -> Host direction.
    const docClient = applyWrite(client.getDoc(), { entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Archery' })
    await client.applyLocal(docClient)
    await waitFor(() => !!activityRow(dbA, 'act-2'))
    expect(activityRow(dbA, 'act-2').name).toBe('Archery')
  })

  it('the one-directional trap: authenticating only ONE way sends fine but silently receives nothing', async () => {
    const hostKey = ensureHostSigningKey(dbA)
    for (const db of [dbA, dbB]) {
      db.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'device-a', 'Device A', new Date().toISOString()
      )
      db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')").run(
        'device-b', 'Device B', new Date().toISOString()
      )
    }
    const tokenA = issueCampToken(dbA, 'user-a', 'device-a')

    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    // ONLY A authenticates to B (A dials B's auth protocol and proves
    // itself). This admits A into B's OWN authenticatedPeers set — the set
    // that gets POPULATED belongs to whichever side ran onAuthenticate,
    // i.e. B here, not A. A's own authenticatedPeers set (populated only by
    // someone authenticating THEMSELVES to A) stays empty, because nobody
    // has done that. This single call is exactly what a naive "Client
    // dials Host on startup and authenticates as itself, done" production
    // wiring would do if it forgot the Host's own reciprocal call.
    await a.authenticateWith(b.peerId, { type: 'authenticate', token: tokenA, device_id: 'device-a' })
    await waitFor(() => b.isPeerAuthenticated(a.peerId))
    expect(a.isPeerAuthenticated(b.peerId)).toBe(false) // the missing half

    // The consequence is worse than a one-way break: `broadcastDoc` on a
    // sender filters by the SENDER's OWN authenticatedPeers (peers who have
    // proven membership TO the sender), and the receiving side's PROTO
    // handler separately re-checks the SAME thing on the RECEIVER's own
    // set. So EITHER a working transfer requires the recipient to already
    // trust the sender (sender-side filter) AND the sender to already be
    // trusted by the recipient (receiver-side gate) — i.e. genuinely
    // mutual proof, in BOTH directions, for a transfer in EITHER direction
    // to succeed at all. With only "A authenticates to B" done:
    //
    //   A -> B: A's own broadcastDoc filters using A's OWN set (empty) —
    //           A never even attempts to send. Nothing to catch on B's side
    //           because nothing left A's side.
    const docA = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })
    await a.applyLocal(docA)

    //   B -> A: B's own broadcastDoc filters using B's OWN set (contains A,
    //           since A authenticated to B above) — B DOES attempt to send.
    //           But A's inbound PROTO handler re-checks A's OWN set (still
    //           empty, since B never authenticated to A) and aborts the
    //           stream. B's send call itself never throws (broadcastDoc's
    //           per-peer .catch swallows it) — the doc simply never lands.
    const docB = applyWrite(b.getDoc(), { entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Archery' })
    await b.applyLocal(docB)

    await new Promise((r) => setTimeout(r, 300)) // generous settle window
    // Neither side received anything — this IS the "sends fine and
    // silently receives nothing" failure shape from the recipient's own
    // point of view on each side (B's applyLocal call completes without
    // throwing; A's data just never arrives), caught here by a test rather
    // than by a director staring at a schedule that never updates.
    expect(activityRow(dbB, 'act-1')).toBeUndefined()
    expect(activityRow(dbA, 'act-2')).toBeUndefined()
  })

  it('a "local" token is rejected over libp2p, exactly like the WS transport', async () => {
    ensureHostSigningKey(dbA)
    dbA.prepare(
      "INSERT INTO devices (id, name, authorized_at, pairing_status, device_secret_identifier) VALUES (?, ?, ?, 'authorized', ?)"
    ).run('client-device', 'Client', new Date().toISOString(), randomBytes(32).toString('hex'))
    const localToken = issueLocalToken(dbA, 'user-x', 'client-device')

    const genesis = createEmptyDoc()
    const host = await startSyncNode({ deviceId: 'host-device', db: dbA, doc: A.clone(genesis) })
    const client = await startSyncNode({ deviceId: 'client-device', db: dbB, doc: A.clone(genesis) })
    nodes.push(host, client)

    await client.dial(host.getMultiaddrs()[0])
    await waitFor(() => client.getPeers().length > 0)

    const reply = await client.authenticateWith(host.peerId, { type: 'authenticate', token: localToken, device_id: 'client-device' })
    expect(reply.type).toBe('auth_failed')
    expect(reply.reason).toBe('local_token_not_valid_for_network')
    expect(host.isPeerAuthenticated(client.peerId)).toBe(false)
  })
})
