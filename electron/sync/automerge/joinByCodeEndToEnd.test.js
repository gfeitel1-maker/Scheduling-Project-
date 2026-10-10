// @vitest-environment node
//
// Join-by-code end to end, on REAL libp2p nodes and REAL SQLite, with the joining
// device finding the Host BY THE CODE-DERIVED TAG ONLY — no injected address.
// Two defects a packaged two-instance run found (build 714d1b32), each pinned here:
//
//  1. Nothing made the Host advertise joinDiscoveryTag(code), so the joiner's
//     search always ended "No camp answered that code" (ADR 2026-09-15 §2: the
//     Host advertises the join tag while — and only while — Add-a-device is open).
//  2. After joining, signing in on the joined device threw "issueLocalToken: this
//     device has no device_secret_identifier — pair it first": the join stored the
//     camp and the Host's device row, but never this device's own pairing secret.
//
// Discovery runs over an in-process TAG BUS standing in for mDNS (which needs a
// real multicast interface; CI has none — see discovery.js). The bus keeps
// mDNS's one property that matters here: a node only ever finds nodes started on
// the SAME service tag. Both tags are derived by the production code on each side.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { seedAllFromSqlite } from '../../automerge/seed.js'
import { ensureHostSigningKey, attemptLogin, verifySessionToken } from '../../auth/localAuth.js'
import { authorize } from '../../auth/authorize.js'
import { signAuthFields } from '../../auth/authSignature.js'
import { startSyncNode } from './syncNode.js'
import { startJoinSession } from './joinSession.js'
import { mintJoinSecret, joinDiscoveryTag } from '../joinCode.js'

const CAMP_ID = 'camp-e2e-join'

function createTagBus() {
  const live = new Map() // tag -> Set<{ service, components }>
  const info = (c) => ({ id: c.peerId, multiaddrs: c.addressManager.getAddresses() })
  const announce = (to, about) => to.service.dispatchEvent(new CustomEvent('peer', { detail: info(about.components) }))
  return (tag) => (components) => {
    const service = new EventTarget()
    const me = { service, components }
    let timer = null
    // Like mDNS's periodic query: while started, keep hearing every node on this tag.
    service.start = () => {
      const peers = live.get(tag) ?? new Set()
      live.set(tag, peers)
      peers.add(me)
      timer = setInterval(() => {
        for (const other of live.get(tag) ?? []) if (other !== me) announce(me, other)
      }, 100)
    }
    service.stop = () => { clearInterval(timer); live.get(tag)?.delete(me) }
    return service
  }
}

function insertUser(db, { name, pin, role }) {
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = scryptSync(pin, salt, 64).toString('hex')
  const auth_sig = signAuthFields(db, { id, role, pin_hash, pin_salt: salt, cred_version: 1 })
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(id, CAMP_ID, name, pin_hash, salt, role, auth_sig)
}

