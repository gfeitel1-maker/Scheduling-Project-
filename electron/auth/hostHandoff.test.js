// @vitest-environment node
//
// The host-handoff state machine (docs/adr/2026-10-09-host-succession-simple.md), DB-only: two real
// databases, real crypto, messages passed by hand. The transport is exercised separately by the
// two-node test in electron/sync/automerge/hostHandoffWire.test.js.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { isHostDevice } from './localAuth.js'
import { createHostHandoff, HANDOFF_TABLES } from './hostHandoff.js'
import { makeHandoffPair, hostOnlyRowCounts, hostOnlyRowIds } from './hostHandoffTestSupport.js'

afterAll(() => cleanupTemplatedDbs())

let pair, h, s, clock, relaunches

const liveKeys = () =>
  [h, s].filter((side) => side.db.prepare('SELECT 1 FROM host_signing_key').get()).length
const pendingKey = (side) => side.db.prepare('SELECT * FROM host_signing_key_pending').get()
const row = (side) => side.db.prepare('SELECT * FROM host_handoff').get()
const publicKey = (side) => side.db.prepare('SELECT signing_public_key k FROM camps').get().k
const auditReasons = (side) =>
  side.db.prepare("SELECT reason FROM audit_events WHERE action = 'host.handoff' AND outcome = 'deny'").all().map((r) => r.reason)

function build(side, label) {
  side.svc = createHostHandoff({
    db: side.db,
    deviceId: side.deviceId,
    getDeviceIdentity: async () => side.identity,
    now: () => clock.t,
    relaunch: () => relaunches.push(label),
  })
}

// Deliver `msg` from one side to the other and return the receiving side's result.
const send = (from, to, msg) => to.svc.handle(msg, { peerDeviceId: from.deviceId })

// Runs steps 1-3 and returns the KEY message S would receive.
async function toKey() {
  const offer = h.svc.offer(s.deviceId)
  expect(offer.ok).toBe(true)
  expect((await send(h, s, offer.msg)).ok).toBe(true)
  const accept = await s.svc.accept()
  expect(accept.ok).toBe(true)
  const key = await send(s, h, accept.msg)
  expect(key.ok).toBe(true)
  return key.reply
}

beforeEach(async () => {
  clock = { t: Date.parse('2026-10-09T12:00:00Z') }
  relaunches = []
  pair = await makeHandoffPair()
  h = pair.H
  s = pair.S
  build(h, 'H')
  build(s, 'S')
})

afterEach(() => {
  h.db.close()
  s.db.close()
})

describe('host handoff: the full exchange', () => {
  it('moves the key and the host-only tables from H to S, with at most one live key at every step', async () => {
    const originalKey = h.db.prepare('SELECT * FROM host_signing_key').get()
    const hIds = hostOnlyRowIds(h.db)
    const hCounts = hostOnlyRowCounts(h.db)
    expect(hIds.length).toBe(HANDOFF_TABLES.length)
    const publicBefore = publicKey(h)

    const keyMsg = await toKey()
    expect(liveKeys()).toBe(1)
    expect(row(h).state).toBe('sent')

    const stored = await send(h, s, keyMsg)
    expect(stored.ok).toBe(true)
    expect(stored.reply.type).toBe('STORED')
    expect(row(s).state).toBe('stored')
    expect(pendingKey(s).public_key).toBe(originalKey.public_key)
    expect(liveKeys()).toBe(1)
    expect(isHostDevice(s.db)).toBe(false)
    expect(hostOnlyRowIds(s.db)).not.toEqual(hIds)

    const commit = await send(s, h, stored.reply)
    expect(commit.ok).toBe(true)
    expect(commit.reply.type).toBe('COMMIT')
    expect(commit.relaunch).toBe(true)
    expect(liveKeys()).toBe(0)
    expect(row(h).state).toBe('committed')
    expect(isHostDevice(h.db)).toBe(false)
    expect(hostOnlyRowCounts(h.db)).toEqual(Object.fromEntries(HANDOFF_TABLES.map((t) => [t, 0])))

    const done = await send(h, s, commit.reply)
    expect(done.ok).toBe(true)
    expect(done.reply.type).toBe('DONE')
    expect(done.relaunch).toBe(true)
    expect(liveKeys()).toBe(1)
    expect(isHostDevice(s.db)).toBe(true)
    expect(s.db.prepare('SELECT * FROM host_signing_key').get()).toEqual(originalKey)
    expect(pendingKey(s)).toBeUndefined()
    expect(row(s).state).toBe('done')
    expect(hostOnlyRowIds(s.db)).toEqual(hIds)
    expect(hostOnlyRowCounts(s.db)).toEqual(hCounts)
    expect(publicKey(s)).toBe(publicBefore)
    expect(publicKey(h)).toBe(publicBefore)

    const ack = await send(s, h, done.reply)
    expect(ack.ok).toBe(true)
    expect(row(h)).toBeUndefined()
  })

  it('refuses to offer when this device is not the host, or the peer is not an admin device', async () => {
    expect((await s.svc.offer(h.deviceId)).reason).toBe('not_host')
    h.db.prepare("DELETE FROM authority_cache WHERE device_id = ?").run(s.deviceId)
    expect(h.svc.offer(s.deviceId)).toMatchObject({ ok: false, reason: 'peer_not_admin' })
    expect(row(h)).toBeUndefined()
  })
})

