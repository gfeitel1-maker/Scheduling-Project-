// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    importSetupRows: vi.fn(),
    deleteEntity: vi.fn(),
  },
}))

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
  },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

vi.mock('../hooks/useCohorts', () => ({
  useCohorts: () => ({
    cohorts: [{ id: 'cohort-1', camp_id: 'camp-1', name: 'Session 1' }],
    activeCohort: { id: 'cohort-1', camp_id: 'camp-1', name: 'Session 1' },
    setActiveCohortId: () => {},
  }),
}))

vi.mock('../components/CohortPicker', () => ({
  default: () => null,
}))

import FixedEventsScreen from './FixedEventsScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'
const COHORT_ID = 'cohort-1'

// T377 (consistency audit 2026-10-12, A9): one row per event NAME. Storage stays one row per day, so
// an edit on the grouped row fans out to every day, a day can be edited alone, and delete asks
// whether to remove every day or one.
const days = [
  { id: 'd1', camp_id: CAMP_ID, label: 'Monday', day_of_week: 1, sort_order: 1 },
  { id: 'd2', camp_id: CAMP_ID, label: 'Tuesday', day_of_week: 2, sort_order: 2 },
  { id: 'd3', camp_id: CAMP_ID, label: 'Wednesday', day_of_week: 3, sort_order: 3 },
]
const blocks = [
  { id: 'block-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Morning', start_time: '09:00:00', end_time: '10:00:00', sort_order: 1 },
  { id: 'block-2', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Late', start_time: '11:00:00', end_time: '12:00:00', sort_order: 2 },
]
const ev = (id, day_id, o = {}) => ({ id, camp_id: CAMP_ID, cohort_id: COHORT_ID, kind: 'fixed', name: 'Lineup', day_id, time_block_id: 'block-1', is_all_groups: 1, unit_ids: [], group_ids: [], activity_id: 'act-1', schedule_week_id: null, location_id: null, ...o })

function setup(events = [ev('e1', 'd1'), ev('e2', 'd2'), ev('e3', 'd3')]) {
  localClient.list.mockImplementation((entity) => {
    if (entity === 'fixed_events') return Promise.resolve(events)
    if (entity === 'days_of_operation') return Promise.resolve(days)
    if (entity === 'time_blocks') return Promise.resolve(blocks)
    if (entity === 'activities') return Promise.resolve([{ id: 'act-1', camp_id: CAMP_ID, name: 'Lineup' }])
    return Promise.resolve([])
  })
  render(<FixedEventsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
}
const writesFor = (field) => localClient.write.mock.calls.filter((c) => c[3] === field).map((c) => [c[2], c[4]])
const pickBlock = (id) => { const sel = document.querySelector(`select option[value="${id}"]`).parentElement; fireEvent.change(sel, { target: { value: id } }) }

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'token-abc', setItem: () => {}, removeItem: () => {} })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('Fixed/Recurring Events grouped by name (T377)', () => {
  it('shows one row per event name with its days compacted, not one row per day', async () => {
    setup()
    await waitFor(() => expect(screen.queryByText('Mon–Wed')).not.toBeNull())
    expect(screen.getAllByRole('button', { name: 'Edit Lineup' })).toHaveLength(1)
  })

  it('shows "times vary" when the days have different time blocks', async () => {
    setup([ev('e1', 'd1'), ev('e2', 'd2', { time_block_id: 'block-2' })])
    await waitFor(() => expect(screen.queryByText('times vary')).not.toBeNull())
  })

  it('edit-all: a time change on the grouped row is written to every day', async () => {
    setup()
    await waitFor(() => expect(screen.queryByText('Mon–Wed')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lineup' }))
    await waitFor(() => expect(screen.queryByText('Save Changes')).not.toBeNull())
    pickBlock('block-2')
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(writesFor('time_block_id')).toHaveLength(3))
    expect(writesFor('time_block_id')).toEqual([['e1', 'block-2'], ['e2', 'block-2'], ['e3', 'block-2']])
    expect(writesFor('day_id')).toEqual([])
  })

  // Keeper: the grouping must respect each row's week. Edit-all never writes schedule_week_id, so a day
  // set to one week keeps it.
  it('edit-all leaves each day\'s week as it was', async () => {
    setup([ev('e1', 'd1'), ev('e2', 'd2', { schedule_week_id: 'w2' })])
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Lineup' })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lineup' }))
    await waitFor(() => expect(screen.queryByText('Save Changes')).not.toBeNull())
    pickBlock('block-2')
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(writesFor('time_block_id')).toHaveLength(2))
    expect(writesFor('schedule_week_id')).toEqual([])
  })

  it('edit-one: an expanded day is edited alone', async () => {
    setup()
    await waitFor(() => expect(screen.queryByText('Mon–Wed')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Show each day of Lineup' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lineup on Tuesday' }))
    await waitFor(() => expect(screen.queryByText('Save Changes')).not.toBeNull())
    pickBlock('block-2')
    fireEvent.click(screen.getByText('Save Changes'))
    await waitFor(() => expect(writesFor('time_block_id')).toEqual([['e2', 'block-2']]))
  })

  it('delete-one: deleting the grouped row can remove just one day', async () => {
    setup()
    await waitFor(() => expect(screen.queryByText('Mon–Wed')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Lineup' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Tuesday only' }))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(1))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'fixed_events', 'e2')
  })

  it('delete-all: deleting the grouped row can remove every day', async () => {
    setup()
    await waitFor(() => expect(screen.queryByText('Mon–Wed')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Lineup' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all 3 days' }))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(3))
    expect(localClient.deleteEntity.mock.calls.map((c) => c[2]).sort()).toEqual(['e1', 'e2', 'e3'])
  })
})
