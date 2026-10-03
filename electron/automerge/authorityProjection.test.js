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
import { createEmptyDoc, applyWrite, listRecordIds, readRecord } from './campDocument.js'
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
  const signature = signAuthorityEntry(signerDb, { id, kind: 'grant', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
  let d = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field: 'kind', value: 'grant' })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_device_id', value: targetDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'target_peer_id', value: targetPeerId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signer_device_id', value: signerDeviceId })
  d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  return d
}

function writeRevoke(doc, { targetDeviceId, signerDeviceId, signerDb }) {
  const id = uid()
  const signature = signAuthorityEntry(signerDb, { id, kind: 'revoke', target_device_id: targetDeviceId, signer_device_id: signerDeviceId })
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
    const forgedSig = signAuthorityEntry(attacker.db, { id, kind: 'grant', target_device_id: 'attacker-device', signer_device_id: 'founder' })
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

  it('Code Reviewer MEDIUM (round-3 correction) — re-granted with a NEW peer id (no intervening revoke): the CAUSALLY LATEST grant\'s peer id wins for signature resolution, not whichever the document happens to list first', async () => {
    const founder = await makeDevice()
    const otherOld = await makeDevice() // 'other's FIRST device_identity_key
    const otherNew = await makeDevice() // 'other's SECOND device_identity_key (e.g. corrected/re-affirmed)
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: otherOld.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    // A second grant for the SAME target, causally after the first, naming a DIFFERENT peer id —
    // no revoke in between, so this is purely a peer-id-resolution question, isolated from the
    // separate vote-persistence-across-re-grant question.
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: otherNew.peerId, signerDeviceId: 'founder', signerDb: founder.db })

    const db = campDb()
    projectAll(db, doc)
    expect(cacheStatus(db, 'other')).toBe('admin')

    // 'other' now signs a fresh entry with its NEW key. If peer-id resolution picked the STALE
    // (causally earlier) grant's peer id instead of the latest one, this signature would fail to
    // verify and the entry would be silently dropped.
    doc = writeGrant(doc, { targetDeviceId: 'yet-another', targetPeerId: 'peer-yet-another', signerDeviceId: 'other', signerDb: otherNew.db })
    projectAll(db, doc)
    expect(cacheStatus(db, 'yet-another')).toBe('admin')
    expect(
      db.prepare("SELECT COUNT(*) c FROM applied_authority_log WHERE target_device_id = 'yet-another'").get().c
    ).toBe(1)
  })

  it('a vote cast before a re-grant does not count against the device\'s NEW tenure after it is re-granted', async () => {
    const founder = await makeDevice()
    const otherOld = await makeDevice()
    const otherNew = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: otherOld.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    // N=2 (founder, other) — founder's lone vote already meets threshold 1 and removes 'other'.
    doc = writeRevoke(doc, { targetDeviceId: 'other', signerDeviceId: 'founder', signerDb: founder.db })
    const dbMid = campDb()
    projectAll(dbMid, doc)
    expect(cacheStatus(dbMid, 'other')).toBe('revoked')

    // 'other' is re-granted (re-paired under a new key) causally AFTER the revoke above. The
    // stale vote must NOT still be sitting there, instantly re-removing the fresh grant.
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: otherNew.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    const db = campDb()
    projectAll(db, doc)
    expect(cacheStatus(db, 'other')).toBe('admin')
  })

  it('SECURITY CRITICAL (round-3 correction) — a captured genuine grant signature replayed under a NEW record id does NOT resurrect a revoked device', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    // The genuine, original grant — captured off the wire by an attacker (anyone with document
    // read access, which under CRDT sync is every paired device, can see every entry including
    // its signature).
    doc = writeGrant(doc, { targetDeviceId: 'other', targetPeerId: other.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    const originalGrant = db_latestEntry(doc, 'grant', 'other')
    // The founder later revokes it.
    doc = writeRevoke(doc, { targetDeviceId: 'other', signerDeviceId: 'founder', signerDb: founder.db })

    const dbBefore = campDb()
    projectAll(dbBefore, doc)
    expect(cacheStatus(dbBefore, 'other')).toBe('revoked')

    // The attack: replay the EXACT captured (kind, target_device_id, signer_device_id, signature)
    // tuple — unchanged, including the real signature, which the founder is STILL a valid admin
    // for — under a BRAND NEW record id, hoping to resurrect 'other' as admin.
    const replayId = 'replayed-entry-id'
    let replayed = applyWrite(doc, { entity: 'camp_authority_log', entity_id: replayId, field: 'kind', value: 'grant' })
    replayed = applyWrite(replayed, { entity: 'camp_authority_log', entity_id: replayId, field: 'target_device_id', value: 'other' })
    replayed = applyWrite(replayed, { entity: 'camp_authority_log', entity_id: replayId, field: 'target_peer_id', value: other.peerId })
    replayed = applyWrite(replayed, { entity: 'camp_authority_log', entity_id: replayId, field: 'signer_device_id', value: 'founder' })
    replayed = applyWrite(replayed, { entity: 'camp_authority_log', entity_id: replayId, field: 'signature', value: originalGrant.signature })

    const dbAfter = campDb()
    projectAll(dbAfter, replayed)
    // The replayed entry must fail signature verification (it was signed for a DIFFERENT id) and
    // never reach applied_authority_log — 'other' stays revoked.
    expect(cacheStatus(dbAfter, 'other')).toBe('revoked')
    expect(
      dbAfter.prepare("SELECT COUNT(*) c FROM applied_authority_log WHERE entry_id = ?").get(replayId).c
    ).toBe(0)
  })
})

// Reads a (kind, signature) pair back off the document for the named target/kind — used only to
// simulate an attacker capturing a genuine signed entry it observed on the wire/in the document.
function db_latestEntry(doc, kind, targetDeviceId) {
  for (const id of listRecordIds(doc, 'camp_authority_log')) {
    const row = readRecord(doc, 'camp_authority_log', id)
    if (row?.kind === kind && row?.target_device_id === targetDeviceId) return row
  }
  return null
}