describe('host handoff: interruption before the decision point', () => {
  it('after OFFER, ACCEPT or KEY is lost, H stays host and S ends with no key and no pending row once it restarts', async () => {
    const offer = h.svc.offer(s.deviceId)
    await send(h, s, offer.msg)
    h.svc.abandon(offer.msg.handoff_id, 'peer_unreachable')
    expect(row(h)).toBeUndefined()
    expect(isHostDevice(h.db)).toBe(true)
    s.svc.recoverOnStartup()
    expect(row(s)).toBeUndefined()

    const offer2 = h.svc.offer(s.deviceId)
    await send(h, s, offer2.msg)
    const accept = await s.svc.accept()
    await send(s, h, accept.msg) // KEY produced, never delivered to S
    expect(row(h).state).toBe('sent')
    h.svc.recoverOnStartup()
    s.svc.recoverOnStartup()
    expect(row(h)).toBeUndefined()
    expect(row(s)).toBeUndefined()
    expect(isHostDevice(h.db)).toBe(true)
    expect(liveKeys()).toBe(1)
    expect(pendingKey(s)).toBeUndefined()
  })

  it('S keeps its pending key when STORED is lost, and deletes it only when H answers not committed', async () => {
    const keyMsg = await toKey()
    await send(h, s, keyMsg) // S stored; STORED never reaches H
    expect(pendingKey(s)).toBeDefined()

    clock.t += 60 * 60 * 1000 // an hour passes, the stream is long gone
    expect(pendingKey(s)).toBeDefined()
    expect(row(s).state).toBe('stored')

    const status = s.svc.contactMessage(h.deviceId)
    expect(status.type).toBe('STATUS')
    const answer = await send(s, h, status)
    expect(answer.reply.type).toBe('NOT_COMMITTED')
    expect(row(h)).toBeUndefined() // H will never commit this handoff
    expect(isHostDevice(h.db)).toBe(true)

    await send(h, s, answer.reply)
    expect(pendingKey(s)).toBeUndefined()
    expect(row(s)).toBeUndefined()
    expect(liveKeys()).toBe(1)

    // A STORED delayed in the network and arriving after the answer cannot make H commit.
    const late = await send(s, h, { type: 'STORED', handoff_id: keyMsg.handoff_id })
    expect(late.ok).toBe(false)
    expect(isHostDevice(h.db)).toBe(true)
  })
})

describe('host handoff: dropped right after the decision point', () => {
  it('S holds the pending key through a dropped COMMIT and activates on a later STATUS answered committed', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    const commit = await send(s, h, stored.reply)
    expect(commit.ok).toBe(true) // H committed; the reply carrying COMMIT is lost
    expect(liveKeys()).toBe(0)
    expect(pendingKey(s)).toBeDefined()
    expect(isHostDevice(s.db)).toBe(false)

    const status = s.svc.contactMessage(h.deviceId)
    const answer = await send(s, h, status)
    expect(answer.reply.type).toBe('COMMIT')
    const done = await send(h, s, answer.reply)
    expect(done.ok).toBe(true)
    expect(isHostDevice(s.db)).toBe(true)
    expect(liveKeys()).toBe(1)
  })

  it('S never activates on its own: no COMMIT, no activation', async () => {
    const keyMsg = await toKey()
    await send(h, s, keyMsg)
    expect(s.svc.recoverOnStartup()).toBeUndefined()
    expect(isHostDevice(s.db)).toBe(false)
    expect(pendingKey(s)).toBeDefined()
  })
})

