// @vitest-environment jsdom
//
// Piece B of the duplicate-catcher ticket: a quiet, derived-at-render-time
// marker on LocationsScreen for locations whose names normalize alike, and
// verification that a near-duplicate never blocks any create.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

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
    locationCapacityProvenance: vi.fn(),
  },
}))

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
    aoa_to_sheet: vi.fn(() => ({})),
  },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

import LocationsScreen from './LocationsScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function location(overrides = {}) {
  return { id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 1, notes: null, sort_order: 1, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  localClient.listMigrationReviews.mockResolvedValue([])
  localClient.locationCapacityProvenance.mockResolvedValue({})
  localClient.write.mockResolvedValue({ ok: true })
  localClient.mergeLocation.mockResolvedValue({ ok: true })
})

describe('LocationsScreen — duplicate-catcher marker (Piece B)', () => {
  it('marks two locations whose names normalize alike ("Gym"/"gym")', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-gym-1', name: 'Gym' }),
          location({ id: 'loc-gym-2', name: 'gym' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 locations')).not.toBeNull())

    const dots = screen.getAllByRole('button', { name: /Possible duplicate/i })
    expect(dots.length).toBe(2)
  })

  it('does not mark genuinely distinct locations', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-1', name: 'Gym' }),
          location({ id: 'loc-2', name: 'Gym Hall' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 locations')).not.toBeNull())

    expect(screen.queryByRole('button', { name: /Possible duplicate/i })).toBeNull()
  })

  it('a near-duplicate creation is never blocked — both rows are created and visible', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-gym-1', name: 'Gym' }),
          location({ id: 'loc-gym-2', name: 'gym' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 locations')).not.toBeNull())
    // Both rows landed — nothing about the duplicate held the second create back.
    expect(screen.getAllByText(/^gym$/i).length).toBe(2)
  })

  it('clicking the marker offers the existing merge flow, wired to mergeLocation', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-gym-1', name: 'Gym' }),
          location({ id: 'loc-gym-2', name: 'gym' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2 locations')).not.toBeNull())

    const [firstDot] = screen.getAllByRole('button', { name: /Possible duplicate/i })
    fireEvent.click(firstDot)
    const mergeBtn = await screen.findByRole('button', { name: /Merge into/i })
    fireEvent.click(mergeBtn)

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(1))
    const call = localClient.mergeLocation.mock.calls[0][0]
    expect([call.loser_id, call.winner_id].sort()).toEqual(['loc-gym-1', 'loc-gym-2'])
  })
})
