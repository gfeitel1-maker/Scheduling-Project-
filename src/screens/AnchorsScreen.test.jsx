// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
  },
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
    await waitFor(() => expect(screen.getByPlaceholderText('Search or add a location…')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Search or add a location…'), { target: { value: 'Pool' } })
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
