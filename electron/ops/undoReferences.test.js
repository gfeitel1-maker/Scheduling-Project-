// @vitest-environment node
//
// referencesInto — U2's read-only single-hop referential check (no deletion
// code in this slice; this is the query the deletion slice will gate on).
// docs/adr/2026-08-17-onescreen-reconciliation-undo.md, "Finding 3 fix" +
// "Finding 4 fix" (batch two-pass exclusion).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { referencesInto } from './undoReferences.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-undoref-unit-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
function migratedDb() {
  return openLocalDb(tmpFile('migrated'))
}

function seedCamp(db) {
  const campId = 'camp-1'
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  return campId
}

describe('referencesInto', () => {
  it('scalar: finds a live row whose column equals the target id', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run('loc-1', campId, 'Lake')
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id) VALUES (?, ?, ?, ?)').run(
      'act-1', campId, 'Kayaking', 'loc-1'
    )

    const blockers = referencesInto(db, 'locations', 'loc-1')
    expect(blockers).toEqual([{ fromTable: 'activities', fromColumn: 'location_id', id: 'act-1' }])
  })

  it('scalar: returns empty when nothing references the target', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run('loc-1', campId, 'Lake')

    expect(referencesInto(db, 'locations', 'loc-1')).toEqual([])
  })

  it('json_array: finds a live row whose json array column contains the target id', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', campId, 'Bunk 1')
    db.prepare('INSERT INTO activities (id, camp_id, name, eligible_group_ids) VALUES (?, ?, ?, ?)').run(
      'act-1', campId, 'Kayaking', JSON.stringify(['grp-1', 'grp-2'])
    )

    const blockers = referencesInto(db, 'groups', 'grp-1')
    expect(blockers).toEqual([{ fromTable: 'activities', fromColumn: 'eligible_group_ids', id: 'act-1' }])
  })

  it('json_array: does not match a target id that is merely a substring of an array entry', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO activities (id, camp_id, name, eligible_group_ids) VALUES (?, ?, ?, ?)').run(
      'act-1', campId, 'Kayaking', JSON.stringify(['grp-10'])
    )

    expect(referencesInto(db, 'groups', 'grp-1')).toEqual([])
  })

  it('excludeSet: a referencing row inside the exclude set is not reported as a blocker', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run('loc-1', campId, 'Lake')
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id) VALUES (?, ?, ?, ?)').run(
      'act-1', campId, 'Kayaking', 'loc-1'
    )

    // both loc-1 and act-1 are being undone together — act-1 no longer
    // counts as a live blocker for loc-1's deletion.
    const blockers = referencesInto(db, 'locations', 'loc-1', new Set(['activities:act-1']))
    expect(blockers).toEqual([])
  })

  it('excludeSet: a referencing row NOT in the exclude set still blocks', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run('loc-1', campId, 'Lake')
    db.prepare('INSERT INTO activities (id, camp_id, name, location_id) VALUES (?, ?, ?, ?)').run(
      'act-1', campId, 'Kayaking', 'loc-1'
    )

    const blockers = referencesInto(db, 'locations', 'loc-1', new Set(['activities:some-other-id']))
    expect(blockers).toEqual([{ fromTable: 'activities', fromColumn: 'location_id', id: 'act-1' }])
  })

  it('checks every registered edge into the entity, not just the first match', () => {
    const db = migratedDb()
    const campId = seedCamp(db)
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run('coh-1', campId, 'Senior')
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(
      'tier-1', campId, 'Tier A', 'coh-1'
    )
    db.prepare('INSERT INTO time_blocks (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(
      'tb-1', campId, 'Block A', 'coh-1'
    )

    const blockers = referencesInto(db, 'cohorts', 'coh-1')
    expect(blockers.sort((a, b) => a.fromTable.localeCompare(b.fromTable))).toEqual([
      { fromTable: 'tiers', fromColumn: 'cohort_id', id: 'tier-1' },
      { fromTable: 'time_blocks', fromColumn: 'cohort_id', id: 'tb-1' },
    ])
  })
})
