// T342 Slice 0 battle tests (docs/adr/2026-10-07-distributed-purge-authority.md, "The regeneration
// problem — Slice 0"). The purge/regenerate path rebuilds the Automerge document FROM SQLite
// (seed.js's seedAllFromSqlite), but camp_authority_log has no backing SQL table — so a naive
// regeneration DROPS the authority log entirely, and the T331 causal-ancestor replay can no longer
// validate on any peer. Slice 0 carries the authority log through the regeneration by RE-AUTHORING
// each entry as its own Automerge change on a fork holding exactly its original ancestor-entries,
// and makes the replay ENTRY-ID-keyed so it tolerates more than one completing change per entry id
// after a peer merge (peers hold originals; the regenerating device holds re-authored copies).
//
// Real @automerge/automerge documents and real Ed25519 keys on the crypto/merge seam (BT-9/BT-10),
// per the ADR — no mocks. BT-8 exercises the pure causal/quorum replay unsigned (same scope and
// reason as authorityReplay.test.js's own property test; signature authenticity is a separate,
// already-tested concern).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Automerge from '@automerge/automerge'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema, openLocalDb } from '../db/localDb.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { signAuthorityEntry } from './authorityLogSignature.js'
import { projectAll } from './projector.js'
import { createAuthorityReplayContext, currentRevokedDeviceIds } from './authorityReplay.js'
import { seedAllFromSqlite, carryAuthorityLog } from './seed.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function keyDb() {
  const file = path.join(os.tmpdir(), `shoresh-carry-key-${Date.now()}-${Math.random()}.sqlite`)
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

