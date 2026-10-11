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

const GRID_TWO_LISTS = `
                        Monday — All Camp

   Time           Otters 1              Otters 2

10:00–10:45       Hike / Fish / Kayak   Art / Music / Chess
`

const GRID_QUESTION = `
                        Monday — All Camp

   Time           Otters 1              Otters 2

10:00–10:45       Arts/Crafts           Swim
`

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

function prepare(grid) {
  const parsed = parseTextGrid(grid)
  const proposal = extractEntities(parsed)
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
  return { proposal, decisions, base }
}

function commit({ decisions, base }, answers = {}) {
  const folded = foldTriageInputs(base, decisions, answers)
  commitIngest(db, { approved: folded.approved, camp_id: campId, device_id: 'd1', confirmedElectiveSets: folded.confirmedElectiveSets })
  return folded
}

const setChoices = () => {
  const sets = db.prepare('SELECT id, name FROM elective_sets ORDER BY name').all()
  return Object.fromEntries(sets.map((st) => [st.name, db.prepare("SELECT a.name, esa.status FROM elective_set_activities esa JOIN activities a ON a.id = esa.activity_id WHERE esa.elective_set_id = ? ORDER BY a.name").all(st.id)]))
}

describe('list cell import, parsed grid to commit', () => {
  it('writes one set with three potential choices and no activity named with slashes', () => {
    const prepared = prepare(GRID)
    expect(prepared.proposal.entities.activities).toContain(LIST)
    const folded = commit(prepared)
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
    const prepared = prepare(GRID)
    const id = prepared.decisions.find((d) => d.kind === 'elective_candidate').id
    const folded = commit(prepared, { [id]: { choice: 'decline' } })
    expect(folded.confirmedElectiveSets).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
    expect(db.prepare('SELECT name FROM activities').all().map((r) => r.name)).toContain(LIST)
  })

  it('two different lists in one block become two sets, each with its own choices', () => {
    commit(prepare(GRID_TWO_LISTS))
    const sets = setChoices()
    expect(Object.keys(sets)).toEqual(['Electives (Art, Chess, Music)', 'Electives (Fish, Hike, Kayak)'])
    expect(sets['Electives (Art, Chess, Music)'].map((r) => r.name)).toEqual(['Art', 'Chess', 'Music'])
    expect(sets['Electives (Fish, Hike, Kayak)'].map((r) => r.name)).toEqual(['Fish', 'Hike', 'Kayak'])
  })

  it('an ambiguous list answered "a choice of several" writes a set with potential choices', () => {
    const prepared = prepare(GRID_QUESTION)
    const q = prepared.decisions.find((d) => d.evidence?.detector === 'list_question')
    expect(q).toBeTruthy()
    commit(prepared, { [q.id]: { choice: 'confirm' } })
    const sets = setChoices()
    expect(sets['Electives (Arts, Crafts)']).toEqual([{ name: 'Arts', status: 'potential' }, { name: 'Crafts', status: 'potential' }])
  })

  it('an ambiguous list left unanswered stays one activity', () => {
    commit(prepare(GRID_QUESTION))
    expect(db.prepare('SELECT COUNT(*) c FROM elective_sets').get().c).toBe(0)
    expect(db.prepare('SELECT name FROM activities').all().map((r) => r.name)).toContain('Arts/Crafts')
  })
})
