// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { deriveLocationId } from '../../electron/ops/locationId'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    listByScope: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    previewDelete: vi.fn(),
    deleteRecord: vi.fn(),
    mergeLocation: vi.fn(),
    listMigrationReviews: vi.fn(),
    dismissMigrationReviews: vi.fn(),
  },
}))

import LocationsScreen from './LocationsScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function location(overrides = {}) {
  return {
    id: 'loc-1',
    camp_id: CAMP_ID,
    name: 'Pool',
    capacity: 1,
    notes: null,
    sort_order: 1,
    ...overrides,
  }
}

function activity(overrides = {}) {
  return { id: 'act-1', camp_id: CAMP_ID, name: 'Free Swim', location_id: 'loc-1', ...overrides }
}

function review(overrides = {}) {
  return {
    id: 'review-1',
    camp_id: CAMP_ID,
    location_id: 'loc-1',
    name: 'Pool',
    kind: 'was_unlimited',
    detail: { seededCapacity: 1 },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-location-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation((entity) => {
    if (entity === 'locations') return Promise.resolve([])
    if (entity === 'activities') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.listByScope.mockReset().mockResolvedValue([])
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue({
    ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 0, activities: [],
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
  localClient.mergeLocation.mockReset().mockResolvedValue({ ok: true, cleared: 0, reassigned_activity_ids: [] })
  localClient.listMigrationReviews.mockReset().mockResolvedValue([])
  localClient.dismissMigrationReviews.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
})

describe('LocationsScreen', () => {
  it('renders the calm empty state when the camp has no places, with no toolbar or table', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('No places yet')).not.toBeNull())
    expect(screen.queryByText(/Add a place below and say how many groups fit at once/)).not.toBeNull()
    expect(screen.queryByText('Add your first place')).not.toBeNull()
    // No toolbar/count eyebrow and no table — the empty state is the calm
    // no-card block (DESIGN_STANDARD §5a), not a 0-row table.
    expect(screen.queryByText(/places$/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    // The Add Place card still renders below the empty block.
    expect(screen.queryByText('Add Place')).not.toBeNull()
  })

  it('loads places scoped to campId and shows the populated table', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-1', name: 'Pool', capacity: 3 }),
          location({ id: 'loc-other', name: 'Wrong Camp', camp_id: 'other-camp' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('1 place')).not.toBeNull())
    expect(localClient.list).toHaveBeenCalledWith('locations')
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText('3 groups')).not.toBeNull()
    expect(screen.queryByText('Wrong Camp')).toBeNull()
  })

  it('adds a place by writing name first, then camp_id/capacity/notes', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No places yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('e.g. Pool, Gym, Beit Midrash'), { target: { value: 'Gym' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('name')
    const fieldsWritten = localClient.write.mock.calls.map((c) => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['name', 'camp_id', 'capacity', 'notes']))
  })

  it('the capacity stepper defaults to 1 in the Add card and cannot go below 1', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No places yet')).not.toBeNull())

    const decrease = screen.getByLabelText('Decrease')
    expect(decrease.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('e.g. Pool, Gym, Beit Midrash'), { target: { value: 'Gym' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
    expect(capacityCall[4]).toBe(1)
  })

  it('edits capacity via the stepper in the inline edit row and saves the new value', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 1 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    // The Add card renders its own stepper too, so scope to the first
    // (edit row) instance — the edit row renders before the Add card in DOM order.
    const increase = screen.getAllByLabelText('Increase')[0]
    fireEvent.click(increase)
    fireEvent.click(increase)
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
      expect(capacityCall).toBeTruthy()
      expect(capacityCall[4]).toBe(3)
    })
  })

  it('the stepper never goes below 1, even via direct typed input', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 1 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const input = screen.getAllByLabelText('Groups at once')[0]
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
      expect(capacityCall).toBeTruthy()
      expect(capacityCall[4]).toBe(1)
    })
  })

  // M3c — delete now routes through previewDelete/DeleteRecordDialog/
  // deleteRecord (the shared host path, D2), replacing the bespoke in-screen
  // unbind-then-deleteEntity flow M3a shipped.
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  it('shows the bound-activity count before deleting, then deletes through the shared host path', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 2,
      activities: [{ id: 'act-1', name: 'Free Swim', max_groups_per_slot: 1 }, { id: 'act-2', name: 'Swim Lessons', max_groups_per_slot: 1 }],
    })
    localClient.deleteRecord.mockResolvedValue({ ok: true, cleared: 2, reassigned_activity_ids: [] })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(localClient.previewDelete).toHaveBeenCalledWith('locations', 'loc-1'))
    await waitFor(() => expect(screen.queryByText(/Delete .Pool./)).not.toBeNull())
    expect(screen.queryByText(/2 activities use Pool right now/)).not.toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    expect(localClient.deleteRecord).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete and clear 2 activities'))

    await waitFor(() => expect(localClient.deleteRecord).toHaveBeenCalledWith('locations', 'loc-1', 2))
  })

  it('shows honest copy when nothing is bound to the place', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 0, activities: [],
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText(/Nothing uses Pool right now/)).not.toBeNull())
  })

  it('shows an admin-role-specific error when previewDelete is rejected for a non-admin', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockRejectedValue(new Error('admin role required'))
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Only an admin can delete places.')).not.toBeNull())
  })

  it('cancels the delete confirm without deleting', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/Delete .Pool./)).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText(/Delete .Pool./)).toBeNull()
    expect(localClient.deleteRecord).not.toHaveBeenCalled()
  })

  it('disables Delete and Delete All for non-admin roles', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.getByText('Delete').disabled).toBe(true)
    expect(screen.getByText('Delete All').disabled).toBe(true)
  })

  it('shows a styled confirm modal (not window.confirm) before Delete All, and confirming deletes all camp-scoped places', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1' }), location({ id: 'loc-2', name: 'Gym' })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all places?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Places'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'locations', 'loc-2')
  })

  it('cancels Delete All without deleting', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all places?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all places?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('navigates to Activities and to Fixed Events from its own Next chain', async () => {
    const onNavigate = vi.fn()
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('No places yet')).not.toBeNull())

    fireEvent.click(screen.getByText('← Back to Activities'))
    expect(onNavigate).toHaveBeenCalledWith('activities')

    fireEvent.click(screen.getByText('Next: Fixed Events →'))
    expect(onNavigate).toHaveBeenCalledWith('anchors')
  })

  it('shows a load-failure banner when localClient.list rejects', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.reject(new Error('boom'))
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText(/Failed to load data/)).not.toBeNull())
  })
})

