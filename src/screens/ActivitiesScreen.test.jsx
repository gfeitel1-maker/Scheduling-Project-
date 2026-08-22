// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    previewDelete: vi.fn(),
    deleteRecord: vi.fn(),
    listImportEvidence: vi.fn(),
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
import { deriveLocationId } from '../../electron/ops/locationId.js'

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
  localClient.listImportEvidence.mockReset().mockResolvedValue({ evidence: [], fieldSources: {} })
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
  it('imports rows from Excel, resolving age division names and skipping duplicates and rows with a warning', async () => {
    // Only the "Water Play" activity itself needs a randomUUID — the "Pool"
    // location it creates now mints a deterministic id via deriveLocationId
    // (T81), not crypto.randomUUID().
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-activity-id') })
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
    const derivedLocId = deriveLocationId(CAMP_ID, 'Pool')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', derivedLocId, 'name', 'Pool')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', derivedLocId)

    // D5 UI freeze: the import path never writes the free-text column either.
    expect(localClient.write.mock.calls.some(c => c[1] === 'activities' && c[3] === 'location')).toBe(false)
  })

  it('flags an import row whose age division name does not match any existing age division', async () => {
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
      { name: 'Ghost Activity', location: '', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: 'Nonexistent Age Division', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/Age Division\(s\) not found: nonexistent age division/)).not.toBeNull())
  })
})

// T81 (docs/work/tickets/T81-activities-template-importer-deterministic-location-ids.md):
// aligned to the M4 Host ingest pattern
// (docs/adr/2026-08-15-locations-import-export-roundtrip.md D1a) — resolve by
// EXACT trimmed name first, mint via deriveLocationId(campId, trimmedName)
// only when absent. Case-SENSITIVE: "Pool" and "pool" are two legitimate,
// mergeable rows (M3c), not one entity folded at create time. Supersedes the
// prior case-insensitive/randomUUID policy these tests used to pin.
describe('ActivitiesScreen — import location resolve is deterministic and case-sensitive (T81)', () => {
  it('mints a NEW row for an imported "pool" even though "Pool" already exists — no silent case-fold', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-activity-id') })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-Pool', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Swim', location: 'pool', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])
    await userEvent.upload(fileInput, file)
    await waitFor(() => expect(screen.queryByText(/Import 1/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 1/))
    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())

    // A distinct "pool" row is minted, case-sensitive, deterministic id.
    const derivedPoolId = deriveLocationId(CAMP_ID, 'pool')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', derivedPoolId, 'name', 'pool')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', derivedPoolId)
    // Never the pre-existing "Pool" row's id.
    expect(localClient.write.mock.calls.some(c => c[1] === 'activities' && c[3] === 'location_id' && c[4] === 'loc-Pool')).toBe(false)
  })

  it('reuses an existing exact-name "Pool" row on re-import — no duplicate is minted', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-activity-id') })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-Pool', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Swim', location: 'Pool', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])
    await userEvent.upload(fileInput, file)
    await waitFor(() => expect(screen.queryByText(/Import 1/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 1/))
    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())

    // No new location row: exact-name "Pool" reuses the existing row.
    expect(localClient.write.mock.calls.some(c => c[1] === 'locations' && c[3] === 'name')).toBe(false)
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'loc-Pool')
  })

  it('within one import, "Field" and "field" mint TWO distinct location rows (case-sensitive)', async () => {
    let n = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `id-${n++}`) })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Soccer', location: 'Field', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
      { name: 'Frisbee', location: 'field', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])
    await userEvent.upload(fileInput, file)
    await waitFor(() => expect(screen.queryByText(/Import 2/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))
    await waitFor(() => expect(screen.queryByText(/2 added/)).not.toBeNull())

    // Two distinct location rows, one per case variant.
    const locationNamesWritten = localClient.write.mock.calls.filter(c => c[1] === 'locations' && c[3] === 'name').map(c => c[4])
    expect(locationNamesWritten.sort()).toEqual(['Field', 'field'])
  })

  // T101 (docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md):
  // a location created earlier (id = deriveLocationId(campId, 'Pool')) may
  // since have been RENAMED — the row keeps its id, its name changes. A CSV
  // re-import of the original name must not silently overwrite the renamed
  // row; it must mint a distinct disambiguated row instead.
  it('T101: importing "Pool" after a rename to "Swimming Pool" mints a distinct row, never overwrites the renamed one', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-activity-id') })
    const renamedRowId = deriveLocationId(CAMP_ID, 'Pool') // the row's id is frozen at creation
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: renamedRowId, camp_id: CAMP_ID, name: 'Swimming Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Swim', location: 'Pool', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
    ])
    await userEvent.upload(fileInput, file)
    await waitFor(() => expect(screen.queryByText(/Import 1/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 1/))
    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())

    // A distinct disambiguated row is minted for "Pool" — never the renamed row's id.
    const disambiguatedId = `${renamedRowId}:2`
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', disambiguatedId, 'name', 'Pool')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', disambiguatedId)
    // The renamed row is never targeted by a locations write at all.
    expect(localClient.write.mock.calls.some(c => c[1] === 'locations' && c[2] === renamedRowId)).toBe(false)
  })

  it('cross-device determinism: the same CSV imported on two independent devices mints byte-identical location ids', async () => {
    // Two independent "devices" — separate localClient.write mocks, no shared
    // in-memory state — each importing the identical row from a blank camp.
    async function importOnOneDevice() {
      vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('new-activity-id') })
      localClient.list.mockReset().mockImplementation(entity => {
        if (entity === 'activities') return Promise.resolve([])
        if (entity === 'locations') return Promise.resolve([])
        return Promise.resolve([])
      })
      localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
      const { unmount } = render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
      await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())
      const file = new File(['dummy'], 'activities.xlsx')
      const fileInput = document.querySelector('input[type="file"]')
      XLSX.utils.sheet_to_json.mockReturnValue([
        { name: 'Swim', location: 'Pool Deck', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '' },
      ])
      await userEvent.upload(fileInput, file)
      await waitFor(() => expect(screen.queryByText(/Import 1/)).not.toBeNull())
      fireEvent.click(screen.getByText(/Import 1/))
      await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
      const locWrite = localClient.write.mock.calls.find(c => c[1] === 'locations' && c[3] === 'name')
      unmount()
      return locWrite[2] // entity_id minted for the location
    }

    const idOnDeviceA = await importOnOneDevice()
    const idOnDeviceB = await importOnOneDevice()

    expect(idOnDeviceA).toBe(idOnDeviceB)
    expect(idOnDeviceA).toBe(deriveLocationId(CAMP_ID, 'Pool Deck'))
  })
})

