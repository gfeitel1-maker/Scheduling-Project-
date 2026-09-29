// T301 slice 2 — the bundle-editor period grid's cell source. A camp holds up
// to two candidate schedules (manual/generated) and neither is canonical
// (CLAUDE.md), so the picker shows the UNION of both routes' placed cells,
// sub-labelling where they disagree — never a route switcher, which would
// imply a per-route authoring model that does not exist.
//
// Reuses deriveOccurrences.js (this module's own sibling) rather than
// re-deriving occurrences from template_slots a second time — a single call
// covering every template present in `templateSlots`, since deriveOccurrences
// already groups its output by template_id internally (confirmed against
// AssignmentPanel.jsx's own usage, which also calls it once).
import { describe, it, expect } from 'vitest'
import { deriveBundlePickerCells } from './deriveBundlePickerCells.js'

const SET_ID = 'set-1'
const DAYS = [
  { id: 'day-mon', name: 'Monday' },
  { id: 'day-tue', name: 'Tuesday' },
]
const TIME_BLOCKS = [
  { id: 'tb-2nd', name: 'Second Period' },
  { id: 'tb-3rd', name: 'Third Period' },
]
const GROUPS = [
  { id: 'grp-jr', tier_id: 'tier-jr' },
  { id: 'grp-sr', tier_id: 'tier-sr' },
]

function slot(overrides) {
  return { id: `slot-${Math.random()}`, elective_set_id: SET_ID, ...overrides }
}

describe('deriveBundlePickerCells', () => {
  it('returns one cell per distinct (day, time block) with both routes populated when they agree', () => {
    const templateSlots = [
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-2nd' }),
      slot({ template_id: 'tpl-generated', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-2nd' }),
    ]
    const scheduleTemplates = [
      { id: 'tpl-manual', kind: 'manual' },
      { id: 'tpl-generated', kind: 'generated' },
    ]

    const cells = deriveBundlePickerCells({
      templateSlots, scheduleTemplates, groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })

    expect(cells).toHaveLength(1)
    expect(cells[0]).toMatchObject({ day_id: 'day-mon', time_block_id: 'tb-2nd' })
    expect(cells[0].manual).toEqual(['tier-jr'])
    expect(cells[0].generated).toEqual(['tier-jr'])
  })

  it('a cell placed on only ONE route reports an empty array for the other — never fabricating agreement', () => {
    const templateSlots = [
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-2nd' }),
      slot({ template_id: 'tpl-generated', group_id: 'grp-jr', day_id: 'day-tue', time_block_id: 'tb-3rd' }),
    ]
    const scheduleTemplates = [
      { id: 'tpl-manual', kind: 'manual' },
      { id: 'tpl-generated', kind: 'generated' },
    ]

    const cells = deriveBundlePickerCells({
      templateSlots, scheduleTemplates, groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })

    expect(cells).toHaveLength(2)
    const manualOnly = cells.find((c) => c.day_id === 'day-mon')
    const generatedOnly = cells.find((c) => c.day_id === 'day-tue')
    expect(manualOnly.manual).toEqual(['tier-jr'])
    expect(manualOnly.generated).toEqual([])
    expect(generatedOnly.manual).toEqual([])
    expect(generatedOnly.generated).toEqual(['tier-jr'])
  })

  it('a cell serving two divisions carries both tier ids', () => {
    const templateSlots = [
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-2nd' }),
      slot({ template_id: 'tpl-manual', group_id: 'grp-sr', day_id: 'day-mon', time_block_id: 'tb-2nd' }),
    ]
    const scheduleTemplates = [{ id: 'tpl-manual', kind: 'manual' }]

    const cells = deriveBundlePickerCells({
      templateSlots, scheduleTemplates, groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })

    expect(cells).toHaveLength(1)
    expect([...cells[0].manual].sort()).toEqual(['tier-jr', 'tier-sr'])
  })

  it("sorts by the camp's own time-block order, then its own day order — not insertion order", () => {
    const templateSlots = [
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-tue', time_block_id: 'tb-3rd' }),
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-3rd' }),
      slot({ template_id: 'tpl-manual', group_id: 'grp-jr', day_id: 'day-tue', time_block_id: 'tb-2nd' }),
    ]
    const scheduleTemplates = [{ id: 'tpl-manual', kind: 'manual' }]

    const cells = deriveBundlePickerCells({
      templateSlots, scheduleTemplates, groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })

    expect(cells.map((c) => `${c.time_block_id}/${c.day_id}`)).toEqual([
      'tb-2nd/day-tue',
      'tb-3rd/day-mon',
      'tb-3rd/day-tue',
    ])
  })

  it('returns an empty array when this set is not placed on any schedule', () => {
    const cells = deriveBundlePickerCells({
      templateSlots: [], scheduleTemplates: [], groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })
    expect(cells).toEqual([])
  })

  it("ignores a different elective set's placements", () => {
    const templateSlots = [
      { id: 's1', template_id: 'tpl-manual', elective_set_id: 'other-set', group_id: 'grp-jr', day_id: 'day-mon', time_block_id: 'tb-2nd' },
    ]
    const scheduleTemplates = [{ id: 'tpl-manual', kind: 'manual' }]

    const cells = deriveBundlePickerCells({
      templateSlots, scheduleTemplates, groups: GROUPS, days: DAYS, timeBlocks: TIME_BLOCKS, electiveSetId: SET_ID,
    })
    expect(cells).toEqual([])
  })
})
