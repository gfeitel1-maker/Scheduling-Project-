// @vitest-environment node
//
// The host handoff over real libp2p (docs/adr/2026-10-09-host-succession-simple.md, S1). H, S and a
// third client C are real syncNode instances on real SQLite databases, authenticating with real
// tokens signed by the one camp key. Nothing in the handoff path is mocked; the only seams are the
// injected relaunch (recorded, not executed) and a test hook that drops one reply frame.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId, CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { createUser, issueCampToken, issueDeviceToken, attemptLogin, isHostDevice, verifySessionToken } from '../../auth/localAuth.js'
import { appendOp } from '../../ops/operations.js'
import { startSyncNode } from './syncNode.js'
import { makeHandoffPair, hostOnlyRowCounts, hostOnlyRowIds } from '../../auth/hostHandoffTestSupport.js'

afterAll(() => cleanupTemplatedDbs())

let nodes = []
let genesis
beforeEach(() => { genesis = createEmptyDoc() })
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  nodes = []
})

async function waitFor(predicate, { timeout = 8000, interval = 20 } = {}) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, interval))
  }
}

const liveKeys = (...sides) => sides.filter((side) => side.db.prepare('SELECT 1 FROM host_signing_key').get()).length
const handoffRow = (side) => side.db.prepare('SELECT * FROM host_handoff').get()
const pending = (side) => side.db.prepare('SELECT * FROM host_signing_key_pending').get()

async function start(side, extra = {}) {
  const node = await startSyncNode({
    deviceId: side.deviceId,
    db: side.db,
    doc: A.clone(genesis),
    handoffRetryMs: 60,
    relaunch: () => side.relaunches.push({ hostKeyRow: !!side.db.prepare('SELECT 1 FROM host_signing_key').get(), row: handoffRow(side)?.state ?? null }),
    ...extra,
  })
  nodes.push(node)
  side.node = node
  return node
}

// Authenticates `from` to `to` with `token`, over a fresh dial.
async function connect(from, to, token) {
  await from.node.dial(to.node.getMultiaddrs()[0])
  const resp = await from.node.authenticateWith(to.node.peerId, {
    type: 'authenticate', token, device_id: from.deviceId, schemaVersion: CURRENT_SCHEMA_VERSION,
  })
  expect(resp.type).toBe('auth_ok')
}

function authorizeEverywhere(sides) {
  for (const side of sides) {
    for (const other of sides) {
      side.db.prepare(
        "INSERT OR REPLACE INTO devices (id, name, authorized_at, pairing_status, libp2p_peer_id) VALUES (?, ?, ?, 'authorized', ?)"
      ).run(other.deviceId, `dev-${other.deviceId.slice(0, 4)}`, '2026-10-09T12:00:00.000Z', other.identity.peerId)
    }
  }
}

async function twoNodes(extraH = {}, extraS = {}) {
  const pair = await makeHandoffPair()
  pair.H.relaunches = []
  pair.S.relaunches = []
  await start(pair.H, extraH)
  await start(pair.S, extraS)
  const userId = randomUUID()
  pair.tokens = { H: issueDeviceToken(pair.H.db, pair.H.deviceId), S: issueCampToken(pair.H.db, userId, pair.S.deviceId) }
  await connect(pair.H, pair.S, pair.tokens.H)
  await connect(pair.S, pair.H, pair.tokens.S)
  return pair
}

