import { describe, it, expect } from 'vitest'
import { buildSpecialDayPlan } from './specialDayPlan'
import { proposeSpecialDay } from './specialDayFile'

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
