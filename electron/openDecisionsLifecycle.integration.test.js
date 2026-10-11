// @vitest-environment node
//
// The Roots "open questions" list across the real commit and undo paths
// (packaged audit 714 items 4 and 5):
//   B  undoing an import clears that import's own open questions, and the
//      "Imported N" count is the same set of records undo removes.
//   C  answering a question (it is not held back at commit) clears it from
//      Roots, even when it was the last open question of its kind.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ops/ingest.js'
import { listOpenReconciliationDecisions } from './ops/openReconciliationDecisions.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'

afterAll(() => cleanupTemplatedDbs())

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
const deviceId = 'device-1'
let db, tmpFile, campId, base

beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  tmpFile = t.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp B', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u1', ?, 'Ruth', 'h', 's', 'admin')").run(campId)
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(randomUUID(), campId, 'Main')
  const parsed = parseTextGrid(fs.readFileSync(SAMPLE, 'utf8'))
  const proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  base = {
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
    camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add',
    fixedEvents, pinOnlyActivityNames: [...pinOnly], seenCounts: proposal.seenCounts ?? null,
  }
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function openQuestions() {
  const dry = commitIngest(db, { ...base, dryRun: true })
  const report = buildReconciliationReport({
    planItems: dry.planItems ?? [],
    fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
  })
  return report.decisions.filter((d) => d.kind === 'confirm_value' || d.kind === 'confirm_change')
}

const openFixed = () => listOpenReconciliationDecisions(db, campId).filter((r) => r.entity_type === 'fixed_events')

describe('open questions across commit and undo (campB-by-day)', () => {
  it('there are open fixed-event questions to carry (premise)', () => {
    expect(openQuestions().filter((d) => d.entity === 'fixed_events').length).toBeGreaterThan(0)
  })

  it('C: answering every fixed-event question clears them from Roots', () => {
    const questions = openQuestions()
    commitIngest(db, { ...base, openDecisions: questions })
    expect(openFixed().length).toBeGreaterThan(0)

    commitIngest(db, { ...base, openDecisions: [] })
    expect(openFixed()).toEqual([])
  })

  it('B: undo removes the import’s own open questions, and the counts agree', () => {
    const questions = openQuestions()
    const outcome = commitIngest(db, { ...base, openDecisions: questions, captureInverse: true })
    expect(listOpenReconciliationDecisions(db, campId).length).toBeGreaterThan(0)
    expect(typeof outcome.importRunId).toBe('string')

    const receipt = ingestUndo(db, {
      invertibleOps: outcome.invertibleOps,
      createdEntityIds: outcome.createdEntityIds,
      importRunId: outcome.importRunId,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(listOpenReconciliationDecisions(db, campId)).toEqual([])
    expect(receipt.deleted.length).toBe(outcome.createdEntityIds.length)
  })

  it('B: undo after a renderer reload (run id lost) still clears the import’s open questions', () => {
    const outcome = commitIngest(db, { ...base, openDecisions: openQuestions(), captureInverse: true })
    expect(listOpenReconciliationDecisions(db, campId).length).toBeGreaterThan(0)
    ingestUndo(db, {
      invertibleOps: outcome.invertibleOps,
      createdEntityIds: outcome.createdEntityIds,
      importRunId: null,
      author_user_id: 'u1', device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(listOpenReconciliationDecisions(db, campId)).toEqual([])
  })
})
