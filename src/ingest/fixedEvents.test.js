import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferFixedEvents } from './fixedEvents'

// docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
// docs/work/specs/2026-08-03-ingest-fixed-events-design.md §3, §10.
//
// One fabricated camp {A, B, C}, Monday–Friday, exhibiting every case:
//   - Mifkad   @ 09:00-09:30 for A,B,C every day        -> all-groups all-days, HIGH
//   - Lunch 1  @ 12:00-12:30 for A,B   every day        -> staggered, {A,B}, HIGH
//   - Lunch 2  @ 12:00-12:30 for C     every day        -> staggered, {C},   HIGH
//   - Swim     @ 14:00-14:30 for A on Mon,Wed,Fri (3/5) -> majority-not-all,  LOW, {A}
//   - Free     @ 15:00-15:30 for A on Mon,Tue     (2/5) -> below majority,    DROPPED
//
// The two orientations are true transposes of one another; inferFixedEvents must
// return identical output for both (the transpose invariant).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

// Orientation A — one page per group, days as columns.
function orientationA() {
  const row = (label, cells) => ({ label, cells })
  return {
    pages: [
      {
        title: 'A',
        columns: DAYS,
        rows: [
          row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', 'Mifkad']),
          row('12:00-12:30', ['Lunch 1', 'Lunch 1', 'Lunch 1', 'Lunch 1', 'Lunch 1']),
          row('14:00-14:30', ['Swim', '', 'Swim', '', 'Swim']),
          row('15:00-15:30', ['Free', 'Free', '', '', '']),
        ],
      },
      {
        title: 'B',
        columns: DAYS,
        rows: [
          row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', 'Mifkad']),
          row('12:00-12:30', ['Lunch 1', 'Lunch 1', 'Lunch 1', 'Lunch 1', 'Lunch 1']),
        ],
      },
      {
        title: 'C',
        columns: DAYS,
        rows: [
          row('09:00-09:30', ['Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', 'Mifkad']),
          row('12:00-12:30', ['Lunch 2', 'Lunch 2', 'Lunch 2', 'Lunch 2', 'Lunch 2']),
        ],
      },
    ],
  }
}

