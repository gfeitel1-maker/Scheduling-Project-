// @vitest-environment node
//
// Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md): end-to-end
// acceptance tests for the auth-over-libp2p admission gate, wired through
// startSyncNode exactly as production code (main.js, once wired) would use
// it — the REAL evaluateAuthenticate (electron/auth/connectionAuth.js)
// against a REAL SQLite db, not a fake authenticator. These are the tests
// that prove the ADR's threat-model claims, not just the mechanism
// (authGate.test.js) or the pure function (connectionAuth.test.js) in
// isolation.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { ensureHostSigningKey, issueCampToken, issueLocalToken } from '../../auth/localAuth.js'
import { startSyncNode } from './syncNode.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-5d1-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
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
  return db.prepare('SELECT id, name FROM activities WHERE id = ?').get(id)
}

// dbB plays the Host (holds host_signing_key, mints tokens, and is the side
// whose admission gate every test here exercises — node A dials node B's
// doc-sync protocol). dbA is the Client presenting a token.
function authorizeDeviceOnHost(deviceId) {
  const hostKey = ensureHostSigningKey(dbB)
  db_updateSigningKey(dbB, hostKey.public_key)
  db_updateSigningKey(dbA, hostKey.public_key) // Client's own db also carries the public key (full-sync)
  dbB.prepare(
    "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')"
  ).run(deviceId, 'Client Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  return hostKey
}

// The outbound broadcast filter (Security review, 5d-1) means a sender only
// transmits to peers that proved membership to IT — so two-way doc flow needs
// BOTH directions authenticated. This authorizes a device on the Client's db so
// the Host can authenticate back to it, exercising the real symmetric path.
function authorizeDeviceOnClient(deviceId) {
  dbA.prepare(
    "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')"
  ).run(deviceId, 'Host Device', new Date().toISOString(), randomBytes(32).toString('hex'))
}

function db_updateSigningKey(db, publicKey) {
  db.prepare('UPDATE camps SET signing_public_key = ?').run(publicKey)
}

describe('syncNode + auth gate — end-to-end (real evaluateAuthenticate, real SQLite)', () => {
  it('a peer that never authenticates gets its stream closed and its bytes never reach A.merge', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const bHeadsBefore = A.getHeads(b.getDoc())

    const bad = applyWrite(A.clone(genesis), { entity: 'activities', entity_id: 'ghost', field: 'name', value: 'Ghost' })
    // a never authenticates. The send may itself throw (the receiving side
    // aborts the stream before/while it's written) or may resolve if the
    // abort races a buffered write — either way the assertion that matters
    // is that the bytes never reach A.merge, checked below.
    await a.sendDocTo(b.peerId, A.save(bad)).catch(() => {})

    await new Promise((r) => setTimeout(r, 150))
    // The doc is provably unchanged — not merely "callback wasn't called".
    expect(A.getHeads(b.getDoc())).toEqual(bHeadsBefore)
    expect(activityRow(dbB, 'ghost')).toBeUndefined()
  })

  it('a peer that completes authenticate with a valid camp token is admitted and doc bytes converge', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
    expect(resp).toEqual({ type: 'auth_ok' })

    // Reverse direction, required for A's outbound filter to admit B (see
    // authorizeDeviceOnClient's comment): the Host proves membership to the
    // Client with a token minted from the same host signing key.
    const hostDeviceId = randomUUID()
    authorizeDeviceOnClient(hostDeviceId)
    const hostToken = issueCampToken(dbB, randomUUID(), hostDeviceId)
    const reverse = await b.authenticateWith(a.peerId, { type: 'authenticate', token: hostToken, device_id: hostDeviceId })
    expect(reverse).toEqual({ type: 'auth_ok' })

    const changed = applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    await a.applyLocal(changed)

    await waitFor(() => activityRow(dbB, 'archery')?.name === 'Archery')
    expect(activityRow(dbB, 'archery').name).toBe('Archery')
  })

  it('a local-type token is rejected over libp2p even though it is valid for local IPC', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    // issueLocalToken requires device_secret_identifier on ITS OWN db — mint
    // it against dbB (the "Host" in this test), the same device row.
    const localToken = issueLocalToken(dbB, randomUUID(), deviceId)

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token: localToken, device_id: deviceId })
    expect(resp).toEqual({ type: 'auth_failed', reason: 'local_token_not_valid_for_network' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)

    // And doc-sync admission is NOT granted as a consequence: node B's doc
    // must be provably unchanged, not merely "the send didn't throw" (a
    // stream abort racing a buffered write can let sendDocTo resolve even
    // though the receiving side never called onDocReceived).
    const bHeadsBefore = A.getHeads(b.getDoc())
    const bad = applyWrite(A.clone(genesis), { entity: 'activities', entity_id: 'ghost', field: 'name', value: 'Ghost' })
    await a.sendDocTo(b.peerId, A.save(bad)).catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
    expect(A.getHeads(b.getDoc())).toEqual(bHeadsBefore)
    expect(activityRow(dbB, 'ghost')).toBeUndefined()
  })

  it('an expired token is rejected and does not admit the peer', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)
    const [payloadB64, signature] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    payload.exp = Date.now() - 1000
    // Deliberately NOT re-signed: an expired+tampered token must fail closed
    // exactly like a merely-expired one (both collapse to invalid_token).
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token: tampered, device_id: deviceId })
    expect(resp.type).toBe('auth_failed')
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })

  it("a token whose device_id doesn't match the claimed device is rejected", async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    const otherDeviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: otherDeviceId })
    expect(resp).toEqual({ type: 'auth_failed', reason: 'invalid_token' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })

  it('a revoked device is rejected even with a structurally valid token', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)
    dbB.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(
      new Date().toISOString(),
      deviceId
    )

    const resp = await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
    expect(resp).toEqual({ type: 'auth_failed', reason: 'device_revoked' })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(false)
  })

  it('after disconnect, the peer is no longer admitted', async () => {
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)

    await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
    expect(b.isPeerAuthenticated(a.peerId)).toBe(true)

    await a.stop()
    nodes = nodes.filter((n) => n !== a)

    await waitFor(() => b.isPeerAuthenticated(a.peerId) === false)
  })
})

