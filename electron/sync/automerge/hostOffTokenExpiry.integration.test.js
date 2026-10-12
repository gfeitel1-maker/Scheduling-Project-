// @vitest-environment node
//
// EVIDENCE test (pins observed v1 behaviour; changes no product code): what happens to two clients'
// sync when the Host (the device holding host_signing_key) is OFF and the 24h network token (localAuth.js
// TOKEN_TTL_MS) lapses. Real libp2p nodes, real authGate/mutualAuth admission, real Host-issued tokens
// (the harness's real join flow), real Automerge docs.
//
// CLOCK: Date.now is replaced by `realNow() + offsetMs`. Not vi.useFakeTimers: fake timers would freeze
// libp2p's own timers. Non-vacuity is proven in-test: the SAME setup admits and syncs at TTL-90s and
// refuses at TTL+60s, and the refusal reason is `invalid_token`, which only verifySessionToken's
// `Date.now() > exp` (localAuth.js) produces for a validly-signed token.
//
// TRUST SEED: the harness's clients never learn each other (devices is device-local; the Host is the only
// device each paired with). So BEFORE any expiry two clients refuse each other with `device_not_authorized`
// (test 0). To isolate the token-expiry question, tests A-D give each client an authorized `devices` row
// for the other, which is the minimum the admission gate needs (connectionAuth.js evaluateAuthenticate).
import { describe, it, expect, afterEach } from 'vitest'
import { setupTwoJoinedDevices, AmHost, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { verifySessionToken, attemptLogin } from '../../auth/localAuth.js'

const TTL_MS = 24 * 60 * 60 * 1000
const realNow = Date.now
let offsetMs = 0
const advanceTo = (ms) => { offsetMs = ms }
Date.now = () => realNow() + offsetMs

let trio
afterEach(async () => {
  offsetMs = 0
  if (trio) {
    await Promise.all([trio.host.stop(), trio.clientA.stop(), trio.clientB.stop(), trio.host2?.stop()])
    cleanupDirs([trio.tmpDir])
    trio = null
  }
})

const log = (line) => { process.stderr.write(`[HOSTOFF] ${line}\n`) }
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'))
const frame = (d) => ({ type: 'authenticate', token: d.token, device_id: d.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION })

function seedMutualTrust(a, b) {
  for (const [me, other] of [[a, b], [b, a]]) {
    me.db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(other.deviceId, 'peer')
    me.db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date(realNow()).toISOString(), other.deviceId)
  }
}

// Both directions are required (a node only sends to peers that authenticated to IT).
async function link(a, b) {
  if (!a.node.getPeers().includes(b.node.peerId)) await a.node.dial(b.node.getMultiaddrs()[0])
  a.node.setAuthToken(a.token); b.node.setAuthToken(b.token)
  const settle = (p) => p.then((r) => r, (e) => ({ type: 'threw', error: String(e?.message ?? e) }))
  const ab = await settle(a.node.authenticateWith(b.node.peerId, frame(a)))
  const ba = await settle(b.node.authenticateWith(a.node.peerId, frame(b)))
  return { ab, ba, admits: a.node.isPeerAuthenticated(b.node.peerId) && b.node.isPeerAuthenticated(a.node.peerId) }
}

async function reaches(from, to, id, ms = 3000) {
  await from.write({ entity: 'activities', entity_id: id, field: 'name', value: id })
  try { await waitFor(() => !!to.domainRow('activities', id), ms); return true } catch { return false }
}

async function restartPair(t, a, b) {
  await a.restart(`${t.tmpDir}/ua`, t.campId)
  await b.restart(`${t.tmpDir}/ub`, t.campId)
}