// The import preview must make location resolution visible BEFORE commit, and
// (T81) must agree with what confirmImport will actually do: resolution is
// now exact-name-only, so a case variant reads 'new', never a silent/annotated
// reuse — the preview's locNameByExact map uses the identical exact-trim key
// as confirmImport's own locationIdByName, so the two can't disagree.
describe('ActivitiesScreen — import preview shows new-vs-reused location', () => {
  async function uploadRows(rows, locations = []) {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve(locations)
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())
    const file = new File(['dummy'], 'activities.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue(rows)
    await userEvent.upload(fileInput, file)
    await waitFor(() => expect(screen.queryByText('Import Preview')).not.toBeNull())
  }
  const row = (over) => ({ name: 'Act', location: '', is_outdoor: '', max_groups_per_slot: '', min_per_week: '', max_per_week: '', same_tier_only: '', priority: '', eligible_tiers: '', prefer_before_day: '', prefer_before_day_min: '', weather_alternative: '', notes: '', ...over })

  it('flags a case-variant "pool" as a NEW location — no silent fold onto the existing "Pool" (T81)', async () => {
    await uploadRows([row({ name: 'Swim', location: 'pool' })], [{ id: 'loc-Pool', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
    expect(screen.queryByText(/new location/)).not.toBeNull()
    expect(screen.queryByText(/reuses/)).toBeNull()
  })

  it('flags a genuinely new location with a "new location" badge', async () => {
    await uploadRows([row({ name: 'Kayak', location: 'Lake' })], [])
    expect(screen.queryByText(/new location/)).not.toBeNull()
  })

  it('shows no annotation for an exact-case match — reuse is obvious', async () => {
    await uploadRows([row({ name: 'Swim', location: 'Pool' })], [{ id: 'loc-Pool', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
    expect(screen.queryByText(/reuses/)).toBeNull()
    expect(screen.queryByText(/new location/)).toBeNull()
  })
})

// M3b — the location picker (docs/work/specs/2026-08-15-m3-locations-design.md
// §picker) replacing the free-text Location input, and the D5 UI freeze it
// completes: the modal save path must write location_id and must never write
// the free-text activities.location column again.
describe('ActivitiesScreen — location picker (M3b)', () => {
  async function openAddModal() {
    fireEvent.click(screen.getByText('+ Add Activity'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a location…')).not.toBeNull())
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

  it('typeahead filters existing locations by case-insensitive substring, with a create row alongside a non-exact match', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Beit Midrash', capacity: 1, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'be' } })

    await waitFor(() => expect(screen.queryByText('Beit Midrash')).not.toBeNull())
    expect(screen.queryByText('Create "be" as a new location')).not.toBeNull()
  })

  it('selecting an existing location binds location_id and shows the selected token; save writes it', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Swim' } })
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))

    await waitFor(() => expect(screen.queryByText('· 3 groups at once')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'loc-1'))
    expect(localClient.write.mock.calls.some(c => c[3] === 'location')).toBe(false)
  })

  it('creating a new location from the picker creates a locations row and binds it immediately — before the activity is ever saved', async () => {
    // T81 round 2 (Red Hat): the picker's inline-create is an INTERACTIVE,
    // renameable create, exactly what
    // docs/adr/2026-08-15-locations-concurrent-create-collision.md option (d)
    // rejects deterministic ids for — stays crypto.randomUUID(), unchanged
    // from pre-T81. Only the CSV-template importer (confirmImport) moved to
    // deriveLocationId.
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
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Lake' } })
    fireEvent.mouseDown(screen.getByText('Create "Lake" as a new location'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'new-location-id', 'name', 'Lake'))
    expect(localClient.write.mock.calls.some(c => c[1] === 'activities')).toBe(false) // director never left the modal, activity not yet saved

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', 'new-location-id'))
  })

  it('clearing a selected location writes location_id: null on save', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Activity name'), { target: { value: 'Swim' } })
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))
    await waitFor(() => expect(screen.queryByLabelText('Clear')).not.toBeNull())

    fireEvent.click(screen.getByLabelText('Clear'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a location…')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Add Activity' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'new-activity-id', 'location_id', null))
  })
})

// Round-2 fix pass (panel findings C1-C5, docs/work/runs/2026-08-15-...):
// regressions + polish on the M3b picker.
describe('ActivitiesScreen — location picker round-2 polish (C1-C5)', () => {
  async function openAddModal() {
    fireEvent.click(screen.getByText('+ Add Activity'))
    await waitFor(() => expect(screen.queryByPlaceholderText('Search or add a location…')).not.toBeNull())
  }

  it('C3: labels the field "Location (optional)" and shows blank-is-fine helper text on the empty state', async () => {
    localClient.list.mockImplementation(() => Promise.resolve([]))
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    expect(screen.queryByText('Location (optional)')).not.toBeNull()
    expect(screen.queryByText('Leaving it blank is fine. Not every activity has a room.')).not.toBeNull()
  })

  it('C3: the blank-is-fine hint disappears once typing starts or a location is bound', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Po' } })
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
    expect(screen.getByPlaceholderText('Search or add a location…').getAttribute('maxLength')).toBe('60')
  })

  it('C2: a location picked from the existing list shows the plain capacity meta, not a stepper', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 3, notes: null }])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Pool' } })
    fireEvent.mouseDown(screen.getByText('Pool'))
    await waitFor(() => expect(screen.queryByText('· 3 groups at once')).not.toBeNull())
    expect(screen.queryByLabelText('Groups at once')).toBeNull()
  })

  it('C2: a location just created this session shows an in-place capacity stepper defaulting to 1, and adjusting it writes the new capacity', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('No activities yet')).not.toBeNull())

    await openAddModal()
    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Lake' } })
    fireEvent.mouseDown(screen.getByText('Create "Lake" as a new location'))
    await waitFor(() => expect(screen.queryByLabelText('Groups at once')).not.toBeNull())

    // The default (1) is unchanged — only an in-place way to adjust it is added.
    expect(screen.getByLabelText('Groups at once').value).toBe('1')

    // createLocation stays crypto.randomUUID()-based (unchanged from pre-T81)
    // — the default beforeEach stub returns 'new-activity-id' for every call.
    fireEvent.click(screen.getByLabelText('Increase'))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'new-activity-id', 'capacity', 2))
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

    fireEvent.focus(screen.getByPlaceholderText('Search or add a location…'))
    const popover = screen.getByText('Pool').closest('button').parentElement
    expect(popover.style.opacity).toBe('0')

    await act(async () => { await new Promise(r => requestAnimationFrame(r)) })
    expect(popover.style.opacity).toBe('1')
  })

  it('C5: editing an activity with a dangling location_id surfaces a warning instead of reading as empty', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity({ location_id: 'loc-ghost' })])
      if (entity === 'locations') return Promise.resolve([]) // the location is gone
      return Promise.resolve([])
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    await waitFor(() => expect(screen.queryByText('The location set here no longer exists — pick a new one.')).not.toBeNull())
    // The search box is shown (not a stale-looking selected token) so the
    // director can immediately pick a replacement.
    expect(screen.queryByPlaceholderText('Search or add a location…')).not.toBeNull()
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
    await waitFor(() => expect(screen.queryByText('The location set here no longer exists — pick a new one.')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-1', 'location_id', null))
  })
})

