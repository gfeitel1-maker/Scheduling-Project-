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
    deleteEntity: vi.fn(),
    onOpApplied: vi.fn(() => () => {}),
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
  let idCounter = 0
  vi.stubGlobal('crypto', { randomUUID: () => `new-id-${idCounter++}` })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockReturnValue(() => {})
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

  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md; docs/work/specs/2026-08-22-event-internal-
  // subschedule-slices.md Step 4). Exercises the full chain: open an event's
  // drill-in, open its internal schedule (seeded from the camp), place an
  // activity in a cell, navigate away and back, confirm it persisted — the
  // Slice 1 campwide placement summary is untouched throughout.
  it('opens the internal schedule, places an activity, and the placement persists across re-render', async () => {
    let eventSlots = []
    let activityRows = []
    const eventTimeBlocks = [{ id: 'tb1', event_id: 'ev-1', name: 'Station 1', sort_order: 0 }]
    const eventGroups = [{ id: 'eg1', event_id: 'ev-1', name: 'Blue Team', sort_order: 0 }]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'events') return Promise.resolve([eventRow()])
      if (entity === 'template_slots') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      if (entity === 'days_of_operation') return Promise.resolve([])
      if (entity === 'time_blocks') return Promise.resolve([])
      if (entity === 'event_time_blocks') return Promise.resolve(eventTimeBlocks)
      if (entity === 'event_groups') return Promise.resolve(eventGroups)
      if (entity === 'event_slots') return Promise.resolve(eventSlots)
      if (entity === 'activities') return Promise.resolve(activityRows)
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation(async (token, entity, id, field, value) => {
      if (entity === 'activities') {
        const existing = activityRows.find((a) => a.id === id)
        if (existing) existing[field] = value
        else activityRows = [...activityRows, { id, camp_id: CAMP_ID, [field]: value }]
      }
      if (entity === 'event_slots' && field === 'activity_id') {
        const existing = eventSlots.find((s) => s.id === id)
        if (existing) existing.activity_id = value
        else eventSlots = [...eventSlots, { id, event_id: 'ev-1', event_group_id: 'eg1', time_block_id: 'tb1', activity_id: value, location_id: null }]
      }
      return { status: 'applied' }
    })

    render(<EventScreen campId={CAMP_ID} role="admin" initialEventId="ev-1" />)
    await waitFor(() => expect(screen.getByText('← Back to Events')).toBeTruthy())

    // The Slice 1 campwide placement summary is present and independent.
    expect(screen.getByText('Not placed on the schedule yet.')).toBeTruthy()

    fireEvent.click(screen.getByText('Open schedule'))
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())
    expect(screen.getByText('Station 1')).toBeTruthy()

    fireEvent.click(screen.getAllByText('Open')[0])
    const box = await screen.findByPlaceholderText('Type an activity…')
    fireEvent.change(box, { target: { value: 'Capture the Flag' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())

    // Navigate away and back — the grid reloads from localClient.list, which
    // now reflects the write above (eventSlots was mutated by the mock).
    fireEvent.click(screen.getByText('← Back to Event'))
    await waitFor(() => expect(screen.getByText('Open schedule')).toBeTruthy())
    fireEvent.click(screen.getByText('Open schedule'))

    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())
  })
})