// ---------------------------------------------------------------------------
// M3c — the first-run migration review region.
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3/D4/D5,
// docs/work/specs/2026-08-15-m3-locations-design.md Part 3.
// ---------------------------------------------------------------------------
describe('LocationsScreen: migration review region', () => {
  it('renders no region at all when the journal is empty (D-3.3)', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.queryByText('These look like the same place')).toBeNull()
    expect(screen.queryByText(/Shoresh set a few capacities/)).toBeNull()
  })

  it('shows the advisory strip for capacity_disagreement and was_unlimited, numbers-only (D-2)', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({
        id: 'r1', location_id: 'loc-1', name: 'Pool', kind: 'capacity_disagreement',
        detail: { declaredCaps: [1, 3], seededCapacity: 3 },
      }),
      review({ id: 'r2', location_id: 'loc-1', name: 'The Gym', kind: 'was_unlimited', detail: { seededCapacity: 1 } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText(/Shoresh set a few capacities/)).not.toBeNull())
    expect(screen.queryByText('2 to look at')).not.toBeNull()
    expect(screen.queryByText(/asked for different limits \(1 and 3 groups at once\)/)).not.toBeNull()
    expect(screen.queryByText(/Shoresh kept the most room: 3/)).not.toBeNull()
    expect(screen.queryByText(/had no limit set and is now 1 group at a time/)).not.toBeNull()
    // Numbers-only — never an activity name (D-2 owner decision).
    expect(screen.queryByText(/Swim Lessons/)).toBeNull()
  })

  it('"Looks right" writes the capacity and dismisses the review', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: 'loc-1', name: 'Pool', kind: 'was_unlimited', detail: { seededCapacity: 1 } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Looks right')).not.toBeNull())

    fireEvent.click(screen.getByText('Looks right'))

    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1']))
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1', 'capacity', 3)
  })

  it('blocks the screen with the near-duplicate merge gate when unresolved (D-3)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('These look like the same place')).not.toBeNull())
    expect(screen.queryByText('1 place left to review')).not.toBeNull()
    // Default winner = most bound activities — "Pool" (2) over "pool" (1).
    expect(screen.queryByText(/2 activities here/)).not.toBeNull()
    expect(screen.queryByText(/1 activity here/)).not.toBeNull()
    // The advisory strip must not render while the gate is up.
    expect(screen.queryByText(/Shoresh set a few capacities/)).toBeNull()

    fireEvent.click(screen.getByText('Merge into one place'))

    await waitFor(() =>
      expect(localClient.mergeLocation).toHaveBeenCalledWith({
        loser_id: poolLowerId,
        winner_id: poolId,
        winner_capacity: 3,
        expected_ref_count: 1,
      })
    )
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
  })

  it('"No — these are different places" dismisses the group without merging', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([location({ id: poolId, name: 'Pool' }), location({ id: poolLowerId, name: 'pool' })])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('These look like the same place')).not.toBeNull())
    fireEvent.click(screen.getByText('No — these are different places'))

    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
    expect(localClient.mergeLocation).not.toHaveBeenCalled()
  })

  // BUG 2: refreshReviewData used to have two different failure semantics —
  // the mount effect swallowed a failure to [], but the shared function
  // handleMerge calls rethrew, so a refresh failure AFTER a merge that
  // genuinely succeeded surfaced a false "merge could not be completed"
  // error. Fixed by giving refreshReviewData ONE failure semantic (never
  // throws) that both callers share.
  it('a refreshReviewData failure after a successful merge does not surface a merge-failure error (BUG 2)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    // First call is the mount effect (must succeed so the gate renders).
    // Second call is handleMerge's own post-merge refreshReviewData() call —
    // that one fails, even though the merge itself already succeeded.
    localClient.listMigrationReviews
      .mockResolvedValueOnce([
        review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
        review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      ])
      .mockRejectedValueOnce(new Error('network blip'))

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same place')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one place'))

    await waitFor(() =>
      expect(localClient.mergeLocation).toHaveBeenCalledWith({
        loser_id: poolLowerId,
        winner_id: poolId,
        winner_capacity: 3,
        expected_ref_count: 1,
      })
    )
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
    await waitFor(() => expect(localClient.listMigrationReviews).toHaveBeenCalledTimes(2))

    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })

  it('D4 self-heal: hides a near_duplicate group whose loser location no longer exists', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    // "pool" was already merged away (on this or another device) — only the
    // winner's row still exists.
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: poolId, name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: 'loc-pool-lower', name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.queryByText('These look like the same place')).toBeNull()
  })

  // FIX 1 (HIGH, safety-panel round): a 3+-variant near-duplicate group whose
  // batch merge fails partway through used to leave the gate trapped — the
  // failure handler only set gateError, never refreshed state, so the gate
  // kept offering an already-deleted loser and every retry died identically
  // on 'no-record' before ever reaching the loser that could still merge.
  // "these are different places" was the only escape, permanently forfeiting
  // the un-merged variant. Fixed by refreshing on failure (self-heals the
  // gate onto the remaining mergeable variant) so a retry only re-attempts
  // what is actually still there.
  it('a mid-batch merge failure self-heals the gate instead of trapping it, and a retry completes (FIX 1)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolUpperId = deriveLocationId(CAMP_ID, 'POOL')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')

    let poolUpperMerged = false
    let poolLowerAttempts = 0

    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        const rows = [location({ id: poolId, name: 'Pool', capacity: 3 })]
        if (!poolUpperMerged) rows.push(location({ id: poolUpperId, name: 'POOL', capacity: 1 }))
        rows.push(location({ id: poolLowerId, name: 'pool', capacity: 1 }))
        return Promise.resolve(rows)
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolUpperId }),
          activity({ id: 'act-4', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r-Pool', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-POOL', location_id: poolUpperId, name: 'POOL', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-pool', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
    ])
    // Real deleteOrMergeLocation behavior, keyed by loser: the first loser
    // (POOL) succeeds outright; the second (pool) fails once with a genuine
    // transient error (a concurrent bind), then succeeds on retry.
    localClient.mergeLocation.mockImplementation(({ loser_id }) => {
      if (loser_id === poolUpperId) {
        poolUpperMerged = true
        return Promise.resolve({ ok: true, cleared: 1, reassigned_activity_ids: ['act-3'] })
      }
      if (loser_id === poolLowerId) {
        poolLowerAttempts += 1
        if (poolLowerAttempts === 1) return Promise.resolve({ error: 'count-changed', ref_count: 1 })
        return Promise.resolve({ ok: true, cleared: 1, reassigned_activity_ids: ['act-4'] })
      }
      return Promise.resolve({ error: 'unexpected-loser' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same place')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one place'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/That merge could not be completed/)).not.toBeNull())

    // (a) self-heal: the screen refreshed (locations re-listed) after the
    // failure, and the gate no longer offers the already-merged loser.
    await waitFor(() =>
      expect(localClient.list.mock.calls.filter((c) => c[0] === 'locations').length).toBeGreaterThan(1)
    )
    expect(screen.queryByText('POOL')).toBeNull()
    expect(screen.getAllByText('pool').length).toBeGreaterThan(0)

    // (c) "these are different places" is not the only escape — the Merge
    // button is still present and functional.
    expect(screen.queryByText('Merge into one place')).not.toBeNull()

    // (b) retry: the previously-failed loser now succeeds, completing the
    // merge — it does not die re-hitting the already-deleted first loser.
    fireEvent.click(screen.getByText('Merge into one place'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r-Pool', 'r-POOL', 'r-pool']))
    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })

  // FIX 1, bullet 2: the sequential loop must tolerate a loser that is
  // already gone (mergeLocation returns 'no-record') by treating it as
  // already-done and continuing to the next loser — not throwing and
  // abandoning a loser that could still merge. This can happen even with
  // fresh state if a peer merged the loser between this device's preview and
  // its confirm.
  it('tolerates an already-merged loser (no-record) mid-batch and continues to complete the merge (FIX 1)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolUpperId = deriveLocationId(CAMP_ID, 'POOL')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')

    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolUpperId, name: 'POOL', capacity: 1 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r-Pool', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-POOL', location_id: poolUpperId, name: 'POOL', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-pool', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
    ])
    // POOL was already merged away by another device between this device's
    // load and its confirm — the host genuinely reports 'no-record' for it.
    // pool is still there and merges normally.
    localClient.mergeLocation.mockImplementation(({ loser_id }) => {
      if (loser_id === poolUpperId) return Promise.resolve({ error: 'no-record' })
      if (loser_id === poolLowerId) return Promise.resolve({ ok: true, cleared: 0, reassigned_activity_ids: [] })
      return Promise.resolve({ error: 'unexpected-loser' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same place')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one place'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r-Pool', 'r-POOL', 'r-pool']))
    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })
})

