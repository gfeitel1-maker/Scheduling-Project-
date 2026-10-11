// @vitest-environment node
//
// The T266 invariant over EVERY sample grid in docs/work/specs/samples (globbed,
// so a new sample is covered automatically): a name ingest claimed as a fixed or
// recurring event raises no review decision, persists no open item, and is an
// activity only as the pinned_event marker row. Real path: parse -> extract ->
// inferFixedEvents -> commitIngest (dry run, then real commit) ->
// buildReconciliationReport -> open_reconciliation_decisions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { listOpenReconciliationDecisions } from './ops/openReconciliationDecisions.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'

const DIR = path.join(process.cwd(), 'docs/work/specs/samples')
// Only the text grids are schedule files; the .csv samples are preference sheets.
const SAMPLES = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt'))

let db, tmpFile, campId, cohortId
const deviceId = 'device-1'

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  cohortId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(cohortId, campId, 'Main')
})

afterEach(() => {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpFile + suffix)) fs.unlinkSync(tmpFile + suffix)
  }
})

it('finds sample grids to check', () => {
  expect(SAMPLES.length).toBeGreaterThan(0)
})

describe.each(SAMPLES)('%s: every claimed event name is classified once', (file) => {
  function run() {
    const parsed = parseTextGrid(fs.readFileSync(path.join(DIR, file), 'utf8'))
    const proposal = extractEntities(parsed)
    const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
    const inputs = {
      approved: {
        groups: proposal.entities.groups,
        days_of_operation: proposal.entities.days_of_operation,
        time_blocks: proposal.entities.time_blocks,
        activities: proposal.entities.activities,
      },
      activityRules: inferActivityRules(
        proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
        proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly,
      ),
      camp_id: campId, cohort_id: cohortId, device_id: deviceId, fixedEvents,
      pinOnlyActivityNames: [...pinOnly], seenCounts: proposal.seenCounts ?? null,
    }
    const dry = commitIngest(db, { ...inputs, dryRun: true })
    const report = buildReconciliationReport({ planItems: dry.planItems ?? [] })
    commitIngest(db, inputs)
    return { pinOnly, dry, report, open: listOpenReconciliationDecisions(db, campId) }
  }

  it('raises no decision, persists no open item, and is an activity only as the marker row', () => {
    const { pinOnly, dry, report, open } = run()
    expect(pinOnly.size).toBeGreaterThan(0)
    const decisions = report.decisions.filter((d) => pinOnly.has(d.entityName)).map((d) => `${d.entity}:${d.entityName}`)
    const openItems = open.filter((r) => pinOnly.has(r.entity_name)).map((r) => `${r.entity_type}:${r.entity_name}`)
    const candidates = (dry.planItems ?? [])
      .filter((i) => i.entity === 'activities' && pinOnly.has(i._name) && i.fields?.catalog_role?.to !== 'pinned_event')
      .map((i) => i._name)
    expect({ decisions, openItems, candidates }).toEqual({ decisions: [], openItems: [], candidates: [] })
  })
})
