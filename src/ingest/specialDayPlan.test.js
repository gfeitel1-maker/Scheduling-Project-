import { describe, it, expect } from 'vitest'
import { buildSpecialDayPlan, resolveSpecialDayPlacement } from './specialDayPlan'
import { proposeSpecialDay } from './specialDayFile'
import { activityNameKey } from './preview'

// T40 slice 3b — turn the recognised one-day file into a plan a director can
// confirm, then commit.
//
// The rule 3a exists to protect stays in force here: a special day must not
// quietly enlarge the camp's PERMANENT setup. So nothing is minted silently —
// the plan REPORTS what it would have to create and what it could not match,
// and the director answers before anything is written.

const maccabiah = proposeSpecialDay([{
  title: '"Among Us" Maccabiah 2022',
  columns: ['Lil Chai', 'Chaverim', 'Shalom'],
  rows: [
    { label: '9:15-9:45', cells: ['Opening', 'Opening', 'Opening'] },
    { label: '10:15', cells: ['Pool - Unit Heads', 'Stem - Sylvia', 'Lunch'] },
  ],
}])

const groups = [
  { id: 'g1', name: 'Lil Chai' },
  { id: 'g2', name: 'chaverim' },   // case differs on purpose
  { id: 'g3', name: 'Bogrim' },     // a group the file does not use
]
const activities = [{ id: 'a1', name: 'Lunch' }, { id: 'a2', name: 'Opening' }]

const plan = buildSpecialDayPlan(maccabiah, { groups, activities, specialDays: [] })

describe('buildSpecialDayPlan — columns become the camp\'s OWN groups', () => {
  it('matches a column to an existing group, ignoring case and spacing', () => {
    expect(plan.columns.find(c => c.columnName === 'Chaverim').groupId).toBe('g2')
  })

  it('reports a column it could not match rather than inventing a group', () => {
    // Creating a group would put a throwaway Maccabiah team in the camp's
    // permanent roster — the exact pollution slice 3a exists to prevent.
    expect(plan.unmatchedColumns).toEqual(['Shalom'])
    expect(plan.columns.find(c => c.columnName === 'Shalom').groupId).toBeNull()
  })

  it('does not touch a group the file never mentions', () => {
    expect(plan.columns.map(c => c.columnName)).not.toContain('Bogrim')
  })
})

describe('buildSpecialDayPlan — periods', () => {
  it('keeps file order and numbers it', () => {
    expect(plan.timeBlocks.map(b => b.name)).toEqual(['9:15-9:45', '10:15'])
    expect(plan.timeBlocks.map(b => b.sort_order)).toEqual([0, 1])
  })

  it('reads both ends of a ranged period', () => {
    expect(plan.timeBlocks[0]).toMatchObject({ start_time: '9:15', end_time: '9:45' })
  })

  it('leaves end_time null when the file gave only a start', () => {
    // Inventing an end would fabricate a period length nobody stated.
    expect(plan.timeBlocks[1]).toMatchObject({ start_time: '10:15', end_time: null })
  })
})

describe('buildSpecialDayPlan — activities are proposed, never minted silently', () => {
  it('binds an activity the camp already has', () => {
    expect(plan.activities.find(a => a.name === 'Opening').activityId).toBe('a2')
  })

  it('lists an activity that would have to be created, separately', () => {
    expect(plan.newActivityNames.sort()).toEqual(['Pool', 'Stem'])
  })

  it('binds case-insensitively so a re-import does not double the catalog', () => {
    const p = buildSpecialDayPlan(maccabiah, {
      groups, activities: [...activities, { id: 'a3', name: '  pool ' }], specialDays: [],
    })
    expect(p.activities.find(a => a.name === 'Pool').activityId).toBe('a3')
    expect(p.newActivityNames).toEqual(['Stem'])
  })
})

describe('buildSpecialDayPlan — the staff names have nowhere to go, and are not dropped', () => {
  it('preserves them as notes on the day', () => {
    // special_day_slots has no notes column (schema.sql). Rather than losing
    // "Pool - Unit Heads", the day itself records what the file said.
    expect(plan.notes).toContain('Pool - Unit Heads')
    expect(plan.notes).toContain('Stem - Sylvia')
  })

  it('says nothing when no cell named a person', () => {
    const plain = buildSpecialDayPlan(proposeSpecialDay([{
      title: 'Colour War', columns: ['Red', 'Blue'],
      rows: [{ label: '9:00', cells: ['Relay', 'Relay'] }, { label: '10:00', cells: ['Tug', 'Tug'] }],
    }]), { groups: [], activities: [], specialDays: [] })
    expect(plain.notes).toBeNull()
  })
})

