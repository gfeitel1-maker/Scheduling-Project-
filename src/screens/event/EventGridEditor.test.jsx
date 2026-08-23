// @vitest-environment jsdom
//
// Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-internal-
// subschedule.md; docs/work/specs/2026-08-22-event-internal-subschedule-
// slices.md Step 4). Mirrors SpecialDayGridEditor.test.jsx's shape, plus new
// coverage for the column axis (event_groups) this editor adds:
// addEventGroup/renameEventGroup/moveEventGroup/removeEventGroup, and the
// first-entry seed from the camp's groups/time_blocks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    onOpApplied: vi.fn(() => () => {}),
  },
}))

vi.mock('../../ingest/textGrid', () => ({ parseTextGrid: vi.fn() }))
vi.mock('../../ingest/parseGridSchedule', () => ({ parseGridSchedule: vi.fn() }))
vi.mock('../../ingest/eventGridPopulate', () => ({ populateEventGrid: vi.fn() }))

import EventGridEditor from './EventGridEditor'
import { localClient } from '../../localClient'
import { parseTextGrid } from '../../ingest/textGrid'
import { parseGridSchedule } from '../../ingest/parseGridSchedule'
import { populateEventGrid } from '../../ingest/eventGridPopulate'

const CAMP_ID = 'camp-1'
const EVT_ID = 'evt-1'

let idCounter
beforeEach(() => {
  idCounter = 0
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => `new-id-${idCounter++}` })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockReturnValue(() => {})
})

function baseFixtures({
  slots = [],
  eventGroups,
  eventTimeBlocks,
  campGroups = [],
  campTimeBlocks = [],
  activities = [],
  locations = [],
} = {}) {
  const defaultEventGroups = eventGroups ?? [
    { id: 'eg1', event_id: EVT_ID, name: 'Blue Team', sort_order: 0 },
    { id: 'eg2', event_id: EVT_ID, name: 'Red Team', sort_order: 1 },
  ]
  const defaultBlocks = eventTimeBlocks ?? [
    { id: 'tb1', event_id: EVT_ID, name: 'Station 1', sort_order: 0 },
  ]
  localClient.list.mockImplementation((entity) => {
    if (entity === 'events') return Promise.resolve([{ id: EVT_ID, camp_id: CAMP_ID, name: 'Color War' }])
    if (entity === 'event_time_blocks') return Promise.resolve(defaultBlocks)
    if (entity === 'event_groups') return Promise.resolve(defaultEventGroups)
    if (entity === 'event_slots') return Promise.resolve(slots)
    if (entity === 'groups') return Promise.resolve(campGroups)
    if (entity === 'time_blocks') return Promise.resolve(campTimeBlocks)
    if (entity === 'activities') return Promise.resolve(activities)
    if (entity === 'locations') return Promise.resolve(locations)
    return Promise.resolve([])
  })
}

describe('EventGridEditor — placement path isolation (Red Hat-relevant)', () => {
  it('writes event_slots.activity_id directly and never touches template_slots/schedule_templates', async () => {
    baseFixtures({ slots: [] })
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByText('Open')[0])
    const box = await screen.findByPlaceholderText('Type an activity…')
    fireEvent.change(box, { target: { value: 'Capture the Flag' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, , field]) => entity === 'event_slots' && field === 'activity_id')).toBe(true)
    })

    const calls = localClient.write.mock.calls
    expect(calls.some(([, entity]) => entity === 'template_slots')).toBe(false)
    expect(calls.some(([, entity]) => entity === 'schedule_templates')).toBe(false)
    // event_slots keyed by event_group_id, not group_id.
    const slotWrite = calls.find(([, entity, , field]) => entity === 'event_slots' && field === 'event_group_id')
    expect(slotWrite).toBeTruthy()
  })
})