let files = []
const freshDb = (tag) => {
  const f = path.join(os.tmpdir(), `shoresh-e2ejoin-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

let hostDb, joinerDb, bus, nodes, sessions, code, windowOpen
beforeEach(() => {
  hostDb = freshDb('host')
  joinerDb = freshDb('joiner')
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp Tag')
  ensureHostSigningKey(hostDb)
  insertUser(hostDb, { name: 'Director', pin: '1234', role: 'admin' })
  bus = createTagBus()
  nodes = []
  sessions = []
  code = mintJoinSecret()
  windowOpen = true
})
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  for (const db of [hostDb, joinerDb]) { try { db.close() } catch { /* closed */ } }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

// The Host as main.js runs it: a node with the live window/secret handles, and the
// director opening Add a device (setJoinWindow -> node.setJoinCode).
async function startHostWithWindowOpen() {
  const host = await startSyncNode({
    deviceId: 'host-device',
    db: hostDb,
    doc: seedAllFromSqlite(hostDb, A.clone(createEmptyDoc())),
    onPairingRequest: () => {},
    isJoinWindowOpen: () => windowOpen,
    getJoinSecret: () => (windowOpen ? code : null),
    joinDiscoveryFor: bus,
  })
  nodes.push(host)
  await host.setJoinCode?.(code)
  return host
}

// The joiner exactly as JoinByCodeScreen drives it, except mDNS -> the tag bus.
async function startJoinerByCodeOnly({ discoveryWaitMs = 3000 } = {}) {
  const { session } = await startJoinSession({
    db: joinerDb,
    deviceId: 'joiner-device',
    deviceName: 'New iPad',
    code,
    peerDiscovery: [bus(joinDiscoveryTag(code))],
    listen: ['/ip4/127.0.0.1/tcp/0'],
    discoveryWaitMs,
  })
  sessions.push(session)
  return session
}

async function approveAndJoin(host, session) {
  await session.requestPairing()
  const secret = randomBytes(32).toString('hex')
  hostDb.prepare(
    "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
  ).run(new Date().toISOString(), secret, 'joiner-device')
  const decision = session.waitForPairingDecision()
  await host.sendPairingApproved('joiner-device', secret)
  const approved = await decision
  expect(approved.status).toBe('approved')
  const login = await session.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: approved.deviceSecretIdentifier })
  expect(login.status).toBe('ok')
  expect(await session.waitForCamp()).not.toBeNull()
  return login
}

describe('join by code — discovered by the join tag alone', () => {
  it('BUG 1: the joiner finds the Host by the code tag while Add a device is open', async () => {
    const host = await startHostWithWindowOpen()
    const session = await startJoinerByCodeOnly()
    expect(await session.findHost()).toBe(host.peerId)
  }, 20_000)

  it('non-vacuous: once the window closes, the same code finds nobody', async () => {
    const host = await startHostWithWindowOpen()
    windowOpen = false
    await host.setJoinCode?.(null)
    const session = await startJoinerByCodeOnly({ discoveryWaitMs: 800 })
    expect(await session.findHost()).toBeNull()
  }, 20_000)

  it('full path: discover by tag, approve, sign in ON the joined device, and a doc edit syncs', async () => {
    const host = await startHostWithWindowOpen()
    const session = await startJoinerByCodeOnly()
    expect(await session.findHost()).toBe(host.peerId)
    const join = await approveAndJoin(host, session)

    // Signed in once: the join's own session is what the app adopts (useDeviceMode.completeJoin),
    // so it must verify and authorize on the joined device itself.
    expect(verifySessionToken(joinerDb, join.token)).toMatchObject({ deviceId: 'joiner-device' })
    expect(authorize({ db: joinerDb, token: join.token, action: 'devices.read' }).allowed).toBe(true)

    // The joined device signs in locally, as LoginScreen does on every later launch.
    const local = await attemptLogin(joinerDb, { name: 'Director', pin: '1234', deviceId: 'joiner-device' })
    expect(local.token).toBeTruthy()
    expect(verifySessionToken(joinerDb, local.token)).toMatchObject({ deviceId: 'joiner-device' })
    expect(authorize({ db: joinerDb, token: local.token, action: 'devices.read' }).allowed).toBe(true)

    await host.applyLocal(applyWrite(host.getDoc(), { entity: 'activities', entity_id: 'act-e2e', field: 'name', value: 'Archery' }))
    await host.broadcastLocalDoc()
    const deadline = Date.now() + 5000
    let row
    while (Date.now() < deadline && !(row = joinerDb.prepare('SELECT name FROM activities WHERE id = ?').get('act-e2e'))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(row?.name).toBe('Archery')
  }, 30_000)
})

describe('join by code — sign-in after join, address injected (isolates bug 2)', () => {
  it('BUG 2: the joined device can sign in locally and its session authorizes', async () => {
    const host = await startHostWithWindowOpen()
    const { session } = await startJoinSession({
      db: joinerDb, deviceId: 'joiner-device', deviceName: 'New iPad', code,
      knownHost: host.getMultiaddrs()[0],
    })
    sessions.push(session)
    await session.findHost()
    await approveAndJoin(host, session)

    const local = await attemptLogin(joinerDb, { name: 'Director', pin: '1234', deviceId: 'joiner-device' })
    expect(local.token).toBeTruthy()
    expect(authorize({ db: joinerDb, token: local.token, action: 'devices.read' }).allowed).toBe(true)
  }, 30_000)
})