describe('buildSpecialDayPlan — slots', () => {
  it('carries one slot per filled cell, keyed by column and period name', () => {
    const s = plan.slots.find(x => x.columnName === 'Lil Chai' && x.blockName === '10:15')
    expect(s.activityName).toBe('Pool')
  })

  it('drops no cell that a matched column and known period can hold', () => {
    expect(plan.slots).toHaveLength(6)
  })
})

describe('buildSpecialDayPlan — readiness', () => {
  it('is not ready while a column is unmatched', () => {
    // Committing now would silently leave a third of the day unbuilt.
    expect(plan.ready).toBe(false)
    expect(plan.blockedBy).toContain('unmatched_columns')
  })

  it('is ready once every column resolves', () => {
    const p = buildSpecialDayPlan(maccabiah, {
      groups: [...groups, { id: 'g4', name: 'Shalom' }], activities, specialDays: [],
    })
    expect(p.unmatchedColumns).toEqual([])
    expect(p.ready).toBe(true)
  })

  it('is not ready when a special day of that name already exists', () => {
    // special_days has UNIQUE(camp_id, name) — the write would fail at the DB.
    const p = buildSpecialDayPlan(maccabiah, {
      groups: [...groups, { id: 'g4', name: 'Shalom' }], activities,
      specialDays: [{ id: 'sd1', name: '"Among Us" Maccabiah 2022' }],
    })
    expect(p.ready).toBe(false)
    expect(p.blockedBy).toContain('name_taken')
  })

  it('returns null for a null proposal rather than an empty plan', () => {
    expect(buildSpecialDayPlan(null, { groups, activities, specialDays: [] })).toBeNull()
  })
})

// Red Hat (T40 3b review) — a plain Map is last-write-wins, so two live groups
// normalizing to the same name silently bound the column to whichever came
// last: one group got the whole day, the other silently got nothing, and the
// director had no way to tell. This camp has hit duplicate-by-normalization
// names before.
describe('buildSpecialDayPlan — two live groups with the same name', () => {
  const dupGroups = [
    { id: 'g1', name: 'Lil Chai' },
    { id: 'g2', name: 'Chaverim' },
    { id: 'g3', name: 'chaverim ' },   // the duplicate
    { id: 'g4', name: 'Shalom' },
  ]
  const p = buildSpecialDayPlan(maccabiah, { groups: dupGroups, activities, specialDays: [] })

  it('refuses to guess which group the column means', () => {
    expect(p.columns.find(c => c.columnName === 'Chaverim').groupId).toBeNull()
  })

  it('reports it as ambiguous rather than merely unmatched', () => {
    // "you have two groups with this name" and "you have no group with this
    // name" need different fixes, so they must not read the same.
    expect(p.ambiguousColumns).toEqual(['Chaverim'])
    expect(p.unmatchedColumns).not.toContain('Chaverim')
  })

  it('blocks the build', () => {
    expect(p.ready).toBe(false)
    expect(p.blockedBy).toContain('ambiguous_columns')
  })
})

// Red Hat sweep (T255 Slice A) — the sibling groupByName block just above
// collects colliding names and refuses to guess; activityByName had no such
// treatment and was plain last-write-wins.
describe('buildSpecialDayPlan — two live activities with the same name', () => {
  const dupActivities = [
    { id: 'a1', name: 'Lunch' },
    { id: 'a2', name: 'Opening' },
    { id: 'a3', name: 'opening ' },   // the duplicate, differs only in case/space
  ]
  const p = buildSpecialDayPlan(maccabiah, { groups, activities: dupActivities, specialDays: [] })

  it('refuses to guess which activity the file means', () => {
    expect(p.activities.find(a => a.name === 'Opening').activityId).toBeNull()
  })

  it('reports it as ambiguous rather than treating it as new or reused', () => {
    expect(p.ambiguousActivityNames).toEqual(['Opening'])
    expect(p.newActivityNames).not.toContain('Opening')
    expect(p.reusedActivityNames).not.toContain('Opening')
  })
})

describe('buildSpecialDayPlan — existing activities it will reuse', () => {
  it('names them, because matching ignores spacing and capitals', () => {
    // A one-off "Ga Ga pit" can silently attach to the camp's real,
    // rule-governed "GaGa Pit". The director should see the reuse, not just
    // the additions.
    const p = buildSpecialDayPlan(maccabiah, { groups, activities, specialDays: [] })
    expect(p.reusedActivityNames.sort()).toEqual(['Lunch', 'Opening'])
  })
})

