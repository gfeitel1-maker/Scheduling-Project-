// F5 (docs/work/evidence/2026-10-11-synthetic-15-scorecard.md): a multi-block
// span read from a TEXT grid imports as ONE session of N blocks.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferActivityRules } from './activityRules.js'
import { capturePlacements } from './capturePlacements.js'
import { inferTextSpans } from './textSpans.js'
import buildSchedule from '../engine/buildSchedule.js'

function dayPage(day, rows) {
  const lines = [`                        ${day} — All Camp`, '', '   Time           Otters 1       Otters 2       Otters 3', '']
  for (const [time, cells] of rows) {
    lines.push(`${time.padEnd(18)}${cells.map((c) => c.padEnd(15)).join('')}`.trimEnd(), '')
  }
  return lines.join('\n')
}
const T = ['09:00–09:45', '10:00–10:45', '11:00–11:45']

function importRules(text) {
  const parsed = parseTextGrid(text)
  const proposal = extractEntities(parsed)
  const { spans } = inferTextSpans({ pages: parsed.pages }, proposal)
  const rules = inferActivityRules(
    proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
    proposal.entities.days_of_operation.length, proposal.entities.groups, [], spans,
  )
  const { placements } = capturePlacements({ pages: parsed.pages }, proposal)
  return { proposal, rules, placements }
}

const REPEAT = [
  dayPage('Monday', [[T[0], ['Ropes Course', 'Music', 'Drama']], [T[1], ['Ropes Course', 'Swim', 'Archery']], [T[2], ['Swim', 'Drama', 'Music']]]),
  dayPage('Tuesday', [[T[0], ['Archery', 'Music', 'Drama']], [T[1], ['Swim', 'Drama', 'Music']], [T[2], ['Music', 'Swim', 'Archery']]]),
  dayPage('Wednesday', [[T[0], ['Swim', 'Music', 'Drama']], [T[1], ['Ropes Course', 'Archery', 'Swim']], [T[2], ['Ropes Course', 'Drama', 'Music']]]),
].join('\n\n')

const BLANK = REPEAT
  .replace(/(10:00–10:45\s+)Ropes Course /, '$1             ')
  .replace(/(11:00–11:45\s+)Ropes Course /, '$1             ')

describe('F5 text-grid spans are one session of N blocks', () => {
  it('r6 repro: a 2-block name printed once a week is span_blocks 2, min_per_week 1', () => {
    const text = readFileSync('docs/work/specs/samples/synthetic/repro/r6-partial-day-trip.txt', 'utf8')
    const { rules, placements } = importRules(text)
    const rule = rules.get('Museum Trip')
    expect(rule.span_blocks).toBe(2)
    expect(rule.min_per_week).toBe(1)
    expect(placements.filter((p) => p.activityName === 'Museum Trip')).toHaveLength(2)
  })

  it('repeat: name printed in both blocks, twice a week -> span 2, 2 sessions', () => {
    const { rules, placements } = importRules(REPEAT)
    const rule = rules.get('Ropes Course')
    expect(rule.span_blocks).toBe(2)
    expect(rule.min_per_week).toBe(2)
    expect(placements.filter((p) => p.activityName === 'Ropes Course')).toHaveLength(4)
    // ordinary single-block activities are untouched
    expect(rules.get('Swim').span_blocks).toBeUndefined()
  })

  it('blank: name printed once, next block blank -> span 2, 2 sessions, all 4 cells captured', () => {
    expect(BLANK).not.toBe(REPEAT)
    const { rules, placements } = importRules(BLANK)
    const rule = rules.get('Ropes Course')
    expect(rule.span_blocks).toBe(2)
    expect(rule.min_per_week).toBe(2)
    const ropes = placements.filter((p) => p.activityName === 'Ropes Course' && p.groupName === 'Otters 1')
    expect(ropes.map((p) => `${p.dayName} ${p.blockLabel}`).sort()).toEqual(
      ['Monday 09:00-09:45', 'Monday 10:00-10:45', 'Wednesday 10:00-10:45', 'Wednesday 11:00-11:45'].sort(),
    )
  })

  it('a single stray blank after one occurrence is not a span', () => {
    const once = BLANK.slice(0, BLANK.lastIndexOf('Wednesday'))
    const { rules } = importRules(once)
    expect(rules.get('Ropes Course').span_blocks).toBeUndefined()
  })

  it('Generate places the imported span contiguously, never as singles', () => {
    const { proposal, rules } = importRules(REPEAT)
    const rule = rules.get('Ropes Course')
    const blocks = proposal.entities.time_blocks.map((b, i) => ({ id: `b${i}`, name: b, sort_order: i, part_of_day: 'morning', start_time: `0${9 + i}:00`, end_time: `0${9 + i}:45` }))
    const days = ['Monday', 'Tuesday', 'Wednesday'].map((d, i) => ({ id: `d${i}`, label: d, day_of_week: i + 1, sort_order: i }))
    const act = { id: 'ropes', name: 'Ropes Course', priority: 'high', min_per_week: rule.min_per_week, max_per_week: rule.min_per_week, span_blocks: rule.span_blocks, max_groups_per_slot: 0, eligible_tier_ids: [], eligible_group_ids: [] }
    const { slots } = buildSchedule({
      groups: [{ id: 'g1', name: 'Otters 1', tier_id: 't1', availability: 'all' }], tiers: [{ id: 't1', name: 'T' }],
      days, timeBlocks: blocks, activities: [act], fixedEvents: [], campId: 'c', replacedDayIds: [],
    })
    const placed = slots.filter((s) => s.activityId === 'ropes')
    const byDay = new Map()
    for (const s of placed) byDay.set(s.dayId, [...(byDay.get(s.dayId) ?? []), Number(s.blockId.slice(1))])
    expect(byDay.size).toBe(2)
    for (const idx of byDay.values()) {
      idx.sort()
      expect(idx).toHaveLength(2)
      expect(idx[1] - idx[0]).toBe(1)
    }
  })
})
