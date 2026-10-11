// F5 follow-up (a): when EVERY group prints the same catalogue-length span (a
// two-block Ropes Course on one day), arm 2 (weekly recurring) used to admit
// each of its blocks as an all-camp fixed event, so the activity was pinned and
// never a candidate for goals. A span is one session of a catalogue activity,
// and under strict category exclusivity
// (docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md) its
// name sits in ONE bucket: the activity. A span that fills more than half the
// day (an all-day Color War) is still an event, and a meal held every day
// (arm 1) is untouched.
import { describe, it, expect } from 'vitest'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'
import { derivePinOnlyActivityNames } from './pinOnlyActivityNames.js'
import { inferTextSpans } from './textSpans.js'
import { inferActivityRules } from './activityRules.js'

const T = ['09:00–09:45', '10:00–10:45', '11:00–11:45', '12:00–12:45', '13:00–13:45', '14:00–14:45']
function dayPage(day, cols) {
  const lines = [`                        ${day} — All Camp`, '', '   Time           Group A        Group B        Group C', '']
  T.forEach((time, b) => lines.push(`${time.padEnd(18)}${cols.map((c) => c[b].padEnd(15)).join('')}`.trimEnd(), ''))
  return lines.join('\n')
}
const text = [
  dayPage('Monday', [
    ['Music', 'Swim', 'Lunch', 'Drama', 'Archery', 'Tennis'],
    ['Swim', 'Drama', 'Lunch', 'Archery', 'Tennis', 'Music'],
    ['Drama', 'Archery', 'Lunch', 'Tennis', 'Music', 'Swim']]),
  dayPage('Tuesday', [
    ['Ropes Course', 'Ropes Course', 'Lunch', 'Swim', 'Music', 'Drama'],
    ['Ropes Course', 'Ropes Course', 'Lunch', 'Music', 'Drama', 'Archery'],
    ['Ropes Course', 'Ropes Course', 'Lunch', 'Archery', 'Swim', 'Tennis']]),
  dayPage('Wednesday', Array(3).fill(Array(6).fill('Color War'))),
].join('\n\n')

function run() {
  const parsed = parseTextGrid(text)
  const proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  return { parsed, proposal, fixedEvents, dualUseNames }
}

describe('inferFixedEvents: a catalogue-length span every group prints stays an activity', () => {
  it('is a 2-block span', () => {
    const { parsed, proposal } = run()
    expect(inferTextSpans(parsed, proposal).spans.get('ropes course')).toMatchObject({ span_blocks: 2 })
  })

  it('is not claimed as a fixed event', () => {
    const { fixedEvents } = run()
    expect(fixedEvents.filter((e) => e.name === 'Ropes Course')).toEqual([])
  })

  it('is an activity with span_blocks 2 and one session a week', () => {
    const { parsed, proposal, fixedEvents, dualUseNames } = run()
    const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
    expect(pinOnly.has('Ropes Course')).toBe(false)
    const rules = inferActivityRules(proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
      proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly, inferTextSpans(parsed, proposal).spans)
    expect(rules.get('Ropes Course')).toMatchObject({ span_blocks: 2, min_per_week: 1 })
  })

  it('an all-day span and a daily meal are still events', () => {
    const { fixedEvents } = run()
    expect(fixedEvents.filter((e) => e.name === 'Color War')).toHaveLength(6)
    expect(fixedEvents.filter((e) => e.name === 'Lunch')).toHaveLength(1)
  })
})

// A two-block span printed by a two-thirds SUBSET of groups is how a part-day trip is admitted as an event
// today (s11 Museum Trip); the release is scoped to the all-groups shape so that stays an event.
describe('inferFixedEvents: a span held by a subset of groups is still admitted', () => {
  it('keeps a two-thirds-subset two-block span as an event', () => {
    const sub = [
      dayPage('Monday', [
        ['Music', 'Swim', 'Lunch', 'Drama', 'Archery', 'Tennis'],
        ['Swim', 'Drama', 'Lunch', 'Archery', 'Tennis', 'Music'],
        ['Drama', 'Archery', 'Lunch', 'Tennis', 'Music', 'Swim']]),
      dayPage('Tuesday', [
        ['Museum Trip', 'Museum Trip', 'Lunch', 'Swim', 'Music', 'Drama'],
        ['Museum Trip', 'Museum Trip', 'Lunch', 'Music', 'Drama', 'Archery'],
        ['Tennis', 'Swim', 'Lunch', 'Archery', 'Drama', 'Music']]),
    ].join('\n\n')
    const parsed = parseTextGrid(sub)
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
    expect(fixedEvents.filter((e) => e.name === 'Museum Trip')).toHaveLength(2)
  })
})
