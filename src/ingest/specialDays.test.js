import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferSpecialDays, DAY_DEVIATION_RATIO, DOMINANT_LABEL_COVERAGE } from './specialDays'

// docs/adr/2026-08-24-special-day-field-trip-ingest.md
//
// One fabricated camp {A, B, C}, Monday–Friday. Every day the same three
// blocks run Mifkad / Swim / Arts for every group — ordinary weekly
// structure, never foreign to the week. On Wednesday, all three groups run
// "Field Trip" instead of Swim and Arts (Mifkad stays normal) — a clear
// whole-day, all-camp deviation that should propose a candidate.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })

function gridFixture({ wednesdayOverride } = {}) {
  const normal = () => [
    row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad']),
    row('10:00-10:30', ['Swim', 'Swim', 'Swim']),
    row('11:00-11:30', ['Arts', 'Arts', 'Arts']),
  ]
  const grid = {}
  for (const day of DAYS) grid[day] = normal(day)
  if (wednesdayOverride) grid.Wednesday = wednesdayOverride
  return {
    pages: DAYS.map((day) => ({
      title: `${day} — All Camp`,
      columns: ['A', 'B', 'C'],
      rows: grid[day],
    })),
  }
}

describe('inferSpecialDays — whole-day, all-camp deviation', () => {
  it('proposes a candidate when a majority of groups deviate ≥ threshold with a single dominant name', () => {
    const parsed = gridFixture({
      wednesdayOverride: [
        row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad']),
        row('10:00-10:30', ['Field Trip', 'Field Trip', 'Field Trip']),
        row('11:00-11:30', ['Field Trip', 'Field Trip', 'Field Trip']),
      ],
    })
    const proposal = extractEntities(parsed)
    const { specialDayCandidates } = inferSpecialDays(parsed, proposal)
    expect(specialDayCandidates).toHaveLength(1)
    expect(specialDayCandidates[0]).toMatchObject({ name: 'Field Trip', day: 'Wednesday' })
    expect(specialDayCandidates[0].support.dominant_groups).toBe(3)
  })

  it('does not propose for an ordinary week with normal daily variance', () => {
    const parsed = gridFixture()
    const proposal = extractEntities(parsed)
    const { specialDayCandidates } = inferSpecialDays(parsed, proposal)
    expect(specialDayCandidates).toEqual([])
  })

  it('does not propose when the deviation ratio is below threshold (one substituted period out of three)', () => {
    const parsed = gridFixture({
      wednesdayOverride: [
        row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad']),
        row('10:00-10:30', ['Swim', 'Swim', 'Swim']),
        row('11:00-11:30', ['Color War', 'Color War', 'Color War']),
      ],
    })
    const proposal = extractEntities(parsed)
    const { specialDayCandidates } = inferSpecialDays(parsed, proposal)
    // 1 foreign of 3 dayActivities = ratio 0.33, below DAY_DEVIATION_RATIO (0.6)
    expect(specialDayCandidates).toEqual([])
  })

  it('does not propose when groups deviate but disagree on a dominant name (no single label majority)', () => {
    const parsed = gridFixture({
      wednesdayOverride: [
        row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad']),
        row('10:00-10:30', ['Trip', 'Off-Camp', 'Excursion']),
        row('11:00-11:30', ['Trip', 'Off-Camp', 'Excursion']),
      ],
    })
    const proposal = extractEntities(parsed)
    const { specialDayCandidates } = inferSpecialDays(parsed, proposal)
    expect(specialDayCandidates).toEqual([])
  })

  it('proposes when the dominant name covers a bare majority of qualifying groups, not unanimity', () => {
    const parsed = gridFixture({
      wednesdayOverride: [
        row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad']),
        row('10:00-10:30', ['Field Trip', 'Field Trip', 'Other Thing']),
        row('11:00-11:30', ['Field Trip', 'Field Trip', 'Other Thing']),
      ],
    })
    const proposal = extractEntities(parsed)
    const { specialDayCandidates } = inferSpecialDays(parsed, proposal)
    expect(specialDayCandidates).toHaveLength(1)
    expect(specialDayCandidates[0].name).toBe('Field Trip')
    expect(specialDayCandidates[0].support.dominant_groups).toBe(2)
  })

  it('is a pure function returning no candidates for empty input', () => {
    expect(inferSpecialDays({ pages: [] }, {})).toEqual({ specialDayCandidates: [] })
  })

  it('exports named threshold constants matching the ADR values', () => {
    expect(DAY_DEVIATION_RATIO).toBe(0.6)
    expect(DOMINANT_LABEL_COVERAGE).toBe(0.5)
  })
})