describe('buildSpecialDayPlan — two columns that resolve to the same group (slice 3a review minor)', () => {
  const twin = proposeSpecialDay([{
    title: 'Color War 2022',
    columns: ['Lil Chai', 'LilChai', 'Shalom'],
    rows: [
      { label: '9:15-9:45', cells: ['Opening', 'Opening', 'Opening'] },
      { label: '10:15', cells: ['Pool', 'Pool', 'Lunch'] },
    ],
  }])

  it('blocks the plan and names the colliding columns instead of letting the second silently overwrite the first', () => {
    const p = buildSpecialDayPlan(twin, { groups: [{ id: 'g1', name: 'Lil Chai' }, { id: 'g3', name: 'Shalom' }], activities: [], specialDays: [] })
    expect(p.ready).toBe(false)
    expect(p.blockedBy).toContain('duplicate_columns')
    expect(p.duplicateColumns).toEqual(['Lil Chai', 'LilChai'])
  })

  it('a plan whose columns are distinct groups is unaffected', () => {
    expect(plan.blockedBy).not.toContain('duplicate_columns')
    expect(plan.duplicateColumns).toEqual([])
  })
})

describe('F3/F4 slice 4: resolveSpecialDayPlacement', () => {
  const days = [{ id: 'dM', label: 'Monday' }, { id: 'dT', label: 'Tuesday' }]
  const weeks = [{ id: 'w1' }, { id: 'w2' }]
  it('weekday in the file name + the open week -> a placement', () => {
    expect(resolveSpecialDayPlacement({ texts: ['Tuesday Color War Day.xlsx'], days, weeks, weekId: 'w2' }))
      .toEqual({ placement: { weekId: 'w2', dayId: 'dT' }, flag: null, dayId: 'dT' })
  })
  it('no weekday printed -> unplaced with a flag, never invented', () => {
    const r = resolveSpecialDayPlacement({ texts: ['Color War Day.xlsx'], days, weeks, weekId: 'w1' })
    expect(r.placement).toBeNull()
    expect(r.flag).toMatch(/weekday/)
  })
  it('a weekday the camp does not run -> unplaced', () => {
    expect(resolveSpecialDayPlacement({ texts: ['Friday games'], days, weeks, weekId: 'w1' }).placement).toBeNull()
  })
  it('no weeks -> not placed, and the flag says why', () => {
    const r = resolveSpecialDayPlacement({ texts: ['Tuesday games'], days, weeks: [], weekId: null })
    expect(r.placement).toBeNull()
    expect(r.flag).toMatch(/no weeks/)
  })
  it('several weeks and none open -> unplaced, but the resolved DAY is kept and the flag says to pick a week', () => {
    const r = resolveSpecialDayPlacement({ texts: ['Tuesday games'], days, weeks, weekId: null })
    expect(r.placement).toBeNull()
    expect(r.dayId).toBe('dT')
    expect(r.flag).toMatch(/pick a week/i)
  })
  it('a weekday that only appears inside a longer word is not a weekday', () => {
    for (const t of ['Mondayish games', 'Sundayfunday', 'Thursdaymorning']) {
      const r = resolveSpecialDayPlacement({ texts: [t], days: [...days, { id: 'dTh', label: 'Thursday' }, { id: 'dS', label: 'Sunday' }], weeks: [{ id: 'w1' }], weekId: 'w1' })
      expect(r.placement, t).toBeNull()
      expect(r.flag, t).toMatch(/does not say which weekday/)
    }
    expect(resolveSpecialDayPlacement({ texts: ['Tuesday-games.xlsx'], days, weeks: [{ id: 'w1' }], weekId: 'w1' }).placement).toEqual({ weekId: 'w1', dayId: 'dT' })
  })
  it('underscore, digit and plural joined weekday names are still weekdays', () => {
    for (const t of ['Tuesday_Games.xlsx', 'Tuesdays.xlsx', 'Day1_Tuesday', 'Tuesday2.xlsx']) {
      expect(resolveSpecialDayPlacement({ texts: [t], days, weeks: [{ id: 'w1' }], weekId: 'w1' }).placement, t).toEqual({ weekId: 'w1', dayId: 'dT' })
    }
  })
  it('one week and none open -> that week', () => {
    expect(resolveSpecialDayPlacement({ texts: ['Tuesday games'], days, weeks: [{ id: 'w1' }], weekId: null }).placement).toEqual({ weekId: 'w1', dayId: 'dT' })
  })
  it('two different weekdays in one name -> unplaced, never the earlier day of the week', () => {
    const r = resolveSpecialDayPlacement({ texts: ['Tuesday Trip (rain date Monday).pdf'], days: [{ id: 'dM', label: 'Monday' }, { id: 'dT', label: 'Tuesday' }], weeks: [{ id: 'w1' }], weekId: 'w1' })
    expect(r.placement).toBeNull()
    expect(r.flag).toMatch(/more than one weekday/)
  })
})

