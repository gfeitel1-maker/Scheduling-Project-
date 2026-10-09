// @vitest-environment node
//
// T348: the device's stable punch identity (DTLS cert/key + ICE credentials + pinned port) lives in
// the SQLCipher-covered database, never as a standing file.
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'
import { openLocalDb } from '../../db/localDb.js'
import { ensurePunchIdentity, materializePunchIdentity, rememberOwnReflexive, rotatePunchIdentity, createPunchPersistence, forgetRevokedPeer } from './punchIdentity.js'

const cleanups = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function freshDb() {
  const f = path.join(os.tmpdir(), `shoresh-pid-${Date.now()}-${Math.random()}.sqlite`)
  const db = openLocalDb(f)
  cleanups.push(() => {
    db.close()
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  })
  return db
}

describe('ensurePunchIdentity', () => {
  it('mints a valid self-signed cert whose fingerprint is the cert digest, and is stable on re-read', () => {
    const db = freshDb()
    const a = ensurePunchIdentity(db)
    const b = ensurePunchIdentity(db)
    expect(b).toEqual(a)
    const cert = new X509Certificate(a.certPem)
    expect(cert.verify(cert.publicKey)).toBe(true)
    const digest = createHash('sha256').update(cert.raw).digest('hex').toUpperCase().match(/../g).join(':')
    expect(a.fingerprint).toBe(digest)
    expect(a.iceUfrag).toMatch(/^[A-Za-z0-9+/]{4,256}$/)
    expect(a.icePwd).toMatch(/^[A-Za-z0-9+/]{22,256}$/)
    expect(a.localPort).toBeGreaterThanOrEqual(49152)
    expect(a.localPort).toBeLessThanOrEqual(65535)
  })
})

describe('materializePunchIdentity', () => {
  it('writes the key only to a private temp dir and removes it on cleanup', () => {
    const db = freshDb()
    const id = ensurePunchIdentity(db)
    const m = materializePunchIdentity(db)
    expect(fs.readFileSync(m.certificatePemFile, 'utf8')).toBe(id.certPem)
    expect(fs.readFileSync(m.keyPemFile, 'utf8')).toBe(id.keyPem)
    expect(fs.statSync(m.keyPemFile).mode & 0o077).toBe(0)
    expect(fs.statSync(path.dirname(m.keyPemFile)).mode & 0o077).toBe(0)
    expect(m.portRange).toEqual({ begin: id.localPort, end: id.localPort })
    expect(m.ice).toEqual({ iceUfrag: id.iceUfrag, icePwd: id.icePwd })
    m.cleanup()
    expect(fs.existsSync(m.keyPemFile)).toBe(false)
    expect(fs.existsSync(path.dirname(m.keyPemFile))).toBe(false)
  })

  it('the private key is stored in the database file, not in a standing file beside it', () => {
    const db = freshDb()
    const id = ensurePunchIdentity(db)
    expect(db.prepare('SELECT key_pem FROM punch_identity WHERE id = 1').get().key_pem).toBe(id.keyPem)
    expect(fs.readdirSync(path.dirname(db.name)).filter((n) => n.endsWith('.pem'))).toEqual([])
  })
})

describe('rememberOwnReflexive', () => {
  it('keeps only srflx candidate lines and round-trips them', () => {
    const db = freshDb()
    ensurePunchIdentity(db)
    const srflx = 'candidate:1 1 UDP 1686052607 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0'
    const host = 'candidate:2 1 UDP 2122317823 192.168.1.5 50001 typ host'
    rememberOwnReflexive(db, [host, srflx], () => '2026-10-08T00:00:00.000Z')
    const id = ensurePunchIdentity(db)
    expect(id.reflexiveCandidates).toEqual([srflx])
    expect(id.reflexiveLearnedAt).toBe('2026-10-08T00:00:00.000Z')
  })
})

describe('stale key directories', () => {
  it('materialize sweeps only dead-pid mkdtemp-shaped directories and leaves look-alike files, dirs and symlinks', () => {
    const tmp = os.tmpdir()
    const dead = fs.mkdtempSync(path.join(tmp, 'shoresh-punch-999999999-'))
    fs.writeFileSync(path.join(dead, 'key.pem'), 'SECRET')
    const file = path.join(tmp, `shoresh-punch-mem-1-x${process.pid}.sqlite`)
    fs.writeFileSync(file, 'db')
    const wiring = fs.mkdtempSync(path.join(tmp, 'shoresh-punch-wiring-'))
    const target = fs.mkdtempSync(path.join(tmp, 'sweep-target-'))
    const link = path.join(tmp, 'shoresh-punch-999999998-abc123')
    fs.symlinkSync(target, link)
    const live = materializePunchIdentity(freshDb())
    cleanups.push(live.cleanup, () => { fs.rmSync(file, { force: true }); fs.rmSync(wiring, { recursive: true, force: true }); fs.rmSync(link, { force: true }); fs.rmSync(target, { recursive: true, force: true }) })
    expect(fs.existsSync(dead)).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(wiring)).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(live.keyPemFile)).toBe(true)
  })
})

