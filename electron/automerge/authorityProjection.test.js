// T331 (docs/adr/2026-10-02-distributed-revocation-authority.md) — gate C: the verify-and-replay
// loop (projector.js's upsertCampAuthorityLogEntity) wired into the REAL projection path
// (projectAll), not just the pure authorityReplay unit. Each simulated "device" is a SEPARATE
// throwaway db holding its own real device_identity_key, so signatures are genuine Ed25519
// signatures over real keys — not hand-waved. All entries land in ONE shared document, mirroring
// how a real multi-device camp's entries merge.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema, openLocalDb } from '../db/localDb.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { signAuthorityEntry } from './authorityLogSignature.js'
import { projectAll, rebuildFromDoc } from './projector.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function keyDb() {
  const file = path.join(os.tmpdir(), `shoresh-authproj-key-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  return db
}

async function makeDevice() {
  const db = keyDb()
  const { peerId } = await ensureDeviceIdentity(db)
  return { db, peerId }
}

let entrySeq = 0
function uid() {
  return `entry-${entrySeq++}`
}

function writeGenesis(doc, { founderDeviceId, founderPeerId }) {
  const id = uid()
  let d = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'kind', value: 'genesis' })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_device_id', value: founderDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_peer_id', value: founderPeerId })
  return d
}

function writeGrant(doc, { targetDeviceId, targetPeerId, signerDeviceId, signerDb }) {
  const id = uid()
  const signature = signAuthorityEntry(signerDb, { kind: 'grant', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  let d = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'kind', value: 'grant' })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_device_id', value: targetDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_peer_id', value: targetPeerId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signer_device_id', value: signerDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  return d
}

function writeRevoke(doc, { targetDeviceId, signerDeviceId, signerDb }) {
  const id = uid()
  const signature = signAuthorityEntry(signerDb, { kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  let d = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'kind', value: 'revoke' })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_device_id', value: targetDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signer_device_id', value: signerDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  return d
}

function campDb() {
  const file = path.join(os.tmpdir(), `shoresh-authproj-camp-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

function cacheStatus(db, deviceId) {
  return db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status ?? null
}

describe('projector gate C — upsertCampAuthorityLogEntity (real signatures, real projection)', () => {
  it('a valid grant and signature puts a device in authority_cache as admin', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: other.peerId, signerDeviceId: 'founder', signerDb: founder.db })

    const db = campDb()
    projectAll(db, doc)
    expect(cacheStatus(db, 'founder')).toBe('admin')
    expect(cacheStatus(db, 'other')).toBe('admin')
  })

  it('battle test 4 (authenticity) — a FORGED signature (wrong signer key) is dropped, never counted', async () => {
    const founder = await makeDevice()
    const attacker = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    // Attacker claims to BE the founder (signer_device_id: 'founder') but signs with their OWN key
    // — the signature will not verify against the founder's real peer id.
    const id = uid()
    const forgedSig = signAuthorityEntry(attacker.db, { kind: 'grant', target_device_id: 'attacker-device', signer_device_id: 'founder' })
    let d = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'kind', value: 'grant' })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_device_id', value: 'attacker-device' })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_peer_id', value: attacker.peerId })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signer_device_id', value: 'founder' })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: forgedSig })

    const db = campDb()
    projectAll(db, d)
    // Fail-safe, not absent: an unverifiable claim is never trusted as admin — it is tracked as
    // 'revoked' (the safe default for any device ever mentioned), never 'admin'.
    expect(cacheStatus(db, 'attacker-device')).toBe('revoked')
    expect(db.prepare('SELECT COUNT(*) c FROM applied_authority_log WHERE target_device_id = ?').get('attacker-device').c).toBe(0)
  })

  it('battle test 2 — a removed admin\'s new revoke is dropped, not applied, through the real projection path', async () => {
    const founder = await makeDevice()
    const s = await makeDevice()
    const t = await makeDevice()
    const d4 = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 's', targetPeerId: s.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 't', targetPeerId: t.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 'd4', targetPeerId: d4.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    // Quorum (N=4, threshold 2 of founder/t/d4) removes s.
    doc = writeRevoke(doc, { targetDeviceId: 's', signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeRevoke(doc, { targetDeviceId: 's', signerDeviceId: 't', signerDb: t.db })

    const db1 = campDb()
    projectAll(db1, doc)
    expect(cacheStatus(db1, 's')).toBe('revoked')

    // s, now revoked, signs a revoke of d4 anyway.
    doc = writeRevoke(doc, { targetDeviceId: 'd4', signerDeviceId: 's', signerDb: s.db })
    const db2 = campDb()
    projectAll(db2, doc)
    expect(cacheStatus(db2, 'd4')).toBe('admin') // s's revoke never counted
    expect(cacheStatus(db2, 's')).toBe('revoked')
  })

  it('battle test 6 — purge/rebuild carries the revocation set forward (never resets it)', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: other.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeRevoke(doc, { targetDeviceId: 'other', signerDeviceId: 'founder', signerDb: founder.db })

    const db = campDb()
    projectAll(db, doc)
    expect(cacheStatus(db, 'other')).toBe('revoked')

    // Simulate a purge/rebuild: wipe EVERY modeled entity's table and re-derive from the document
    // alone — rebuildFromDoc's full-camp shape (same primitive purgeSupportCommand.js/
    // rebuildSupportCommand.js use to prove "SQLite is disposable"). The previously-revoked
    // device must NOT be silently re-admitted.
    rebuildFromDoc(db, doc)
    expect(cacheStatus(db, 'other')).toBe('revoked')
  })

  it('battle test 5 — the founder is removable by a quorum, through the real projection path', async () => {
    const founder = await makeDevice()
    const a = await makeDevice()
    const b = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'a', targetPeerId: a.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 'b', targetPeerId: b.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeRevoke(doc, { targetDeviceId: 'founder', signerDeviceId: 'a', signerDb: a.db })
    doc = writeRevoke(doc, { targetDeviceId: 'founder', signerDeviceId: 'b', signerDb: b.db })

    const db = campDb()
    projectAll(db, doc)
    expect(cacheStatus(db, 'founder')).toBe('revoked')
  })
})