function campDb() {
  const file = path.join(os.tmpdir(), `shoresh-carry-camp-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
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

// The DERIVED authority state as it lands in SQLite after a real projection — the thing a purge must
// not reset. Sorted so two projections of the same logical state compare equal regardless of insert
// order.
function authoritySnapshot(db) {
  return db
    .prepare('SELECT device_id, status FROM authority_cache ORDER BY device_id')
    .all()
    .map((r) => `${r.device_id}:${r.status}`)
}

function appliedLogRows(db) {
  return db
    .prepare('SELECT entry_id, kind, target_device_id, signer_device_id FROM applied_authority_log ORDER BY entry_id')
    .all()
    .map((r) => `${r.entry_id}|${r.kind}|${r.target_device_id ?? ''}|${r.signer_device_id ?? ''}`)
}

// ---------------------------------------------------------------------------
// BT-9 — purge carries forward on a LONE device (no peer). The red-before-green gate for the carry.
// ---------------------------------------------------------------------------
describe('BT-9 — authority log survives document regeneration (lone device, signed)', () => {
  it('derived admin + revoked set are IDENTICAL before and after seedAllFromSqlite regeneration', async () => {
    const founder = await makeDevice()
    const a = await makeDevice()
    const b = await makeDevice()
    const c = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'a', targetPeerId: a.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 'b', targetPeerId: b.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 'c', targetPeerId: c.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    // Quorum (N=4, threshold 2 of founder/a/b) removes c.
    doc = writeRevoke(doc, { targetDeviceId: 'c', signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeRevoke(doc, { targetDeviceId: 'c', signerDeviceId: 'a', signerDb: a.db })

    const dbBefore = campDb()
    projectAll(dbBefore, doc)
    const snapshotBefore = authoritySnapshot(dbBefore)
    // Non-vacuity: the pre-regen state is genuinely non-trivial (admins AND a revoked device).
    expect(snapshotBefore).toContain('founder:admin')
    expect(snapshotBefore).toContain('c:revoked')

    // Regenerate the document FROM SQLite, carrying the authority log forward from the live doc.
    const regenerated = seedAllFromSqlite(dbBefore, createEmptyDoc(), { authoritySourceDoc: doc })

    const dbAfter = campDb()
    projectAll(dbAfter, regenerated)
    const snapshotAfter = authoritySnapshot(dbAfter)

    // RED against pre-change seed.js: the regenerated document drops camp_authority_log entirely, so
    // snapshotAfter is [] and this equality fails. GREEN once the carry re-authors the entries.
    expect(snapshotAfter).toEqual(snapshotBefore)
  })
})

// ---------------------------------------------------------------------------
// BT-8 — convergence property: replay(original) == replay(carried) == replay(merge(original,
// carried)) for the admin set AND the revoked set, under every merge order. Checked against
// hand-constructed cases with human-known absolute outcomes so agreement is non-vacuous (the exact
// non-vacuity concern authorityReplay.test.js's own property test resolves the same way), plus a
// randomized fuzz asserting cross-equivalence over many concurrent DAGs.
// ---------------------------------------------------------------------------
describe('BT-8 — carry/merge convergence (pure causal/quorum replay)', () => {
  let nextId = 0
  const unsignedUid = () => `u${nextId++}`
  function pushEntry(doc, entry) {
    const id = unsignedUid()
    let d = doc
    for (const [field, value] of Object.entries(entry)) {
      d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
    }
    return d
  }
  function admins(doc) {
    return [...createAuthorityReplayContext(Automerge, doc, { founderDeviceId: 'FOUNDER' }).currentState().grantedSet].sort()
  }
  function revoked(doc) {
    return currentRevokedDeviceIds(Automerge, doc, { founderDeviceId: 'FOUNDER' })
  }
  function changeHashes(doc) {
    return new Set(Automerge.getAllChanges(doc).map((c) => Automerge.decodeChange(c).hash))
  }

  it('hand-constructed absolute outcome: original, carried, and both merges all equal the known state', () => {
    // N=3 (FOUNDER, A, B); target A revoked by a quorum (B and FOUNDER). Known outcome: admins
    // {B, FOUNDER}, revoked {A}. Two concurrent revoke branches, like the pinned case in
    // authorityReplay.test.js.
    let base = pushEntry(createEmptyDoc(), { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    base = pushEntry(base, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    const branch0 = pushEntry(Automerge.clone(base), { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })
    const branch1 = pushEntry(Automerge.clone(base), { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const original = Automerge.merge(Automerge.clone(branch0), branch1)

    const KNOWN_ADMINS = ['B', 'FOUNDER']
    const KNOWN_REVOKED = ['A']
    expect(admins(original)).toEqual(KNOWN_ADMINS)
    expect(revoked(original)).toEqual(KNOWN_REVOKED)

    const carried = carryAuthorityLog(original, createEmptyDoc())
    // Genuinely re-authored, not aliased: the carried branch shares only genesis with the original.
    const origHashes = changeHashes(original)
    const carriedOnly = [...changeHashes(carried)].filter((h) => !origHashes.has(h))
    expect(carriedOnly.length).toBeGreaterThan(0)

    expect(admins(carried)).toEqual(KNOWN_ADMINS)
    expect(revoked(carried)).toEqual(KNOWN_REVOKED)

    const mergedAB = Automerge.merge(Automerge.clone(original), carried)
    const mergedBA = Automerge.merge(Automerge.clone(carried), original)
    expect(admins(mergedAB)).toEqual(KNOWN_ADMINS)
    expect(revoked(mergedAB)).toEqual(KNOWN_REVOKED)
    expect(admins(mergedBA)).toEqual(KNOWN_ADMINS)
    expect(revoked(mergedBA)).toEqual(KNOWN_REVOKED)
  })

  it('random concurrent DAGs: carried and merged replays match the original replay for admins and revoked', () => {
    function mulberry32(seed) {
      let a = seed
      return function () {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const SEED = 342007
    const CASES = 25
    const DEVICES = ['FOUNDER', 'A', 'B', 'C']
    const rng = mulberry32(SEED)
    const pick = (arr) => arr[Math.floor(rng() * arr.length)]

    let casesWithRevocation = 0
    for (let c = 0; c < CASES; c++) {
      let base = pushEntry(createEmptyDoc(), { kind: 'grant', target_device_id: 'FOUNDER', signer_device_id: 'FOUNDER' })
      for (const d of DEVICES) {
        if (d !== 'FOUNDER' && rng() < 0.7) base = pushEntry(base, { kind: 'grant', target_device_id: d, signer_device_id: 'FOUNDER' })
      }
      // Three concurrent branches forked from the shared base, never seeing each other.
      const branches = []
      for (let b = 0; b < 3; b++) {
        let branch = Automerge.clone(base)
        for (let i = 0; i < 3; i++) {
          const kind = rng() < 0.5 ? 'grant' : 'revoke'
          const signer = pick(DEVICES)
          const target = pick(DEVICES)
          if (signer === target) continue
          branch = pushEntry(branch, { kind, target_device_id: target, signer_device_id: signer })
        }
        branches.push(branch)
      }
      let original = Automerge.clone(branches[0])
      original = Automerge.merge(original, branches[1])
      original = Automerge.merge(original, branches[2])

      const expectedAdmins = admins(original)
      const expectedRevoked = revoked(original)
      if (expectedRevoked.length > 0) casesWithRevocation++

      const carried = carryAuthorityLog(original, createEmptyDoc())
      const mergedAB = Automerge.merge(Automerge.clone(original), carried)
      const mergedBA = Automerge.merge(Automerge.clone(carryAuthorityLog(original, createEmptyDoc())), original)

      const ctx = `case ${c} (seed ${SEED})`
      expect(admins(carried), `${ctx} carried admins`).toEqual(expectedAdmins)
      expect(revoked(carried), `${ctx} carried revoked`).toEqual(expectedRevoked)
      expect(admins(mergedAB), `${ctx} merge(orig,carried) admins`).toEqual(expectedAdmins)
      expect(revoked(mergedAB), `${ctx} merge(orig,carried) revoked`).toEqual(expectedRevoked)
      expect(admins(mergedBA), `${ctx} merge(carried,orig) admins`).toEqual(expectedAdmins)
      expect(revoked(mergedBA), `${ctx} merge(carried,orig) revoked`).toEqual(expectedRevoked)
    }
    // Non-vacuity: the suite actually exercised revocations, not just all-admin states.
    expect(casesWithRevocation).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// BT-10 — rebuild idempotence: projecting a document that holds authority entries (including a
// merge of originals + re-authored copies) reproduces identical derived rows, with no duplicate or
// lost entry, however many times it runs.
// ---------------------------------------------------------------------------
describe('BT-10 — rebuild idempotence over carried authority entries (signed)', () => {
  it('projecting merge(original, carried) reproduces identical authority rows, no dup/loss', async () => {
    const founder = await makeDevice()
    const a = await makeDevice()
    const b = await makeDevice()
    let doc = createEmptyDoc()
    doc = writeGenesis(doc, { founderDeviceId: 'founder', founderPeerId: founder.peerId })
    doc = writeGrant(doc, { targetDeviceId: 'a', targetPeerId: a.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeGrant(doc, { targetDeviceId: 'b', targetPeerId: b.peerId, signerDeviceId: 'founder', signerDb: founder.db })
    doc = writeRevoke(doc, { targetDeviceId: 'b', signerDeviceId: 'founder', signerDb: founder.db })

    const dbOriginal = campDb()
    projectAll(dbOriginal, doc)
    const cacheOriginal = authoritySnapshot(dbOriginal)
    const logOriginal = appliedLogRows(dbOriginal)

    // The regenerating device holds re-authored copies; a peer still holds the originals. After
    // they merge, every entry id has MORE THAN ONE completing change.
    const carried = carryAuthorityLog(doc, createEmptyDoc())
    const merged = Automerge.merge(Automerge.clone(doc), carried)

    const dbMerged = campDb()
    projectAll(dbMerged, merged)
    expect(authoritySnapshot(dbMerged)).toEqual(cacheOriginal)
    // No duplicate entry rows despite duplicate completing changes.
    expect(appliedLogRows(dbMerged)).toEqual(logOriginal)
    const dups = dbMerged
      .prepare('SELECT entry_id, COUNT(*) n FROM applied_authority_log GROUP BY entry_id HAVING n > 1')
      .all()
    expect(dups).toEqual([])

    // Idempotent: projecting the same merged document again (what a rebuild re-run does) yields the
    // identical rows.
    projectAll(dbMerged, merged)
    expect(authoritySnapshot(dbMerged)).toEqual(cacheOriginal)
    expect(appliedLogRows(dbMerged)).toEqual(logOriginal)
  })
})
