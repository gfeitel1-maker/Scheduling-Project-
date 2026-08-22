// @vitest-environment jsdom
//
// Events overlay placement Slice 1, Step 6 (docs/adr/2026-08-22-events-
// overlay-placement.md §5, docs/work/specs/2026-08-22-events-overlay-
// slices.md). Mirrors ElectivesScreen.test.jsx's shape, minus offerings.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
  },
}))

import EventScreen from './EventScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function eventRow(overrides = {}) {
  return { id: 'ev-1', camp_id: CAMP_ID, name: 'Color War', sort_order: null, notes: null, ...overrides }
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
})

describe('EventScreen', () => {
  it('shows the empty state when the camp has no events', async () => {
    localClient.list.mockImplementation(byEntity({ events: [], template_slots: [], groups: [], days_of_operation: [], time_blocks: [] }))
    render(<EventScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('No events yet')).not.toBeNull())
  })

  it('creates a new event by writing name FIRST, then camp_id (UNIQUE_FIRST_FIELD orphan-row guard)', async () => {
    localClient.list.mockImplementation(byEntity({ events: [], template_slots: [], groups: [], days_of_operation: [], time_blocks: [] }))
    render(<EventScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No events yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('e.g. Color War'), { target: { value: 'Color War' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fields = localClient.write.mock.calls.map((c) => c[3])
    expect(fields[0]).toBe('name')
    expect(fields).toEqual(expect.arrayContaining(['name', 'camp_id']))
  })

  it('lists existing events and opens the drill-in on click', async () => {
    localClient.list.mockImplementation(byEntity({
      events: [eventRow()],
      template_slots: [],
      groups: [],
      days_of_operation: [],
      time_blocks: [],
    }))
    render(<EventScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('Color War')).not.toBeNull())
    fireEvent.click(screen.getByText('Color War'))

    await waitFor(() => expect(screen.getByText('← Back to Events')).toBeTruthy())
  })

  it('opens directly to an event\'s detail when initialEventId is passed (grid drill-in)', async () => {
    localClient.list.mockImplementation(byEntity({
      events: [eventRow(), eventRow({ id: 'ev-2', name: 'Banquet' })],
      template_slots: [],
      groups: [],
      days_of_operation: [],
      time_blocks: [],
    }))
    render(<EventScreen campId={CAMP_ID} role="admin" initialEventId="ev-1" />)

    await waitFor(() => expect(screen.getByText('← Back to Events')).toBeTruthy())
    expect(screen.queryByText('Banquet')).toBeNull()
  })

  it('renders a read-only placement summary resolving day/group/block names', async () => {
    localClient.list.mockImplementation(byEntity({
      events: [eventRow()],
      template_slots: [
        { id: 'ts1', template_id: 'tpl1', event_id: 'ev-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1' },
      ],
      groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bnei Mitzvah' }],
      days_of_operation: [{ id: 'd1', camp_id: CAMP_ID, label: 'Wed' }],
      time_blocks: [{ id: 'b1', camp_id: CAMP_ID, name: 'Period 3' }],
    }))
    render(<EventScreen campId={CAMP_ID} role="admin" initialEventId="ev-1" />)

    await waitFor(() => expect(screen.getByText(/Bnei Mitzvah/)).toBeTruthy())
    expect(screen.getByText(/Wed/)).toBeTruthy()
    expect(screen.getByText(/Period 3/)).toBeTruthy()
  })

  it('has no coming-soon controls — no disabled affordance for the deferred internal sub-schedule', async () => {
    localClient.list.mockImplementation(byEntity({
      events: [eventRow()],
      template_slots: [],
      groups: [],
      days_of_operation: [],
      time_blocks: [],
    }))
    render(<EventScreen campId={CAMP_ID} role="admin" initialEventId="ev-1" />)

    await waitFor(() => expect(screen.getByText('← Back to Events')).toBeTruthy())
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })
})