// Slice D (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §7) — row-level
// provenance dot + popover.
describe('ActivitiesScreen — rule provenance (Slice D)', () => {
  function evidenceRow(overrides = {}) {
    return {
      id: 'ev-1', camp_id: CAMP_ID, entity_type: 'activities', entity_id: 'act-1',
      field: 'min_per_week', tag: 'inferred', confidence: 'low', support: {},
      import_run_id: 'run-1', committed_at: '2026-08-01T00:00:00Z',
      ...overrides,
    }
  }

  it('shows no dot for a hand-created activity with no import_evidence at all', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({ evidence: [], fieldSources: { 'act-1': { min_per_week: null, max_per_week: null, eligible_group_ids: null, location_id: null } } })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    expect(screen.queryByRole('button', { name: /Provenance:/ })).toBeNull()
  })

  it('shows an inferred-tier dot when a field was imported without evidence, and worst tier wins over other fields', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [evidenceRow({ field: 'min_per_week', tag: 'observed', confidence: 'high', support: { occupied_days: 3, operating_days: 5 } })],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    // observed evidence tag but source==='import' -> tier 'observed', worst present.
    expect(screen.queryByRole('button', { name: /Provenance: observed, 1 of 3 fields need review/ })).not.toBeNull()
  })

  it('opens the popover with exactly 3 field rows, and Confirm re-writes the field then flips the row to confirmed in place', async () => {
    const act1 = activity({ min_per_week: 2, max_per_week: 4 })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([act1])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [evidenceRow({ field: 'min_per_week', tag: 'inferred', confidence: 'low', support: {} })],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Provenance:/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('Min–Max/Wk')).not.toBeNull()
    expect(within(dialog).queryByText('Eligible groups')).not.toBeNull()
    expect(within(dialog).queryByText('Location')).not.toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-1', 'min_per_week', 2))
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'activities', 'act-1', 'max_per_week', 4)

    // Popover stays open (no toast) — the row for min_per_week now reads Confirmed.
    await waitFor(() => expect(within(screen.getByRole('dialog')).queryAllByText('Confirmed').length).toBeGreaterThan(0))
  })

  it('Change opens the existing ActivityModal for that activity', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [evidenceRow()],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Provenance:/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Change' })[0])

    expect(screen.queryByText('Edit: Archery')).not.toBeNull()
  })

  it('reduced motion: the popover is present at full opacity with no transform on mount, no crash', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      localClient.list.mockImplementation(entity => {
        if (entity === 'activities') return Promise.resolve([activity()])
        return Promise.resolve([])
      })
      localClient.listImportEvidence.mockResolvedValue({
        evidence: [evidenceRow()],
        fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
      })
      render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
      await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

      fireEvent.click(screen.getByRole('button', { name: /Provenance:/ }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.style.transform).toBe('')
      await act(async () => { await new Promise(r => requestAnimationFrame(r)) })
      expect(dialog.style.opacity).toBe('1')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})

