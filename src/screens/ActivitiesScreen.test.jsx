// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    previewDelete: vi.fn(),
    deleteRecord: vi.fn(),
  },
}))

vi.mock('../data/scheduleRepository', () => ({
  createScheduleRepository: () => ({
    loadWeekExclusions: vi.fn().mockResolvedValue({ activityExclusions: [] }),
    toggleActivityExclusion: vi.fn(),
  }),
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

import ActivitiesScreen from './ActivitiesScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'

function activity(overrides = {}) {
  return {
    id: 'act-1',
    camp_id: CAMP_ID,
    name: 'Archery',
    location: null,
    is_outdoor: 0,
    max_groups_per_slot: 1,
    min_per_week: 0,
    max_per_week: 5,
    span_blocks: 1,
    same_tier_only: 0,
    priority: 'low',
    eligible_tier_ids: '[]',
    eligible_group_ids: '[]',
    prefer_before_day: null,
    prefer_before_day_min: null,
    weather_alternative_id: null,
    notes: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-activity-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation(entity => {
    if (entity === 'activities') return Promise.resolve([])
    if (entity === 'tiers') return Promise.resolve([])
    if (entity === 'groups') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue({
    ok: true, entity: 'activities', entity_id: 'act-1', name: 'Archery',
    destructive: true, slot_count: 0, routes: [], unprotected_count: 0,
    anchor_count: 0, overlay_count: 0, weather_dependent_count: 0,
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
})

describe('ActivitiesScreen quick-add', () => {
  it('appends a name-only activity with normalizeActivity-matching defaults', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('0 activities')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Activity name (e.g. Archery)'), { target: { value: 'Archery' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fieldsWritten = Object.fromEntries(
      localClient.write.mock.calls.map(c => [c[3], c[4]])
    )
    expect(fieldsWritten.name).toBe('Archery')
    expect(fieldsWritten.camp_id).toBe(CAMP_ID)
    expect(fieldsWritten.location).toBe(null)
    expect(fieldsWritten.is_outdoor).toBe(0) // serialized boolean, matches normalizeActivity's is_outdoor fallback of false
    expect(fieldsWritten.max_groups_per_slot).toBe(1)
    expect(fieldsWritten.min_per_week).toBe(0)
    expect(fieldsWritten.max_per_week).toBe(5)
    expect(fieldsWritten.span_blocks).toBe(1)
    expect(fieldsWritten.same_tier_only).toBe(0)
    expect(fieldsWritten.priority).toBe('low')
    expect(fieldsWritten.eligible_tier_ids).toBe('[]')
    expect(fieldsWritten.eligible_group_ids).toBe('[]')
    expect(fieldsWritten.prefer_before_day).toBe(null)
    expect(fieldsWritten.prefer_before_day_min).toBe(null)
    expect(fieldsWritten.weather_alternative_id).toBe(null)
    expect(fieldsWritten.notes).toBe(null)

    // name written first, matching the create-path convention used across
    // TiersScreen/TimeBlocksScreen/GroupsScreen (UNIQUE collision fails atomically)
    expect(localClient.write.mock.calls[0][3]).toBe('name')
  })

  it('rejects a duplicate name (case-insensitive) without writing', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ name: 'Archery' })])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Activity name (e.g. Archery)'), { target: { value: 'archery' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() =>
      expect(screen.queryByText(/An activity with this name already exists/)).not.toBeNull()
    )
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('compensating-deletes the partially-created row when a later field write fails', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (field === 'camp_id') return Promise.reject(new Error('write failed'))
      return Promise.resolve({ status: 'applied' })
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('0 activities')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Activity name (e.g. Archery)'), { target: { value: 'Archery' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id'))
  })
})

describe('ActivitiesScreen — delete all', () => {
  it('re-fetches activities immediately before deleting, then reports partial failure', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' }), activity({ id: 'a2', name: 'Swim' })])
      return Promise.resolve([])
    })
    localClient.deleteEntity.mockImplementation((token, entity, id) => {
      if (id === 'a2') return Promise.reject(new Error('boom'))
      return Promise.resolve({ status: 'applied' })
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(screen.queryByText(/Deleted 1 of 2 activities/)).not.toBeNull())
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'activities', 'a1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'activities', 'a2')
  })

  it('shows an admin-specific message when every delete fails due to role', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' })])
      return Promise.resolve([])
    })
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(screen.queryByText(/Only an admin can delete activities/)).not.toBeNull())
  })

  it('surfaces an error banner when deleteAll fails unexpectedly instead of silently closing', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' })])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    // The re-fetch inside deleteAll throws (e.g. the DB read fails). Without a
    // catch the promise rejects unhandled while the confirm has already closed —
    // it looks like success. It must surface an error banner instead.
    localClient.list.mockRejectedValue(new Error('disk failure'))
    fireEvent.click(screen.getByText('Delete All'))

    await waitFor(() => expect(screen.queryByText(/Those activities could not be deleted/)).not.toBeNull())
  })
})

describe('ActivitiesScreen — import', () => {
  it('imports rows from Excel, resolving unit names and skipping duplicates and rows with a warning', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1', name: 'Archery' })])
      if (entity === 'tiers') return Promise.resolve([{ id: 'tier-1', camp_id: CAMP_ID, name: 'Yeladim' }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'archery', location: '', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: 'Yeladim', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' }, // duplicate, case-insensitive
      { name: '', location: '', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' }, // missing name -> warning
      { name: 'Water Play', location: 'Pool', is_outdoor: 'TRUE', max_groups_per_slot: 2, min_per_week: 1, max_per_week: 3, same_tier_only: 'FALSE', priority: 'high', eligible_tiers: 'Yeladim', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' }, // new, valid
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const namesWritten = localClient.write.mock.calls.filter(c => c[3] === 'name').map(c => c[4])
    expect(namesWritten).toEqual(['Water Play'])
    const priorityWritten = localClient.write.mock.calls.filter(c => c[3] === 'priority').map(c => c[4])
    expect(priorityWritten).toEqual(['high'])
  })

  it('flags an import row whose unit name does not match any existing unit', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'tiers') return Promise.resolve([{ id: 'tier-1', camp_id: CAMP_ID, name: 'Yeladim' }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')

    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Ghost Activity', location: '', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: 'Nonexistent Unit', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/Unit\(s\) not found: nonexistent unit/)).not.toBeNull())
  })
})