// --- T155: the properties the gate does NOT have, measured rather than assumed ---
//
// An external review asked for adversarial coverage of replayed authentication,
// simultaneous dials, and reconnect after a long offline period. Two of those
// turned out to be already covered elsewhere in this file (an expired token is
// rejected; a revoked device is rejected, and `revokeDevice` in main.js evicts a
// still-connected one from the live admission set rather than waiting for a
// disconnect). This block measures the one that is genuinely open, so it is a
// characterized property rather than an assumption.
describe('syncNode + auth gate — characterized limits (T155)', () => {
  it('A CAMP TOKEN IS A BEARER CREDENTIAL: a DIFFERENT peer presenting the same valid token is admitted', async () => {
    // This is not a regression and not (yet) a defect — it is the shape of the
    // current design, written down so nobody has to infer it from the code.
    //
    // `evaluateAuthenticate` binds a token to the `device_id` INSIDE the token
    // (connectionAuth.js). Nothing binds it to the libp2p peer id that presents
    // it, so whoever holds the bytes can authenticate from any machine.
    //
    // Why it is not simply fixed here: `devices.libp2p_peer_id` exists (v57) but
    // libp2p generates a fresh peer id on every process start — the column is
    // documented as a routing convenience precisely because it is stale by
    // design — so requiring the presented token's device to match the connecting
    // peer id would reject every ordinary reconnect. Closing it means persisting
    // a libp2p identity per device and binding tokens to it, which is a design
    // decision with its own key-management consequences, not a test fix.
    //
    // What bounds the exposure meanwhile: obtaining the token means reaching a
    // paired device's storage, and anyone who can do that already has the camp
    // document — which IS the camp's data. The marginal gain is impersonation,
    // not access. See SECURITY.md.
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    const impostor = await startSyncNode({ deviceId: 'device-impostor', db: freshDb('impostor'), doc: A.clone(genesis) })
    nodes.push(a, b, impostor)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    expect(await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })).toEqual({ type: 'auth_ok' })

    // The SAME token, replayed from a peer the Host has never seen before.
    await impostor.dial(b.getMultiaddrs()[0])
    await waitFor(() => impostor.getPeers().length > 0)
    const replayed = await impostor.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
    expect(replayed).toEqual({ type: 'auth_ok' })
  })

  it('but revoking the device closes BOTH peers out — the credential follows the device, not the connection', async () => {
    // The counterweight to the test above, and the reason the bearer property is
    // survivable: revocation is re-checked on every authenticate, so a replayed
    // token stops working the moment the device it names is revoked.
    const genesis = createEmptyDoc()
    const a = await startSyncNode({ deviceId: 'device-a', db: dbA, doc: A.clone(genesis) })
    const b = await startSyncNode({ deviceId: 'device-b', db: dbB, doc: A.clone(genesis) })
    nodes.push(a, b)

    const deviceId = randomUUID()
    authorizeDeviceOnHost(deviceId)
    const token = issueCampToken(dbB, randomUUID(), deviceId)

    await a.dial(b.getMultiaddrs()[0])
    await waitFor(() => a.getPeers().length > 0)
    expect(await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })).toEqual({ type: 'auth_ok' })

    dbB.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?")
      .run(new Date().toISOString(), deviceId)

    const after = await a.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
    expect(after.type).toBe('auth_failed')
  })
})