// M5 — per-week location availability, mirroring ActivitiesScreen/GroupsScreen's
// week-exclusion toggle exactly: a WeekToggle column when weekId is present,
// toggle-off writes week_id then location_id, toggle-on deletes the row, and
// closing a place with placed slots requires confirmation first.
describe('LocationsScreen — week availability (M5)', () => {
  const WEEK_ID = 'week-1'
  const weeks = [{ id: WEEK_ID, camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 }]

  it('shows a week column with a WeekToggle per place when weekId is set', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)

    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('closing a place with no placed slots writes the exclusion immediately, no confirm', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(localClient.write.mock.calls[0][1]).toBe('week_location_exclusions')
    expect(localClient.write.mock.calls[0][3]).toBe('week_id')
    expect(localClient.write.mock.calls[0][4]).toBe(WEEK_ID)
    expect(localClient.write.mock.calls[1][3]).toBe('location_id')
    expect(localClient.write.mock.calls[1][4]).toBe('loc-1')
    expect(screen.queryByText(/Turn off/)).toBeNull()
  })

  it('closing a place with placed slots shows a confirm dialog with the slot count first', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      if (entity === 'activities') return Promise.resolve([activity({ id: 'act-1', location_id: 'loc-1' })])
      if (entity === 'schedule_templates') return Promise.resolve([{ id: 'tmpl-1', week_id: WEEK_ID, kind: 'generated' }])
      if (entity === 'template_slots') return Promise.resolve([
        { id: 's1', template_id: 'tmpl-1', activity_id: 'act-1' },
        { id: 's2', template_id: 'tmpl-1', activity_id: 'act-1' },
      ])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.queryByText(/Turn off "Pool"/)).not.toBeNull())
    expect(localClient.write).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Turn off anyway'))
    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(localClient.write.mock.calls[1][3]).toBe('location_id')
    expect(localClient.write.mock.calls[1][4]).toBe('loc-1')
  })

  it('reopening an excluded place deletes the exclusion row, no confirm', async () => {
    const exclusionRow = { id: 'excl-1', week_id: WEEK_ID, location_id: 'loc-1' }
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      if (entity === 'week_location_exclusions') return Promise.resolve([exclusionRow])
      return Promise.resolve([])
    })
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      if (entity === 'week_location_exclusions' && scopeId === WEEK_ID) return Promise.resolve([exclusionRow])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'week_location_exclusions', 'excl-1'))
  })
})