describe('Host OFF + 24h network token lapse (documents current v1 behaviour)', () => {
  it('0. documents current v1 behaviour: two freshly-joined clients do NOT admit each other even at t=0 (no expiry involved)', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    expect(claims(a.token)).toMatchObject({ type: 'camp' })
    expect(claims(a.token).exp - claims(a.token).iat).toBe(TTL_MS)
    await host.stop()
    const r = await link(a, b)
    log(`0 t=0 host off, no seed: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.ab).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(r.admits).toBe(false)
  }, 60000)

  it('A. documents current v1 behaviour: an ESTABLISHED client link survives past TTL, but a re-link after TTL is refused invalid_token', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    seedMutualTrust(a, b)
    const first = await link(a, b)
    log(`A t=0 link: ${JSON.stringify(first)}`)
    expect(first.admits).toBe(true)
    await host.stop()

    advanceTo(TTL_MS - 90_000)
    const preEdit = await reaches(a, b, 'a-pre-ttl')
    log(`A t=TTL-90s established link: C1 edit reaches C2 = ${preEdit}`)
    expect(preEdit).toBe(true)

    // control: a fresh RECONNECT just before TTL still admits (non-vacuity of the clock path)
    await restartPair(trio, a, b)
    const preRelink = await link(a, b)
    log(`A t=TTL-90s reconnect: ${JSON.stringify(preRelink)}`)
    expect(preRelink.admits).toBe(true)
    expect(await reaches(a, b, 'a-pre-ttl-relinked')).toBe(true)

    advanceTo(TTL_MS + 60_000)
    expect(verifySessionToken(a.db, a.token)).toBeNull()
    const postEstablished = await reaches(a, b, 'a-post-ttl-same-connection')
    log(`A t=TTL+60s SAME connection (admitted before expiry): C1 edit reaches C2 = ${postEstablished}`)
    expect(postEstablished).toBe(true)

    await restartPair(trio, a, b)
    const postRelink = await link(a, b)
    log(`A t=TTL+60s reconnect: A->B ${JSON.stringify(postRelink.ab)} B->A ${JSON.stringify(postRelink.ba)} admits=${postRelink.admits}`)
    expect(postRelink.ab).toEqual({ type: 'auth_failed', reason: 'invalid_token' })
    expect(postRelink.ba).toEqual({ type: 'auth_failed', reason: 'invalid_token' })
    expect(postRelink.admits).toBe(false)
    const postEdit = await reaches(a, b, 'a-post-ttl-relinked')
    log(`A t=TTL+60s after refused reconnect: C1 edit reaches C2 = ${postEdit}`)
    expect(postEdit).toBe(false)
  }, 120000)

  it('B. documents current v1 behaviour: C2 offline >24h with Host off cannot sync with C1 when it returns', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    seedMutualTrust(a, b)
    expect((await link(a, b)).admits).toBe(true)
    await host.stop()
    await b.node.stop()
    advanceTo(TTL_MS + 3_600_000)
    await a.restart(`${trio.tmpDir}/ua`, trio.campId)
    await a.write({ entity: 'activities', entity_id: 'b-while-away', field: 'name', value: 'x' })
    await b.restart(`${trio.tmpDir}/ub`, trio.campId)
    const r = await link(a, b)
    log(`B t=25h C2 returns: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.admits).toBe(false)
    expect(r.ab).toEqual({ type: 'auth_failed', reason: 'invalid_token' })
    let arrived = true
    try { await waitFor(() => !!b.domainRow('activities', 'b-while-away'), 3000) } catch { arrived = false }
    log(`B C1 edit made while C2 away reached C2 = ${arrived}`)
    expect(arrived).toBe(false)
  }, 120000)

  it('C. documents current v1 behaviour: process restart past TTL re-reads a dead token; the client has only a local PIN login, whose token the network refuses', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    seedMutualTrust(a, b)
    await host.stop()
    advanceTo(TTL_MS + 60_000)
    await restartPair(trio, a, b)
    expect(verifySessionToken(a.db, a.token)).toBeNull()
    const r = await link(a, b)
    log(`C restart past TTL, stored token: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.admits).toBe(false)
    expect(r.ab.reason).toBe('invalid_token')

    // The only re-login a client has is local (main.js login: "login is local on every device").
    const relogin = attemptLogin(a.db, { name: 'admin', pin: '1234', deviceId: a.deviceId })
    log(`C local PIN re-login result: ${JSON.stringify({ ...relogin, token: relogin.token ? claims(relogin.token).type + '-token' : undefined })}`)
    expect(claims(relogin.token).type).toBe('local')
    a.token = relogin.token
    const r2 = await link(a, b)
    log(`C after local re-login: A->B ${JSON.stringify(r2.ab)} admits=${r2.admits}`)
    // Not `local_token_not_valid_for_network` (4402): the peer cannot even verify a 'local' token, because
    // it holds no device_secret_identifier for this device, so it fails earlier as invalid_token.
    expect(r2.ab).toEqual({ type: 'auth_failed', reason: 'invalid_token' })
  }, 120000)

  it('D. documents current v1 behaviour: Host returning after expiry does not renew client tokens by itself', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b, tmpDir } = trio
    seedMutualTrust(a, b)
    const oldToken = a.token
    await host.stop()
    advanceTo(TTL_MS + 60_000)
    await restartPair(trio, a, b)

    trio.host2 = new AmHost(`${tmpDir}/host.db`)
    await trio.host2.start()
    const h = trio.host2
    expect(h.adminToken).toBeTruthy()
    log(`D Host back (new device token exp ${new Date(claims(h.adminToken).exp).toISOString()})`)

    a.hostPeerId = h.node.peerId
    await a.node.dial(h.node.getMultiaddrs()[0])
    await waitFor(() => a.node.getPeers().includes(h.node.peerId))
    a.node.setAuthToken(a.token)
    const toHost = await a.node.authenticateWith(h.node.peerId, frame(a)).catch((e) => ({ type: 'threw', error: String(e?.message ?? e) }))
    log(`D client -> returned Host authenticate with stored token: ${JSON.stringify(toHost)}`)
    expect(toHost).toEqual({ type: 'auth_failed', reason: 'invalid_token' })

    await new Promise((r) => setTimeout(r, 2500))
    // Admission is directional: A admitting the returned Host (the Host authenticated outward with its fresh
    // device token) is not the Host admitting A.
    const hostAdmitsA = h.node.isPeerAuthenticated(a.node.peerId)
    log(`D after 2.5s idle with Host online: A token unchanged = ${a.token === oldToken}, Host admits A = ${hostAdmitsA}, A admits Host = ${a.node.isPeerAuthenticated(h.node.peerId)}`)
    expect(a.token).toBe(oldToken)
    expect(hostAdmitsA).toBe(false)
    const toA = await reaches(h, a, 'd-host-edit')
    const fromA = await reaches(a, h, 'd-client-edit')
    log(`D Host edit reaches A = ${toA}; A edit reaches Host = ${fromA}`)
    expect(fromA).toBe(false)

    const r = await link(a, b)
    log(`D clients with Host back: A->B ${JSON.stringify(r.ab)} admits=${r.admits}`)
    expect(r.admits).toBe(false)
  }, 120000)
})
