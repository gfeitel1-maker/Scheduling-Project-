// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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
    location_id: null,
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
    expect(fieldsWritten.location_id).toBe(null)
    expect(fieldsWritten.location).toBeUndefined() // D5 UI freeze: quick-add never writes the free-text column
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
  it('shows a styled confirm modal (not window.confirm) before deleting, and confirming deletes', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' })])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all activities?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Activities'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'activities', 'a1'))
  })

  it('cancels without deleting', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' })])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all activities?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all activities?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

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
    await waitFor(() => expect(screen.queryByText('Delete all activities?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Activities'))

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
    await waitFor(() => expect(screen.queryByText('Delete all activities?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Activities'))

    await waitFor(() => expect(screen.queryByText(/Only an admin can delete activities/)).not.toBeNull())
  })

  it('surfaces an error banner when deleteAll fails unexpectedly instead of silently closing', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ id: 'a1' })])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    // Open the confirm modal, then make the re-fetch inside confirmDeleteAll
    // throw (e.g. the DB read fails). Without a catch the promise rejects
    // unhandled while the modal closes — it looks like success. It must
    // surface an error banner instead.
    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all activities?')).not.toBeNull())
    localClient.list.mockRejectedValue(new Error('disk failure'))
    fireEvent.click(screen.getByText('Delete All Activities'))

    await waitFor(() => expect(screen.queryByText(/Those activities could not be deleted/)).not.toBeNull())
  })
})

describe('ActivitiesScreen — import', () => {
  it('imports rows from Excel, resolving unit names and skipping duplicates and rows with a warning', async () => {
    // Two distinct ids needed: the location this import creates for "Pool"
    // (D5 UI freeze, extended to the import path — see confirmImport), then
    // the "Water Play" activity itself.
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-location-id').mockReturnValueOnce('new-activity-id') })
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
      { name: 'Water Play', location: 'Pool', is_outdoor: 'TRUE', max_groups_per_slot: 2, min_per_week: 1, max_per_week: 3, same_tier_only: 'FALSE', priority: 'high', eligible_tiers: 'Yeladim', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' }, // new, valid, location resolved+created
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    expect(screen.queryByText(/2 skipped/)).not.toBeNull()
    const activityNamesWritten = localClient.write.mock.calls.filter(c => c[1] === 'activities' && c[3] === 'name').map(c => c[4])
    expect(activityNamesWritten).toEqual(['Water Play'])
    const priorityWritten = localClient.write.mock.calls.filter(c => c[3] === 'priority').map(c => c[4])
    expect(priorityWritten).toEqual(['high'])

    // The sheet's free-text "Pool" resolved to a new locations row, created
    // before the activity that references it.
    const locationNamesWritten = localClient.write.mock.calls.filter(c => c[1] === 'locations' && c[3] === 'name').map(c => c[4])
    expect(locationNamesWritten).toEqual(['Pool'])
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'new-location-id')

    // D5 UI freeze: the import path never writes the free-text column either.
    expect(localClient.write.mock.calls.some(c => c[1] === 'activities' && c[3] === 'location')).toBe(false)
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

// M3b — the place picker (docs/work/specs/2026-08-15-m3-locations-design.md
// §picker) replacing the free-text Location input, and the D5 UI freeze it
// completes: the modal save path must write location_id and must never write
// the free-text activities.location column again.
describe('ActivitiesScreen — location picker (M3b)', () => {
  async function openAddModal() {
    fireEvent.click(screen.getByText('+ Add Activity'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a place…')).not.toBeNull())
  }

  it('D5: the modal save path writes location_id and never the free-text location column', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Archery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', null))
    expect(localClient.write.mock.calls.some(c => c[3] === 'location')).toBe(false)
  })

  it('typeahead filters existing places by case-insensitive substring, with a create row alongside a non-exact match', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Beit Midrash', capacity: 1, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'be' } })

    await waitFor(() => expect(screen.queryByText('Beit Midrash')).not.toBeNull())
    expect(screen.queryByText('Create "be" as a new place')).not.toBeNull()
  })

  it('selecting an existing place binds location_id and shows the selected token; save writes it', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Swim' } })
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))

    await waitFor(() => expect(screen.queryByText('· 3 groups at once')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'loc-1'))
    expect(localClient.write.mock.calls.some(c => c[3] === 'location')).toBe(false)
  })

  it('creating a new place from the picker creates a locations row and binds it immediately — before the activity is ever saved', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-location-id').mockReturnValueOnce('new-activity-id') })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Kayaking' } })
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Lake' } })
    fireEvent.mouseDown(screen.getByText('Create "Lake" as a new place'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'new-location-id', 'name', 'Lake'))
    expect(localClient.write.mock.calls.some(c => c[1] === 'activities')).toBe(false) // director never left the modal, activity not yet saved

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'new-location-id'))
  })

  it('clearing a selected place writes location_id: null on save', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Swim' } })
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))
    await waitFor(() => expect(screen.queryByLabelText('Clear')).not.toBeNull())

    fireEvent.click(screen.getByLabelText('Clear'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a place…')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', null))
  })
})

