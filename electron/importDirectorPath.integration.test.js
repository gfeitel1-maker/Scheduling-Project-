// @vitest-environment node
//
// Packaged-audit ship-blockers #12/#14/#16 — the director's import path end to
// end, with every reconciliation card left UNANSWERED (the common case: a
// director who clicks Import without working the queue).
//
// real sample -> parseTextGrid -> extractEntities -> inferFixedEvents ->
// commitIngest dry run -> buildReconciliationReport -> foldTriageInputs (no
// answers) -> commitIngest -> real SQLite -> buildSchedule (Generate and
// Manual's fixedEventsOnly) + materializeImportedVersion.
//
// Before this fix: a claimed event name's low-confidence activity card went
// unanswered, the activity was held back while the event still committed, the
// fixed_events row landed with a NULL activity_id, and both Generate and
// Manual "Start a blank week" refused on FIXED_EVENT_IDENTITY_GAP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { appendOp } from './ops/operations.js'
import { materializeImportedVersion } from './ops/materializeImportedVersion.js'
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './ops/scheduleInputNormalization.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'
import { foldTriageInputs } from '../src/screens/reconciliationTriage.js'
import { resolveFixedEventActivityIds } from '../src/engine/fixedEventActivityLink.js'
import { resolvePriorityForGeneration } from '../src/ingest/resolvePriorityForGeneration.js'
import buildSchedule from '../src/engine/buildSchedule.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
const deviceId = 'device-1'
const userId = 'u1'

let db, campId, parsed, proposal, committed

beforeAll(async () => {
  ;({ db } = openTemplatedDb())
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp B', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(randomUUID(), campId, 'Main')

  parsed = parseTextGrid(fs.readFileSync(SAMPLE, 'utf8'))
  proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  const baseInputs = {
    approved: {
      groups: proposal.entities.groups,
      days_of_operation: proposal.entities.days_of_operation,
      time_blocks: proposal.entities.time_blocks,
      activities: proposal.entities.activities,
    },
    fixedEvents,
    activityRules: inferActivityRules(
      proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
      proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly,
    ),
    pinOnlyActivityNames: [...pinOnly],
    seenCounts: proposal.seenCounts ?? null,
  }
  const common = { camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add' }

  const dry = commitIngest(db, { ...common, ...baseInputs, dryRun: true })
  const report = buildReconciliationReport({
    planItems: dry.planItems ?? [],
    fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
  })
  const folded = foldTriageInputs(baseInputs, report.decisions, {})
  committed = commitIngest(db, { ...common, ...baseInputs, ...folded })
}, 60_000)

afterAll(() => { db?.close(); cleanupTemplatedDbs() })

function scheduleInput() {
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = db.prepare(`SELECT * FROM ${entity}`).all()
  const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, campId)
  return { ...flat, activities: resolvePriorityForGeneration(flat.activities), campId }
}

describe('director import with every reconciliation card unanswered (campB-by-day)', () => {
  it('commits, and commits fixed events', () => {
    expect(committed.held).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ?').get(campId).c).toBeGreaterThan(0)
  })

  it('every fixed_events row links to exactly one live activity', () => {
    const live = new Set(db.prepare('SELECT id FROM activities WHERE camp_id = ?').all(campId).map((r) => r.id))
    const unlinked = db.prepare('SELECT * FROM fixed_events WHERE camp_id = ?').all(campId)
      .filter((fe) => resolveFixedEventActivityIds(fe).filter((id) => live.has(id)).length !== 1)
      .map((fe) => fe.name)
    expect(unlinked).toEqual([])
  })

  it('Generate returns slots with no error findings', () => {
    const result = buildSchedule(scheduleInput())
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(result.slots.length).toBeGreaterThan(0)
  })

  it('Manual "Start a blank week" (fixedEventsOnly) has no error findings and places events', () => {
    const result = buildSchedule({ ...scheduleInput(), fixedEventsOnly: true })
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(result.slots.length).toBeGreaterThan(0)
  })

  it('materializes the imported schedule as a version on a fresh camp with no week row yet', async () => {
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks WHERE camp_id = ?').get(campId).c).toBe(0)
    const writeClient = {
      async write({ entity, entity_id, field, value, author_user_id }) {
        return { status: 'applied', op: appendOp(db, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
      },
    }
    const { placements } = capturePlacements({ pages: parsed.pages }, proposal)
    const out = await materializeImportedVersion(db, writeClient, { campId, authorUserId: userId, placements })
    expect(out.created).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots WHERE id = ?').get(out.snapshotId).c).toBe(1)
  })
})
