// T255 slice C, carried item — listAliasMap's cohort-scope asymmetry.
// docs/work/tickets/T255-name-keyed-lookups-assume-uniqueness.md.
//
// COHORT_SCOPED types (tiers, time_blocks) are scoped by cohort_id at write
// time (confirmAlias.test.js "scopes cohort-scoped types... by cohort_id").
// But the READ side (listAliasMap, inside buildExistingSnapshot) only applied
// that scoping when the CALLER passed a cohort_id — `if (COHORT_SCOPED.has
// (row.entity_type) && cohort_id && row.cohort_id !== cohort_id) continue`
// skips the whole check when `cohort_id` is falsy (no active Program), so an
// import with no active Program saw every cohort's aliases for that label at
// once and the last one read from SQL silently overwrote the others in the
// single-valued Map — merging two Programs' alias namespaces into one.

import { describe, it, expect, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { confirmAlias } from './confirmAlias.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

let db, tmpFile, campId
const deviceId = 'device-1'

function setup() {
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
}

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('listAliasMap: cohort-scope asymmetry between two active Programs', () => {
  it('an import with no active cohort applies NEITHER Program\'s confirmed alias for the same label (no namespace merge)', () => {
    setup()
    const cohortA = randomUUID()
    const cohortB = randomUUID()
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortA, campId, 'Program A')
    db.prepare('INSERT INTO cohorts (id, camp_id, name) VALUES (?, ?, ?)').run(cohortB, campId, 'Program B')
    const tierA = randomUUID()
    const tierB = randomUUID()
    // Deliberately NOT named "Gimel" — an exact-name match would mask the alias bug.
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierA, campId, 'Tier A', cohortA)
    db.prepare('INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES (?, ?, ?, ?)').run(tierB, campId, 'Tier B', cohortB)

    // Both are legitimately active: same label, different cohort scope.
    confirmAlias(db, { camp_id: campId, entity_type: 'tiers', cohort_id: cohortA, source_label: 'Gimel', entity_id: tierA, confirmed_by: 'u1' })
    confirmAlias(db, { camp_id: campId, entity_type: 'tiers', cohort_id: cohortB, source_label: 'Gimel', entity_id: tierB, confirmed_by: 'u1' })

    // Import runs with NO active Program (cohort_id omitted/null) — neither
    // scoped alias should fire, so "Gimel" must be created fresh rather than
    // silently bound to whichever cohort's row SQLite happened to return last.
    const result = commitIngest(db, {
      approved: { tiers: ['Gimel'] },
      camp_id: campId,
      cohort_id: null,
      author_user_id: 'u1',
      device_id: deviceId,
    })

    expect(result.held).toBe(false)
    expect(result.created.tiers).toBe(1)
    const createdTier = db.prepare("SELECT id FROM tiers WHERE camp_id = ? AND name = 'Gimel'").get(campId)
    expect(createdTier).toBeTruthy()
    expect(createdTier.id).not.toBe(tierA)
    expect(createdTier.id).not.toBe(tierB)
  })
})
