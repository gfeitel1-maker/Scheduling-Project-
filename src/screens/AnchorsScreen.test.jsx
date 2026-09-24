// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
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

import AnchorsScreen from './AnchorsScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'
const COHORT_ID = 'cohort-1'

function day(overrides = {}) {
  return { id: 'day-1', camp_id: CAMP_ID, label: 'Monday', day_of_week: 1, sort_order: 1, ...overrides }
}
function block(overrides = {}) {
  return { id: 'block-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Morning', start_time: '09:00:00', end_time: '10:00:00', sort_order: 1, ...overrides }
}

let idCounter
beforeEach(() => {
  idCounter = 0
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => `new-anchor-id-${idCounter++}` })
  vi.spyOn(window, 'confirm').mockReset().mockReturnValue(true)
  vi.spyOn(console, 'error').mockReset().mockImplementation(() => {})
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('AnchorsScreen fan-out-per-day creation', () => {
  it('creating one anchor across 3 selected days produces 3 rows with distinct ids and day_ids, same name', async () => {
    const days = [
      day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 }),
      day({ id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 2 }),
      day({ id: 'd3', label: 'Wednesday', day_of_week: 3, sort_order: 3 }),
    ]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve(days)
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Fixed Event'))

    fireEvent.change(screen.getByPlaceholderText('e.g. Mifkad, Lunch, Swim'), { target: { value: 'Mifkad' } })
    fireEvent.click(screen.getByText('Monday'))
    fireEvent.click(screen.getByText('Tuesday'))
    fireEvent.click(screen.getByText('Wednesday'))
    fireEvent.change(screen.getByDisplayValue('— Select block —'), { target: { value: 'block-1' } })

    fireEvent.click(screen.getByText('Add Fixed Event (×3)'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    await waitFor(() => {
      const nameCalls = localClient.write.mock.calls.filter(c => c[3] === 'name')
      expect(nameCalls.length).toBe(3)
    })

    const idCalls = localClient.write.mock.calls.filter(c => c[3] === 'name')
    const ids = idCalls.map(c => c[2])
    expect(new Set(ids).size).toBe(3)
    ids.forEach(id => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'anchor_activities', id, 'name', 'Mifkad'))

    const dayIdCalls = localClient.write.mock.calls.filter(c => c[3] === 'day_id')
    const dayIds = dayIdCalls.map(c => c[4]).sort()
    expect(dayIds).toEqual(['d1', 'd2', 'd3'])

    // Each id maps to exactly one day_id write, and the id set for day_id writes
    // matches the id set for name writes (same 3 rows, fully written).
    const dayIdIds = dayIdCalls.map(c => c[2]).sort()
    expect(dayIdIds).toEqual([...ids].sort())
  })

  it('selected day pill routes its fill/text through S.chip, not a hardcoded #fff', async () => {
    const days = [
      day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 }),
      day({ id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 2 }),
    ]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve(days)
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Fixed Event'))
    fireEvent.click(screen.getByText('Monday'))

    const selectedLabel = screen.getByText('Monday').closest('label')
    const unselectedLabel = screen.getByText('Tuesday').closest('label')
    expect(selectedLabel.style.background).toBe('var(--primary)')
    expect(selectedLabel.style.color).toBe('rgb(255, 255, 255)')
    expect(unselectedLabel.style.background).toBe('var(--surface)')
    expect(unselectedLabel.style.color).toBe('var(--text)')
  })
})