// Orientation B — one page per day, groups as columns. The exact transpose of A.
function orientationB() {
  const GROUPS = ['A', 'B', 'C']
  // day -> block -> [A, B, C] cell values
  const grid = {
    Monday: {
      '09:00-09:30': ['Mifkad', 'Mifkad', 'Mifkad'],
      '12:00-12:30': ['Lunch 1', 'Lunch 1', 'Lunch 2'],
      '14:00-14:30': ['Swim', '', ''],
      '15:00-15:30': ['Free', '', ''],
    },
    Tuesday: {
      '09:00-09:30': ['Mifkad', 'Mifkad', 'Mifkad'],
      '12:00-12:30': ['Lunch 1', 'Lunch 1', 'Lunch 2'],
      '15:00-15:30': ['Free', '', ''],
    },
    Wednesday: {
      '09:00-09:30': ['Mifkad', 'Mifkad', 'Mifkad'],
      '12:00-12:30': ['Lunch 1', 'Lunch 1', 'Lunch 2'],
      '14:00-14:30': ['Swim', '', ''],
    },
    Thursday: {
      '09:00-09:30': ['Mifkad', 'Mifkad', 'Mifkad'],
      '12:00-12:30': ['Lunch 1', 'Lunch 1', 'Lunch 2'],
    },
    Friday: {
      '09:00-09:30': ['Mifkad', 'Mifkad', 'Mifkad'],
      '12:00-12:30': ['Lunch 1', 'Lunch 1', 'Lunch 2'],
      '14:00-14:30': ['Swim', '', ''],
    },
  }
  return {
    pages: DAYS.map((day) => ({
      title: `${day} — All Camp`,
      columns: GROUPS,
      rows: Object.entries(grid[day]).map(([label, cells]) => ({ label, cells })),
    })),
  }
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.time_block.localeCompare(b.time_block)

describe('inferFixedEvents — detection over a fabricated grid', () => {
  const parsed = orientationA()
  const proposal = extractEntities(parsed)
  const { fixedEvents } = inferFixedEvents(parsed, proposal)
  const find = (name, block) => fixedEvents.find((e) => e.name === name && e.time_block === block)

  it('orients the fixture as one page per group, days across', () => {
    expect(proposal.orientation.columns).toBe('days')
  })

  it('proposes an all-days, all-groups event as high confidence', () => {
    const mifkad = find('Mifkad', '09:00-09:30')
    expect(mifkad).toBeTruthy()
    expect(mifkad.confidence).toBe('high')
    expect(mifkad.scope).toEqual({ is_all_groups: true, groups: null })
    expect(mifkad.days).toEqual(DAYS)
  })

  it('separates staggered variants into distinct events, scoped to their groups', () => {
    const lunch1 = find('Lunch 1', '12:00-12:30')
    const lunch2 = find('Lunch 2', '12:00-12:30')
    expect(lunch1.scope).toEqual({ is_all_groups: false, groups: ['A', 'B'] })
    expect(lunch1.confidence).toBe('high')
    expect(lunch2.scope).toEqual({ is_all_groups: false, groups: ['C'] })
    expect(lunch2.confidence).toBe('high')
  })

  it('proposes a majority-but-not-all event as low confidence, scoped to its group', () => {
    const swim = find('Swim', '14:00-14:30')
    expect(swim.confidence).toBe('low')
    expect(swim.scope).toEqual({ is_all_groups: false, groups: ['A'] })
    expect(swim.days).toEqual(['Monday', 'Wednesday', 'Friday'])
  })

  it('drops an event below a strict majority', () => {
    expect(find('Free', '15:00-15:30')).toBeUndefined()
  })

  it('proposes exactly the four surviving events', () => {
    expect(fixedEvents.map((e) => e.name).sort()).toEqual(['Lunch 1', 'Lunch 2', 'Mifkad', 'Swim'])
  })

  // B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): support is
  // additive — every other field above is unchanged by its presence.
  it('attaches the observation support each event\'s days/scope were inferred from', () => {
    const mifkad = find('Mifkad', '09:00-09:30')
    expect(mifkad.support).toEqual({
      days: DAYS,
      occupied_days: 5,
      operating_days: 5,
      groups_in_scope: ['A', 'B', 'C'],
      groups: [
        { name: 'A', occupied_days: 5, operating_days: 5 },
        { name: 'B', occupied_days: 5, operating_days: 5 },
        { name: 'C', occupied_days: 5, operating_days: 5 },
      ],
      min_occupied_days: 5,
      min_operating_days: 5,
    })

    const lunch1 = find('Lunch 1', '12:00-12:30')
    expect(lunch1.support).toEqual({
      days: DAYS,
      occupied_days: 5,
      operating_days: 5,
      groups_in_scope: ['A', 'B'],
      groups: [
        { name: 'A', occupied_days: 5, operating_days: 5 },
        { name: 'B', occupied_days: 5, operating_days: 5 },
      ],
      min_occupied_days: 5,
      min_operating_days: 5,
    })

    const swim = find('Swim', '14:00-14:30')
    expect(swim.support).toEqual({
      days: ['Monday', 'Wednesday', 'Friday'],
      occupied_days: 3,
      operating_days: 5,
      groups_in_scope: ['A'],
      groups: [{ name: 'A', occupied_days: 3, operating_days: 5 }],
      min_occupied_days: 3,
      min_operating_days: 5,
    })
  })
})

// Red Hat round-1 MEDIUM: support must stay consistent with confidence for a
// collapsed multi-group event — the group that actually justifies a 'low'
// tier must be visible in the persisted support, not just the strongest one.
describe('support/confidence consistency for a collapsed multi-group event (Red Hat round-1)', () => {
  it('a low-confidence collapse carries the weak group\'s sub-majority ratio, not just the strong group\'s', () => {
    const row = (label, cells) => ({ label, cells })
    // Both groups occupy Flag on the SAME day-set (Mon–Wed) — required for
    // them to collapse into one event, since the collapse key includes the
    // occupied day-set. Group A operates only those 3 days -> 3/3, HIGH.
    // Group B additionally operates Thursday (a 4th day column) where Flag
    // is blank -> occupied stays Mon–Wed (3) but operating is 4 -> 3/4, a
    // genuine sub-majority (passes the strict-majority filter: 3*2 > 4) that
    // drags the collapsed event's confidence to 'low'.
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: ['Monday', 'Tuesday', 'Wednesday'],
          rows: [row('09:00-09:30', ['Flag', 'Flag', 'Flag'])],
        },
        {
          title: 'B',
          columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'],
          rows: [row('09:00-09:30', ['Flag', 'Flag', 'Flag', ''])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal)
    const flag = fixedEvents.find((e) => e.name === 'Flag')
    expect(flag).toBeTruthy()
    expect(flag.days).toEqual(['Monday', 'Tuesday', 'Wednesday'])
    // A alone (3/3) would be 'high'; B's 3/4 drags the collapsed tier to 'low'.
    expect(flag.confidence).toBe('low')

    const bStat = flag.support.groups.find((g) => g.name === 'B')
    expect(bStat.occupied_days).toBe(3)
    expect(bStat.operating_days).toBe(4)
    expect(bStat.occupied_days / bStat.operating_days).toBeLessThan(1)
    // The weakest-group summary points at B's sub-majority ratio, not A's 3/3
    // — this is what makes confidence='low' explainable from support alone.
    expect(flag.support.min_occupied_days).toBe(3)
    expect(flag.support.min_operating_days).toBe(4)
    // The headline occupied_days/operating_days still carries the STRONGEST
    // group (the documented aggregation choice) — support is additive, not
    // replaced, so this stays 3/3 even though confidence is 'low'.
    expect(flag.support.occupied_days).toBe(3)
    expect(flag.support.operating_days).toBe(3)
  })
})

describe('the transpose invariant', () => {
  it('returns identical output for the same fixture in either orientation', () => {
    const a = orientationA()
    const b = orientationB()
    const outA = inferFixedEvents(a, extractEntities(a)).fixedEvents
    const outB = inferFixedEvents(b, extractEntities(b)).fixedEvents
    expect(outB.sort(byName)).toEqual(outA.sort(byName))
  })

  it('reads Camp B fixture as one page per day, groups across', () => {
    const b = orientationB()
    expect(extractEntities(b).orientation.columns).toBe('groups')
  })
})

describe('dualUseNames (ADR 2026-08-09, Decision 1) — a seed, not a verdict', () => {
  it('excludes a pin-only name (no occupied tuple outside its confirmed footprint)', () => {
    const parsed = orientationA()
    const proposal = extractEntities(parsed)
    const { dualUseNames } = inferFixedEvents(parsed, proposal)
    // Mifkad is all-groups, all-days, with no other occurrence anywhere else.
    expect(dualUseNames).not.toContain('Mifkad')
  })

  it('flags a name that is both a confirmed fixed event AND used outside its footprint', () => {
    const row = (label, cells) => ({ label, cells })
    const parsed = {
      pages: [
        {
          title: 'A',
          columns: DAYS,
          rows: [row('10:00-10:30', ['Ceramics', 'Ceramics', 'Ceramics', 'Ceramics', 'Ceramics'])],
        },
        {
          title: 'B',
          columns: DAYS,
          // Below majority (2/5) at a DIFFERENT block -> dropped by the filter,
          // but still recorded in the pre-filter `occupied` map.
          rows: [row('11:00-11:30', ['Ceramics', 'Ceramics', '', '', ''])],
        },
      ],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents, dualUseNames } = inferFixedEvents(parsed, proposal)
    expect(fixedEvents.map((e) => e.name)).toContain('Ceramics')
    expect(dualUseNames).toContain('Ceramics')
  })
})

describe('normalizer fix (Red Hat Risk 5) — orientation B with inconsistent group-name spelling', () => {
  it('collapses "Zahav\\t" and "zahav" into one group for confidence, majority, and dual-use', () => {
    const row = (label, cells) => ({ label, cells })
    // 5 day-pages; the group column is spelled inconsistently across pages.
    const spellings = ['Zahav\t', 'zahav', ' Zahav', 'ZAHAV', 'Zahav']
    const parsed = {
      pages: DAYS.map((day, i) => ({
        title: day,
        columns: [spellings[i]],
        rows: [
          row('09:00-09:30', ['Mifkad']),
          // "Ceramics" pinned every day at 10:00 for this SAME group
          // (despite spelling drift) -> confirmed high-confidence event.
          row('10:00-10:30', ['Ceramics']),
        ],
      })),
    }
    // A second block, only on two of the five (differently-spelled) pages,
    // proves the dual-use footprint match also survives spelling drift.
    parsed.pages[0].rows.push(row('11:00-11:30', ['Ceramics']))
    parsed.pages[1].rows.push(row('11:00-11:30', ['Ceramics']))

    const proposal = extractEntities(parsed)
    const { fixedEvents, dualUseNames } = inferFixedEvents(parsed, proposal)

    const mifkad = fixedEvents.find((e) => e.name === 'Mifkad')
    expect(mifkad.confidence).toBe('high')
    expect(mifkad.days.length).toBe(5) // denominator not fragmented by spelling drift

    const ceramics = fixedEvents.find((e) => e.name === 'Ceramics' && e.time_block === '10:00-10:30')
    expect(ceramics.confidence).toBe('high')
    expect(ceramics.days.length).toBe(5)

    expect(dualUseNames).toContain('Ceramics') // outside-footprint use at 11:00 on 2/5 pages
  })
})

// Slice 0 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md) —
// Bug A: three same-name cells staggered by an embedded TIME under one shared
// row label used to collapse into a single all-groups event, losing the
// stagger. Days: same-block-same-day recurrence across multiple days must
// stay ONE event (the legitimate case) — only a difference in embedded time
// splits an event, never a difference in day.
describe('Bug A — staggered same-name occurrences under one shared row label', () => {
  const row = (label, cells) => ({ label, cells })

  it('does not collapse three staggered same-name cells into one all-groups event', () => {
    // One wide "Lunch" block row; each group's own cell carries its true,
    // staggered time as text — exactly what a camp encodes when the row
    // label alone can't capture three different lunch times.
    const parsed = {
      pages: [
        { title: 'A', columns: DAYS, rows: [row('12:00-13:00', DAYS.map(() => 'Lunch 12:00'))] },
        { title: 'B', columns: DAYS, rows: [row('12:00-13:00', DAYS.map(() => 'Lunch 12:30'))] },
        { title: 'C', columns: DAYS, rows: [row('12:00-13:00', DAYS.map(() => 'Lunch 1:00'))] },
      ],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal)

    const lunches = fixedEvents.filter((e) => e.name === 'Lunch')
    expect(lunches.length).toBe(3)
    for (const e of lunches) {
      expect(e.scope.is_all_groups).toBe(false)
      expect(e.scope.groups.length).toBe(1)
      // Never surfaced on the output — the by-name resolution invariant
      // still needs time_block to be exactly the row's own block spelling.
      expect(e.time_block).toBe('12:00-13:00')
    }
    expect(new Set(lunches.flatMap((e) => e.scope.groups))).toEqual(new Set(['A', 'B', 'C']))
  })

  it('keeps the same activity at the same block on multiple days as ONE event (no false split by day)', () => {
    const parsed = {
      pages: [
        { title: 'A', columns: DAYS, rows: [row('09:00-09:30', DAYS.map(() => 'Mifkad'))] },
      ],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal)
    const mifkads = fixedEvents.filter((e) => e.name === 'Mifkad')
    expect(mifkads.length).toBe(1)
    expect(mifkads[0].days).toEqual(DAYS)
  })
})

// Bug B: a camp whose periods are named "Period 1"/"Block 2" rather than
// printed times produced zero detection because isBlockLabel only recognized
// a time-shaped regex. Passing the camp's own already-configured time_blocks
// names lets non-time period labels be recognized too.
describe('Bug B — non-time period labels', () => {
  const row = (label, cells) => ({ label, cells })

  it('detects nothing for non-time row labels with no known block names (documents the gap)', () => {
    const parsed = {
      pages: [{ title: 'A', columns: DAYS, rows: [row('Period 1', DAYS.map(() => 'Mifkad'))] }],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal)
    expect(fixedEvents).toEqual([])
  })

  it('detects the same recurring event once the camp\'s own period names are known', () => {
    const parsed = {
      pages: [{ title: 'A', columns: DAYS, rows: [row('Period 1', DAYS.map(() => 'Mifkad'))] }],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal, { knownTimeBlockNames: ['Period 1', 'Period 2'] })
    const mifkad = fixedEvents.find((e) => e.name === 'Mifkad')
    expect(mifkad).toBeTruthy()
    expect(mifkad.time_block).toBe('Period 1')
    expect(mifkad.confidence).toBe('high')
    expect(mifkad.scope).toEqual({ is_all_groups: true, groups: null })
  })

  it('matches known block names case- and whitespace-insensitively', () => {
    const parsed = {
      pages: [{ title: 'A', columns: DAYS, rows: [row('  period 1  ', DAYS.map(() => 'Mifkad'))] }],
    }
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal, { knownTimeBlockNames: ['Period 1'] })
    expect(fixedEvents.find((e) => e.name === 'Mifkad')).toBeTruthy()
  })

  it('keeps the time-shaped path working unaffected by known-block-names threading', () => {
    const parsed = orientationA()
    const proposal = extractEntities(parsed)
    const { fixedEvents } = inferFixedEvents(parsed, proposal, { knownTimeBlockNames: ['Period 1'] })
    expect(fixedEvents.map((e) => e.name).sort()).toEqual(['Lunch 1', 'Lunch 2', 'Mifkad', 'Swim'])
  })
})

describe('the name-identity invariant (§3.2)', () => {
  // Every string a fixed event carries must appear verbatim in the paired
  // entity proposal, or the commit path cannot resolve it by name.
  for (const [label, make] of [['orientation A', orientationA], ['orientation B', orientationB]]) {
    it(`spells every name exactly as the entity proposal does (${label})`, () => {
      const parsed = make()
      const proposal = extractEntities(parsed)
      const { fixedEvents } = inferFixedEvents(parsed, proposal)
      const { activities, time_blocks, days_of_operation, groups } = proposal.entities
      expect(fixedEvents.length).toBeGreaterThan(0)
      for (const fe of fixedEvents) {
        expect(activities, fe.name).toContain(fe.name)
        expect(time_blocks, fe.time_block).toContain(fe.time_block)
        for (const d of fe.days) expect(days_of_operation).toContain(d)
        for (const g of fe.scope.groups ?? []) expect(groups).toContain(g)
      }
    })
  }
})