describe('EventGridEditor — column axis (event_groups), new capability', () => {
  it('renders every event_group as a column', async () => {
    baseFixtures({})
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())
    expect(screen.getByText('Red Team')).toBeTruthy()
  })

  it('addEventGroup writes event_id/name/sort_order and appends a column', async () => {
    baseFixtures({})
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())

    fireEvent.click(screen.getByText('+ Add Group'))

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, , field]) => entity === 'event_groups' && field === 'event_id')).toBe(true)
    })
    expect(await screen.findByText('New Group')).toBeTruthy()
  })

  it('renameEventGroup writes the new name', async () => {
    baseFixtures({})
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())

    fireEvent.click(screen.getByText('Blue Team'))
    const input = screen.getByDisplayValue('Blue Team')
    fireEvent.change(input, { target: { value: 'Green Team' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, id, field, value]) =>
        entity === 'event_groups' && id === 'eg1' && field === 'name' && value === 'Green Team'
      )).toBe(true)
    })
  })

  it('moveEventGroup swaps sort_order between two groups', async () => {
    baseFixtures({})
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())

    fireEvent.click(screen.getAllByTitle('Move right')[0])

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, id, field, value]) =>
        entity === 'event_groups' && id === 'eg1' && field === 'sort_order' && value === 1
      )).toBe(true)
      expect(calls.some(([, entity, id, field, value]) =>
        entity === 'event_groups' && id === 'eg2' && field === 'sort_order' && value === 0
      )).toBe(true)
    })
  })

  it('removeEventGroup asks for confirmation when the group has filled cells, and skips the delete if declined', async () => {
    baseFixtures({
      slots: [{ id: 'sl1', event_id: EVT_ID, event_group_id: 'eg1', time_block_id: 'tb1', activity_id: 'act1', location_id: null }],
      activities: [{ id: 'act1', camp_id: CAMP_ID, name: 'Capture the Flag' }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())

    fireEvent.click(screen.getAllByTitle('Remove group')[0])

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('removes an empty group without prompting', async () => {
    baseFixtures({ slots: [] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByTitle('Remove group').length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByTitle('Remove group')[0])

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'event_groups', 'eg1'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('EventGridEditor — first-entry seed from the camp', () => {
  it('seeds event_time_blocks and event_groups from the camp when the event has zero of each', async () => {
    baseFixtures({
      eventGroups: [],
      eventTimeBlocks: [],
      campGroups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A', sort_order: 0 }],
      campTimeBlocks: [{ id: 'tb1', camp_id: CAMP_ID, name: 'Morning', sort_order: 0, start_time: '09:00' }],
    })
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)

    await waitFor(() => expect(screen.getByText('Bunk A')).toBeTruthy())
    expect(screen.getByText('Morning')).toBeTruthy()

    const calls = localClient.write.mock.calls
    expect(calls.some(([, entity, , field, value]) => entity === 'event_groups' && field === 'name' && value === 'Bunk A')).toBe(true)
    expect(calls.some(([, entity, , field, value]) => entity === 'event_time_blocks' && field === 'name' && value === 'Morning')).toBe(true)
  })

  it('does not seed when the event already has time blocks or groups', async () => {
    baseFixtures({})
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Blue Team')).toBeTruthy())

    const calls = localClient.write.mock.calls
    expect(calls.some(([, entity]) => entity === 'event_groups' || entity === 'event_time_blocks')).toBe(false)
  })

  it('seeds only the still-empty axis when one axis already has a row (Red Hat MEDIUM, per-axis guard)', async () => {
    baseFixtures({
      // event_groups already has one row (director added it by hand); event_time_blocks is still empty.
      eventGroups: [{ id: 'eg-existing', event_id: EVT_ID, name: 'Blue Team', sort_order: 0 }],
      eventTimeBlocks: [],
      campGroups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A', sort_order: 0 }],
      campTimeBlocks: [{ id: 'tb1', camp_id: CAMP_ID, name: 'Morning', sort_order: 0 }],
    })
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)

    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())
    expect(screen.getByText('Blue Team')).toBeTruthy()

    const calls = localClient.write.mock.calls
    // Blocks axis seeded from the camp.
    expect(calls.some(([, entity, , field, value]) => entity === 'event_time_blocks' && field === 'name' && value === 'Morning')).toBe(true)
    // Groups axis was NOT re-seeded — no write ever names a group "Bunk A".
    expect(calls.some(([, entity, , field, value]) => entity === 'event_groups' && field === 'name' && value === 'Bunk A')).toBe(false)
  })

  it('derives deterministic seed ids from (eventId, source camp entity id, axis) so two seed passes converge instead of duplicating', async () => {
    baseFixtures({
      eventGroups: [],
      eventTimeBlocks: [],
      campGroups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A', sort_order: 0 }],
      campTimeBlocks: [{ id: 'tb1', camp_id: CAMP_ID, name: 'Morning', sort_order: 0 }],
    })
    const { unmount } = render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Bunk A')).toBeTruthy())

    const firstPassIds = localClient.write.mock.calls
      .filter(([, entity]) => entity === 'event_groups' || entity === 'event_time_blocks')
      .map(([, , id]) => id)
    unmount()
    localClient.write.mockClear()

    // A second seed pass (a second device, or a remount before the write lands) with the
    // SAME camp inputs must mint the SAME ids — not crypto.randomUUID().
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Bunk A')).toBeTruthy())
    const secondPassIds = localClient.write.mock.calls
      .filter(([, entity]) => entity === 'event_groups' || entity === 'event_time_blocks')
      .map(([, , id]) => id)

    expect(new Set(secondPassIds)).toEqual(new Set(firstPassIds))
    expect(firstPassIds.every((id) => !id.startsWith('new-id-'))).toBe(true)
  })
})

describe('EventGridEditor — live-delete-while-editing', () => {
  it('redirects via onDeletedElsewhere when the open event is tombstoned by another device', async () => {
    baseFixtures({ slots: [] })
    const onDeletedElsewhere = vi.fn()
    render(
      <EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={onDeletedElsewhere} />
    )
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    expect(localClient.onOpApplied).toHaveBeenCalled()
    const opHandler = localClient.onOpApplied.mock.calls[0][0]
    opHandler({ entity: 'events', entity_id: EVT_ID, field: '__deleted__', value: 1, device_id: 'other-device' })

    await waitFor(() => expect(onDeletedElsewhere).toHaveBeenCalledTimes(1))
  })
})

describe('EventGridEditor — grid-schedule import affordance (docs/adr/2026-08-22-event-schedule-import.md)', () => {
  beforeEach(() => {
    parseTextGrid.mockReset()
    parseGridSchedule.mockReset()
    populateEventGrid.mockReset()
  })

  it('renders the import affordance when the grid has no placed activities', async () => {
    baseFixtures({ slots: [] })
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))
    expect(screen.getByText(/import this event’s schedule from a file/)).toBeTruthy()
  })

  it('does not render the import affordance once the grid has a placed activity', async () => {
    baseFixtures({
      slots: [{ id: 's1', event_id: EVT_ID, event_group_id: 'eg1', time_block_id: 'tb1', activity_id: 'act-1' }],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Capture the Flag' }],
    })
    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())
    expect(screen.queryByText(/import this event’s schedule from a file/)).toBeNull()
  })

  it('file -> parse -> populate wiring: selecting a file runs parseTextGrid -> parseGridSchedule -> populateEventGrid, then reloads', async () => {
    baseFixtures({ slots: [] })
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['Kinders'], rows: [{ label: '9:30-10:10', cells: ['Swim'] }] }] })
    const parsed = {
      orientation: { axis: 'rows-are-time', confident: true },
      timeAxis: [{ name: '9:30-10:10', start_time: '09:30', end_time: '10:10', sourceIndex: 0 }],
      groupAxis: [{ name: 'Kinders', sourceIndex: 0 }],
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null }],
      unmapped: [],
    }
    parseGridSchedule.mockReturnValue(parsed)
    populateEventGrid.mockResolvedValue({ ok: true, unmapped: [] })

    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    const importButton = screen.getByText(/import this event’s schedule from a file/)
    fireEvent.click(importButton)
    const file = new File(['irrelevant'], 'schedule.txt', { type: 'text/plain' })
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(populateEventGrid).toHaveBeenCalledTimes(1))
    expect(parseGridSchedule).toHaveBeenCalledWith([{ title: 'x', columns: ['Kinders'], rows: [{ label: '9:30-10:10', cells: ['Swim'] }] }])
    const [passedParsed, ctx] = populateEventGrid.mock.calls[0]
    expect(passedParsed).toBe(parsed)
    expect(ctx.eventId).toBe(EVT_ID)
    expect(ctx.campId).toBe(CAMP_ID)
    // reload happened after a successful import
    await waitFor(() => expect(localClient.list.mock.calls.filter(([e]) => e === 'event_slots').length).toBeGreaterThan(1))
  })

  it('not-confident orientation refuses and surfaces the ADR §5.2 message, writes nothing new', async () => {
    baseFixtures({ slots: [] })
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['A'], rows: [{ label: 'Monday', cells: ['Art'] }] }] })
    parseGridSchedule.mockReturnValue({ orientation: { axis: null, confident: false }, timeAxis: [], groupAxis: [], cells: [], unmapped: [] })
    populateEventGrid.mockResolvedValue({ ok: false, reason: "Couldn't tell which side of this file is the schedule's times. Check that the file has a clear time column or time row, and try again." })

    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'schedule.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(screen.getByText(/Couldn.t tell which side of this file/)).toBeTruthy())
  })

  it('partial parse: renders the unmapped summary without treating it as a failure', async () => {
    baseFixtures({ slots: [] })
    parseTextGrid.mockReturnValue({ pages: [{ title: 'x', columns: ['A'], rows: [{ label: '9:30-10:10', cells: ['Swim'] }] }] })
    parseGridSchedule.mockReturnValue({
      orientation: { axis: 'rows-are-time', confident: true },
      timeAxis: [{ name: '9:30-10:10', start_time: '09:30', end_time: '10:10', sourceIndex: 0 }],
      groupAxis: [{ name: 'A', sourceIndex: 0 }],
      cells: [{ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: 'Field' }],
      unmapped: [],
    })
    populateEventGrid.mockResolvedValue({ ok: true, unmapped: [{ sourceExcerpt: 'Field', reason: 'no matching location for this cell' }] })

    render(<EventGridEditor campId={CAMP_ID} eventId={EVT_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'schedule.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(screen.getByText(/couldn.t be fully matched/)).toBeTruthy())
  })
})