// Slice 2 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md):
// per-anchor "which weeks" control writing schedule_week_id. Default "All
// weeks" (NULL, today's implicit meaning) — picking a specific week writes
// that week's id.
describe('AnchorsScreen — which weeks control (schedule_week_id)', () => {
  const weeks = [
    { id: 'week-1', camp_id: CAMP_ID, name: 'Week 1', sort_order: 1 },
    { id: 'week-2', camp_id: CAMP_ID, name: 'Week 2', sort_order: 2 },
  ]
  const anchorRow = {
    id: 'anc-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Mifkad',
    day_id: 'd1', time_block_id: 'block-1', is_all_groups: 1, group_ids: '[]', kind: 'fixed',
    notes: null, schedule_week_id: null,
  }

  function mockList(anchors = [anchorRow]) {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve(anchors)
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1' })])
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      if (entity === 'schedule_weeks') return Promise.resolve(weeks)
      return Promise.resolve([])
    })
  }

  it('defaults an anchor with schedule_week_id NULL to "All weeks"', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())
    expect(screen.getByDisplayValue('All weeks')).not.toBeNull()
  })

  it('picking a specific week writes schedule_week_id for that anchor', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.change(screen.getByDisplayValue('All weeks'), { target: { value: 'week-2' } })

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'anchor_activities', 'anc-1', 'schedule_week_id', 'week-2'
    ))
  })

  it('an anchor already bound to a week shows that week selected, not "All weeks"', async () => {
    mockList([{ ...anchorRow, schedule_week_id: 'week-1' }])
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())
    expect(screen.getByDisplayValue('Week 1')).not.toBeNull()
  })

  it('picking "All weeks" on a week-bound anchor writes schedule_week_id back to null', async () => {
    mockList([{ ...anchorRow, schedule_week_id: 'week-1' }])
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.change(screen.getByDisplayValue('Week 1'), { target: { value: '' } })

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'anchor_activities', 'anc-1', 'schedule_week_id', null
    ))
  })

  it('has no visible Edit button', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('Enter on a focused row opens the edit modal', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    const row = screen.getByRole('button', { name: 'Edit Mifkad' })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.queryByText('Edit: Mifkad')).not.toBeNull()
  })

  it('changing the week select does not open the edit modal', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.change(screen.getByDisplayValue('All weeks'), { target: { value: 'week-2' } })

    expect(screen.queryByText('Edit: Mifkad')).toBeNull()
  })

  it('clicking Delete does not open the edit modal', async () => {
    mockList()
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Delete "Mifkad"?')).not.toBeNull())
    expect(screen.queryByText('Edit: Mifkad')).toBeNull()
  })
})

// W7b (docs/work/specs/camp-setup-ingestion-program.md): location_id picker
// on the recurring-event modal, mirroring ActivitiesScreen's LocationPicker.
describe('AnchorsScreen — location picker (location_id)', () => {
  const locations = [
    { id: 'loc-1', camp_id: CAMP_ID, name: 'Pool Deck', capacity: 2, notes: null },
  ]
  const anchorRow = {
    id: 'anc-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Swim',
    day_id: 'd1', time_block_id: 'block-1', is_all_groups: 1, group_ids: '[]', kind: 'fixed',
    notes: null, schedule_week_id: null, location_id: null,
  }

  function mockList(anchors, locs = locations) {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve(anchors)
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1' })])
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      if (entity === 'schedule_weeks') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve(locs)
      return Promise.resolve([])
    })
  }

  it('selecting a location in the Edit modal writes location_id', async () => {
    mockList([anchorRow])
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Swim' }))
    await waitFor(() => expect(screen.getByPlaceholderText("Search your camp's locations…")).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText("Search your camp's locations…"), { target: { value: 'Pool' } })
    fireEvent.mouseDown(await screen.findByText('Pool Deck'))

    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'anchor_activities', 'anc-1', 'location_id', 'loc-1'
    ))
  })

  it('a location_id pointing at a deleted location is nulled out on save (C5 dangling guard)', async () => {
    mockList([{ ...anchorRow, location_id: 'stale-loc' }], locations)
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Swim' }))
    await waitFor(() => expect(screen.getByText('The location set here no longer exists — pick a new one.')).not.toBeNull())

    fireEvent.click(screen.getByText('Save Changes'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'anchor_activities', 'anc-1', 'location_id', null
    ))
  })
})

describe('AnchorsScreen cleanup-failure surfacing', () => {
  it('shows a distinct honest error when a mid-fan-out write fails and rollback is refused (non-admin)', async () => {
    const days = [
      day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 }),
      day({ id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 2 }),
    ]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve(days)
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })

    // First row's writes succeed; second row's "name" write fails, triggering
    // rollback of both created rows. Rollback itself is then refused (as it
    // would be for a non-admin, since delete routes through the admin-gated
    // DELETE_FIELD path in electron/main.js).
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (id === 'new-anchor-id-1' && field === 'name') {
        return Promise.reject(new Error('write failed for field "name"'))
      }
      return Promise.resolve({ status: 'applied' })
    })
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Fixed Event'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Mifkad, Lunch, Swim'), { target: { value: 'Mifkad' } })
    fireEvent.click(screen.getByText('Monday'))
    fireEvent.click(screen.getByText('Tuesday'))
    fireEvent.change(screen.getByDisplayValue('— Select block —'), { target: { value: 'block-1' } })

    fireEvent.click(screen.getByText('Add Fixed Event (×2)'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalled())

    await waitFor(() => {
      expect(screen.queryAllByText(/couldn't be fully rolled back \(admin required\)/i).length).toBeGreaterThan(0)
    })
    // The old generic message must NOT be shown — it falsely implies nothing happened.
    expect(screen.queryByText('Failed to save — check your connection and try again')).toBeNull()
  })
})

