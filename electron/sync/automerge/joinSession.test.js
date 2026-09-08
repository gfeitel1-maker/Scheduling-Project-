// @vitest-environment node
//
// The Stage 6 join flow (docs/adr/2026-09-08-libp2p-join-flow.md) against REAL
// SQLite databases and REAL libp2p nodes — the same posture as
// pairingLogin.test.js, and for the same reason: the thing under test is
// whether a device with NO camp row can become a device with one, which a
// mocked transport cannot answer.
//
// The joining device's db is deliberately left with no `camps` row and no
// `users` row. That is the whole point: every previous test in this directory
// (including pairingLogin.test.js's own `freshDb`) inserts a camps row into
// BOTH sides up front, which is exactly the test-only scaffolding Stage 6a
// stopped on.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { seedAllFromSqlite } from '../../automerge/seed.js'
import { ensureHostSigningKey } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'
import { startJoinSession } from './joinSession.js'

const HOST_CAMP_ID = 'camp-join-test'

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
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-join-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

let hostDb, joinerDb
let nodes = []
let sessions = []
beforeEach(() => {
  hostDb = freshDb('host')
  joinerDb = freshDb('joiner')
  // The Host is a real, bootstrapped camp.
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(HOST_CAMP_ID, 'Camp Kinneret')
  ensureHostSigningKey(hostDb)
  // The joiner gets NOTHING. No camps row, no users row.
})
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  sessions = []
  nodes = []
  for (const db of [hostDb, joinerDb]) {
    try { db.close() } catch { /* already closed */ }
  }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function startHost({ onPairingRequest } = {}) {
  const host = await startSyncNode({
    deviceId: 'host-device',
    db: hostDb,
    // Seeded from SQLite exactly as main.js's ensureAutomergeDocSeeded does on
    // a real Host. Starting from a bare genesis here would make the Host's own
    // camp invisible to the document and the joiner would (correctly) receive
    // nothing — the document is what carries identity now.
    doc: seedAllFromSqlite(hostDb, A.clone(createEmptyDoc())),
    onPairingRequest,
  })
  nodes.push(host)
  return host
}

async function startJoiner(host, { code = 'H7KB9WCE' } = {}) {
  const started = await startJoinSession({
    db: joinerDb,
    deviceId: 'joiner-device',
    deviceName: "Rivka's iPad",
    code,
    knownHost: host.getMultiaddrs()[0],
  })
  if (started.session) sessions.push(started.session)
  return started
}

describe('startJoinSession — refusals that must happen before any node starts', () => {
  it('reports a mistyped code as a typo rather than starting a doomed search', async () => {
    // A tag derived from nonsense matches nothing, and the director would see
    // "no camps found" — sending them to check their Wi-Fi over a mistyped
    // character. See joinCode.js's normalizeJoinCode.
    // NB 'NOTACODE' normalizes to a VALID code (8 chars, all in the alphabet)
    // — the check is structural, not a dictionary. These are the real failures.
    for (const bad of ['H7KB9WC', 'H7KB9WCEE', 'H7KB9WC!', 'H7KB9WCU', '', null, undefined]) {
      expect(await startJoinSession({ db: joinerDb, deviceId: 'joiner-device', code: bad }))
        .toEqual({ status: 'invalid_code' })
    }
  })

  it('refuses a device that already belongs to a camp', async () => {
    joinerDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('already-here', 'Other Camp')
    await expect(
      startJoinSession({ db: joinerDb, deviceId: 'joiner-device', code: 'H7KB9WCE' })
    ).rejects.toThrow(/already belongs to a camp/)
  })
})

