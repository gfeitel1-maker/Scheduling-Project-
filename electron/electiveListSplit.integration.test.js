// @vitest-environment node
// F6 D3: a parsed grid with a list cell, through the real detector, report,
// triage fold and commitIngest, must leave potential choices of one elective
// set and no activity named with the list's delimiter.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { buildElectiveCandidates } from '../src/ingest/buildPlan.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'
import { foldTriageInputs } from '../src/screens/reconciliationTriage.js'

const GRID = `
                        Monday — All Camp

   Time           Otters 1              Otters 2

09:00–09:45       Archery               Music

10:00–10:45       Hike / Fish / Kayak   Hike / Fish / Kayak
`
const LIST = 'Hike / Fish / Kayak'

let db, file, campId
beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db; file = t.file; campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'D')
})
afterEach(() => {
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.unlinkSync(file + s)
})

function run(answers = {}) {
  const parsed = parseTextGrid(GRID)
  const proposal = extractEntities(parsed)
  expect(proposal.entities.activities).toContain(LIST)
  const electiveCandidates = buildElectiveCandidates({
    electiveHeaderFindings: proposal.electiveHeaderFindings,
    activityPeriods: proposal.activityPeriods,
    approved: { activities: proposal.entities.activities },
  }, { activities: [] })
  const { decisions } = buildReconciliationReport({ planItems: [], readiness: [], electiveCandidates })
  const { placements } = capturePlacements(parsed, proposal)
  const base = {
    approved: { groups: proposal.entities.groups, days_of_operation: proposal.entities.days_of_operation, time_blocks: proposal.entities.time_blocks, activities: proposal.entities.activities },
    resolutions: [], placements,
  }
  const folded = foldTriageInputs(base, decisions, answers)
  const result = commitIngest(db, { approved: folded.approved, camp_id: campId, device_id: 'd1', confirmedElectiveSets: folded.confirmedElectiveSets })
  return { folded, result, decisions }
}

describe('list cell import, parsed grid to commit', () => {
  it('writes one set with three potential choices and no activity named with slashes', () => {
    const { folded } = run()
    expect(folded.placements.filter((p) => p.electiveSetName)).toHaveLength(2)
    expect(db.prepare('SELECT name FROM elective_sets').all()).toEqual([{ name: 'Electives (Fish, Hike, Kayak)' }])
    const rows = db.prepare("SELECT a.name, esa.status FROM elective_set_activities esa JOIN activities a ON a.id = esa.activity_id ORDER BY a.name").all()
    expect(rows.map((r) => r.name)).toEqual(['Fish', 'Hike', 'Kayak'])
    expect(rows.every((r) => r.status === 'potential')).toBe(true)
    const names = db.prepare('SELECT name FROM activities').all().map((r) => r.name)
    expect(names.filter((n) => n.includes(' / '))).toEqual([])
    expect(names).toContain('Archery')
  })

  it('"One activity" keeps the slashed name as an activity and writes no set', () => {
    const { decisions } = run({})
    const id = decisions.find((d) => d.kind === 'elective_candidate').id
    db.prepare('DELETE FROM elective_set_activities').run()
    db.prepare('DELETE FROM elective_sets').run()
    db.prepare('DELETE FROM activities').run()
    const { folded } = run({ [id]: { choice: 'decline' } })
    expect(folded.confirmedElectiveSets).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
    expect(db.prepare('SELECT name FROM activities').all().map((r) => r.name)).toContain(LIST)
  })
})
