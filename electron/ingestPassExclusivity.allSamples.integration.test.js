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
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { detectAllCampOverrides } from '../src/ingest/allCampOverrides.js'
import { normalizeName } from '../src/ingest/preview.js'

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
    // The director's full review: fixed-event questions and all-camp overrides included.
    const { placements } = capturePlacements(parsed, proposal)
    const fullReport = buildReconciliationReport({
      planItems: dry.planItems ?? [],
      fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
      allCampOverrides: detectAllCampOverrides(placements, proposal.entities.groups),
      placements,
      allGroupNames: proposal.entities.groups,
    })
    commitIngest(db, inputs)
    return { pinOnly, dualUseNames, dry, report, fullReport, open: listOpenReconciliationDecisions(db, campId) }
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

describe.each(SAMPLES)('%s: a name is one kind, in both directions', (file) => {
  function review() {
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
    const { placements } = capturePlacements(parsed, proposal)
    const report = buildReconciliationReport({
      planItems: dry.planItems ?? [],
      fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
      allCampOverrides: detectAllCampOverrides(placements, proposal.entities.groups),
      placements,
      allGroupNames: proposal.entities.groups,
    })
    commitIngest(db, inputs)
    return { fixedEvents, dualUseNames, report }
  }

  it('a catalogue activity is never also a fixed-event candidate or decision', () => {
    const { fixedEvents, dualUseNames, report } = review()
    const dual = new Set(dualUseNames.map(normalizeName))
    const candidates = fixedEvents.filter((f) => f.confidence === 'low' && dual.has(normalizeName(f.name))).map((f) => f.name)
    const decisions = report.decisions
      .filter((d) => d.entity === 'fixed_events' && dual.has(normalizeName(d.entityName ?? '')))
      .map((d) => d.entityName)
    expect({ candidates, decisions }).toEqual({ candidates: [], decisions: [] })
  })

  it('no subject is asked about under two kinds', () => {
    const { report } = review()
    const entitiesByName = new Map()
    for (const d of report.decisions) {
      if (!d.entityName || (d.entity !== 'activities' && d.entity !== 'fixed_events')) continue
      const key = normalizeName(d.entityName)
      entitiesByName.set(key, new Set([...(entitiesByName.get(key) ?? []), d.entity]))
    }
    const twoKinds = [...entitiesByName].filter(([, kinds]) => kinds.size > 1).map(([name]) => name)
    expect(twoKinds).toEqual([])
  })

  it('after commit no name is both a non-marker activity and a fixed event', () => {
    review()
    // OQ3 (strict, 2026-10-11): no exemptions, not even a pin held every day.
    const both = db.prepare(`
      SELECT DISTINCT a.name FROM activities a
      JOIN fixed_events f ON lower(trim(f.name)) = lower(trim(a.name)) AND f.camp_id = a.camp_id
      WHERE a.camp_id = ? AND a.catalog_role IS NOT 'pinned_event'`).all(campId).map((r) => r.name)
    expect(both).toEqual([])
  })
})

describe('campB-by-day with zero answers', () => {
  const asked = () => {
    const parsed = parseTextGrid(fs.readFileSync(path.join(DIR, 'campB-by-day.txt'), 'utf8'))
    const proposal = extractEntities(parsed)
    const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
    const dry = commitIngest(db, {
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
      pinOnlyActivityNames: [...pinOnly], seenCounts: proposal.seenCounts ?? null, dryRun: true,
    })
    const { placements } = capturePlacements(parsed, proposal)
    const report = buildReconciliationReport({
      planItems: dry.planItems ?? [],
      fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
      allCampOverrides: detectAllCampOverrides(placements, proposal.entities.groups),
      placements,
      allGroupNames: proposal.entities.groups,
    })
    const out = report.decisions.map((d) => `${d.entity}:${d.entityName}`)
    out.report = report
    return out
  }

  it('Music, Sports and Water Play raise no fixed-event question', () => {
    expect(asked().filter((q) => /^fixed_events:(Music|Sports|Water Play)$/.test(q))).toEqual([])
  })

  it('All Camp Activity, Ruach and Shabbat are asked once at most', () => {
    const q = asked()
    for (const name of ['All Camp Activity', 'Ruach', 'Shabbat']) {
      expect(q.filter((x) => x.endsWith(`:${name}`)).length, name).toBeLessThanOrEqual(1)
    }
  })

  it('the one remaining Ruach question still says which group is excluded', () => {
    const ruach = asked().report.decisions.filter((d) => d.entityName === 'Ruach')
    expect(ruach.length).toBe(1)
    expect(ruach[0].title).toContain('every group except CIT')
  })

  it('meal waves are treated alike: Lunch 1-5 and Menucha raise no question', () => {
    expect(asked().filter((q) => /^fixed_events:(Lunch \d|Menucha)$/.test(q))).toEqual([])
  })
})
