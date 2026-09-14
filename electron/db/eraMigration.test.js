// @vitest-environment node
//
// LONG-CHAIN MIGRATION SURVIVABILITY (T154).
//
// From an external architecture review (item 5): the schema is at v59 and every
// migration test synthesizes its own pre-state ad hoc, which is pairwise by
// construction. Pairwise tests cannot show what happens when a database is
// dragged across thirty migrations at once — and for a local-first app whose
// durable artifacts sit untouched between summers, that is the ordinary case,
// not an edge one.
//
// The fixtures under test/fixtures/eras/ are REAL: each was written by the
// localDb.js that actually shipped at that commit, checked out of git history
// (scripts/fixtures/make-era-fixtures.mjs). A fixture produced by running
// today's chain up to version N would prove only that today's code agrees with
// itself; it could never catch a migration mis-reading a shape today's code
// would not have written.
//
// The assertion is SEMANTIC, not schema shape. A migration that leaves the
// columns perfect and the camp's meaning altered is the failure worth catching:
// a group that lost its division, a slot that lost its activity, a template
// that lost its rows.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb, CURRENT_SCHEMA_VERSION, getSchemaVersion } from './localDb.js'

const ERAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/eras')

let copies = []
afterEach(() => {
  for (const f of copies) {
    for (const suffix of ['', '-wal', '-shm', '.bak']) {
      try { fs.rmSync(f + suffix, { force: true }) } catch { /* best effort */ }
    }
  }
  copies = []
})

// Never migrate the fixture itself — it is the artifact.
function workingCopy(name) {
  const target = path.join(os.tmpdir(), `shoresh-era-${name}-${Date.now()}-${Math.random()}.sqlite`)
  fs.copyFileSync(path.join(ERAS_DIR, name), target)
  copies.push(target)
  return target
}

const FIXTURES = fs.readdirSync(ERAS_DIR).filter((f) => f.endsWith('.sqlite')).sort()

// The camp every fixture was seeded with (scripts/fixtures/make-era-fixtures.mjs).
const CAMP = 'camp-era-0000'

describe('a database from an older era survives the whole chain to current', () => {
  it('has fixtures to test at all — an empty directory must not read as a pass', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3)
  })

  for (const fixture of FIXTURES) {
    it(`${fixture} migrates to v${CURRENT_SCHEMA_VERSION} with the camp's MEANING intact`, () => {
      const file = workingCopy(fixture)
      const db = openLocalDb(file)
      try {
        expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)

        // The camp itself.
        expect(db.prepare('SELECT id, name FROM camps').all()).toEqual([{ id: CAMP, name: 'Era Camp' }])

        // Its people, still filed where they were filed.
        const groups = db.prepare('SELECT id, name, tier_id FROM groups ORDER BY id').all()
        expect(groups).toEqual([
          { id: 'grp-1', name: 'Bunk 1', tier_id: 'tier-1' },
          { id: 'grp-2', name: 'Bunk 2', tier_id: 'tier-1' },
        ])
        expect(db.prepare('SELECT id, name, cohort_id FROM tiers ORDER BY id').all())
          .toEqual([{ id: 'tier-1', name: 'Aleph', cohort_id: 'coh-1' }])

        // Its week and its activities.
        expect(db.prepare('SELECT id, label, day_of_week FROM days_of_operation ORDER BY id').all()).toEqual([
          { id: 'day-1', label: 'Monday', day_of_week: 1 },
          { id: 'day-2', label: 'Tuesday', day_of_week: 2 },
        ])
        expect(db.prepare('SELECT id, name FROM activities ORDER BY id').all()).toEqual([
          { id: 'act-1', name: 'Swim' },
          { id: 'act-2', name: 'Archery' },
        ])

        // THE SCHEDULE ITSELF — the thing a director would notice losing.
        // Which template row survives is not asserted by id: v21/v22 re-mint
        // schedule_templates ids by design, so the meaning is "the two
        // placements still point at one template, the right groups, the right
        // day/block, the right activities".
        const slots = db.prepare(
          'SELECT group_id, day_id, time_block_id, activity_id, template_id FROM template_slots ORDER BY group_id'
        ).all()
        expect(slots).toHaveLength(2)
        expect(slots.map((s) => [s.group_id, s.day_id, s.time_block_id, s.activity_id])).toEqual([
          ['grp-1', 'day-1', 'tb-1', 'act-1'],
          ['grp-2', 'day-1', 'tb-1', 'act-2'],
        ])
        expect(new Set(slots.map((s) => s.template_id)).size).toBe(1)
        const template = db.prepare('SELECT id FROM schedule_templates WHERE id = ?').get(slots[0].template_id)
        expect(template, 'every slot points at a template that exists').toBeTruthy()

        // Nothing orphaned or duplicated along the way.
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(2)
        expect(db.prepare('SELECT COUNT(*) AS n FROM activities').get().n).toBe(2)
      } finally {
        db.close()
      }
    })
  }
})
