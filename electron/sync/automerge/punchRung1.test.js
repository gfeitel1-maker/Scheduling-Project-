// @vitest-environment node
//
// T348 Rung 1: real node-datachannel over loopback. Two devices punch once WITH signaling (which
// leaves a remembered session in each database), then reconnect with attemptRung1 and ZERO
// signaling messages.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { multiaddr } from '@multiformats/multiaddr'
import { openLocalDb } from '../../db/localDb.js'
import { TimeoutError } from '@libp2p/interface'
import { punchTransport, shutdownPunchNative, PunchConnectionFailedError } from './punchTransport.js'
import { makeSignalingPair } from './punchTestSupport.js'
import { materializePunchIdentity, ensurePunchIdentity } from './punchIdentity.js'
import { rememberPunchMemory } from './peerAddressBook.js'
import { attemptRung1 } from './punchRung1.js'

const noop = Object.assign(() => {}, { error() {}, trace() {}, newScope: () => noop })
const components = { logger: { forComponent: () => noop } }

const cleanups = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await shutdownPunchNative()
})

function freshDb() {
  const f = path.join(os.tmpdir(), `shoresh-rung1-${Date.now()}-${Math.random()}.sqlite`)
  const db = openLocalDb(f)
  cleanups.push(() => {
    db.close()
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  })
  return db
}

const LOOP = { allowNonPublicCandidates: true }
const upgraderFor = (remote) => ({
  upgradeOutbound: async (maConn) => ({ remotePeer: { toString: () => remote }, maConn, close: async () => { upgraderFor.closed.push(remote) } }),
  upgradeInbound: async (maConn) => ({ remotePeer: { toString: () => remote }, maConn, close: async () => { upgraderFor.closed.push(remote) } }),
})

function trustPeer(db, peerId, revoked = false) {
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at, libp2p_peer_id) VALUES (?, ?, 'approved', ?, ?, ?)")
    .run(`dev-${peerId}`, peerId, '2026-10-01T00:00:00.000Z', revoked ? '2026-10-02T00:00:00.000Z' : null, peerId)
}

async function makeDevice(name, signaling) {
  const db = freshDb()
  const ident = materializePunchIdentity(db)
  cleanups.push(() => ident.cleanup())
  const established = []
  const transport = punchTransport({
    signaling,
    certificatePemFile: ident.certificatePemFile,
    keyPemFile: ident.keyPemFile,
    ice: ident.ice,
    portRange: ident.portRange,
    connectTimeoutMs: 8000,
    onEstablished: (m) => {
      established.push(m)
      rememberPunchMemory(db, m.peerId, m)
    },
  })(components)
  await transport.start()
  cleanups.push(() => transport.stop())
  return { name, db, transport, established, identity: ensurePunchIdentity(db) }
}

upgraderFor.closed = []
let sent
let a, b
beforeEach(async () => {
  sent = { a: 0, b: 0 }
  const [sigA, sigB] = makeSignalingPair()
  const spy = (sig, key) => ({ onSignal: sig.onSignal, sendSignal: (m) => { sent[key]++; return sig.sendSignal(m) } })
  a = await makeDevice('a', spy(sigA, 'a'))
  b = await makeDevice('b', spy(sigB, 'b'))
  trustPeer(a.db, 'peer-b')
  trustPeer(b.db, 'peer-a')
  const listener = b.transport.createListener({ upgrader: upgraderFor('peer-a') })
  await listener.listen(multiaddr('/ip4/127.0.0.1/udp/9'))
  await a.transport.dial(multiaddr('/ip4/127.0.0.1/udp/9'), { upgrader: upgraderFor('peer-b'), signal: AbortSignal.timeout(10000) })
  await new Promise((r) => setTimeout(r, 200))
  await Promise.all([...a.transport.sessions.values(), ...b.transport.sessions.values()].map((s) => { s.close(); return s.whenClosed }))
}, 30000)