describe('host handoff over real libp2p', () => {
  it('moves hosting from H to S; the camp key is unchanged; a third client connected throughout keeps working', async () => {
    const pair = await makeHandoffPair()
    const { H, S, campId } = pair
    const C = { db: openTemplatedDb().db, relaunches: [] }
    C.deviceId = getOrCreateDeviceId(C.db)
    const { ensureDeviceIdentity } = await import('../../auth/deviceIdentity.js')
    C.identity = await ensureDeviceIdentity(C.db)
    C.db.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run(campId, 'Test Camp', pair.key.public_key)
    H.relaunches = []
    S.relaunches = []
    authorizeEverywhere([H, S, C])
    const publicKey = pair.key.public_key

    const write = async ({ entity, entity_id, field, value }) => ({
      status: 'applied',
      op: appendOp(H.db, { entity, entity_id, field, value, author_user_id: null, device_id: H.deviceId, parent_op_id: null }),
    })
    const user = await createUser(H.db, { camp_id: campId, name: 'Director', pin: '246810', role: 'admin' }, write)
    for (const other of [S, C]) {
      const r = H.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
      other.db.prepare(`INSERT INTO users (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r))
    }
    for (const side of [H, S, C]) {
      side.db.prepare('UPDATE devices SET device_secret_identifier = ? WHERE id = ?').run('ab'.repeat(32), side.deviceId)
    }

    await start(H)
    await start(S)
    await start(C)
    const tokens = {
      H: issueDeviceToken(H.db, H.deviceId),
      S: issueCampToken(H.db, user.id, S.deviceId),
      C: issueCampToken(H.db, user.id, C.deviceId),
    }
    await connect(H, S, tokens.H)
    await connect(S, H, tokens.S)
    await connect(C, H, tokens.C)
    await connect(C, S, tokens.C)
    await connect(H, C, tokens.H)
    await connect(S, C, tokens.S)

    const hIdsBefore = hostOnlyRowIds(H.db)
    const hCountsBefore = hostOnlyRowCounts(H.db)
    // Only an admin device on the LAN is eligible: C is connected but is not an admin device.
    expect(H.node.handoff.eligibleDeviceIds()).toEqual([S.deviceId])

    const started = await H.node.handoff.start(S.deviceId)
    expect(started).toEqual({ ok: true })
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    expect(S.node.handoff.status().handoff).toMatchObject({ role: 'taker', peerDeviceId: H.deviceId })
    expect(liveKeys(H, S)).toBe(1)

    const accepted = await S.node.handoff.accept()
    expect(accepted).toEqual({ ok: true })

    // Step 5 and 6 have both committed; the relaunch seam saw the committed state, never an earlier one.
    expect(H.relaunches).toEqual([{ hostKeyRow: false, row: 'committed' }])
    expect(S.relaunches).toEqual([{ hostKeyRow: true, row: 'done' }])

    expect(liveKeys(H, S)).toBe(1)
    expect(isHostDevice(S.db)).toBe(true)
    expect(isHostDevice(H.db)).toBe(false)
    expect(S.db.prepare('SELECT public_key FROM host_signing_key').get().public_key).toBe(publicKey)
    for (const side of [H, S, C]) expect(side.db.prepare('SELECT signing_public_key k FROM camps').get().k).toBe(publicKey)
    expect(hostOnlyRowIds(S.db)).toEqual(hIdsBefore)
    expect(hostOnlyRowCounts(S.db)).toEqual(hCountsBefore)
    expect(Object.values(hostOnlyRowCounts(H.db)).every((n) => n === 0)).toBe(true)
    expect(pending(S)).toBeUndefined()
    expect(handoffRow(H)).toBeUndefined() // DONE reached H
    expect(S.node.handoff.status().handoff.state).toBe('done')

    // "Relaunch": new processes on the same databases. Roles come from key presence alone.
    await H.node.stop()
    await S.node.stop()
    await start(H)
    await start(S)
    const sHostToken = issueDeviceToken(S.db, S.deviceId) // what chooseMode self-issues once S is host
    S.node.setAuthToken(sHostToken)
    H.node.setAuthToken(tokens.H) // H keeps the token it already held; it is signed by the unchanged key
    await connect(S, H, sHostToken)
    await connect(H, S, tokens.H)
    await connect(C, S, tokens.C) // the third client re-authenticates against the new host
    await connect(C, H, tokens.C)
    expect(() => issueDeviceToken(H.db, H.deviceId)).toThrow(/not the Host/)

    // PIN logins verify on every device against the one unchanged public key.
    for (const side of [H, S, C]) {
      const login = attemptLogin(side.db, { name: 'Director', pin: '246810', deviceId: side.deviceId })
      expect(login).toMatchObject({ userId: user.id, role: 'admin' })
      expect(verifySessionToken(side.db, login.token)).toMatchObject({ userId: user.id })
    }
    // Everyone still syncs with everyone.
    const fromH = applyWrite(H.node.getDoc(), { entity: 'activities', entity_id: 'archery', field: 'name', value: 'Archery' })
    await H.node.applyLocal(fromH)
    await waitFor(() => S.db.prepare("SELECT name FROM activities WHERE id = 'archery'").get()?.name === 'Archery')
    await waitFor(() => C.db.prepare("SELECT name FROM activities WHERE id = 'archery'").get()?.name === 'Archery')
    const fromS = applyWrite(S.node.getDoc(), { entity: 'activities', entity_id: 'swim', field: 'name', value: 'Swim' })
    await S.node.applyLocal(fromS)
    await waitFor(() => H.db.prepare("SELECT name FROM activities WHERE id = 'swim'").get()?.name === 'Swim')

    expect(verifySessionToken(C.db, tokens.C)).toMatchObject({ deviceId: C.deviceId })
    C.db.close()
  }, 60000)
})

describe('interruption', () => {
  it('a refused or unreachable OFFER leaves H the host with nothing changed', async () => {
    const { H, S } = await twoNodes()
    // S already holds a key row, so it refuses the OFFER outright.
    S.db.prepare("INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, 'x', 'now')").run(H.db.prepare('SELECT public_key FROM host_signing_key').get().public_key)
    const started = await H.node.handoff.start(S.deviceId)
    expect(started).toMatchObject({ ok: false, reason: 'already_host' })
    expect(handoffRow(H)).toBeUndefined()
    expect(isHostDevice(H.db)).toBe(true)
    expect(H.node.handoff.status().lastResult).toMatchObject({ ok: false, peerDeviceId: S.deviceId })
  })

  it('a device that is not connected on the LAN cannot be handed to, and the failure is recorded for the control', async () => {
    const { H } = await twoNodes()
    expect(await H.node.handoff.start('not-a-connected-device')).toEqual({ ok: false, reason: 'peer_not_on_lan' })
    expect(handoffRow(H)).toBeUndefined()
    expect(H.node.handoff.status().lastResult).toMatchObject({ ok: false, reason: 'peer_not_on_lan', peerDeviceId: 'not-a-connected-device' })
  })

  it('S declining the offer leaves both sides untouched', async () => {
    const { H, S } = await twoNodes()
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    S.node.handoff.decline()
    expect(handoffRow(S)).toBeUndefined()
    // H's row clears when it times out or when S says no on its next STATUS; H is still the host.
    expect(isHostDevice(H.db)).toBe(true)
    expect(liveKeys(H, S)).toBe(1)
  })

  for (const [step, faults] of [
    ['ACCEPT is lost on its way to H', { dropRequest: (msg) => msg.type === 'ACCEPT' }],
    ['the KEY reply is lost on its way to S', { dropReply: (frame) => frame.type === 'KEY' }],
  ]) {
    it(`when ${step}, H stays host and S ends with no key, no pending row and no handoff row`, async () => {
      const { H, S } = await twoNodes({ handoffFaults: faults })
      await H.node.handoff.start(S.deviceId)
      await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
      const result = await S.node.handoff.accept()
      expect(result.ok).toBe(false)
      expect(isHostDevice(H.db)).toBe(true)
      expect(liveKeys(H, S)).toBe(1)
      expect(pending(S)).toBeUndefined()
      expect(handoffRow(S)).toBeUndefined()
      expect(isHostDevice(S.db)).toBe(false)
      expect(H.relaunches).toEqual([])
    })
  }

  it('a stream dropped right after H\'s step-5 transaction leaves S holding the pending key, and S activates on a later STATUS=committed', async () => {
    let dropped = false
    const { H, S } = await twoNodes({ handoffFaults: { dropReply: (frame) => { if (frame.type === 'COMMIT' && !dropped) { dropped = true; return true } return false } } })
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    const result = await S.node.handoff.accept()
    expect(dropped).toBe(true)
    expect(result.ok).toBe(false)

    expect(isHostDevice(H.db)).toBe(false)
    expect(handoffRow(H).state).toBe('committed')
    expect(handoffRow(S).state).toBe('stored')
    expect(pending(S)).toBeDefined()
    expect(liveKeys(H, S)).toBe(0)
    expect(H.relaunches.length).toBe(1) // H relaunches whether or not the reply landed

    // S retries STATUS on its own and activates only because H answers committed.
    await waitFor(() => isHostDevice(S.db))
    expect(liveKeys(H, S)).toBe(1)
    expect(pending(S)).toBeUndefined()
    await waitFor(() => !handoffRow(H))
    expect(S.relaunches.length).toBe(1)
  })

  it('S failing to activate after H committed is reported on both sides, keeps the pending key, and S activates once it can', async () => {
    const { H, S } = await twoNodes()
    S.db.exec("CREATE TRIGGER fail_alias BEFORE INSERT ON source_aliases BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END")
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    const result = await S.node.handoff.accept()
    expect(result).toMatchObject({ ok: false, reason: 'activation_failed' })
    expect(handoffRow(H).state).toBe('committed')
    expect(handoffRow(S).state).toBe('stored')
    expect(pending(S)).toBeDefined()
    expect(isHostDevice(S.db)).toBe(false)
    expect(S.node.handoff.status().lastResult).toMatchObject({ ok: false, reason: 'activation_failed', peerDeviceId: H.deviceId })
    // S tells H, so H's control can say so too.
    await waitFor(() => H.node.handoff.status().lastResult?.reason === 'activation_failed')
    expect(H.node.handoff.status().lastResult).toMatchObject({ peerDeviceId: S.deviceId })

    // S keeps retrying on its own; once the write can succeed it activates.
    S.db.exec('DROP TRIGGER fail_alias')
    await waitFor(() => isHostDevice(S.db))
    expect(liveKeys(H, S)).toBe(1)
    expect(pending(S)).toBeUndefined()
  })

  it('S never discards its pending key on a timeout: it keeps asking STATUS, and deletes only when H says not committed', async () => {
    // H's reply to STORED is dropped BEFORE H's service sees it (the STORED never lands).
    let dropStored = true
    const { H, S } = await twoNodes({ handoffFaults: { dropRequest: (msg) => dropStored && msg.type === 'STORED' } })
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    const result = await S.node.handoff.accept()
    expect(result.ok).toBe(false)
    expect(handoffRow(S).state).toBe('stored')
    expect(handoffRow(H).state).toBe('sent')
    expect(liveKeys(H, S)).toBe(1)

    // STATUS finds H not committed (and clears H's row), so S lets the pending key go.
    await waitFor(() => !pending(S))
    expect(handoffRow(S)).toBeUndefined()
    expect(handoffRow(H)).toBeUndefined()
    expect(isHostDevice(H.db)).toBe(true)
    expect(liveKeys(H, S)).toBe(1)
    dropStored = false
  })
})

describe('restart recovery over the wire', () => {
  it('H restarting in committed is a client and re-sends COMMIT when S connects; S activates and H clears its row', async () => {
    const pair = await twoNodes({ handoffFaults: { dropReply: (frame) => frame.type === 'COMMIT' } }, { handoffRetryMs: 600000 })
    const { H, S, tokens } = pair
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    await S.node.handoff.accept()
    expect(handoffRow(S).state).toBe('stored')
    expect(handoffRow(H).state).toBe('committed')

    // Both processes restart. S has only its pending key; H derives client from the missing key row.
    await H.node.stop()
    await S.node.stop()
    await start(H)
    await start(S, { handoffRetryMs: 600000 })
    expect(handoffRow(H).state).toBe('committed')
    expect(handoffRow(S).state).toBe('stored')
    expect(liveKeys(H, S)).toBe(0)
    expect(isHostDevice(H.db)).toBe(false)

    // S admits H first (its own STATUS to H is refused: H has not admitted S yet), then H admits S
    // and re-sends COMMIT on its own.
    await connect(H, S, tokens.H)
    await connect(S, H, tokens.S)
    await waitFor(() => isHostDevice(S.db))
    await waitFor(() => !handoffRow(H))
    expect(liveKeys(H, S)).toBe(1)
    expect(S.relaunches.length).toBe(1)
  }, 30000)

  it('S restarting in stored asks STATUS on contact; H answering not committed makes S delete the pending key', async () => {
    const pair = await twoNodes({ handoffFaults: { dropRequest: (msg) => msg.type === 'STORED' } }, { handoffRetryMs: 600000 })
    const { H, S, tokens } = pair
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    await S.node.handoff.accept()
    expect(handoffRow(S).state).toBe('stored')
    expect(handoffRow(H).state).toBe('sent')

    await H.node.stop()
    await S.node.stop()
    await start(H)
    await start(S, { handoffRetryMs: 600000 })
    expect(handoffRow(H)).toBeUndefined() // H restarted in `sent`: nothing was decided
    expect(isHostDevice(H.db)).toBe(true)
    expect(pending(S)).toBeDefined()
    expect(liveKeys(H, S)).toBe(1)

    await connect(S, H, tokens.S) // H admits S first, so S's STATUS can land once S admits H
    await connect(H, S, tokens.H)
    await waitFor(() => !pending(S))
    expect(handoffRow(S)).toBeUndefined()
    expect(liveKeys(H, S)).toBe(1)
    expect(isHostDevice(H.db)).toBe(true)
  }, 30000)
})

describe('rejections over the wire', () => {
  it('a peer S never admitted cannot reach the handoff protocol, even though it admitted S', async () => {
    const { H, S } = await twoNodes()
    const stranger = openTemplatedDb().db
    stranger.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('other', 'Other', S.db.prepare('SELECT signing_public_key k FROM camps').get().k)
    const intruder = { db: stranger, deviceId: getOrCreateDeviceId(stranger), relaunches: [] }
    const { ensureDeviceIdentity } = await import('../../auth/deviceIdentity.js')
    intruder.identity = await ensureDeviceIdentity(stranger)
    authorizeEverywhere([intruder, S])
    await start(intruder)
    // The intruder admits S (so its own outbound check passes); S never admitted the intruder.
    await connect(S, intruder, issueCampToken(H.db, randomUUID(), S.deviceId))
    await expect(intruder.node.sendHandoff(S.node.peerId, { type: 'OFFER', handoff_id: 'x', camp_id: 'other' })).rejects.toThrow()
    expect(handoffRow(S)).toBeUndefined()
    expect(H.db.prepare('SELECT 1 FROM host_signing_key').get()).toBeDefined()
    stranger.close()
  })

  it('an authenticated client that is not an admin device is refused and audited, and nothing is written', async () => {
    const { H, S } = await twoNodes()
    const C = { db: openTemplatedDb().db, relaunches: [] }
    C.deviceId = getOrCreateDeviceId(C.db)
    const { ensureDeviceIdentity } = await import('../../auth/deviceIdentity.js')
    C.identity = await ensureDeviceIdentity(C.db)
    C.db.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run(S.db.prepare('SELECT id FROM camps').get().id, 'Test Camp', S.db.prepare('SELECT signing_public_key k FROM camps').get().k)
    authorizeEverywhere([H, S, C])
    await start(C)
    const cToken = issueCampToken(H.db, randomUUID(), C.deviceId)
    await connect(C, S, cToken)
    await connect(S, C, issueCampToken(H.db, randomUUID(), S.deviceId))
    const reply = await C.node.sendHandoff(S.node.peerId, { type: 'OFFER', handoff_id: 'h-x', camp_id: S.db.prepare('SELECT id FROM camps').get().id })
    expect(reply).toMatchObject({ type: 'ERROR', reason: 'peer_not_admin' })
    expect(handoffRow(S)).toBeUndefined()
    expect(S.db.prepare("SELECT reason FROM audit_events WHERE action = 'host.handoff'").all().map((r) => r.reason)).toContain('peer_not_admin')
    C.db.close()
  })

  it('malformed and unknown messages are refused and write nothing', async () => {
    const { S, H } = await twoNodes()
    expect(await H.node.sendHandoff(S.node.peerId, { type: 'BOGUS' })).toMatchObject({ type: 'ERROR', reason: 'unsupported_message' })
    expect(await H.node.sendHandoff(S.node.peerId, {})).toMatchObject({ type: 'ERROR', reason: 'malformed' })
    expect(await H.node.sendHandoff(S.node.peerId, { type: 'KEY', handoff_id: 'nope', sealed: {} })).toMatchObject({ type: 'ERROR' })
    expect(handoffRow(S)).toBeUndefined()
    expect(pending(S)).toBeUndefined()
  })
})

describe('relaunch and flush', () => {
  it('both sides relaunch exactly once, after their own transaction, and S\'s DONE reaches H before S relaunches', async () => {
    const { H, S } = await twoNodes({}, { handoffRetryMs: 600000 })
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    await S.node.handoff.accept()
    expect(H.relaunches).toEqual([{ hostKeyRow: false, row: 'committed' }])
    // At the moment S relaunched, H had already cleared its row (DONE was delivered and acked).
    expect(S.relaunches).toEqual([{ hostKeyRow: true, row: 'done' }])
    expect(handoffRow(H)).toBeUndefined()
  })

  it('a lost DONE is recovered: S relaunches anyway, and H re-sends COMMIT when S next connects', async () => {
    let dropDone = true
    const { H, S } = await twoNodes({ handoffFaults: { dropRequest: (msg) => dropDone && msg.type === 'DONE' } }, { handoffRetryMs: 600000 })
    await H.node.handoff.start(S.deviceId)
    await waitFor(() => S.node.handoff.status().handoff?.state === 'offered')
    await S.node.handoff.accept()
    expect(isHostDevice(S.db)).toBe(true)
    expect(S.relaunches.length).toBe(1)
    expect(handoffRow(H).state).toBe('committed') // DONE never arrived; H still holds its row

    dropDone = false
    await H.node.handoff.contactPeer(S.node.peerId) // what H's admission of S triggers on the next launch
    await waitFor(() => !handoffRow(H))
    expect(liveKeys(H, S)).toBe(1)
  })
})