// Slice E (motion + depth pass) — confirm feedback, hover ring, tier shape.
describe('ActivitiesScreen — motion + depth pass (Slice E)', () => {
  function evidenceRow(overrides = {}) {
    return {
      id: 'ev-1', camp_id: CAMP_ID, entity_type: 'activities', entity_id: 'act-1',
      field: 'min_per_week', tag: 'inferred', confidence: 'low', support: {},
      import_run_id: 'run-1', committed_at: '2026-08-01T00:00:00Z',
      ...overrides,
    }
  }

  it('Confirm highlights the row, then the highlight self-clears after 700ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const act1 = activity({ min_per_week: 2, max_per_week: 4 })
      localClient.list.mockImplementation(entity => {
        if (entity === 'activities') return Promise.resolve([act1])
        return Promise.resolve([])
      })
      localClient.listImportEvidence.mockResolvedValue({
        evidence: [evidenceRow()],
        fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
      })
      render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
      await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

      const row = screen.getByText('Archery').closest('tr')
      expect(row.style.background).toBe('transparent')

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      await user.click(screen.getByRole('button', { name: /Provenance:/ }))
      const dialog = await screen.findByRole('dialog')
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))

      await waitFor(() => expect(row.style.background).toBe('color-mix(in srgb, var(--secondary) 10%, transparent)'))

      await vi.advanceTimersByTimeAsync(700)
      // The settle green is gone; clicking the in-row dot left the row hovered
      // (declarative hover → var(--bg)), so move the pointer off before
      // asserting the fully-cleared 'transparent' resting state.
      fireEvent.mouseLeave(row)
      await waitFor(() => expect(row.style.background).toBe('transparent'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('hovering a just-confirmed row does NOT cancel the settle highlight (review-fix regression)', async () => {
    const act1 = activity({ min_per_week: 2, max_per_week: 4 })
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([act1])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [evidenceRow()],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    const row = screen.getByText('Archery').closest('tr')
    await userEvent.click(screen.getByRole('button', { name: /Provenance:/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(row.style.background).toBe('color-mix(in srgb, var(--secondary) 10%, transparent)'))

    // Hovering the row while the settle is active must not overwrite the green.
    fireEvent.mouseEnter(row)
    expect(row.style.background).toBe('color-mix(in srgb, var(--secondary) 10%, transparent)')
    fireEvent.mouseLeave(row)
    expect(row.style.background).toBe('color-mix(in srgb, var(--secondary) 10%, transparent)')
  })

  it('reduced motion: the confirmed row has no background transition', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      localClient.list.mockImplementation(entity => {
        if (entity === 'activities') return Promise.resolve([activity()])
        return Promise.resolve([])
      })
      localClient.listImportEvidence.mockResolvedValue({
        evidence: [evidenceRow()],
        fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
      })
      render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
      await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

      const row = screen.getByText('Archery').closest('tr')
      expect(row.style.transition).toBe('none')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('tier shape: confirmed is a filled dot, observed is a ring, inferred is an outlined fill', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    // min_per_week: source 'import' + evidence tag 'inferred' -> tier inferred.
    // eligible_group_ids/location_id: source 'import' + evidence tag 'observed' -> tier observed.
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [
        evidenceRow({ field: 'min_per_week', tag: 'inferred', confidence: 'low', support: {} }),
        evidenceRow({ id: 'ev-2', field: 'location', tag: 'observed', confidence: 'high', support: {} }),
      ],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: 'import' } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Provenance:/ }))
    const dialog = await screen.findByRole('dialog')

    // Locate the small tier dots (6x6) rendered before each field label.
    const dots = dialog.querySelectorAll('span')
    const tierDots = Array.from(dots).filter(d => d.style.width === '6px' && d.style.height === '6px')
    expect(tierDots.length).toBe(3)

    // eligible_group_ids: source null -> confirmed -> filled solid, no border/box-shadow.
    const confirmedDot = tierDots.find(d => d.style.background === 'var(--secondary)')
    // location_id: observed -> ring, transparent fill, --primary border.
    const observedDot = tierDots.find(d => d.style.border && d.style.border.includes('var(--primary)'))
    // min_per_week: inferred -> outlined fill, --accent double box-shadow.
    const inferredDot = tierDots.find(d => d.style.boxShadow && d.style.boxShadow.includes('var(--accent)'))

    expect(confirmedDot).toBeTruthy()
    expect(observedDot).toBeTruthy()
    expect(inferredDot).toBeTruthy()
    expect(confirmedDot.style.borderStyle).toBe('none')
    expect(observedDot.style.background).toBe('transparent')
    expect(inferredDot.style.background).toBe('var(--accent)')
  })

  it('provenance dot shows a hover ring on mouse enter, and clears it on mouse leave', async () => {
    localClient.list.mockImplementation(entity => {
      if (entity === 'activities') return Promise.resolve([activity()])
      return Promise.resolve([])
    })
    localClient.listImportEvidence.mockResolvedValue({
      evidence: [evidenceRow()],
      fieldSources: { 'act-1': { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: null, location_id: null } },
    })
    render(<ActivitiesScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={null} weeks={[]} />)
    await waitFor(() => expect(screen.queryByText('Archery')).not.toBeNull())

    const dot = screen.getByRole('button', { name: /Provenance:/ })
    expect(dot.style.boxShadow).not.toContain('color-mix(in srgb, var(--text) 10%, transparent)')

    fireEvent.mouseEnter(dot)
    expect(dot.style.boxShadow).toBe('0 0 0 3px color-mix(in srgb, var(--text) 10%, transparent)')

    fireEvent.mouseLeave(dot)
    expect(dot.style.boxShadow).not.toBe('0 0 0 3px color-mix(in srgb, var(--text) 10%, transparent)')
  })
})
