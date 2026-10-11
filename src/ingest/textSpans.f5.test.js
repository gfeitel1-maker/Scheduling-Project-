// F5 (docs/work/evidence/2026-10-11-synthetic-15-scorecard.md): a multi-block
// span read from a TEXT grid imports as ONE session of N blocks.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferActivityRules } from './activityRules.js'
import { capturePlacements } from './capturePlacements.js'
import { inferTextSpans } from './textSpans.js'

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
  // `spans` is passed as an F5 caller did; inferActivityRules must not turn it into span_blocks.
  const rules = inferActivityRules(
    proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
    proposal.entities.days_of_operation.length, proposal.entities.groups, [], spans,
  )
  const { placements } = capturePlacements({ pages: parsed.pages }, proposal)
  return { proposal, rules, placements, spans }
}

const REPEAT = [
  dayPage('Monday', [[T[0], ['Ropes Course', 'Music', 'Drama']], [T[1], ['Ropes Course', 'Swim', 'Archery']], [T[2], ['Swim', 'Drama', 'Music']]]),
  dayPage('Tuesday', [[T[0], ['Archery', 'Music', 'Drama']], [T[1], ['Swim', 'Drama', 'Music']], [T[2], ['Music', 'Swim', 'Archery']]]),
  dayPage('Wednesday', [[T[0], ['Swim', 'Music', 'Drama']], [T[1], ['Ropes Course', 'Archery', 'Swim']], [T[2], ['Ropes Course', 'Drama', 'Music']]]),
].join('\n\n')

// The same week with each span printed once and its second block blank. Every
// blank continuation is followed by a printed cell, as a merged cell always is.
const BLANK = [
  dayPage('Monday', [[T[0], ['Ropes Course', 'Music', 'Drama']], [T[1], ['', 'Swim', 'Archery']], [T[2], ['Swim', 'Drama', 'Music']]]),
  dayPage('Tuesday', [[T[0], ['Archery', 'Music', 'Drama']], [T[1], ['Swim', 'Drama', 'Music']], [T[2], ['Music', 'Swim', 'Archery']]]),
  dayPage('Wednesday', [[T[0], ['Ropes Course', 'Music', 'Drama']], [T[1], ['', 'Archery', 'Swim']], [T[2], ['Swim', 'Drama', 'Music']]]),
].join('\n\n')

describe('F5 text-grid spans are one session of N blocks', () => {
  it('r6 repro: a 2-block name printed once a week is detected as a 2-block span', () => {
    const text = readFileSync('docs/work/specs/samples/synthetic/repro/r6-partial-day-trip.txt', 'utf8')
    const { spans, placements } = importRules(text)
    expect(spans.get('museum trip')?.span_blocks).toBe(2)
    expect(placements.filter((p) => p.activityName === 'Museum Trip')).toHaveLength(2)
  })

  // The engine has no placement precedence or repair for spans yet
  // (buildSchedule.js repair is single-block only), so a span_blocks rule left
  // some synthetic camps' spans with ZERO placements on Generate. Until that
  // engine change is made, the detected span is not written into the rule: the
  // activity keeps its per-block count and is placed as singles, as before F5.
  it('repeat: a detected span is withheld from the rule (no span_blocks, per-block count)', () => {
    const { rules, placements, spans } = importRules(REPEAT)
    expect(spans.get('ropes course')?.span_blocks).toBe(2)
    const rule = rules.get('Ropes Course')
    expect(rule.span_blocks).toBeUndefined()
    expect(rule.min_per_week).toBe(4)
    expect(placements.filter((p) => p.activityName === 'Ropes Course')).toHaveLength(4)
    // ordinary single-block activities are untouched
    expect(rules.get('Swim').span_blocks).toBeUndefined()
  })

  it('blank: name printed once, next block blank -> span 2, all 4 cells captured', () => {
    expect(BLANK).not.toBe(REPEAT)
    const { rules, placements, spans } = importRules(BLANK)
    expect(spans.get('ropes course')?.span_blocks).toBe(2)
    expect(rules.get('Ropes Course').span_blocks).toBeUndefined()
    const ropes = placements.filter((p) => p.activityName === 'Ropes Course' && p.groupName === 'Otters 1')
    expect(ropes.map((p) => `${p.dayName} ${p.blockLabel}`).sort()).toEqual(
      ['Monday 09:00-09:45', 'Monday 10:00-10:45', 'Wednesday 09:00-09:45', 'Wednesday 10:00-10:45'].sort(),
    )
  })

  it('a block blank for every group (a free period) is not a span tail', () => {
    const FREE = [
      dayPage('Monday', [[T[0], ['Music', 'Drama', 'Swim']], [T[1], ['Archery', 'Swim', 'Drama']], [T[2], ['', '', '']]]),
      dayPage('Tuesday', [[T[0], ['Drama', 'Swim', 'Music']], [T[1], ['Archery', 'Music', 'Swim']], [T[2], ['', '', '']]]),
      dayPage('Wednesday', [[T[0], ['Swim', 'Music', 'Drama']], [T[1], ['Archery', 'Drama', 'Music']], [T[2], ['', '', '']]]),
    ].join('\n\n')
    const { rules, placements, spans } = importRules(FREE)
    expect(rules.get('Archery')).toBeDefined()
    expect(spans.has('archery')).toBe(false)
    expect(placements.filter((p) => p.activityName === 'Archery')).toHaveLength(3)
  })

  it('a blank that ends one group\'s day (a minority short day) is not a span tail', () => {
    const SHORT = [
      dayPage('Monday', [[T[0], ['Music', 'Drama', 'Swim']], [T[1], ['Archery', 'Swim', 'Drama']], [T[2], ['', 'Crafts', 'Music']]]),
      dayPage('Tuesday', [[T[0], ['Drama', 'Swim', 'Music']], [T[1], ['Archery', 'Music', 'Swim']], [T[2], ['', 'Crafts', 'Drama']]]),
    ].join('\n\n')
    const { spans, placements } = importRules(SHORT)
    expect(placements.filter((p) => p.activityName === 'Archery')).toHaveLength(2)
    expect(spans.has('archery')).toBe(false)
  })

  it('a single stray blank after one occurrence is not a span', () => {
    const once = BLANK.slice(0, BLANK.lastIndexOf('Wednesday'))
    const { spans } = importRules(once)
    expect(spans.has('ropes course')).toBe(false)
  })
})
