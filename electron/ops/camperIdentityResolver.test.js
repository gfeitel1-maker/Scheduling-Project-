// T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md) — the shared
// resolve-or-mint entry point used by every real camper-id-minting call site
// (attributeElectiveSubject.js, src/ingest/preferenceSheet.js x2,
// src/localClient.mock.js). Exercises real SQLite via openLocalDb, same
// fixture shape as commitElectiveRun.identicalSubmissions.test.js.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { resolveOrMintCamperId } from './camperIdentityResolver.js'
import { deriveCamperId } from './electiveDerivedIds.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t321-resolver-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('resolveOrMintCamperId — cache miss (first import of a new camper)', () => {
  it('mints a camper id and writes a camper_identity_keys row for a name-mode lookup', () => {
    const { db, campId } = freshDb()
    const { camperId, minted } = resolveOrMintCamperId(db, {
      campId, deviceId: 'dev-1', displayName: 'Ari Green',
    })
    expect(minted).toBe(true)
    expect(camperId).toMatch(/^camper2:/)
    const lookupId = deriveCamperId(campId, { displayName: 'Ari Green' })
    const row = db.prepare('SELECT * FROM camper_identity_keys WHERE id = ?').get(lookupId)
    expect(row).toBeTruthy()
    expect(row.key_mode).toBe('name')
    expect(row.key_value).toBe('arigreen')
    expect(row.camper_id).toBe(camperId)
  })

  it('mints a camper id for an ext-mode lookup, key_value is the raw external id', () => {
    const { db, campId } = freshDb()
    const { camperId } = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', externalId: 'CM-4417' })
    const lookupId = deriveCamperId(campId, { externalId: 'CM-4417' })
    const row = db.prepare('SELECT * FROM camper_identity_keys WHERE id = ?').get(lookupId)
    expect(row.key_mode).toBe('ext')
    expect(row.key_value).toBe('CM-4417')
    expect(row.camper_id).toBe(camperId)
  })

  it('mints a camper id for a sub-mode (provisional subject) lookup', () => {
    const { db, campId } = freshDb()
    const { camperId } = resolveOrMintCamperId(db, {
      campId, deviceId: 'dev-1', submissionKey: 'subhash1', arrivalId: 'arrive-1',
    })
    const lookupId = deriveCamperId(campId, { submissionKey: 'subhash1', arrivalId: 'arrive-1' })
    const row = db.prepare('SELECT * FROM camper_identity_keys WHERE id = ?').get(lookupId)
    expect(row.key_mode).toBe('sub')
    expect(row.camper_id).toBe(camperId)
  })

  it('two different camper lookups mint two different random camper ids', () => {
    const { db, campId } = freshDb()
    const a = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })
    const b = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Noa Katz' })
    expect(a.camperId).not.toBe(b.camperId)
  })
})

describe('resolveOrMintCamperId — cache hit (already-known camper)', () => {
  it('resolves to the SAME camper id on a second call for the same key, and does not mint again', () => {
    const { db, campId } = freshDb()
    const first = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })
    const second = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })
    expect(second.minted).toBe(false)
    expect(second.camperId).toBe(first.camperId)
  })

  // Acceptance criterion 6 — a re-imported sheet for an already-known camper
  // resolves to the SAME campers.id it always has, mirroring the migration
  // back-fill test's own assertion but through the live resolver path.
  it('resolves the same name through a differently-cased/spaced spelling (canonicalization)', () => {
    const { db, campId } = freshDb()
    const first = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari  Green' })
    const second = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'ari green' })
    expect(second.camperId).toBe(first.camperId)
  })
})
