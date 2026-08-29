// commitPlan's write step for open_reconciliation_decisions (§3/§4).
// docs/adr/2026-08-28-persisted-reconciliation-decisions.md, "Migration
// order / test-first notes for Maker", item 3.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { listOpenReconciliationDecisions } from './openReconciliationDecisions.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ord-ingest-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

// A bare create defaults to createConfidenceTier's 'new' (HIGH confidence,
// no decision) — buildPlan.js's createConfidenceTier only drops to 'low'
// when seenCounts reports the name seen fewer than 2 times. Passing an
// explicit seenCounts with count 1 for the created name is the supported,
// realistic way (same input real ImportScreen callers pass) to force a
// genuine confirm_value decision through the whole commitIngest path.
function lowConfidenceSeenCounts(entity, names) {
  const counts = {}
  for (const name of names) counts[name] = 1
  return { [entity]: counts }
}

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })
const openRows = () => listOpenReconciliationDecisions(db, campId)

describe('commitPlan writes open_reconciliation_decisions', () => {
  it('a plain LOW-confidence create persists a confirm_value decision', () => {
    commit({ approved: { groups: ['Bunk 1'] }, seenCounts: lowConfidenceSeenCounts('groups', ['Bunk 1']) })
    const rows = openRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_type).toBe('groups')
    expect(rows[0].kind).toBe('confirm_value')
    expect(rows[0].entity_name).toBe('Bunk 1')
  })

  it('a commit whose decisions are all resolved on re-import leaves that scope empty', () => {
    commit({ approved: { groups: ['Bunk 1'] }, seenCounts: lowConfidenceSeenCounts('groups', ['Bunk 1']) })
    expect(openRows()).toHaveLength(1)

    // Re-importing the SAME group again: buildPlan now sees it as
    // op:'unchanged' against the live db (no diff), so no decision at all —
    // the scope clears.
    commit({ approved: { groups: ['Bunk 1'] }, seenCounts: lowConfidenceSeenCounts('groups', ['Bunk 1']) })
    expect(openRows()).toHaveLength(0)
  })

  it('a commit touching entity_type A never deletes existing open rows for untouched entity_type B', () => {
    commit({
      approved: { groups: ['Bunk 1'], activities: ['Swim'] },
      seenCounts: { groups: { 'Bunk 1': 1 }, activities: { Swim: 1 } },
    })
    expect(openRows().map((r) => r.entity_type).sort()).toEqual(['activities', 'groups'])

    // Re-import touching only groups (now resolved) — activities' open row survives.
    commit({ approved: { groups: ['Bunk 1'] }, seenCounts: lowConfidenceSeenCounts('groups', ['Bunk 1']) })
    const types = openRows().map((r) => r.entity_type)
    expect(types).toEqual(['activities'])
  })

  it('re-importing cohort B tiers never deletes cohort A still-open tier decisions', () => {
    commit({ approved: { cohorts: ['CohortA'] } })
    const cohortAId = db.prepare('SELECT id FROM cohorts WHERE name = ?').get('CohortA').id
    commit({ approved: { cohorts: ['CohortB'] } })
    const cohortBId = db.prepare('SELECT id FROM cohorts WHERE name = ?').get('CohortB').id

    commit({ cohort_id: cohortAId, approved: { tiers: ['Seniors'] }, seenCounts: lowConfidenceSeenCounts('tiers', ['Seniors']) })
    commit({ cohort_id: cohortBId, approved: { tiers: ['Juniors'] }, seenCounts: lowConfidenceSeenCounts('tiers', ['Juniors']) })

    const names = openRows().filter((r) => r.entity_type === 'tiers').map((r) => r.entity_name).sort()
    expect(names).toEqual(['Juniors', 'Seniors'])
  })

  it('a cohort-scoped tier decision with cohort_id NULL is still matched and replaced (cohort_id IS ?, not = ?)', () => {
    commit({ approved: { tiers: ['Seniors'] }, seenCounts: lowConfidenceSeenCounts('tiers', ['Seniors']) })
    const row = openRows().find((r) => r.entity_type === 'tiers')
    expect(row.cohort_id).toBeNull()

    // Re-import, still NULL cohort, now resolved (unchanged) — must clear.
    commit({ approved: { tiers: ['Seniors'] }, seenCounts: lowConfidenceSeenCounts('tiers', ['Seniors']) })
    expect(openRows().filter((r) => r.entity_type === 'tiers')).toHaveLength(0)
  })

  it('a commit that throws leaves open_reconciliation_decisions completely unchanged', () => {
    commit({ approved: { groups: ['Bunk 1'] }, seenCounts: lowConfidenceSeenCounts('groups', ['Bunk 1']) })
    const before = openRows()
    expect(() => commit({ approved: { template_slots: ['x'] } })).toThrow()
    expect(openRows()).toEqual(before)
  })
})
