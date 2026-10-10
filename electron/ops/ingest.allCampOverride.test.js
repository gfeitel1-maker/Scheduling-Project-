// Audit 714 review: answering an all-camp override card has to change what is committed.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest } from './ingest.js'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import { extractEntities } from '../../src/ingest/extractEntities.js'
import { capturePlacements } from '../../src/ingest/capturePlacements.js'
import { detectAllCampOverrides } from '../../src/ingest/allCampOverrides.js'
import { buildReconciliationReport } from '../../src/ingest/reconciliationReport.js'
import { foldTriageInputs } from '../../src/screens/reconciliationTriage.js'

afterAll(() => { cleanupTemplatedDbs() })

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')
const parsed = parseTextGrid(campB)
const proposal = extractEntities(parsed)
const { placements } = capturePlacements(parsed, proposal)
const groups = proposal.entities.groups

function thursdayAllCamp() {
  const overrides = detectAllCampOverrides(placements, groups)
  const report = buildReconciliationReport({ planItems: [], readiness: [], placements, allGroupNames: groups, allCampOverrides: overrides })
  const decision = report.decisions.find((d) => d.kind === 'all_camp_override' && d.entityName === 'All Camp Activity' && d.evidence.day === 'Thursday')
  const seen = [...new Set(placements.filter((p) => p.activityName === 'All Camp Activity').map((p) => p.groupName))]
  return { decision, seen }
}

function commitWith(answer) {
  const { decision, seen } = thursdayAllCamp()
  const base = {
    approved: { groups, activities: ['All Camp Activity'] },
    activityRules: { 'All Camp Activity': { eligible_group_names: seen, min_per_week: 1, max_per_week: 2, priority: 'low', eligibility_known: false } },
    cohort_id: null, mode: 'add',
  }
  const inputs = foldTriageInputs(base, [decision], answer ? { [decision.id]: answer } : {})
  commitIngest(db, { ...inputs, camp_id: campId, device_id: deviceId, author_user_id: 'u1' })
  const row = db.prepare('SELECT eligible_group_ids FROM activities WHERE name = ?').get('All Camp Activity')
  const names = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g.name]))
  return JSON.parse(row.eligible_group_ids).map((id) => names.get(id))
}

describe('all-camp override answers reach the commit (campB, Thursday All Camp Activity)', () => {
  it('the file never lists CIT for it', () => {
    expect(thursdayAllCamp().seen).not.toContain('CIT')
  })

  it('"It’s for all camp" makes CIT eligible', () => {
    expect(commitWith({ choice: 'all_camp' })).toContain('CIT')
  })

  it('"It really excludes CIT" keeps the file’s groups', () => {
    expect(commitWith({ choice: 'as_written' })).not.toContain('CIT')
  })

  it('an unanswered card keeps the file’s groups', () => {
    expect(commitWith(null)).not.toContain('CIT')
  })
})
