// @vitest-environment node
//
// ACCEPTANCE test for docs/adr/2026-10-12-shared-signed-device-roster.md (T376): with the Host (the device
// holding host_signing_key) OFF, two enrolled clients admit each other and keep syncing, with no renewal and
// no dependence on the 24h network token (localAuth.js TOKEN_TTL_MS). Real libp2p nodes, real authGate/
// mutualAuth admission, the harness's real join flow (so the roster comes from the Host's login mint, never
// hand-inserted rows), real Automerge docs. Supersedes hostOffTokenExpiry.integration.test.js (commit
// 565dc85f), which pinned the pre-roster behaviour these tests flip.
//
// CLOCK: Date.now is replaced by `realNow() + offsetMs`. Not vi.useFakeTimers: fake timers would freeze
// libp2p's own timers. The clock is real evidence here, not decoration: the SAME session token is shown to
// be expired (verifySessionToken === null) while admission still holds.
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
// The frame carries no token: admission is the signed roster plus the Noise-proven peer id.
const frame = (d) => ({ type: 'authenticate', device_id: d.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION })

// Both directions are required (a node only sends to peers that authenticated to IT).
async function link(a, b) {
  if (!a.node.getPeers().includes(b.node.peerId)) await a.node.dial(b.node.getMultiaddrs()[0])
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

describe('Host OFF: enrolled devices admit each other from the signed roster, no token, no renewal', () => {
  it('0. host stopped, no seeding, t=0: two freshly-joined clients admit each other and an edit crosses', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    expect(claims(a.token)).toMatchObject({ type: 'camp' })
    expect(claims(a.token).exp - claims(a.token).iat).toBe(TTL_MS)
    await host.stop()
    const r = await link(a, b)
    log(`0 t=0 host off, no seed: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.ab.type).not.toBe('auth_failed')
    expect(r.ba.type).not.toBe('auth_failed')
    expect(r.admits).toBe(true)
    expect(await reaches(a, b, 'zero-edit')).toBe(true)
  }, 60000)

  it('0b. negative twin: two devices that were never rostered still refuse each other with device_not_authorized', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    await host.stop()
    a.db.prepare('DELETE FROM roster_cache WHERE device_id = ?').run(b.deviceId)
    b.db.prepare('DELETE FROM roster_cache WHERE device_id = ?').run(a.deviceId)
    const r = await link(a, b)
    log(`0b never rostered: A->B ${JSON.stringify(r.ab)} admits=${r.admits}`)
    expect(r.ab).toEqual({ type: 'auth_failed', reason: 'device_not_authorized' })
    expect(r.admits).toBe(false)
  }, 60000)

  it('A. an established link survives past TTL AND a re-link after TTL admits (no invalid_token)', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    const first = await link(a, b)
    log(`A t=0 link: ${JSON.stringify(first)}`)
    expect(first.admits).toBe(true)
    await host.stop()

    advanceTo(TTL_MS - 90_000)
    expect(await reaches(a, b, 'a-pre-ttl')).toBe(true)

    await restartPair(trio, a, b)
    const preRelink = await link(a, b)
    expect(preRelink.admits).toBe(true)
    expect(await reaches(a, b, 'a-pre-ttl-relinked')).toBe(true)

    advanceTo(TTL_MS + 60_000)
    expect(verifySessionToken(a.db, a.token)).toBeNull()
    expect(await reaches(a, b, 'a-post-ttl-same-connection')).toBe(true)

    await restartPair(trio, a, b)
    const postRelink = await link(a, b)
    log(`A t=TTL+60s reconnect: A->B ${JSON.stringify(postRelink.ab)} B->A ${JSON.stringify(postRelink.ba)} admits=${postRelink.admits}`)
    expect(postRelink.ab.type).not.toBe('auth_failed')
    expect(postRelink.ba.type).not.toBe('auth_failed')
    expect(postRelink.admits).toBe(true)
    expect(await reaches(a, b, 'a-post-ttl-relinked')).toBe(true)
  }, 120000)

  it('B. C2 offline >24h with the Host off syncs with C1 when it returns, and the edit made while away arrives', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    expect((await link(a, b)).admits).toBe(true)
    await host.stop()
    await b.node.stop()
    advanceTo(TTL_MS + 3_600_000)
    await a.restart(`${trio.tmpDir}/ua`, trio.campId)
    await a.write({ entity: 'activities', entity_id: 'b-while-away', field: 'name', value: 'x' })
    await b.restart(`${trio.tmpDir}/ub`, trio.campId)
    const r = await link(a, b)
    log(`B t=25h C2 returns: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.admits).toBe(true)
    let arrived = true
    try { await waitFor(() => !!b.domainRow('activities', 'b-while-away'), 3000) } catch { arrived = false }
    log(`B C1 edit made while C2 away reached C2 = ${arrived}`)
    expect(arrived).toBe(true)
  }, 120000)

  it('C. process restart past TTL with a dead stored token admits; a local PIN re-login changes nothing', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b } = trio
    await host.stop()
    advanceTo(TTL_MS + 60_000)
    await restartPair(trio, a, b)
    expect(verifySessionToken(a.db, a.token)).toBeNull()
    const r = await link(a, b)
    log(`C restart past TTL, stored token: A->B ${JSON.stringify(r.ab)} B->A ${JSON.stringify(r.ba)} admits=${r.admits}`)
    expect(r.admits).toBe(true)

    const relogin = attemptLogin(a.db, { name: 'admin', pin: '1234', deviceId: a.deviceId })
    expect(claims(relogin.token).type).toBe('local')
    a.token = relogin.token
    const r2 = await link(a, b)
    log(`C after local re-login: A->B ${JSON.stringify(r2.ab)} admits=${r2.admits}`)
    expect(r2.admits).toBe(true)
  }, 120000)

  it('D. Host returning after expiry admits a client with no token, edits cross both ways, and the clients still admit each other', async () => {
    trio = await setupTwoJoinedDevices()
    const { host, clientA: a, clientB: b, tmpDir } = trio
    await host.stop()
    advanceTo(TTL_MS + 60_000)
    await restartPair(trio, a, b)

    trio.host2 = new AmHost(`${tmpDir}/host.db`)
    await trio.host2.start()
    const h = trio.host2

    a.hostPeerId = h.node.peerId
    await a.node.dial(h.node.getMultiaddrs()[0])
    await waitFor(() => a.node.getPeers().includes(h.node.peerId))
    const toHost = await a.node.authenticateWith(h.node.peerId, frame(a)).catch((e) => ({ type: 'threw', error: String(e?.message ?? e) }))
    log(`D client -> returned Host authenticate with no token: ${JSON.stringify(toHost)}`)
    expect(toHost.type).not.toBe('auth_failed')

    await new Promise((r) => setTimeout(r, 2500))
    const hostAdmitsA = h.node.isPeerAuthenticated(a.node.peerId)
    log(`D after 2.5s idle with Host online: Host admits A = ${hostAdmitsA}, A admits Host = ${a.node.isPeerAuthenticated(h.node.peerId)}`)
    expect(hostAdmitsA).toBe(true)
    const toA = await reaches(h, a, 'd-host-edit')
    const fromA = await reaches(a, h, 'd-client-edit')
    log(`D Host edit reaches A = ${toA}; A edit reaches Host = ${fromA}`)
    expect(toA).toBe(true)
    expect(fromA).toBe(true)

    const r = await link(a, b)
    log(`D clients with Host back: A->B ${JSON.stringify(r.ab)} admits=${r.admits}`)
    expect(r.admits).toBe(true)
  }, 120000)
})
