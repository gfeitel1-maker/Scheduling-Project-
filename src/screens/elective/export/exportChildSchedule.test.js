// T248 (docs/work/tickets/T248-child-schedule-export.md) — unit tests for the
// pure per-camper export shaping utility. No IPC here: the handler's rows
// (electron/main.js's getElectiveRunOuterScheduleHandler, camelCase) are
// passed in already loaded, mirroring exportElectiveRun.js's signature style.
import { describe, it, expect } from 'vitest'
import { buildChildScheduleExport } from './exportChildSchedule.js'

describe('buildChildScheduleExport', () => {
  it('produces format_version 1 with the ADR shape', () => {
    const result = buildChildScheduleExport({
      run: { id: 'run-1', name: 'Week 1 electives', status: 'final' },
      campers: [{ id: 'camper-a', display_name: 'Camper A', group_id: 'group-1' }],
      groups: [{ id: 'group-1', name: 'Bunk Alpha' }],
      days: [{ id: 'day-1', name: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 1' }],
      outerRows: [
        {
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-1',
          activityName: 'Archery', locationName: 'Field', spanBlocks: 1,
        },
      ],
      generatedAt: '2026-09-25T00:00:00.000Z',
    })

    expect(result).toEqual({
      format_version: 1,
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
            { day: 'Monday', time_block: 'Period 1', activity_name: 'Archery', location_name: 'Field', span_blocks: 1 },
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
          camperId: 'camper-a', dayId: 'day-1', timeBlockId: 'tb-1',
          activityName: 'Swim', locationName: 'Lake', spanBlocks: 3,
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
})
