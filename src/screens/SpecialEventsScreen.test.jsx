// @vitest-environment jsdom
//
// Special Events unification (owner-approved 2026-08-29, docs/adr/2026-08-29-
// unify-special-events-screen.md). Replaces EventScreen.test.jsx +
// SpecialDaysScreen.test.jsx with one suite covering the merged create/manage
// hub: an inline-add TABLE of special_days + events (Wave C — cards→table so
// all Sprouts setup screens are one family), create both kinds via the blank
// last row, open a detail, edit notes, "Build →" to the Plants build surface,
// delete.
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
import { seedFailureMessage } from './specialDay/seedFailureMessage'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

// Fill the always-present InlineAddRow (name + type select) and commit via +Add.
function addViaInlineRow({ name, type }) {
  fireEvent.change(screen.getByPlaceholderText('Name a special day or event…'), { target: { value: name } })
  // The type select defaults to "Event"; switch it when adding a Special Day.
  fireEvent.change(screen.getByDisplayValue('Event'), { target: { value: type } })
  fireEvent.click(screen.getByText('+ Add'))
}

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
  it('shows an in-table empty state (with a reachable inline-add row) when the camp has no special days or events', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())
    // The blank inline-add row is present even at zero items.
    expect(screen.getByPlaceholderText('Name a special day or event…')).toBeTruthy()
    expect(screen.getByText('+ Add')).toBeTruthy()
  })
})

describe('SpecialEventsScreen — create', () => {
  it('creates an event via the inline row (type = Event)', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())

    addViaInlineRow({ name: 'Color War', type: 'event' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const fields = localClient.write.mock.calls.map((c) => c[3])
    expect(fields[0]).toBe('name')
    // No special_days write for an event.
    expect(localClient.write.mock.calls.some((c) => c[1] === 'special_days')).toBe(false)
  })

  it('creates a special day via the inline row (type = Special Day) AND shows the seed prompt', async () => {
    localClient.list.mockImplementation(byEntity(emptyEntries))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())

    addViaInlineRow({ name: 'Visiting Day', type: 'day' })

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'special_days', expect.any(String), 'name', 'Visiting Day'))
    // Seed-from-time-blocks prompt still fires when a Special Day is created inline.
    await waitFor(() => expect(screen.queryByText(/Seed from Time Blocks/)).not.toBeNull())
  })

  it('lists both kinds as table rows with correct type tags', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()], special_days: [dayRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.queryByText('Color War')).not.toBeNull())
    expect(screen.getByText('Visiting Day')).toBeTruthy()
    // Type tags render as chip <span>s on the rows (distinct from the add-row
    // <option>s that share the same label text).
    const eventTag = screen.getAllByText('Event').filter((el) => el.tagName === 'SPAN')
    const dayTag = screen.getAllByText('Special Day').filter((el) => el.tagName === 'SPAN')
    expect(eventTag.length).toBe(1)
    expect(dayTag.length).toBe(1)
  })

  it('clicking a row opens that item’s detail', async () => {
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, events: [eventRow()] }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('Color War')).not.toBeNull())

    fireEvent.click(screen.getByText('Color War'))
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
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

    fireEvent.click(screen.getByText('Build the schedule →'))
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

    fireEvent.click(screen.getByText('Build the schedule →'))
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

// Ported from the retired EventScreen.test.jsx "location picker" describe block
// (git show 26e53ee^:src/screens/EventScreen.test.jsx). W7b: the location_id
// picker on the event's own detail card. The LocationPicker is carried into
// EventDetail here verbatim, so these assertions re-home unchanged behavior.
describe('SpecialEventsScreen — event detail location picker (location_id)', () => {
  it('selecting a location on the event detail writes events.location_id', async () => {
    localClient.list.mockImplementation(byEntity({
      ...emptyEntries,
      events: [eventRow()],
      locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Field House', capacity: 4, notes: null }],
    }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'event', id: 'ev-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText("Search your camp's locations…"), { target: { value: 'Field' } })
    fireEvent.mouseDown(await screen.findByText('Field House'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith(
      'token-abc', 'events', 'ev-1', 'location_id', 'loc-1'
    ))
  })

  it('an event whose location_id points at a deleted location shows the C5 dangling warning', async () => {
    localClient.list.mockImplementation(byEntity({
      ...emptyEntries,
      events: [eventRow({ location_id: 'loc-GONE' })],
      locations: [{ id: 'loc-1', camp_id: CAMP_ID, name: 'Field House', capacity: 4, notes: null }],
    }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" initialFocus={{ type: 'event', id: 'ev-1' }} />)
    await waitFor(() => expect(screen.getByText('← Back to Special Events')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByText('The location set here no longer exists — pick a new one.')).not.toBeNull()
    )
  })
})

// Ported from the retired SpecialDaysScreen.test.jsx "seed from camp time
// blocks" describe block (git show 26e53ee^:src/screens/SpecialDaysScreen.test
// .jsx). seedFromCampTimeBlocks is carried into SpecialEventsScreen verbatim.
describe('SpecialEventsScreen — seed from camp time blocks', () => {
  it('copies camp time_blocks into NEW special_day_time_blocks rows with minted ids, never touching the camp time_blocks table', async () => {
    const campBlocks = [
      { id: 'camp-tb-1', camp_id: CAMP_ID, cohort_id: 'cohort-1', name: 'Morning', sort_order: 0, start_time: '09:00:00', end_time: '10:00:00' },
    ]
    localClient.list.mockImplementation(byEntity({ ...emptyEntries, time_blocks: campBlocks }))
    render(<SpecialEventsScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.queryByText('No special events yet.')).not.toBeNull())

    addViaInlineRow({ name: 'Color War', type: 'day' })
    await waitFor(() => expect(screen.queryByText(/Seed from Time Blocks/)).not.toBeNull())

    fireEvent.click(screen.getByText(/Seed from Time Blocks/))

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, id, field, value]) =>
        entity === 'special_day_time_blocks' && field === 'special_day_id' && id === 'new-id-1' && value === 'new-id-0'
      )).toBe(true)
      expect(calls.some(([, entity, , field, value]) =>
        entity === 'special_day_time_blocks' && field === 'name' && value === 'Morning'
      )).toBe(true)
    })

    // The seed never writes to the camp's own `time_blocks` table — a
    // one-shot COPY, not an ongoing storage relationship.
    const calls = localClient.write.mock.calls
    expect(calls.some(([, entity]) => entity === 'time_blocks')).toBe(false)
  })

  it('reports partial completion when seeding fails partway through (non-atomic, design-accepted)', () => {
    expect(seedFailureMessage(1, 2)).toBe(
      'Only seeded 1 of 2 time blocks before hitting an error — the rest were not added.'
    )
  })

  it('falls back to the plain message when nothing seeded before the error', () => {
    expect(seedFailureMessage(0, 2)).toBe('Could not seed time blocks.')
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
