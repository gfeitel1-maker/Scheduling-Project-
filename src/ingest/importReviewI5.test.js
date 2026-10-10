// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'
import { derivePinOnlyActivityNames } from './pinOnlyActivityNames.js'
import { buildElectiveCandidates } from './buildPlan.js'
import { getReadiness } from '../engine/readiness.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { reportToLanes } from './reportToLanes.js'
import { withImportOwnRecords } from './importOwnRecords.js'

const text = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')

function campBSource() {
  const p = parseTextGrid(text)
  const prop = extractEntities(p)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: p.pages }, prop, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  return {
    approved: { activities: prop.entities.activities },
    fixedEvents,
    pinOnlyActivityNames: [...pinOnly],
    electiveHeaderFindings: prop.electiveHeaderFindings ?? [],
    activityPeriods: prop.activityPeriods ?? {},
  }
}

describe('I5b elective guesses on campB', () => {
  it('guesses nothing for a name that is an activity or fixed event', () => {
    const source = campBSource()
    const names = new Set([
      ...source.approved.activities.map((a) => String(a?.name ?? a).toLowerCase()),
      ...source.fixedEvents.map((f) => f.name.toLowerCase()),
    ])
    const out = buildElectiveCandidates(source, null)
    const bad = out.filter((c) => names.has(String(c.sourceExcerpt).toLowerCase()))
    expect(bad.map((c) => c.sourceExcerpt)).toEqual([])
    expect(out.filter((c) => /^sports$/i.test(c.sourceExcerpt))).toEqual([])
  })

  it('excludes a name already in the db as an activity or fixed event', () => {
    const src = {
      approved: { activities: ['Foo'] },
      electiveHeaderFindings: [
        { detector: 'header', source: 'cell', band: 'confirmed', sourceExcerpt: 'Sports', row: 1, column: 'A' },
        { detector: 'header', source: 'cell', band: 'confirmed', sourceExcerpt: 'Chugim', row: 2, column: 'B' },
      ],
    }
    const out = buildElectiveCandidates(src, { activities: [], fixed_events: [{ name: 'Sports' }] })
    expect(out.map((c) => c.sourceExcerpt)).toEqual(['Chugim'])
  })

  it('still guesses a real elective period', () => {
    const src = {
      approved: { activities: [] },
      electiveHeaderFindings: [
        { detector: 'header', source: 'label', band: 'confirmed', sourceExcerpt: 'Electives', row: 1, column: 'A' },
      ],
    }
    expect(buildElectiveCandidates(src, null).map((c) => c.sourceExcerpt)).toEqual(['Electives'])
  })
})

describe('I5a still-to-set-up counts the import\'s own records (campB, fresh camp)', () => {
  const gapLabels = (collections) => {
    const report = buildReconciliationReport({ planItems: [], readiness: getReadiness(collections, null) })
    return reportToLanes(report).hold.filter((d) => d.kind === 'required_gap').map((d) => d.label)
  }

  it('lists none of the four the file contains', () => {
    const p = parseTextGrid(text)
    const prop = extractEntities(p)
    const baseInputs = {
      approved: {
        groups: prop.entities.groups,
        days_of_operation: prop.entities.days_of_operation,
        time_blocks: prop.entities.time_blocks,
        activities: prop.entities.activities,
        tiers: prop.entities.tiers,
      },
    }
    const dbOnly = gapLabels({})
    expect(dbOnly).toEqual(expect.arrayContaining(['Groups', 'Time Blocks', 'Activities']))
    const withOwn = gapLabels(withImportOwnRecords({}, baseInputs))
    for (const label of ['Age Divisions', 'Groups', 'Time Blocks', 'Activities']) expect(withOwn).not.toContain(label)
  })

  it('still lists an area the file does not contain', () => {
    expect(gapLabels(withImportOwnRecords({}, { approved: { groups: ['A'] } }))).toContain('Activities')
  })
})
