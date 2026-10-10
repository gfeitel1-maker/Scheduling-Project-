import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { capturePlacements } from './capturePlacements.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { describeAppearance, groupedCardLines, groupedCardHeadline } from './appearsAt.js'

// Keeper ruling: an aggregated review card lists where each item appears,
// compactly — "Carpool · 140 cells · Mon–Fri 8:40 AM, 3:40 PM · every group".
const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')
const parsed = parseTextGrid(campB)
const proposal = extractEntities(parsed)
const { placements } = capturePlacements(parsed, proposal)
const groups = proposal.entities.groups

describe('describeAppearance on campB', () => {
  it('Carpool: days collapse to a range, times listed, every group', () => {
    expect(describeAppearance(placements, 'Carpool', groups)).toBe('Carpool · 140 cells · Mon–Fri 8:40 AM, 3:40 PM · every group')
  })

  it('All Camp Activity: separate day sets stay separate, groups cap at 3 then +N', () => {
    expect(describeAppearance(placements, 'All Camp Activity', groups)).toBe(
      'All Camp Activity · 26 cells · Tue, Thu 2:25 PM · Beavers 1, Beavers 2, Badger 1 +10',
    )
  })

  it('caps a long list of times', () => {
    const many = ['08:40-09:00', '09:00-09:15', '09:20-09:40', '09:45-10:25', '10:35-11:15'].map((b, i) => (
      { groupName: 'A', dayName: 'Monday', blockLabel: b, activityName: 'X' + (i ? '' : '') }
    ))
    const text = describeAppearance(many, 'X', ['A'])
    expect(text).toMatch(/Mon 8:40 AM, 9:00 AM, 9:20 AM \+2 more/)
  })

  it('never returns a bare name when it knows nothing', () => {
    expect(describeAppearance([], 'Ghost', groups)).toBe('Ghost')
  })
})

describe('aggregated card copy', () => {
  const item = (name) => ({ op: 'create', entity: 'activities', entity_id: null, _name: name, evidence: { tier: 'low' }, fields: {} })
  const report = buildReconciliationReport({
    planItems: [item('Carpool'), item('Busses')],
    readiness: [],
    placements,
    allGroupNames: groups,
  })
  const decisions = report.decisions.filter((d) => d.kind === 'confirm_value')

  it('each activity decision carries where it appears', () => {
    expect(decisions.map((d) => d.appearsAt)).toEqual([
      'Carpool · 140 cells · Mon–Fri 8:40 AM, 3:40 PM · every group',
      'Busses · 70 cells · Mon–Fri 3:20 PM · every group',
    ])
  })

  it('a card standing for different items lists every one, not just the first name', () => {
    expect(groupedCardLines(decisions)).toEqual([
      'Carpool · 140 cells · Mon–Fri 8:40 AM, 3:40 PM · every group',
      'Busses · 70 cells · Mon–Fri 3:20 PM · every group',
    ])
    expect(groupedCardHeadline(decisions)).toBe("Use the file's values for these 2 items?")
  })

  it('a card standing for one repeated name keeps its own headline', () => {
    expect(groupedCardHeadline([decisions[0], decisions[0]])).toBeNull()
  })
})