describe('F3/F4 slice 4/5 review: plan and commit share one activity-name equivalence', () => {
  const towProposal = (name) => proposeSpecialDay([{
    title: 'Color War 2022', columns: ['Lil Chai', 'Chaverim', 'Shalom'], rows: [{ label: '9:15-9:45', cells: [name, name, name] }, { label: '10:15', cells: ['Lunch', 'Lunch', 'Lunch'] }],
  }])
  const live = (extra = {}) => ({ groups: [{ id: 'g1', name: 'Lil Chai' }], activities: [{ id: 'a1', name: 'Tug of War' }, { id: 'a2', name: 'Lunch' }], specialDays: [], ...extra })

  it('an aliased name is reused, not listed as new', () => {
    const p = buildSpecialDayPlan(towProposal('Tug Battle'), live({ aliases: new Map([['tug battle', 'a1']]) }))
    expect(p.newActivityNames).toEqual([])
    expect(p.reusedActivityNames).toContain('Tug Battle')
    expect(p.activities.find((a) => a.name === 'Tug Battle').activityId).toBe('a1')
  })
  it('without the alias the same name is new', () => {
    expect(buildSpecialDayPlan(towProposal('Tug Battle'), live()).newActivityNames).toEqual(['Tug Battle'])
  })
  it('"Tug-of-War" matches "Tug of War" with no alias at all', () => {
    const p = buildSpecialDayPlan(towProposal('Tug-of-War'), live())
    expect(p.newActivityNames).toEqual([])
    expect(p.activities.find((a) => a.name === 'Tug-of-War').activityId).toBe('a1')
  })
})

describe('activityNameKey', () => {
  it('folds case, whitespace and punctuation; keeps genuinely different names apart', () => {
    const k = activityNameKey
    expect(k('Tug-of-War')).toBe(k('Tug of War'))
    expect(k('tug_of_war')).toBe(k('TUG  OF  WAR'))
    expect(k('Capture the Flag!')).toBe(k('capture the flag'))
    expect(k('T-Ball')).toBe(k('Tball'))
    expect(k('Arts & Crafts')).not.toBe(k('Arts and Crafts'))
    expect(k('Swim')).not.toBe(k('Swim Return'))
    expect(k('Lunch 2')).not.toBe(k('Lunch 3'))
  })
})

describe('buildSpecialDayPlan — meals and camp events are events, never catalogue activities', () => {
  const file = proposeSpecialDay([{
    title: 'Color War Day',
    columns: ['Lil Chai', 'Chaverim'],
    rows: [
      { label: '9:15-9:45', cells: ['Lunch', 'Lunch'] },
      { label: '10:15', cells: ['Mifkad', 'Pool'] },
    ],
  }])
  const live = { groups, activities: [], specialDays: [], fixedEvents: [{ name: 'mifkad ', activity_id: 'fe-act' }] }
  const p = buildSpecialDayPlan(file, live)

  it('keeps a meal name out of newActivityNames and lists it as an event', () => {
    expect(p.newActivityNames).toEqual(['Pool'])
    expect(p.eventNames).toContain('Lunch')
  })

  it('keeps a camp fixed-event name out of newActivityNames and binds it to the event\'s activity', () => {
    expect(p.newActivityNames).not.toContain('Mifkad')
    expect(p.reusedActivityNames).toContain('Mifkad')
    expect(p.activities.find((a) => a.name === 'Mifkad').activityId).toBe('fe-act')
  })

  it('reuses a live marker of that key instead of minting another', () => {
    const q = buildSpecialDayPlan(file, { ...live, activities: [{ id: 'm1', name: 'Lunch', catalog_role: 'pinned_event' }] })
    expect(q.activities.find((a) => a.name === 'Lunch').activityId).toBe('m1')
    expect(q.newActivityNames).toEqual(['Pool'])
    expect(q.eventNames).not.toContain('Lunch')
  })
})
