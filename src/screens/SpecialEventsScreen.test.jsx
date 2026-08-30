// @vitest-environment jsdom
//
// Special Events unification (owner-approved 2026-08-29, docs/adr/2026-08-29-
// unify-special-events-screen.md). Replaces EventScreen.test.jsx +
// SpecialDaysScreen.test.jsx with one suite covering the merged create/manage
// hub: card grid of special_days + events, create both kinds, open a
// detail, edit notes, "Build →" to the Plants build surface, delete.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    deleteEvent: vi.fn(),
    deleteSpecialDay: vi.fn(),
    onOpApplied: vi.fn(() => () => {}),
  },
}))

import SpecialEventsScreen from './SpecialEventsScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function eventRow(overrides = {}) {
  return { id: 'ev-1', camp_id: CAMP_ID, name: 'Color War', sort_order: null, notes: null, ...overrides }
}

function dayRow(overrides = {}) {
  return { id: 'day-1', camp_id: CAMP_ID, name: 'Visiting Day', notes: null, ...overrides }
}

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
}

const emptyEntries = {
  events: [], special_days: [], special_day_time_blocks: [], special_day_slots: [],
  template_slots: [], groups: [], days_of_operation: [], time_blocks: [], locations: [],
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
  localClient.deleteEvent.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteSpecialDay.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockReturnValue(() => {})
})

describe('SpecialEventsScreen — empty state', () => {
  it('shows a calm empty state when the camp has no special days or events', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())
  })
})

describe('SpecialEventsScreen — create', () => {
  it('creates an event and shows it tagged "Event"', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Event'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Color War'), { target: { value: 'Color War' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fields = localClient.write.mock.calls.map((c) => c[3])
    expect(fields[0]).toBe('name')
  })

  it('creates a special day and shows it tagged "Special Day"', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())

    fireEvent.click(screen.getByText('+ Special Day'))
    fireEvent.change(screen.getByPlaceholderText('Name your special day…'), { target: { value: 'Visiting Day' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'special_days', expect.any(String), 'name', 'Visiting Day'))
    // Seed prompt appears after create.
    await waitFor(() => expect(screen.queryByText(/Seed from Time Blocks/)).not.toBeNull())
  })

  it('lists both kinds with correct type tags', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()], special_days: [dayRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('Color War')).not.toBeNull())
    expect(screen.getByText('Visiting Day')).toBeTruthy()
    expect(screen.getByText('Event')).toBeTruthy()
    expect(screen.getByText('Special Day')).toBeTruthy()
  })
})

describe('SpecialEventsScreen — event detail', () => {
  it('click card opens detail with name + notes, and Build → routes correctly', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow({ notes: 'Bring points sheet' })] }))
    const onNavigate = vi.fn()
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Color War')).not.toBeNull())
    fireEvent.click(screen.getByText('Color War'))

    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
    expect(screen.getByDisplayValue('Bring points sheet')).toBeTruthy()

    fireEvent.click(screen.getByText(/Build this event's schedule from Special Schedules/))
    expect(onNavigate).toHaveBeenCalledWith('schedule:special', { buildEventId: 'ev-1' })
  })

  it('editing notes commits on blur', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'event', id: 'ev-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())

    const textarea = screen.getByPlaceholderText(/Teams, points, staffing/)
    fireEvent.change(textarea, { target: { value: 'New notes' } })
    fireEvent.blur(textarea)

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'events', 'ev-1', 'notes', 'New notes'))
  })

  it('deletes an event', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'event', id: 'ev-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())

    fireEvent.click(screen.getByText('Delete Event'))
    const confirmButtons = screen.getAllByText('Delete Event')
    fireEvent.click(confirmButtons[confirmButtons.length - 1])

    await waitFor(() => expect(localClient.deleteEvent).toHaveBeenCalledWith({ eventId: 'ev-1' }))
  })
})

describe('SpecialEventsScreen — special day detail', () => {
  it('click card opens detail with name + notes, and Build → routes with { specialDayId }', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, special_days: [dayRow({ notes: 'Setup at 8am' })] }))
    const onNavigate = vi.fn()
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('Visiting Day')).not.toBeNull())
    fireEvent.click(screen.getByText('Visiting Day'))

    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
    expect(screen.getByDisplayValue('Setup at 8am')).toBeTruthy()

    fireEvent.click(screen.getByText(/Build this day's schedule from Special Schedules/))
    expect(onNavigate).toHaveBeenCalledWith('schedule:special', { specialDayId: 'day-1' })
  })

  it('editing notes commits on blur', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, special_days: [dayRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'day', id: 'day-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())

    const textarea = screen.getByPlaceholderText(/Run-of-show/)
    fireEvent.change(textarea, { target: { value: 'Updated notes' } })
    fireEvent.blur(textarea)

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'special_days', 'day-1', 'notes', 'Updated notes'))
  })

  it('deletes a special day', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, special_days: [dayRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'day', id: 'day-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())

    fireEvent.click(screen.getByText('Delete Special Day'))
    const confirmButtons = screen.getAllByText('Delete Special Day')
    fireEvent.click(confirmButtons[confirmButtons.length - 1])

    await waitFor(() => expect(localClient.deleteSpecialDay).toHaveBeenCalledWith({ specialDayId: 'day-1' }))
  })
})

// Ported from the retired SpecialDaysScreen.test.jsx's admin-gate coverage —
// especially load-bearing now that Delete Event is newly reachable here (it
// had no UI in the old EventScreen). Both delete controls are admin-only.
describe('SpecialEventsScreen — Delete is admin-only for both kinds', () => {
  it('disables "Delete Event" for a staff role', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="staff" initialFocus={{ type: 'event', id: 'ev-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
    expect(screen.getByText('Delete Event').disabled).toBe(true)
  })

  it('disables "Delete Special Day" for a staff role', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, special_days: [dayRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="staff" initialFocus={{ type: 'day', id: 'day-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
    expect(screen.getByText('Delete Special Day').disabled).toBe(true)
  })
})
