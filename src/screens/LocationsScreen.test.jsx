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
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
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

  it('shows the bound-activity count before deleting and unbinds them before deleting the place', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      if (entity === 'activities') return Promise.resolve([activity(), activity({ id: 'act-2', name: 'Swim Lessons' })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Delete "Pool"?')).not.toBeNull())
    expect(screen.queryByText(/2 activities use "Pool" right now/)).not.toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete Place'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1'))
    const unboundIds = localClient.write.mock.calls
      .filter((c) => c[1] === 'activities' && c[3] === 'location_id')
      .map((c) => c[2])
    expect(unboundIds.sort()).toEqual(['act-1', 'act-2'])
  })

  it('shows honest copy when nothing is bound to the place', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText(/Nothing uses "Pool" right now/)).not.toBeNull())
  })

  it('cancels the delete confirm without deleting', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText('Delete "Pool"?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete "Pool"?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
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