// Characterization tests pinning the CURRENT write/serialize/delete-all
// behavior before the setupCrudRepository migration. They must stay green,
// unedited, against both the pre- and post-migration screen. See
// docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md (Anchors/Cohorts
// follow-up).
describe('AnchorsScreen write serialization (characterization)', () => {
  it('serializes is_all_groups to a number and group_ids to a JSON string on write', async () => {
    const days = [day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 })]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve(days)
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Fixed Event'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Mifkad, Lunch, Swim'), { target: { value: 'Mifkad' } })
    fireEvent.click(screen.getByText('Monday'))
    fireEvent.change(screen.getByDisplayValue('— Select block —'), { target: { value: 'block-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Fixed Event' }))

    await waitFor(() => {
      const allGroupsCall = localClient.write.mock.calls.find(c => c[3] === 'is_all_groups')
      expect(allGroupsCall).toBeTruthy()
      // Boolean true is serialized to the number 1, never the raw boolean.
      expect(allGroupsCall[4]).toBe(1)
    })
    const groupIdsCall = localClient.write.mock.calls.find(c => c[3] === 'group_ids')
    expect(groupIdsCall).toBeTruthy()
    // Array is serialized to a JSON string, never the raw array.
    expect(groupIdsCall[4]).toBe('[]')
  })
})

describe('AnchorsScreen deleteAll (characterization)', () => {
  function existing(overrides = {}) {
    return {
      id: 'anchor-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Mifkad',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 1, group_ids: null, kind: 'fixed',
      ...overrides,
    }
  }

  it('shows a styled confirm modal (not window.confirm) before deleting, and confirming deletes', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities' ? [existing()] : [])
    )
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all fixed events?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Fixed Events'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'anchor_activities', 'anchor-1'))
  })

  it('cancels without deleting', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities' ? [existing()] : [])
    )
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all fixed events?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all fixed events?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('re-fetches immediately before deleting and deletes every camp+cohort-scoped row, catching rows synced in after load', async () => {
    // Initial load sees only anchor-1.
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities' ? [existing()] : [])
    )
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    // Another device synced in anchor-2 between load and the click.
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities'
        ? [existing(), existing({ id: 'anchor-2', name: 'Second' })]
        : [])
    )
    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all fixed events?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Fixed Events'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'anchor_activities', 'anchor-2'))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'anchor_activities', 'anchor-1')
  })

  it('surfaces a partial-failure count rather than silently succeeding or aborting', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities'
        ? [existing({ id: 'a1' }), existing({ id: 'a2', name: 'Second' })]
        : [])
    )
    localClient.deleteEntity.mockImplementation((token, entity, id) => {
      if (id === 'a1') return Promise.resolve({ status: 'applied' })
      return Promise.reject(new Error('boom'))
    })
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all fixed events?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Fixed Events'))

    await waitFor(() =>
      expect(screen.queryByText('Deleted 1 of 2 fixed events — please try again for the rest.')).not.toBeNull()
    )
  })

  it('shows an admin-specific message when every delete is refused for role', async () => {
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'anchor_activities'
        ? [existing({ id: 'a1' }), existing({ id: 'a2', name: 'Second' })]
        : [])
    )
    localClient.deleteEntity.mockRejectedValue(new Error('admin role required'))
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all fixed events?')).not.toBeNull())
    fireEvent.click(screen.getByText('Delete All Fixed Events'))

    await waitFor(() =>
      expect(screen.queryByText('Only an admin can delete fixed events — no fixed events were deleted.')).not.toBeNull()
    )
  })
})