// Round-2 fix pass (panel findings C1-C5, docs/work/runs/2026-08-15-...):
// regressions + polish on the M3b picker.
describe('ActivitiesScreen — location picker round-2 polish (C1-C5)', () => {
  async function openAddModal() {
    fireEvent.click(screen.getByText('+ Add Activity'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a place…')).not.toBeNull())
  }

  it('C3: labels the field "Location (optional)" and shows blank-is-fine helper text on the empty state', async () => {
    localClient.list.mockImplementation(() => Promise.resolve([]))
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    expect(screen.queryByText('Location (optional)')).not.toBeNull()
    expect(screen.queryByText('Leaving it blank is fine. Not every activity has a room.')).not.toBeNull()
  })

  it('C3: the blank-is-fine hint disappears once typing starts or a place is bound', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Po' } })
    expect(screen.queryByText('Leaving it blank is fine. Not every activity has a room.')).toBeNull()

    fireEvent.mouseDown(screen.getByText('Pool'))
    await waitFor(() => expect(screen.queryByLabelText('Clear')).not.toBeNull())
    expect(screen.queryByText('Leaving it blank is fine. Not every activity has a room.')).toBeNull()
  })

  it('C4: the search input carries a reasonable maxLength', async () => {
    localClient.list.mockImplementation(() => Promise.resolve([]))
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    expect(screen.getByPlaceholderText('Search or add a place…').getAttribute('maxLength')).toBe('60')
  })

  it('C2: a place picked from the existing list shows the plain capacity meta, not a stepper', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))
    await waitFor(() => expect(screen.queryByText('· 3 groups at once')).not.toBeNull())
    expect(screen.queryByLabelText('Groups at once')).toBeNull()
  })

  it('C2: a place just created this session shows an in-place capacity stepper defaulting to 1, and adjusting it writes the new capacity', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-location-id').mockReturnValueOnce('new-activity-id') })
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a place…'), { target: { value: 'Lake' } })
    fireEvent.mouseDown(screen.getByText('Create "Lake" as a new place'))
    await waitFor(() => expect(screen.queryByLabelText('Groups at once')).not.toBeNull())

    // The default (1) is unchanged — only an in-place way to adjust it is added.
    expect(screen.getByLabelText('Groups at once').value).toBe('1')

    fireEvent.click(screen.getByLabelText('Increase'))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'new-location-id', 'capacity', 2))
  })

  it('C1: the popover mounts fresh (unentered) on open so popFade has a "from" frame to animate from', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())
    await openAddModal()

    // Let time pass after the field mounts (unfocused) — matching real usage,
    // where the director looks at other fields before clicking into Location.
    // Pre-fix, the popFade hook lived in the always-mounted LocationPicker, so
    // by now `entered` had already settled true and the popover's first frame
    // showed no "from" state at all.
    await act(async () => { await new Promise(r => requestAnimationFrame(r)) })

    fireEvent.focus(screen.getByPlaceholderText('Search or add a place…'))
    const popover = screen.getByText('Pool').closest('button').parentElement
    expect(popover.style.opacity).toBe('0')

    await act(async () => { await new Promise(r => requestAnimationFrame(r)) })
    expect(popover.style.opacity).toBe('1')
  })

  it('C5: editing an activity with a dangling location_id surfaces a warning instead of reading as empty', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ location_id: 'loc-ghost' })])
      if (entity === 'locations') return Promise.resolve([]) // the place is gone
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    await waitFor(() => expect(screen.queryByText('The place set here no longer exists — pick a new one.')).not.toBeNull())
    // The search box is shown (not a stale-looking selected token) so the
    // director can immediately pick a replacement.
    expect(screen.queryByPlaceholderText('Search or add a place…')).not.toBeNull()
  })

  it('C5: saving without re-picking a dangling location clears it rather than persisting the stale id', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ location_id: 'loc-ghost' })])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    await waitFor(() => expect(screen.queryByText('The place set here no longer exists — pick a new one.')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-1', 'location_id', null))
  })
})
