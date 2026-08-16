// @vitest-environment node
//
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { listMigrationReviews, dismissMigrationReviews } from './migrationReviews.js'

const files = []
let db

beforeEach(() => {
  const file = path.join(os.tmpdir(), `shoresh-migreview-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function insertReview(id, kind, detail, campId = 'camp1') {
  db.prepare(
    `INSERT INTO location_migration_reviews (id, camp_id, location_id, name, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, campId, 'loc-1', 'Pool', kind, detail ? JSON.stringify(detail) : null, new Date().toISOString())
}

describe('listMigrationReviews (D3) — table-absence-guarded local read', () => {
  it('returns [] rather than throwing when the journal table does not exist', () => {
    // A fresh openLocalDb already creates the table via the v32 migration
    // block (it always runs on a fresh install too) — drop it to simulate a
    // device that paired into an already-v32 camp and never ran it.
    db.exec('DROP TABLE IF EXISTS location_migration_reviews')
    expect(listMigrationReviews(db)).toEqual([])
  })

  it('returns [] for an existing but empty journal', () => {
    expect(listMigrationReviews(db)).toEqual([])
  })

  it('reads rows for the singleton camp, with detail parsed to an object', () => {
    insertReview('r1', 'capacity_disagreement', { declaredCaps: [1, 3], seededCapacity: 3 })
    insertReview('r2', 'was_unlimited', { seededCapacity: 1 })

    const rows = listMigrationReviews(db)
    expect(rows).toHaveLength(2)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.r1.kind).toBe('capacity_disagreement')
    expect(byId.r1.detail).toEqual({ declaredCaps: [1, 3], seededCapacity: 3 })
    expect(byId.r2.detail).toEqual({ seededCapacity: 1 })
  })

  it('defends against a corrupted detail column — parses to null, does not throw', () => {
    db.prepare(
      `INSERT INTO location_migration_reviews (id, camp_id, location_id, name, kind, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('r-bad', 'camp1', 'loc-1', 'Pool', 'was_unlimited', '{not json', new Date().toISOString())

    const rows = listMigrationReviews(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toBeNull()
  })

  it('scopes to the calling device’s own camp only', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp2', 'Other Camp')
    insertReview('r1', 'was_unlimited', { seededCapacity: 1 }, 'camp1')
    insertReview('r2', 'was_unlimited', { seededCapacity: 1 }, 'camp2')

    // SELECT id FROM camps LIMIT 1 picks whichever camp row is first — assert
    // against whichever one that resolves to, matching this module's own
    // "singleton camp" contract rather than hardcoding camp1.
    const actualCampId = db.prepare('SELECT id FROM camps LIMIT 1').get().id
    const rows = listMigrationReviews(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(actualCampId === 'camp1' ? 'r1' : 'r2')
  })
})

describe('dismissMigrationReviews (D4) — local-only delete, resolution', () => {
  it('deletes the given ids and reports how many were removed', () => {
    insertReview('r1', 'was_unlimited', { seededCapacity: 1 })
    insertReview('r2', 'capacity_disagreement', { declaredCaps: [1, 2], seededCapacity: 2 })

    const result = dismissMigrationReviews(db, ['r1'])
    expect(result).toEqual({ ok: true, dismissed: 1 })
    expect(listMigrationReviews(db).map((r) => r.id)).toEqual(['r2'])
  })

  it('is a no-op that still reports ok on an absent table', () => {
    db.exec('DROP TABLE IF EXISTS location_migration_reviews')
    expect(dismissMigrationReviews(db, ['r1'])).toEqual({ ok: true, dismissed: 0 })
  })

  it('is a no-op for an empty or missing id list', () => {
    expect(dismissMigrationReviews(db, [])).toEqual({ ok: true, dismissed: 0 })
    expect(dismissMigrationReviews(db, undefined)).toEqual({ ok: true, dismissed: 0 })
  })

  it('ignores malformed entries in the id list rather than throwing', () => {
    insertReview('r1', 'was_unlimited', { seededCapacity: 1 })
    expect(dismissMigrationReviews(db, ['r1', 42, null, ''])).toEqual({ ok: true, dismissed: 1 })
  })
})
