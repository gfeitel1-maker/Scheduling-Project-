import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'

// T141 — docs/work/tickets/T141-fixed-event-eligibility-ignores-group-coverage.md
//
// Arm 2 of the eligibility rule: an event that recurs on a FIXED SUBSET of
// weekdays is pinned by group-coverage, not day-coverage. Modelled on the
// owner's real file (Schedule by Group.xlsx): All Camp Activity holds
// 02:25-03:15 on Tue+Thu in all 14 sheets, Shabbat holds the same block on
// Friday, Ruach holds 01:40-02:20 on Friday. All three are 1-2 days of 5 and
// were therefore dropped outright by the day-majority gate.
//
// Fabricated camp {A, B, C}, Monday-Friday:
//   - Mifkad            @ 09:00 A,B,C every day     -> arm 1 (unchanged), HIGH, fixed
//   - All Camp Activity @ 14:00 A,B,C Tue,Thu       -> arm 2, 3/3 groups, HIGH, fixed
//   - Shabbat           @ 14:00 A,B,C Fri           -> arm 2, same block, different
//                                                      day-set -> its own event
//   - Ruach             @ 15:00 A,B   Fri           -> arm 2, 2/3 groups, LOW, recurring
//   - Clay              @ 16:00 A     Tue           -> 1/3 groups -> DROPPED
//   - Swim              @ 17:00 A Tue / 18:00 B Tue -> not block-invariant -> DROPPED
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })

// day-keyed cell helper: '' everywhere except the named days.
const on = (days, value) => DAYS.map((d) => (days.includes(d) ? value : ''))

function orientationA() {
  return {
    pages: [
      {
        title: 'A',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
          row('15:00-15:30', on(['Friday'], 'Ruach')),
          row('16:00-16:30', on(['Tuesday'], 'Clay')),
          row('17:00-17:30', on(['Tuesday'], 'Swim')),
        ],
      },
      {
        title: 'B',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
          row('15:00-15:30', on(['Friday'], 'Ruach')),
          row('18:00-18:30', on(['Tuesday'], 'Swim')),
        ],
      },
      {
        title: 'C',
        columns: DAYS,
        rows: [
          row('09:00-09:30', on(DAYS, 'Mifkad')),
          row('14:00-14:30', DAYS.map((d) =>
            d === 'Tuesday' || d === 'Thursday' ? 'All Camp Activity' : d === 'Friday' ? 'Shabbat' : '')),
        ],
      },
    ],
  }
}

// The exact transpose: one page per day, groups as columns.
function orientationB() {
  const GROUPS = ['A', 'B', 'C']
  const a = orientationA()
  const blocks = [...new Set(a.pages.flatMap((p) => p.rows.map((r) => r.label)))]
  return {
    pages: DAYS.map((day) => ({
      title: day,
      columns: GROUPS,
      rows: blocks.map((block) => row(block, GROUPS.map((g) => {
        const page = a.pages.find((p) => p.title === g)
        const r = page.rows.find((rr) => rr.label === block)
        return r ? r.cells[DAYS.indexOf(day)] : ''
      }))),
    })),
  }
}

describe('inferFixedEvents — arm 2, weekly recurrence by group coverage (T141)', () => {
  const parsed = orientationA()
  const proposal = extractEntities(parsed)
  const { fixedEvents } = inferFixedEvents(parsed, proposal)
  const find = (name, block) => fixedEvents.find((e) => e.name === name && e.time_block === block)

  it('proposes an all-groups two-day event that no group holds a majority of days', () => {
    const aca = find('All Camp Activity', '14:00-14:30')
    expect(aca).toBeTruthy()
    expect(aca.days).toEqual(['Tuesday', 'Thursday'])
    expect(aca.scope).toEqual({ is_all_groups: true, groups: null })
    expect(aca.kind).toBe('fixed')
    expect(aca.confidence).toBe('high')
  })

  it('proposes a single-day all-groups event', () => {
    const shabbat = find('Shabbat', '14:00-14:30')
    expect(shabbat).toBeTruthy()
    expect(shabbat.days).toEqual(['Friday'])
    expect(shabbat.scope).toEqual({ is_all_groups: true, groups: null })
    expect(shabbat.confidence).toBe('high')
  })

  it('keeps two different day-sets in the same block as separate events', () => {
    expect(find('All Camp Activity', '14:00-14:30').days).toEqual(['Tuesday', 'Thursday'])
    expect(find('Shabbat', '14:00-14:30').days).toEqual(['Friday'])
  })

  it('proposes a two-thirds-coverage event as low confidence, scoped to its groups', () => {
    const ruach = find('Ruach', '15:00-15:30')
    expect(ruach).toBeTruthy()
    expect(ruach.confidence).toBe('low')
    expect(ruach.kind).toBe('recurring')
    expect(ruach.scope).toEqual({ is_all_groups: false, groups: ['A', 'B'] })
  })

  it('drops a one-group single-day occurrence', () => {
    expect(find('Clay', '16:00-16:30')).toBeUndefined()
  })

  it('drops an activity that is not block-invariant across groups', () => {
    expect(find('Swim', '17:00-17:30')).toBeUndefined()
    expect(find('Swim', '18:00-18:30')).toBeUndefined()
  })

  it('marks why each event was admitted', () => {
    expect(find('Mifkad', '09:00-09:30').support.basis).toBe('daily')
    expect(find('All Camp Activity', '14:00-14:30').support.basis).toBe('weekly')
  })

  it('holds the transpose invariant', () => {
    const bParsed = orientationB()
    const bProposal = extractEntities(bParsed)
    const b = inferFixedEvents(bParsed, bProposal).fixedEvents
    expect(bProposal.orientation.columns).toBe('groups')
    expect(b).toEqual(fixedEvents)
  })
})