describe('AnchorsScreen delete confirmation', () => {
  function existingAnchor(overrides = {}) {
    return {
      id: 'anchor-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Mifkad',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 1, group_ids: null, kind: 'fixed',
      ...overrides,
    }
  }

  function setupList() {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([existingAnchor()])
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1' })])
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
  }

  it('shows a styled confirm modal (not window.confirm) with the specified copy before deleting', async () => {
    setupList()
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete "Mifkad"?')).not.toBeNull())
    expect(screen.queryByText('This fixed event will be removed from your schedules.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete Fixed Event'))
    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'anchor_activities', 'anchor-1'))
  })

  it('cancels without deleting', async () => {
    setupList()
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Mifkad"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Mifkad"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })
})

describe('AnchorsScreen — caution and error banners use shared primitives', () => {
  it('shows the no-time-blocks caution through the shared bronze --accent primitive, not hardcoded amber', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'days_of_operation') return Promise.resolve([day()])
      return Promise.resolve([])
    })
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)

    const banner = await waitFor(() => screen.getByText(/No time blocks found\./))
    expect(banner.style.background).toMatch(/var\(--accent\)/)
    expect(banner.style.background).not.toMatch(/#FFF8E7/i)
  })

  it('shows a save failure through the shared danger error primitive, not hardcoded red', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1' })])
      if (entity === 'time_blocks') return Promise.resolve([block()])
      return Promise.resolve([])
    })
    localClient.write.mockRejectedValue(new Error('disk failure'))
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Fixed Event'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Mifkad, Lunch, Swim'), { target: { value: 'Mifkad' } })
    fireEvent.click(screen.getByText('Monday'))
    fireEvent.change(screen.getByDisplayValue('— Select block —'), { target: { value: 'block-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Fixed Event' }))

    const banner = await waitFor(() => screen.getByText(/Your changes could not be saved/))
    expect(banner.style.background).toMatch(/var\(--danger\)/)
    expect(banner.style.background).not.toMatch(/#fff5f5/i)
  })
})

// ── T180: division scope is stored, not snapshotted ───────────────────────────

describe('AnchorsScreen — recurring event division scope (T180)', () => {
  const days = [day({ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 1 })]
  const tiers = [
    { id: 't1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Juniors', sort_order: 0 },
    { id: 't2', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Seniors', sort_order: 1 },
  ]
  const groups = [
    { id: 'g1', camp_id: CAMP_ID, name: 'Aleph', tier_id: 't1' },
    { id: 'g2', camp_id: CAMP_ID, name: 'Bet', tier_id: 't2' },
  ]

  function mount(anchors = []) {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'anchor_activities') return Promise.resolve(anchors)
      if (entity === 'days_of_operation') return Promise.resolve(days)
      if (entity === 'time_blocks') return Promise.resolve([block()])
      if (entity === 'tiers') return Promise.resolve(tiers)
      if (entity === 'groups') return Promise.resolve(groups)
      return Promise.resolve([])
    })
    return render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="recurring" />)
  }

  it('writes the chosen divisions as unit_ids, so scope resolves live', async () => {
    mount()
    await waitFor(() => expect(screen.queryByText('No recurring events yet')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Add Recurring Event'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Mifkad, Lunch, Swim'), { target: { value: 'Swim' } })
    fireEvent.click(screen.getByText('Monday'))
    fireEvent.click(screen.getByText('Juniors'))
    fireEvent.change(screen.getByDisplayValue('— Select block —'), { target: { value: 'block-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Recurring Event' }))

    await waitFor(() => {
      const call = localClient.write.mock.calls.find(c => c[3] === 'unit_ids')
      expect(call).toBeTruthy()
      // Serialized like group_ids — a JSON string, never a raw array.
      expect(call[4]).toBe(JSON.stringify(['t1']))
    })
  })

  it('shows the stored division, not one reverse-derived from group_ids', async () => {
    // The defect shape: a snapshot that covers ONE group of a two-group
    // division used to render as the whole division. With unit_ids stored,
    // the label reads what the row actually says.
    mount([{
      id: 'a1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Swim',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 0,
      group_ids: '[]', unit_ids: JSON.stringify(['t2']), kind: 'recurring',
    }])
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())
    expect(screen.queryByText('Seniors')).not.toBeNull()
    expect(screen.queryByText('Juniors')).toBeNull()
  })

  it('a legacy group_ids-only row still reads as the division it covers', async () => {
    // Pre-v65 rows carry no unit_ids; the backwards derivation stays as the
    // fallback for them ONLY, so nothing already on disk starts showing "—".
    mount([{
      id: 'a1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Swim',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 0,
      group_ids: JSON.stringify(['g1']), unit_ids: null, kind: 'recurring',
    }])
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())
    expect(screen.queryByText('Juniors')).not.toBeNull()
  })

  it('marks a legacy group_ids-derived label as inferred via a title, without changing the visible division text (T183)', async () => {
    // The backward derivation cannot tell "the whole Juniors division" from
    // "one Juniors bunk" — so the label must not silently present it as a
    // saved division choice. The visible text stays "Juniors" (a pre-v65 row
    // must not start reading as "—"); the honesty rides on a tooltip.
    mount([{
      id: 'a1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Swim',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 0,
      group_ids: JSON.stringify(['g1']), unit_ids: null, kind: 'recurring',
    }])
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())
    const cell = screen.getByText('Juniors')
    expect(cell.getAttribute('title')).toBeTruthy()
  })

  it('does NOT mark a stored unit_ids label as inferred (T183)', async () => {
    mount([{
      id: 'a1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Swim',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 0,
      group_ids: '[]', unit_ids: JSON.stringify(['t2']), kind: 'recurring',
    }])
    await waitFor(() => expect(screen.queryByText('Swim')).not.toBeNull())
    const cell = screen.getByText('Seniors')
    expect(cell.getAttribute('title')).toBeFalsy()
  })
})