describe('startJoinSession — a camp-less device joins for real', () => {
  it('pairs, signs in with a PIN, and receives its camp identity through the document', async () => {
    insertUser(hostDb, { camp_id: HOST_CAMP_ID, name: 'Director', pin: '1234', role: 'admin' })

    // The Host's director-approval hook, exactly as main.js wires it.
    let requested = null
    const host = await startHost({
      onPairingRequest: (deviceId, deviceName) => { requested = { deviceId, deviceName } },
    })

    const { status, session } = await startJoiner(host)
    expect(status).toBe('started')

    // Precondition worth asserting explicitly, because it is the thing every
    // earlier test scaffolded around.
    expect(joinerDb.prepare('SELECT id FROM camps LIMIT 1').get()).toBeUndefined()

    expect(await session.findHost()).toBe(host.peerId)

    const pairing = await session.requestPairing()
    expect(pairing.status).toBe('pending')
    // The director sees a device, named — not a key.
    expect(requested.deviceName).toBe("Rivka's iPad")

    // Director approves. main.js's approveDevice does exactly this pair of
    // steps: stamp the row, then deliver the decision.
    const secret = randomBytes(32).toString('hex')
    hostDb.prepare(
      "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
    ).run(new Date().toISOString(), secret, 'joiner-device')
    const decision = session.waitForPairingDecision()
    expect(await host.sendPairingApproved('joiner-device', secret)).toBe(true)

    // This is the assertion the whole slice turns on: before this change the
    // Host's dial-back landed on `unsupported_auth_message` and the joining
    // device never learned it had been approved.
    expect(await decision).toEqual({ status: 'approved', deviceSecretIdentifier: secret })

    const login = await session.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })
    expect(login.status).toBe('ok')
    expect(login.role).toBe('admin')

    // And the payoff: the camp arrives in the DOCUMENT (#325 models camps and
    // users) and projects into the joiner's own SQLite. No full_sync, no
    // seeding, nothing test-only.
    const camp = await session.waitForCamp()
    expect(camp).not.toBeNull()
    expect(camp.name).toBe('Camp Kinneret')
    expect(camp.id).toBe(HOST_CAMP_ID)

    // The user reached it too, so this device can sign in again next launch.
    const user = joinerDb.prepare('SELECT name, role FROM users WHERE name = ?').get('Director')
    expect(user).toMatchObject({ name: 'Director', role: 'admin' })
  })

  it('carries the camp\'s existing domain data across with the identity', async () => {
    insertUser(hostDb, { camp_id: HOST_CAMP_ID, name: 'Director', pin: '1234', role: 'admin' })
    const host = await startHost({ onPairingRequest: () => {} })

    // A camp that has already been set up, not an empty one.
    await host.applyLocal(applyWrite(host.getDoc(), {
      entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming',
    }))

    const { session } = await startJoiner(host)
    await session.findHost()
    await session.requestPairing()
    const secret = randomBytes(32).toString('hex')
    hostDb.prepare(
      "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
    ).run(new Date().toISOString(), secret, 'joiner-device')
    await host.sendPairingApproved('joiner-device', secret)
    await session.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })
    await session.waitForCamp()

    const activity = joinerDb.prepare('SELECT name FROM activities WHERE id = ?').get('act-1')
    expect(activity?.name).toBe('Swimming')
  })

  it('a denied device is told so, and never gets a camp', async () => {
    const host = await startHost({ onPairingRequest: () => {} })
    const { session } = await startJoiner(host)
    await session.findHost()
    await session.requestPairing()

    const decision = session.waitForPairingDecision()
    expect(await host.sendPairingDenied('joiner-device')).toBe(true)
    expect(await decision).toEqual({ status: 'denied' })
    expect(joinerDb.prepare('SELECT id FROM camps LIMIT 1').get()).toBeUndefined()
  })

  it('a wrong PIN fails the same way it fails everywhere else, and leaves no camp behind', async () => {
    insertUser(hostDb, { camp_id: HOST_CAMP_ID, name: 'Director', pin: '1234', role: 'admin' })
    const host = await startHost({ onPairingRequest: () => {} })
    const { session } = await startJoiner(host)
    await session.findHost()
    await session.requestPairing()
    const secret = randomBytes(32).toString('hex')
    hostDb.prepare(
      "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
    ).run(new Date().toISOString(), secret, 'joiner-device')
    await host.sendPairingApproved('joiner-device', secret)

    const login = await session.login({ name: 'Director', pin: 'wrong', deviceSecretIdentifier: secret })
    expect(login.status).toBe('failed')
    expect(joinerDb.prepare('SELECT id FROM camps LIMIT 1').get()).toBeUndefined()
  })

  // The failure mode the ADR names as most likely to be got wrong: under the
  // op-log, "logged in" and "has a camp" were one instant (full_sync was a
  // single message). Under a CRDT they are two, and the gap is a state a
  // device can genuinely get stuck in.
  it('reports a bounded wait rather than spinning when no document arrives', async () => {
    const host = await startHost({ onPairingRequest: () => {} })
    const started = await startJoinSession({
      db: joinerDb,
      deviceId: 'joiner-device',
      code: 'H7KB9WCE',
      knownHost: host.getMultiaddrs()[0],
      documentWaitMs: 150,
    })
    sessions.push(started.session)
    // Never logs in, so is never admitted, so no document can arrive.
    expect(await started.session.waitForCamp()).toBeNull()
    expect(joinerDb.prepare('SELECT id FROM camps LIMIT 1').get()).toBeUndefined()
  })

  it('gives up on discovery rather than waiting forever when nobody answers the code', async () => {
    const started = await startJoinSession({
      db: joinerDb,
      deviceId: 'joiner-device',
      code: 'H7KB9WCE',
      discoveryWaitMs: 150,
    })
    sessions.push(started.session)
    expect(await started.session.findHost()).toBeNull()
  })
})
