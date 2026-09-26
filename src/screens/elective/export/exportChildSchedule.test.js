// T248 (docs/work/tickets/T248-child-schedule-export.md) — unit tests for the
// pure per-camper export shaping utility. No IPC here: the handler's rows
// (electron/main.js's getElectiveRunOuterScheduleHandler, camelCase) are
// passed in already loaded, mirroring exportElectiveRun.js's signature style.
//
// v76 (T197, docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4):
// format_version bumps 1 -> 2 for this file's own shape change (rows gain cell_kind, a linked
// choice collapses from N schedule entries to 1). exportScheduleJson.js's SEPARATE contract is
// untouched by this bump.
import { describe, it, expect } from 'vitest'
import { buildChildScheduleExport } from './exportChildSchedule.js'

describe('buildChildScheduleExport', () => {
  it('produces format_version 2 with cell_kind on each schedule entry', () => {
    const result = buildChildScheduleExport({
      run: { id: 'run-1', name: 'Week 1 electives', status: 'final' },
      campers: [{ id: 'camper-a', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        {
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-1', cellKind: 'elective',
          activityName: 'Archery', locationName: 'Field', spanBlocks: 1, isLinkedChoice: false,
        },
      ],
      generatedAt: '2026-09-25T00:00:00.000Z',
    })

    expect(result).toEqual({
      format_version: 2,
      run_id: 'run-1',
      run_name: 'Week 1 electives',
      run_status: 'final',
      generated_at: '2026-09-25T00:00:00.000Z',
      campers: [
        {
          camper_id: 'camper-a',
          display_name: 'Camper A',
          group_name: 'Bunk Alpha',
          schedule: [
            {
              kind: 'span', day: 'Monday', time_block: 'Period 1', cell_kind: 'elective',
              activity_name: 'Archery', location_name: 'Field', span_blocks: 1,
            },
          ],
        },
      ],
    })
  })

  it('collapses a multi-block activity into ONE row with span_blocks set, not one row per block', () => {
    const result = buildChildScheduleExport({
      run: { id: 'run-1', name: 'Week 1', status: 'draft' },
      campers: [{ id: 'camper-a', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        {
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-1', cellKind: 'inherited',
          activityName: 'Swim', locationName: 'Lake', spanBlocks: 3, isLinkedChoice: false,
        },
      ],
      generatedAt: '2026-09-25T00:00:00.000Z',
    })

    expect(result.campers[0].schedule).toHaveLength(1)
    expect(result.campers[0].schedule[0].span_blocks).toBe(3)
  })

  it('includes a camper with no outer rows as an empty schedule', () => {
    const result = buildChildScheduleExport({
      run: { id: 'run-1', name: 'Week 1', status: 'draft' },
      campers: [{ id: 'camper-a', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [],
      timeBlocks: [],
      outerRows: [],
      generatedAt: '2026-09-25T00:00:00.000Z',
    })

    expect(result.campers).toEqual([
      { camper_id: 'camper-a', display_name: 'Camper A', group_name: 'Bunk Alpha', schedule: [] },
    ])
  })

  it('a linked elective choice renders as ONE unit, not N separate schedule entries', () => {
    const result = buildChildScheduleExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final' },
      campers: [{ id: 'camper-a', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }, { id: 'tb-3', name: 'Period 3' }],
      outerRows: [
        {
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-1', cellKind: 'elective',
          activityName: 'Archery', locationName: 'Field', spanBlocks: 1,
          isLinkedChoice: true, choiceId: 'ch-1', choiceLabel: 'Bundle',
        },
        {
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-3', cellKind: 'elective',
          activityName: 'Canoeing', locationName: 'Lake', spanBlocks: 1,
          isLinkedChoice: true, choiceId: 'ch-1', choiceLabel: 'Bundle',
        },
      ],
      generatedAt: '2026-09-25T00:00:00.000Z',
    })

    const schedule = result.campers[0].schedule
    expect(schedule).toHaveLength(1)
    expect(schedule[0]).toMatchObject({ kind: 'linked_choice', label: 'Bundle' })
    expect(schedule[0].memberRows).toHaveLength(2)
  })
})
