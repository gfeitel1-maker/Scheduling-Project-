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
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
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

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} />)
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

    render(<AnchorsScreen campId={CAMP_ID} onNavigate={() => {}} />)
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

describe('AnchorsScreen delete confirmation', () => {
  function existingAnchor(overrides = {}) {
    return {
      id: 'anchor-1', camp_id: CAMP_ID, cohort_id: COHORT_ID, name: 'Mifkad',
      day_id: 'd1', time_block_id: 'block-1', is_all_groups: 1, group_ids: null,
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
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
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
    render(<AnchorsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Mifkad')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Mifkad"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Mifkad"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })
})
