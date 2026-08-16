import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { confirmAlias, ConfirmAliasError } from './confirmAlias.js'

let db, tmpFile, campId

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-confirmAlias-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function makeGroup(name = 'Bunk 1') {
  const id = randomUUID()
  db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run(id, campId, name, 'all')
  return id
}

function makeActivity(name = 'Swim', isLocked = 0) {
  const id = randomUUID()
  db.prepare('INSERT INTO activities (id, camp_id, name, is_locked) VALUES (?, ?, ?, ?)').run(id, campId, name, isLocked)
  return id
}

function makeLocation(name = 'Pool') {
  const id = randomUUID()
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(id, campId, name)
  return id
}

describe('confirmAlias — single-writer transactional write', () => {
  it('produces exactly one active row for a fresh confirm', () => {
    const groupId = makeGroup()
    const result = confirmAlias(db, {
      camp_id: campId, entity_type: 'groups', source_label: 'Bunk One', entity_id: groupId,
    })
    expect(result.superseded).toBeNull()
    const rows = db.prepare("SELECT * FROM source_aliases WHERE camp_id = ? AND status = 'active'").all(campId)
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(groupId)
    expect(rows[0].source_label).toBe('Bunk One')
  })

  it('re-confirming the same label to a DIFFERENT target supersedes the old row and inserts a new one, in one transaction', () => {
    const groupA = makeGroup('Bunk 1')
    const groupB = makeGroup('Bunk 2')
    const first = confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Bunk One', entity_id: groupA })
    const second = confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Bunk One', entity_id: groupB })

    expect(second.superseded).toBe(first.id)

    const oldRow = db.prepare('SELECT * FROM source_aliases WHERE id = ?').get(first.id)
    expect(oldRow.status).toBe('superseded')
    expect(oldRow.superseded_by).toBe(second.id)

    const active = db.prepare("SELECT * FROM source_aliases WHERE camp_id = ? AND status = 'active'").all(campId)
    expect(active).toHaveLength(1)
    expect(active[0].entity_id).toBe(groupB)

    // No partial row is ever observable: exactly 2 rows total, one of each status.
    const all = db.prepare('SELECT status FROM source_aliases WHERE camp_id = ?').all(campId)
    expect(all.map((r) => r.status).sort()).toEqual(['active', 'superseded'])
  })

  it('re-confirming the SAME label to the SAME target is a no-op (no duplicate row)', () => {
    const groupId = makeGroup()
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Bunk One', entity_id: groupId })
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'bunk one', entity_id: groupId })
    const rows = db.prepare("SELECT * FROM source_aliases WHERE camp_id = ? AND status = 'active'").all(campId)
    expect(rows).toHaveLength(1)
  })

  it('scopes cohort-scoped types (tiers/time_blocks) by cohort_id, camp-wide types ignore it', () => {
    const cohortA = randomUUID()
    const cohortB = randomUUID()
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortA, campId, 'Cohort A')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortB, campId, 'Cohort B')
    const tierA = randomUUID()
    const tierB = randomUUID()
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierA, campId, 'Seniors', cohortA)
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierB, campId, 'Seniors', cohortB)

    confirmAlias(db, { camp_id: campId, entity_type: 'tiers', cohort_id: cohortA, source_label: 'Seniors', entity_id: tierA })
    confirmAlias(db, { camp_id: campId, entity_type: 'tiers', cohort_id: cohortB, source_label: 'Seniors', entity_id: tierB })

    const rows = db.prepare("SELECT * FROM source_aliases WHERE camp_id = ? AND status = 'active'").all(campId)
    expect(rows).toHaveLength(2)
  })
})

describe('confirmAlias — validation and refusal (§3, §6)', () => {
  it('rejects an invalid entity_type before any DB access', () => {
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'template_slots', source_label: 'x', entity_id: 'whatever',
    })).toThrow(ConfirmAliasError)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })

  it('rejects cohort_id for a non-cohort-scoped type', () => {
    const groupId = makeGroup()
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'groups', cohort_id: 'c1', source_label: 'x', entity_id: groupId,
    })).toThrow(ConfirmAliasError)
  })

  it('refuses a nonexistent target', () => {
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'groups', source_label: 'x', entity_id: 'not-a-real-id',
    })).toThrow(/target_not_live/)
  })

  it('refuses a Trashed target', () => {
    const groupId = makeGroup()
    db.prepare('DELETE FROM groups WHERE id = ?').run(groupId) // simulated trash: physically absent from projection
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'groups', source_label: 'x', entity_id: groupId,
    })).toThrow(/target_not_live/)
  })

  it('refuses (surfaces) a locked activity target rather than silently binding', () => {
    const activityId = makeActivity('Swim', 1)
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'activities', source_label: 'Swimming', entity_id: activityId,
    })).toThrow(/target_locked/)
    expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(0)
  })
})

// M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5, registry
// row 2): 'locations' joins ALIAS_ENTITY_TABLE — this file's own copy, kept
// deliberately separate from ingest.js's per the header comment. Without both
// copies updated, `entity_type: 'locations'` would pass the INGESTIBLE_ENTITIES
// check but then resolve `table = undefined` and throw a raw SQL error instead
// of a clean ConfirmAliasError — the exact drift this second test guards.
describe('confirmAlias — locations (M4)', () => {
  it('confirms a location alias (e.g. "Pool Deck" -> the existing "Pool" row)', () => {
    const locationId = makeLocation('Pool')
    const result = confirmAlias(db, {
      camp_id: campId, entity_type: 'locations', source_label: 'Pool Deck', entity_id: locationId,
    })
    expect(result.superseded).toBeNull()
    const row = db.prepare("SELECT * FROM source_aliases WHERE camp_id = ? AND status = 'active'").get(campId)
    expect(row.entity_type).toBe('locations')
    expect(row.entity_id).toBe(locationId)
    expect(row.cohort_id).toBeNull() // locations are camp-wide, never cohort-scoped
  })

  it('refuses a nonexistent location target the same way every other entity does', () => {
    expect(() => confirmAlias(db, {
      camp_id: campId, entity_type: 'locations', source_label: 'Pool Deck', entity_id: 'not-a-real-id',
    })).toThrow(/target_not_live/)
  })
})