describe('stale key directory removal failure', () => {
  it('is surfaced as a warning that names the path class only and never aborts materializePunchIdentity', () => {
    const tmp = os.tmpdir()
    const stuck = fs.mkdtempSync(path.join(tmp, 'shoresh-punch-999999997-'))
    const inner = path.join(stuck, 'inner')
    fs.mkdirSync(inner)
    fs.writeFileSync(path.join(inner, 'key.pem'), 'SECRET-KEY-MATERIAL')
    fs.chmodSync(inner, 0o500)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => { warn.mockRestore(); fs.chmodSync(inner, 0o700); fs.rmSync(stuck, { recursive: true, force: true }) })
    let live
    expect(() => { live = materializePunchIdentity(freshDb()) }).not.toThrow()
    cleanups.push(live.cleanup)
    expect(fs.existsSync(live.keyPemFile)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const text = warn.mock.calls[0].join(' ')
    expect(text).toContain('stale punch key directory')
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain(stuck)
  })
})

const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'p'.repeat(22) + '\r\n'
const established = (peerId) => ({ peerId, role: 'offerer', remoteSdpType: 'answer', remoteSdp: SDP, candidates: [{ candidate: 'candidate:1 1 UDP 1 203.0.113.7 6000 typ srflx', mid: '0' }], localCandidates: ['candidate:2 1 UDP 1 203.0.113.1 4000 typ srflx'] })
const memoryRows = (db) => db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c

describe('createPunchPersistence - remembered only after authGate admission', () => {
  it('an upgraded but not yet admitted peer leaves nothing behind; admission persists the memory and our own reflexive', () => {
    const db = freshDb()
    ensurePunchIdentity(db)
    const p = createPunchPersistence(db)
    p.onEstablished(established('peer-x'))
    expect(memoryRows(db)).toBe(0)
    p.onPeerAdmitted('peer-x')
    expect(memoryRows(db)).toBe(1)
    expect(ensurePunchIdentity(db).reflexiveCandidates).toEqual(['candidate:2 1 UDP 1 203.0.113.1 4000 typ srflx'])
  })

  it('admission of a peer that did not come over the punch transport persists nothing', () => {
    const db = freshDb()
    ensurePunchIdentity(db)
    createPunchPersistence(db).onPeerAdmitted('peer-tcp')
    expect(memoryRows(db)).toBe(0)
  })

  it('a stale upgraded-but-never-admitted entry is not persisted by a later admission', () => {
    const db = freshDb()
    ensurePunchIdentity(db)
    let t = 0
    const p = createPunchPersistence(db, { now: () => t })
    p.onEstablished(established('peer-x'))
    t = 60_000
    p.onPeerAdmitted('peer-x')
    expect(memoryRows(db)).toBe(0)
  })
})

describe('rotatePunchIdentity', () => {
  it('replaces cert, key, fingerprint and ICE credentials but keeps the pinned port', () => {
    const db = freshDb()
    const before = ensurePunchIdentity(db)
    rotatePunchIdentity(db)
    const after = ensurePunchIdentity(db)
    expect(after.certPem).not.toBe(before.certPem)
    expect(after.keyPem).not.toBe(before.keyPem)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.iceUfrag).not.toBe(before.iceUfrag)
    expect(after.icePwd).not.toBe(before.icePwd)
    expect(after.localPort).toBe(before.localPort)
    expect(new X509Certificate(after.certPem).verify(new X509Certificate(after.certPem).publicKey)).toBe(true)
  })

  it('does not create an identity on a device that never had one', () => {
    const db = freshDb()
    rotatePunchIdentity(db)
    expect(db.prepare('SELECT COUNT(*) c FROM punch_identity').get().c).toBe(0)
  })
})

describe('forgetRevokedPeer', () => {
  it('clears that peer\'s punch memory and rotates our identity, leaving other peers\' memory', () => {
    const db = freshDb()
    const before = ensurePunchIdentity(db)
    const p = createPunchPersistence(db)
    for (const id of ['peer-x', 'peer-y']) {
      p.onEstablished(established(id))
      p.onPeerAdmitted(id)
    }
    expect(memoryRows(db)).toBe(2)
    forgetRevokedPeer(db, 'peer-x')
    expect(db.prepare('SELECT peer_id FROM peer_punch_memory').all()).toEqual([{ peer_id: 'peer-y' }])
    const after = ensurePunchIdentity(db)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.icePwd).not.toBe(before.icePwd)
    expect(after.reflexiveCandidates).toEqual([])
  })

  it('rotates ONCE per revocation: repeat calls, and a peer we hold nothing for, leave the identity alone', () => {
    const db = freshDb()
    ensurePunchIdentity(db)
    const p = createPunchPersistence(db)
    p.onEstablished(established('peer-x'))
    p.onPeerAdmitted('peer-x')
    forgetRevokedPeer(db, 'peer-x')
    const rotated = ensurePunchIdentity(db)
    forgetRevokedPeer(db, 'peer-x')
    forgetRevokedPeer(db, 'peer-x')
    forgetRevokedPeer(db, 'never-seen')
    expect(ensurePunchIdentity(db).fingerprint).toBe(rotated.fingerprint)
  })
})
