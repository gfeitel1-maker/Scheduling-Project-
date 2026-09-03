import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { confirmCompoundCellPattern, ConfirmCompoundCellPatternError } from './confirmCompoundCellPattern.js'
import { listCompoundCellDecisions } from './ingest.js'

let db, tmpFile, campId

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-confirmCompoundCellPattern-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('confirmCompoundCellPattern — single-writer transactional write', () => {
  it('write then read round-trips all fields', () => {
    const result = confirmCompoundCellPattern(db, {
      camp_id: campId,
      pattern: 'Lunch + Leave',
      interpretation: 'wrapper',
      anchor_name: 'Lunch',
      wrapper_name: 'Leave',
      confirmed_by: 'user1',
    })
    expect(result.id).toBeTruthy()

    const row = db.prepare('SELECT * FROM compound_cell_decisions WHERE id = ?').get(result.id)
    expect(row.camp_id).toBe(campId)
    expect(row.pattern).toBe('Lunch + Leave')
    expect(row.interpretation).toBe('wrapper')
    expect(row.anchor_name).toBe('Lunch')
    expect(row.wrapper_name).toBe('Leave')
    expect(row.confirmed_by).toBe('user1')
    expect(row.confirmed_at).toBeTruthy()

    const map = listCompoundCellDecisions(db, campId)
    expect(map.get('Lunch + Leave')).toEqual({
      interpretation: 'wrapper',
      anchor_name: 'Lunch',
      wrapper_name: 'Leave',
    })
  })

  it('a second write for the same (camp_id, pattern) updates rather than duplicates', () => {
    confirmCompoundCellPattern(db, {
      camp_id: campId, pattern: 'Change/Snack', interpretation: 'as_written',
    })
    const second = confirmCompoundCellPattern(db, {
      camp_id: campId, pattern: 'Change/Snack', interpretation: 'wrapper',
      anchor_name: 'Snack', wrapper_name: 'Change',
    })

    const rows = db.prepare('SELECT * FROM compound_cell_decisions WHERE camp_id = ? AND pattern = ?').all(campId, 'Change/Snack')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(second.id)
    expect(rows[0].interpretation).toBe('wrapper')
    expect(rows[0].anchor_name).toBe('Snack')
  })

  it('two different camps can independently confirm the identical pattern string, no cross-camp bleed', () => {
    const campId2 = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId2, 'Camp Two', 'b'.repeat(64))

    confirmCompoundCellPattern(db, { camp_id: campId, pattern: 'Climbing/Sports', interpretation: 'alternatives' })
    confirmCompoundCellPattern(db, { camp_id: campId2, pattern: 'Climbing/Sports', interpretation: 'as_written' })

    const rows = db.prepare('SELECT camp_id, interpretation FROM compound_cell_decisions WHERE pattern = ?').all('Climbing/Sports')
    expect(rows).toHaveLength(2)

    const map1 = listCompoundCellDecisions(db, campId)
    const map2 = listCompoundCellDecisions(db, campId2)
    expect(map1.get('Climbing/Sports').interpretation).toBe('alternatives')
    expect(map2.get('Climbing/Sports').interpretation).toBe('as_written')
  })

  it('throws ConfirmCompoundCellPatternError on an invalid interpretation and writes nothing', () => {
    expect(() =>
      confirmCompoundCellPattern(db, { camp_id: campId, pattern: 'Lunch + Leave', interpretation: 'bogus' })
    ).toThrow(ConfirmCompoundCellPatternError)
    expect(db.prepare('SELECT COUNT(*) c FROM compound_cell_decisions').get().c).toBe(0)
  })

  it('throws on a missing camp_id or pattern', () => {
    expect(() => confirmCompoundCellPattern(db, { pattern: 'x', interpretation: 'as_written' })).toThrow(ConfirmCompoundCellPatternError)
    expect(() => confirmCompoundCellPattern(db, { camp_id: campId, interpretation: 'as_written' })).toThrow(ConfirmCompoundCellPatternError)
  })

  it('throws on a "wrapper" interpretation missing anchor_name or wrapper_name, and writes nothing', () => {
    expect(() =>
      confirmCompoundCellPattern(db, { camp_id: campId, pattern: 'Lunch + Leave', interpretation: 'wrapper' })
    ).toThrow(ConfirmCompoundCellPatternError)
    expect(() =>
      confirmCompoundCellPattern(db, {
        camp_id: campId, pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch',
      })
    ).toThrow(ConfirmCompoundCellPatternError)
    expect(() =>
      confirmCompoundCellPattern(db, {
        camp_id: campId, pattern: 'Lunch + Leave', interpretation: 'wrapper', wrapper_name: 'Leave',
      })
    ).toThrow(ConfirmCompoundCellPatternError)
    expect(db.prepare('SELECT COUNT(*) c FROM compound_cell_decisions').get().c).toBe(0)
  })
})

describe('listCompoundCellDecisions', () => {
  it('returns an empty Map for a camp with zero decisions', () => {
    const map = listCompoundCellDecisions(db, campId)
    expect(map).toBeInstanceOf(Map)
    expect(map.size).toBe(0)
  })
})

describe('compound_cell_decisions is host-local and cannot replicate (sync-exclusion property)', () => {
  it('is absent from every registry that would give it a sync or read path', async () => {
    const { PROJECTIONS } = await import('./projections.js')
    const { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } = await import('./campScopedEntities.js')
    const { ENTITIES } = await import('../auth/permissions.js')

    expect(Object.keys(PROJECTIONS)).not.toContain('compound_cell_decisions')
    expect(DIRECT_CAMP_ENTITIES.has('compound_cell_decisions')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('compound_cell_decisions')
    expect(ENTITIES).not.toContain('compound_cell_decisions')
  })

  it('is not shipped in the first-pairing full_sync snapshot (syncClient.js)', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncClient.js'),
      'utf8'
    )
    expect(src).not.toMatch(/DOMAIN_SNAPSHOT_TABLES[\s\S]{0,600}compound_cell_decisions/)
  })

  it('is not present in syncServer.js\'s full-sync payload builder', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../sync/syncServer.js'),
      'utf8'
    )
    expect(src).not.toMatch(/compound_cell_decisions/)
  })
})