describe('host handoff: restart recovery', () => {
  it('H restarting in offered or sent clears its row and stays host', async () => {
    const offer = h.svc.offer(s.deviceId)
    h.svc.recoverOnStartup()
    expect(row(h)).toBeUndefined()
    const offer2 = h.svc.offer(s.deviceId)
    await send(h, s, offer2.msg)
    const accept = await s.svc.accept()
    await send(s, h, accept.msg)
    expect(row(h).state).toBe('sent')
    h.svc.recoverOnStartup()
    expect(row(h)).toBeUndefined()
    expect(isHostDevice(h.db)).toBe(true)
    expect(offer.ok).toBe(true)
  })

  it('S restarting in accepted discards; restarting in stored keeps the pending key and asks STATUS', async () => {
    const offer = h.svc.offer(s.deviceId)
    await send(h, s, offer.msg)
    await s.svc.accept()
    s.svc.recoverOnStartup()
    expect(row(s)).toBeUndefined()
    expect(liveKeys()).toBe(1)
    h.svc.recoverOnStartup()

    const keyMsg = await toKey()
    await send(h, s, keyMsg)
    s.svc.recoverOnStartup()
    expect(row(s).state).toBe('stored')
    expect(pendingKey(s)).toBeDefined()
    expect(s.svc.contactMessage(h.deviceId).type).toBe('STATUS')
    expect(s.svc.contactMessage('someone-else')).toBeNull()
    expect(liveKeys()).toBe(1)
  })

  it('S in stored: H answers committed, S activates; H answers not committed, S deletes pending and its row', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    await send(s, h, stored.reply)
    s.svc.recoverOnStartup()
    const answer = await send(s, h, s.svc.contactMessage(h.deviceId))
    await send(h, s, answer.reply)
    expect(isHostDevice(s.db)).toBe(true)
    expect(liveKeys()).toBe(1)
  })

  it('H restarting in committed is a client and re-sends COMMIT to S, which answers DONE and H clears its row', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    await send(s, h, stored.reply)
    h.svc.recoverOnStartup()
    expect(row(h).state).toBe('committed')
    expect(isHostDevice(h.db)).toBe(false)
    expect(h.svc.contactMessage('someone-else')).toBeNull()
    const commit = h.svc.contactMessage(s.deviceId)
    expect(commit.type).toBe('COMMIT')
    const done = await send(h, s, commit)
    expect(isHostDevice(s.db)).toBe(true)
    await send(s, h, done.reply)
    expect(row(h)).toBeUndefined()
    expect(liveKeys()).toBe(1)

    // A COMMIT repeated after activation is answered DONE again and changes nothing.
    const again = await send(h, s, commit)
    expect(again.reply.type).toBe('DONE')
    expect(liveKeys()).toBe(1)
  })
})

describe('host handoff: relaunch seam', () => {
  it('reports relaunch on the result and calls the injected relaunch only from afterReplyFlushed', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    const commit = await send(s, h, stored.reply)
    expect(relaunches).toEqual([])
    h.svc.afterReplyFlushed(commit)
    expect(relaunches).toEqual(['H'])
    h.svc.afterReplyFlushed({ ok: true, reply: { type: 'ACK' } })
    expect(relaunches).toEqual(['H'])
  })
})

