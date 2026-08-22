// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    deleteElectiveSet: vi.fn(),
  },
}))

import ElectivesScreen from './ElectivesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function electiveSet(overrides = {}) {
  return { id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim', sort_order: null, is_reusable: 1, ...overrides }
}

function offering(overrides = {}) {
  return { id: 'off-1', elective_set_id: 'set-1', activity_id: 'act-1', camper_headcount: null, ...overrides }
}

function activity(overrides = {}) {
  return { id: 'act-1', camp_id: CAMP_ID, name: 'Pottery', location_id: 'loc-1', eligible_tier_ids: '[]', eligible_group_ids: '[]', ...overrides }
}

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-id' })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteElectiveSet.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('ElectivesScreen', () => {
  it('shows the empty state when the camp has no elective sets', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [], activities: [], locations: [], tiers: [], groups: [] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('No elective sets yet')).not.toBeNull())
  })

  it('creates a new elective set by writing camp_id and name', async () => {
    localClient.list.mockImplementation(byEntity({ elective_sets: [], activities: [], locations: [], tiers: [], groups: [] }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No elective sets yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('e.g. Afternoon Chugim'), { target: { value: 'Morning Bechirot' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fields = localClient.write.mock.calls.map((c) => c[3])
    expect(fields).toEqual(expect.arrayContaining(['name', 'camp_id']))
  })

  it('opens directly to a set\'s offerings when initialElectiveSetId is passed (Slice 2 drill-in)', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet(), electiveSet({ id: 'set-2', name: 'Morning Bechirot' })],
      elective_set_activities: [offering({ camper_headcount: 8 })],
      activities: [activity()],
      locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool' }],
      tiers: [],
      groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" initialElectiveSetId="set-1" />)

    // Lands directly on the offerings table for set-1, not the sets list.
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.queryByText('Morning Bechirot')).toBeNull()
    expect(screen.getByText('← Back to Elective Sets')).toBeTruthy()
  })

  it('lists a set with its offerings, showing location and eligibility read from the activity', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      elective_set_activities: [offering({ camper_headcount: 8 })],
      activities: [activity()],
      locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Pool' }],
      tiers: [],
      groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())

    fireEvent.click(screen.getByText('Manage Offerings'))

    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText('Everyone')).not.toBeNull()
    expect(screen.getByLabelText('Capacity for Pottery').value).toBe('8')
  })

  it('persists a capacity edit as camper_headcount, and empty as null (no cap)', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      elective_set_activities: [offering()],
      activities: [activity()],
      locations: [],
      tiers: [],
      groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    fireEvent.click(screen.getByText('Manage Offerings'))
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: '15' } })
    fireEvent.blur(capacityInput)

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'elective_set_activities', 'off-1', 'camper_headcount', 15)
    )
  })

  it('rejects non-numeric / negative capacity input without writing', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      elective_set_activities: [offering()],
      activities: [activity()],
      locations: [], tiers: [], groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    fireEvent.click(screen.getByText('Manage Offerings'))
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    // digits-only guard blocks bad chars from ever entering the field
    fireEvent.change(capacityInput, { target: { value: 'abc' } })
    expect(capacityInput.value).toBe('')
    fireEvent.change(capacityInput, { target: { value: '-5' } })
    expect(capacityInput.value).toBe('')
    fireEvent.blur(capacityInput)
    // blur with an unchanged (still-null) value must not write
    expect(localClient.write).not.toHaveBeenCalledWith(
      'token-abc', 'elective_set_activities', 'off-1', 'camper_headcount', expect.anything()
    )
  })

  it('flashes a success cue on the capacity field after a save, then clears it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      localClient.list.mockImplementation(byEntity({
        elective_sets: [electiveSet()],
        elective_set_activities: [offering()],
        activities: [activity()],
        locations: [], tiers: [], groups: [],
      }))
      render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
      await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
      fireEvent.click(screen.getByText('Manage Offerings'))
      await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

      const capacityInput = screen.getByLabelText('Capacity for Pottery')
      fireEvent.change(capacityInput, { target: { value: '15' } })
      fireEvent.blur(capacityInput)

      await waitFor(() => expect(capacityInput.hasAttribute('data-saved')).toBe(true))
      await vi.advanceTimersByTimeAsync(700)
      await waitFor(() => expect(capacityInput.hasAttribute('data-saved')).toBe(false))
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a write failure instead of silently swallowing it', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      elective_set_activities: [offering()],
      activities: [activity()],
      locations: [],
      tiers: [],
      groups: [],
    }))
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    fireEvent.click(screen.getByText('Manage Offerings'))
    await waitFor(() => expect(screen.queryByText('Pottery')).not.toBeNull())

    const capacityInput = screen.getByLabelText('Capacity for Pottery')
    fireEvent.change(capacityInput, { target: { value: '15' } })
    fireEvent.blur(capacityInput)

    await waitFor(() => expect(screen.queryByText(/That capacity could not be saved/)).not.toBeNull())
  })

  it('adds an offering from the camp activities not already in the set', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      elective_set_activities: [],
      activities: [activity(), activity({ id: 'act-2', name: 'Ceramics' })],
      locations: [],
      tiers: [],
      groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())
    fireEvent.click(screen.getByText('Manage Offerings'))
    await waitFor(() => expect(screen.queryByText('No offerings yet')).not.toBeNull())

    fireEvent.change(screen.getByLabelText('Choose an activity to add'), { target: { value: 'act-2' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const calls = localClient.write.mock.calls
    expect(calls.some((c) => c[3] === 'activity_id' && c[4] === 'act-2')).toBe(true)
    expect(calls.some((c) => c[3] === 'elective_set_id' && c[4] === 'set-1')).toBe(true)
  })

  it('deletes an elective set via localClient.deleteElectiveSet after confirmation', async () => {
    localClient.list.mockImplementation(byEntity({
      elective_sets: [electiveSet()],
      activities: [],
      locations: [],
      tiers: [],
      groups: [],
    }))
    render(<ElectivesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Afternoon Chugim')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/Delete "Afternoon Chugim"/)).not.toBeNull())
    fireEvent.click(screen.getByText('Delete Elective Set'))

    await waitFor(() => expect(localClient.deleteElectiveSet).toHaveBeenCalledWith({ electiveSetId: 'set-1' }))
  })
})