describe('Rung 1 - remembered-candidate redial', () => {
  it('the signaled session leaves the peer\'s fingerprint, ufrag/pwd, candidates and our role in the database', () => {
    expect(sent.a + sent.b).toBeGreaterThan(0)
    const row = a.db.prepare('SELECT * FROM peer_punch_memory WHERE peer_id = ?').get('peer-b')
    expect(row.role).toBe('offerer')
    expect(row.remote_sdp_type).toBe('answer')
    expect(row.remote_fingerprint).toBe(b.identity.fingerprint)
    expect(row.remote_ufrag).toBe(b.identity.iceUfrag)
    expect(row.remote_pwd).toBe(b.identity.icePwd)
    expect(JSON.parse(row.candidates).length).toBeGreaterThan(0)
    expect(a.established[0].localCandidates.length).toBeGreaterThan(0)
    expect(b.db.prepare('SELECT role FROM peer_punch_memory WHERE peer_id = ?').get('peer-a').role).toBe('answerer')
  })

  it('both ends redial from memory and connect with ZERO signaling messages', async () => {
    sent.a = 0
    sent.b = 0
    const opts = { timeoutMs: 8000 }
    const [ra, rb] = await Promise.all([
      attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: a.transport, upgrader: upgraderFor('peer-b'), ...LOOP, ...opts }),
      attemptRung1({ peerId: 'peer-a' }, { db: b.db, transport: b.transport, upgrader: upgraderFor('peer-a'), ...LOOP, ...opts }),
    ])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(sent).toEqual({ a: 0, b: 0 })
  }, 30000)

  it('a changed remote port fails within the bound with a reason, and does not throw', async () => {
    const row = a.db.prepare('SELECT candidates FROM peer_punch_memory WHERE peer_id = ?').get('peer-b')
    const moved = JSON.parse(row.candidates).map((c) => ({ ...c, candidate: c.candidate.replace(/(\S+) (\d+) typ/, (_, addr, port) => `${addr} ${Number(port) === 9 ? 10 : Number(port) - 1} typ`) }))
    a.db.prepare('UPDATE peer_punch_memory SET candidates = ? WHERE peer_id = ?').run(JSON.stringify(moved), 'peer-b')
    const started = Date.now()
    const r = await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: a.transport, upgrader: upgraderFor('peer-b'), ...LOOP, timeoutMs: 2000 })
    expect(r.ok).toBe(false)
    expect(['mapping-moved', 'timeout']).toContain(r.reason)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(sent.a + sent.b).toBeGreaterThan(0)
  }, 30000)

  it('a peer with no memory reports no-memory without touching the transport', async () => {
    const r = await attemptRung1({ peerId: 'peer-unknown' }, { db: a.db, transport: { connectFromMemory: () => { throw new Error('must not be called') } }, upgrader: {} })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
  })

  it('a revoked peer\'s memory is not redialled', async () => {
    a.db.prepare("UPDATE devices SET revoked_at = '2026-10-08T00:00:00.000Z' WHERE libp2p_peer_id = 'peer-b'").run()
    expect(a.db.prepare('SELECT COUNT(*) c FROM peer_punch_memory WHERE peer_id = ?').get('peer-b').c).toBe(1)
    const calls = []
    const r = await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: (...args) => { calls.push(args) } }, upgrader: {} })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
    expect(calls).toEqual([])
  })

  it('maps ICE failure to mapping-moved, a timeout to timeout, and anything else to error', async () => {
    const failWith = (err) => attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: async () => { throw err } }, upgrader: {}, ...LOOP })
    expect(await failWith(new PunchConnectionFailedError('failed'))).toEqual({ ok: false, reason: 'mapping-moved' })
    expect(await failWith(new TimeoutError('slow'))).toEqual({ ok: false, reason: 'timeout' })
    expect(await failWith(new Error('boom'))).toEqual({ ok: false, reason: 'error' })
  })

  it('a corrupt stored candidates row is ignored as no-memory, not thrown', async () => {
    a.db.prepare("UPDATE peer_punch_memory SET candidates = 'not json' WHERE peer_id = 'peer-b'").run()
    const r = await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: () => { throw new Error('must not be called') } }, upgrader: {} })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
  })

  it('memory older than the freshness bound is not redialled', async () => {
    a.db.prepare("UPDATE peer_punch_memory SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE peer_id = 'peer-b'").run()
    const r = await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: () => { throw new Error('must not be called') } }, upgrader: {}, ...LOOP })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
  })

  it('never probes loopback/private/non-srflx candidates from memory by default', async () => {
    const calls = []
    const r = await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: (m) => { calls.push(m) } }, upgrader: {} })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
    expect(calls).toEqual([])
    const row = { ...JSON.parse(a.db.prepare('SELECT candidates FROM peer_punch_memory WHERE peer_id = ?').get('peer-b').candidates)[0] }
    const pub = [{ ...row, candidate: 'candidate:1 1 UDP 1686052607 203.0.113.9 40000 typ srflx' }, { ...row, candidate: 'candidate:2 1 UDP 1686052607 10.0.0.5 40001 typ srflx' }]
    a.db.prepare('UPDATE peer_punch_memory SET candidates = ? WHERE peer_id = ?').run(JSON.stringify(pub), 'peer-b')
    await attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: { connectFromMemory: (m) => { calls.push(m) } }, upgrader: {} })
    expect(calls).toHaveLength(1)
    expect(calls[0].candidates.map((c) => c.candidate)).toEqual([pub[0].candidate])
    expect(calls[0].remoteSdp).not.toMatch(/^a=candidate:/m)
  })

  it('a connection that authenticates as a different peer is closed and reported as mapping-moved', async () => {
    upgraderFor.closed.length = 0
    const [ra] = await Promise.all([
      attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: a.transport, upgrader: upgraderFor('peer-impostor'), ...LOOP, timeoutMs: 8000 }),
      attemptRung1({ peerId: 'peer-a' }, { db: b.db, transport: b.transport, upgrader: upgraderFor('peer-a'), ...LOOP, timeoutMs: 8000 }),
    ])
    expect(ra).toEqual({ ok: false, reason: 'mapping-moved' })
    expect(upgraderFor.closed).toContain('peer-impostor')
  }, 30000)

  it('two peers redialled concurrently on one pinned port are serialized: the second times out, no throw', async () => {
    trustPeer(a.db, 'peer-c')
    a.db.prepare('INSERT INTO peer_punch_memory SELECT ?, role, remote_sdp_type, remote_sdp, remote_fingerprint, remote_ufrag, remote_pwd, candidates, last_seen_at FROM peer_punch_memory WHERE peer_id = ?').run('peer-c', 'peer-b')
    const pa = attemptRung1({ peerId: 'peer-b' }, { db: a.db, transport: a.transport, upgrader: upgraderFor('peer-b'), ...LOOP, timeoutMs: 8000 })
    const pb = attemptRung1({ peerId: 'peer-a' }, { db: b.db, transport: b.transport, upgrader: upgraderFor('peer-a'), ...LOOP, timeoutMs: 8000 })
    const pc = attemptRung1({ peerId: 'peer-c' }, { db: a.db, transport: a.transport, upgrader: upgraderFor('peer-c'), ...LOOP, timeoutMs: 2500 })
    const [ra, rb, rc] = await Promise.all([pa, pb, pc])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(rc).toEqual({ ok: false, reason: 'timeout' })
  }, 30000)
})