describe('host handoff: rejections write nothing and are audited', () => {
  const stateIsUntouched = () => {
    expect(isHostDevice(h.db)).toBe(true)
    expect(liveKeys()).toBe(1)
    expect(pendingKey(s)).toBeUndefined()
  }

  it('tampered ciphertext', async () => {
    const keyMsg = await toKey()
    const flipped = (keyMsg.sealed.ct.startsWith('0') ? '1' : '0') + keyMsg.sealed.ct.slice(1)
    const result = await send(h, s, { ...keyMsg, sealed: { ...keyMsg.sealed, ct: flipped } })
    expect(result).toMatchObject({ ok: false, reason: 'bad_ciphertext' })
    stateIsUntouched()
    expect(auditReasons(s)).toContain('bad_ciphertext')
  })

  it('a key whose public half is not this camp\'s signing_public_key', async () => {
    const keyMsg = await toKey()
    s.db.prepare('UPDATE camps SET signing_public_key = ?').run('ab'.repeat(44))
    const result = await send(h, s, keyMsg)
    expect(result).toMatchObject({ ok: false, reason: 'wrong_camp_key' })
    stateIsUntouched()
    expect(auditReasons(s)).toContain('wrong_camp_key')
  })

  it('a payload whose row counts do not match', async () => {
    const keyMsg = await toKey()
    // Re-seal a payload with a lying count, as an honest-but-buggy giver might.
    const { buildAad, open, seal } = await import('./hostHandoffSeal.js')
    const aad = buildAad({ handoffId: keyMsg.handoff_id, campId: pair.campId, giverDeviceId: h.deviceId, takerDeviceId: s.deviceId })
    const eph = s.svc.ephemeralForTest(keyMsg.handoff_id)
    const payload = JSON.parse(open({ takerEphemeralPrivate: eph.privateKey, sealed: keyMsg.sealed, aad }).toString())
    payload.counts.source_aliases += 1
    const sealed = seal({ takerEphemeralPublic: eph.publicKey, plaintext: Buffer.from(JSON.stringify(payload)), aad })
    const result = await send(h, s, { ...keyMsg, sealed })
    expect(result).toMatchObject({ ok: false, reason: 'row_count_mismatch' })
    stateIsUntouched()
  })

  it('a peer that is not an admin device, on either side', async () => {
    const offer = h.svc.offer(s.deviceId)
    s.db.prepare("DELETE FROM authority_cache WHERE device_id = ?").run(h.deviceId)
    expect(await send(h, s, offer.msg)).toMatchObject({ ok: false, reason: 'peer_not_admin' })
    expect(row(s)).toBeUndefined()
    expect(auditReasons(s)).toContain('peer_not_admin')

    s.db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, 'admin', 'now')").run(h.deviceId)
    await send(h, s, offer.msg)
    const accept = await s.svc.accept()
    h.db.prepare("UPDATE authority_cache SET status = 'revoked' WHERE device_id = ?").run(s.deviceId)
    expect(await send(s, h, accept.msg)).toMatchObject({ ok: false, reason: 'peer_not_admin' })
    expect(row(h).state).toBe('offered')
    stateIsUntouched()
    expect(auditReasons(h)).toContain('peer_not_admin')
  })

  it('an ephemeral key signed by the wrong device identity', async () => {
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const offer = h.svc.offer(s.deviceId)
    await send(h, s, offer.msg)
    const accept = await s.svc.accept()
    const impostorKey = await generateKeyPair('Ed25519')
    const impostor = createHostHandoff({
      db: s.db, deviceId: s.deviceId, getDeviceIdentity: async () => ({ privateKey: impostorKey, peerId: s.identity.peerId }),
      now: () => clock.t, relaunch: () => {},
    })
    s.db.prepare('UPDATE host_handoff SET state = ?').run('offered')
    const forged = await impostor.accept()
    expect(await send(s, h, forged.msg)).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(row(h).state).toBe('offered')
    stateIsUntouched()
    expect(auditReasons(h)).toContain('bad_signature')
    expect(accept.ok).toBe(true)
  })

  it('a replayed or stale handoff_id', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    const commit = await send(s, h, stored.reply)
    await send(h, s, commit.reply)
    await send(s, h, { type: 'DONE', handoff_id: keyMsg.handoff_id })
    expect(liveKeys()).toBe(1)

    // A fresh handoff, then every old message replayed into it.
    const staleKey = { ...keyMsg, handoff_id: 'not-the-current-one' }
    expect(await send(h, s, staleKey)).toMatchObject({ ok: false })
    expect(await send(h, s, { type: 'COMMIT', handoff_id: 'not-the-current-one' })).toMatchObject({ ok: false })
    expect(await send(s, h, { type: 'STORED', handoff_id: 'not-the-current-one' })).toMatchObject({ ok: false })
    expect(await send(s, h, { type: 'ACCEPT', handoff_id: 'not-the-current-one', ephemeral_public: 'aa', signature: 'bb' })).toMatchObject({ ok: false })
    expect(liveKeys()).toBe(1)
  })

  it('a KEY replayed into a completed handoff, and a COMMIT with no pending key, activate nothing', async () => {
    const keyMsg = await toKey()
    const stored = await send(h, s, keyMsg)
    await send(s, h, stored.reply)
    await send(h, s, { type: 'COMMIT', handoff_id: keyMsg.handoff_id })
    expect(isHostDevice(s.db)).toBe(true)
    const replay = await send(h, s, keyMsg)
    expect(replay.ok).toBe(false)
    expect(pendingKey(s)).toBeUndefined()
    expect(liveKeys()).toBe(1)
  })
})

describe('host handoff: a device that is already a host', () => {
  it('refuses an OFFER, so a handoff can never create a second host', async () => {
    const offer = h.svc.offer(s.deviceId)
    s.db.prepare("INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, 'x', 'now')").run(pair.key.public_key)
    expect(await send(h, s, offer.msg)).toMatchObject({ ok: false, reason: 'already_host' })
  })
})

describe('host handoff: staleness', () => {
  it('H gives up on an unanswered OFFER or an unstored KEY and stays host', async () => {
    const offer = h.svc.offer(s.deviceId)
    clock.t += 6 * 60 * 1000
    expect(h.svc.status().handoff).toBeNull()
    expect(h.svc.status().lastResult).toMatchObject({ ok: false, reason: 'timed_out', peerDeviceId: s.deviceId })
    expect(isHostDevice(h.db)).toBe(true)
    expect(offer.ok).toBe(true)
  })
})