// T255 Slice B, finding 5 — schema v73 lets two time blocks or two age
// divisions share a name within one camp+cohort. Before this fix `blockMap`
// and `tierMap` were plain last-write-wins `Object.fromEntries`, so an
// imported row silently bound to whichever same-named row happened to come
// last in the array, with no warning — a wrong bind, not a genuinely
// unmatched name.
describe('AnchorsScreen — import refuses an ambiguous same-named match', () => {
  it('refuses to bind an imported row to an arbitrary time block when two blocks share a name', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1', label: 'Monday', day_of_week: 1 })])
      if (entity === 'time_blocks') return Promise.resolve([
        block({ id: 'block-a', name: 'Morning', camp_id: CAMP_ID, cohort_id: COHORT_ID }),
        block({ id: 'block-b', name: 'Morning', camp_id: CAMP_ID, cohort_id: COHORT_ID }),
      ])
      return Promise.resolve([])
    })
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    const file = new File(['dummy'], 'anchors.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Mifkad', day_label: 'Monday', time_block_name: 'Morning', is_all_tiers: 'TRUE', tier_names: '', notes: '' },
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/ambiguous/i)).not.toBeNull())
    const timeBlockIdsWritten = localClient.write.mock.calls.filter(c => c[3] === 'time_block_id').map(c => c[4])
    expect(timeBlockIdsWritten).toEqual([])
  })

  it('refuses to bind an imported row to an arbitrary age division when two divisions share a name', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'days_of_operation') return Promise.resolve([day({ id: 'd1', label: 'Monday', day_of_week: 1 })])
      if (entity === 'time_blocks') return Promise.resolve([block({ id: 'block-1', camp_id: CAMP_ID, cohort_id: COHORT_ID })])
      if (entity === 'tiers') return Promise.resolve([
        { id: 'tier-a', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Yeladim' },
        { id: 'tier-b', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Yeladim' },
      ])
      return Promise.resolve([])
    })
    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} kind="fixed" />)
    await waitFor(() => expect(screen.queryByText('No fixed events yet')).not.toBeNull())

    const file = new File(['dummy'], 'anchors.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    XLSX.utils.sheet_to_json.mockReturnValue([
      { name: 'Swim', day_label: 'Monday', time_block_name: 'Morning', is_all_tiers: 'FALSE', tier_names: 'Yeladim', notes: '' },
    ])

    await userEvent.upload(fileInput, file)

    await waitFor(() => expect(screen.queryByText(/ambiguous/i)).not.toBeNull())
    const unitIdsWritten = localClient.write.mock.calls.filter(c => c[3] === 'unit_ids').map(c => c[4])
    expect(unitIdsWritten).toEqual([])
  })
})
