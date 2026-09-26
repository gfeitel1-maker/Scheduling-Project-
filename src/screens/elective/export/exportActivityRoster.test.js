// F1 (round 2): fixtures rebuilt from the REAL producer shape — an outer row
// (electron/main.js getElectiveRunOuterScheduleHandler) carries only camperId, never camperName or
// groupId. Camper/group identity comes from a separate `campers` lookup (id, display_name,
// group_id — campers table shape), resolved the same way exportChildSchedule.js already does.
import { describe, it, expect } from 'vitest'
import { buildActivityRosterExport } from './exportActivityRoster.js'

describe('buildActivityRosterExport', () => {
  it('groups elective assignments by (day, time_block, activity) and lists members with group name', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [
        { id: 'c1', display_name: 'Camper A', group_id: 'group-1' },
        { id: 'c2', display_name: 'Camper B', group_id: 'group-1' },
      ],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        { camperId: 'c1', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: false },
        { camperId: 'c2', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: false },
      ],
      capacityRows: [{ occurrenceId: 'occ-1', activityId: 'act-1', filled: 5, capacity: 5 }],
      occurrences: [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }],
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ day: 'Monday', time_block: 'Period 1', activity_name: 'Archery', count: 2, capacity: 5 })
    expect(result[0].members).toEqual([
      { camper_id: 'c1', camper_name: 'Camper A', group_name: 'Bunk Alpha' },
      { camper_id: 'c2', camper_name: 'Camper B', group_name: 'Bunk Alpha' },
    ])
  })

  it('excludes inherited (non-elective) rows — the roster is who is ASSIGNED, not a template restatement', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [{ id: 'c1', display_name: 'Camper A', group_id: null }],
      groups: [], days: [{ id: 'day-1', name: 'Monday' }], timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        { camperId: 'c1', cellKind: 'inherited', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-2', activityName: 'Arts & Crafts', isLinkedChoice: false },
      ],
      capacityRows: [],
    })

    expect(result).toHaveLength(0)
  })

  it('a linked choice groups its members under the choice label as one roster row, not per-member-occurrence rows', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [{ id: 'c1', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }, { id: 'tb-3', name: 'Period 3' }],
      outerRows: [
        { camperId: 'c1', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: true, choiceId: 'ch-1', choiceLabel: 'Bundle' },
        { camperId: 'c1', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-3', activityId: 'act-3', activityName: 'Canoeing', isLinkedChoice: true, choiceId: 'ch-1', choiceLabel: 'Bundle' },
      ],
      capacityRows: [],
    })

    expect(result).toHaveLength(1)
    // F5 (round 2): count is the ASSIGNMENT grain (2 member occurrences), not the presentation
    // grain (members.length: 1 camper) — see exportElectiveRunProjection.test.js's exit-clause test.
    expect(result[0]).toMatchObject({ activity_name: 'Bundle', count: 2 })
    expect(result[0].members).toEqual([{ camper_id: 'c1', camper_name: 'Camper A', group_name: 'Bunk Alpha' }])
  })

  it('every assignment appears exactly once across the roster (count sums to total elective rows minus linked-choice collapsing)', () => {
    const outerRows = [
      { camperId: 'c1', cellKind: 'elective', dayId: 'd1', timeBlockId: 't1', activityId: 'a1', activityName: 'X', isLinkedChoice: false },
      { camperId: 'c2', cellKind: 'elective', dayId: 'd1', timeBlockId: 't1', activityId: 'a1', activityName: 'X', isLinkedChoice: false },
      { camperId: 'c3', cellKind: 'elective', dayId: 'd1', timeBlockId: 't2', activityId: 'a2', activityName: 'Y', isLinkedChoice: false },
    ]
    const campers = [
      { id: 'c1', display_name: 'A', group_id: null },
      { id: 'c2', display_name: 'B', group_id: null },
      { id: 'c3', display_name: 'C', group_id: null },
    ]
    const result = buildActivityRosterExport({ run: { id: 'run-1' }, campers, groups: [], days: [{id:'d1',name:'D1'}], timeBlocks: [{id:'t1',name:'T1'},{id:'t2',name:'T2'}], outerRows, capacityRows: [] })
    const totalMembers = result.reduce((sum, r) => sum + r.members.length, 0)
    expect(totalMembers).toBe(3)
  })

  it('a camper missing from the campers lookup resolves to null names, never a stale field read off the outer row', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [],
      groups: [],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        { camperId: 'ghost', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: false },
      ],
      capacityRows: [],
    })

    expect(result[0].members).toEqual([{ camper_id: 'ghost', camper_name: null, group_name: null }])
  })
})

describe('buildActivityRosterExport — F3: real capacityRows shape (no dayId/timeBlockId on the row)', () => {
  it('resolves per-cell capacity from overCapacityOccurrences via the occurrences lookup, not a nonexistent dayId/timeBlockId on the capacity row', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [{ id: 'c1', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        { camperId: 'c1', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: false },
      ],
      // The REAL shape (electron/main.js getElectiveRunHandler's overCapacityOccurrences): no
      // dayId/timeBlockId — only occurrenceId, activityId, filled, capacity.
      capacityRows: [{ occurrenceId: 'occ-1', activityId: 'act-1', filled: 7, capacity: 5 }],
      occurrences: [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }],
    })

    expect(result[0]).toMatchObject({ capacity: 5 })
  })

  it('leaves capacity null when no over-capacity occurrence resolves to this cell', () => {
    const result = buildActivityRosterExport({
      run: { id: 'run-1' },
      campers: [{ id: 'c1', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        { camperId: 'c1', cellKind: 'elective', dayId: 'day-1', timeBlockId: 'tb-1', activityId: 'act-1', activityName: 'Archery', isLinkedChoice: false },
      ],
      capacityRows: [],
      occurrences: [],
    })

    expect(result[0]).toMatchObject({ capacity: null })
  })
})
