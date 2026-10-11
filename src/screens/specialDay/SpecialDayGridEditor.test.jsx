// @vitest-environment jsdom
//
// T106 (docs/work/tickets/T106-special-day-author-ui.md;
// docs/work/specs/2026-08-21-special-day-author-ui-design.md "Test seams").
//
// Covers:
//  - stub-slot render: no console errors, no stray flag/merge/elective UI
//    (proves SlotCell/EmptyCell degrade safely on special-day slots)
//  - placement-path isolation: the special-day flow writes
//    special_day_slots.activity_id directly and NEVER calls
//    placeActivityManual or writes to template_slots/schedule_templates
//  - all camp groups, no cohort filter
//  - dangling-reference fallbacks: "Activity (removed)" / removed-group
//    column behavior
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

import SpecialDayGridEditor from './SpecialDayGridEditor'
import { localClient } from '../../localClient'

const CAMP_ID = 'camp-1'
const SD_ID = 'sd-1'

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

function baseFixtures({ slots = [], groups, activities = [], locations = [] } = {}) {
  const defaultGroups = groups ?? [
    { id: 'g1', camp_id: CAMP_ID, name: 'Bunk A' },
    { id: 'g2', camp_id: CAMP_ID, name: 'Bunk B' },
  ]
  localClient.list.mockImplementation((entity) => {
    if (entity === 'special_days') return Promise.resolve([{ id: SD_ID, camp_id: CAMP_ID, name: 'Color War' }])
    if (entity === 'special_day_time_blocks') {
      return Promise.resolve([{ id: 'tb1', special_day_id: SD_ID, name: 'Opening', sort_order: 0 }])
    }
    if (entity === 'special_day_slots') return Promise.resolve(slots)
    if (entity === 'groups') return Promise.resolve(defaultGroups)
    if (entity === 'activities') return Promise.resolve(activities)
    if (entity === 'locations') return Promise.resolve(locations)
    return Promise.resolve([])
  })
}

describe('SpecialDayGridEditor — safe degradation on stub special-day slots', () => {
  it('renders a filled cell with no console errors and no stray flag/merge/elective UI', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    baseFixtures({
      slots: [{ id: 'sl1', special_day_id: SD_ID, group_id: 'g1', time_block_id: 'tb1', activity_id: 'act1', location_id: null }],
      activities: [{ id: 'act1', camp_id: CAMP_ID, name: 'Capture the Flag' }],
    })

    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())

    expect(errorSpy).not.toHaveBeenCalled()
    // No merge/split affordances (title text from SlotCell's ExpandGlyph buttons)
    expect(screen.queryByTitle('Let this activity run into the next period')).toBeNull()
    expect(screen.queryByTitle('Split')).toBeNull()
    // No elective/flag markup
    expect(document.querySelector('.flag--overlap')).toBeNull()
    expect(document.querySelector('.flag--week-closed')).toBeNull()
    expect(document.querySelector('[data-elective]')).toBeNull()
    errorSpy.mockRestore()
  })
})

describe('SpecialDayGridEditor — placement path isolation (Red Hat-relevant)', () => {
  it('writes special_day_slots.activity_id directly and never touches template_slots/schedule_templates', async () => {
    baseFixtures({ slots: [] })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    // Double-click to open the inline editor (WS5 Excel-style double-click-to-
    // edit — EmptyCell/SlotCell are shared, so this grid follows the same rule).
    fireEvent.doubleClick(screen.getAllByText('Open')[0])
    const box = await screen.findByPlaceholderText('Activity')
    fireEvent.change(box, { target: { value: 'Capture the Flag' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => {
      const calls = localClient.write.mock.calls
      expect(calls.some(([, entity, , field]) => entity === 'special_day_slots' && field === 'activity_id')).toBe(true)
    })

    const calls = localClient.write.mock.calls
    expect(calls.some(([, entity]) => entity === 'template_slots')).toBe(false)
    expect(calls.some(([, entity]) => entity === 'schedule_templates')).toBe(false)
  })
})

describe('SpecialDayGridEditor — all camp groups, no cohort filter', () => {
  it('renders every camp group as a column regardless of cohort', async () => {
    baseFixtures({
      groups: [
        { id: 'g1', camp_id: CAMP_ID, name: 'Bunk A', cohort_id: 'cohort-1' },
        { id: 'g2', camp_id: CAMP_ID, name: 'Bunk B', cohort_id: 'cohort-2' },
        { id: 'g3', camp_id: CAMP_ID, name: 'Bunk C', cohort_id: null },
      ],
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Bunk A')).toBeTruthy())
    expect(screen.getByText('Bunk B')).toBeTruthy()
    expect(screen.getByText('Bunk C')).toBeTruthy()
  })
})

describe('SpecialDayGridEditor — live-delete-while-editing (Red Hat/Code Reviewer MEDIUM)', () => {
  it('redirects via onDeletedElsewhere when the open special day is tombstoned by another device, with no write-failure banner', async () => {
    baseFixtures({ slots: [] })
    const onDeletedElsewhere = vi.fn()
    render(
      <SpecialDayGridEditor
        campId={CAMP_ID}
        specialDayId={SD_ID}
        onBack={() => {}}
        onDeletedElsewhere={onDeletedElsewhere}
      />
    )
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    expect(localClient.onOpApplied).toHaveBeenCalled()
    const opHandler = localClient.onOpApplied.mock.calls[0][0]
    opHandler({ entity: 'special_days', entity_id: SD_ID, field: '__deleted__', value: 1, device_id: 'other-device' })

    await waitFor(() => expect(onDeletedElsewhere).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/could not|failed/i)).toBeNull()
  })

  it('does not redirect on an unrelated op (different entity or a different row)', async () => {
    baseFixtures({ slots: [] })
    const onDeletedElsewhere = vi.fn()
    render(
      <SpecialDayGridEditor
        campId={CAMP_ID}
        specialDayId={SD_ID}
        onBack={() => {}}
        onDeletedElsewhere={onDeletedElsewhere}
      />
    )
    await waitFor(() => expect(screen.getAllByText('Open').length).toBeGreaterThan(0))

    const opHandler = localClient.onOpApplied.mock.calls[0][0]
    opHandler({ entity: 'special_day_time_blocks', entity_id: 'tb1', field: '__deleted__', value: 1 })
    opHandler({ entity: 'special_days', entity_id: 'some-other-day', field: '__deleted__', value: 1 })
    opHandler({ entity: 'special_days', entity_id: SD_ID, field: 'name', value: 'Renamed' })

    expect(onDeletedElsewhere).not.toHaveBeenCalled()
  })
})

describe('SpecialDayGridEditor — remove-block confirm guard (Code Reviewer + Tester coverage gap)', () => {
  it('asks for confirmation when the block has filled cells, and skips the delete if declined', async () => {
    baseFixtures({
      slots: [{ id: 'sl1', special_day_id: SD_ID, group_id: 'g1', time_block_id: 'tb1', activity_id: 'act1', location_id: null }],
      activities: [{ id: 'act1', camp_id: CAMP_ID, name: 'Capture the Flag' }],
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Capture the Flag')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Remove block'))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith('Remove block and its 1 cell?')
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('deletes without prompting when the block has no filled cells', async () => {
    baseFixtures({ slots: [] })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('Remove block')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Remove block'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'special_day_time_blocks', 'tb1'))
    expect(confirmSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})

describe('SpecialDayGridEditor — dangling-reference fallbacks', () => {
  it('renders "Activity (removed)" when a slot references a deleted activity', async () => {
    baseFixtures({
      slots: [{ id: 'sl1', special_day_id: SD_ID, group_id: 'g1', time_block_id: 'tb1', activity_id: 'gone', location_id: null }],
      activities: [], // the activity is not in the loaded list — deleted
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Activity (removed)')).toBeTruthy())
  })

  it('renders "Location (removed)" when a filled cell references a deleted location', async () => {
    baseFixtures({
      slots: [{ id: 'sl1', special_day_id: SD_ID, group_id: 'g1', time_block_id: 'tb1', activity_id: 'act1', location_id: 'gone-loc' }],
      activities: [{ id: 'act1', camp_id: CAMP_ID, name: 'Swim' }],
      locations: [], // the location is not in the loaded list — deleted
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Location (removed)')).toBeTruthy())
  })

  it('removes a group column entirely when the group has been deleted (not rendered as a dangling column)', async () => {
    // A slot references a group id that is no longer in the loaded `groups`
    // list — the grid must not render an orphan column for it, only for the
    // groups that still exist.
    baseFixtures({
      groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A' }],
      slots: [{ id: 'sl1', special_day_id: SD_ID, group_id: 'deleted-group', time_block_id: 'tb1', activity_id: 'act1', location_id: null }],
      activities: [{ id: 'act1', camp_id: CAMP_ID, name: 'Swim' }],
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Bunk A')).toBeTruthy())
    expect(screen.queryByText('Swim')).toBeNull()
    // Only one group column header should be present.
    expect(screen.getAllByRole('columnheader').filter(el => el.textContent !== 'Block')).toHaveLength(1)
  })
})

describe('SpecialDayGridEditor — T350 slice 5', () => {
  it('renders the Placed on strip under the title', async () => {
    baseFixtures()
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    expect(await screen.findByRole('button', { name: '+ Place on a day' })).toBeTruthy()
    expect(screen.getByText('Placed on')).toBeTruthy()
  })

  it('a failed write is an inline role="alert" line, not a filled banner', async () => {
    baseFixtures()
    localClient.write.mockResolvedValue({ status: 'rejected' })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    fireEvent.click(await screen.findByText('+ Add Block'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not add a time block.')
    expect(alert.style.background).toBe('')
    expect(alert.style.border).toBe('')
  })
})

describe('SpecialDayGridEditor — back control', () => {
  it('renders the corrected "← Special Schedules" label (returns to the picker list)', async () => {
    baseFixtures({})
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('← Special Schedules')[0]).toBeTruthy())
  })
})

describe('SpecialDayGridEditor — block times (packaged audit #30)', () => {
  it('shows a seeded block’s start/end time with AM/PM beside its name', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: SD_ID, camp_id: CAMP_ID, name: 'Color War' }])
      if (entity === 'special_day_time_blocks') {
        return Promise.resolve([{ id: 'tb1', special_day_id: SD_ID, name: 'Opening', sort_order: 0, start_time: '09:00', end_time: '13:15' }])
      }
      if (entity === 'groups') return Promise.resolve([{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A' }])
      return Promise.resolve([])
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('9:00 AM–1:15 PM')).toBeTruthy())
    expect(screen.getByText('9:00 AM–1:15 PM').closest('.block-name').textContent).toBe('Opening9:00 AM–1:15 PM')
  })
})

describe('SpecialDayGridEditor — Copy time blocks on an empty special schedule', () => {
  const campBlocks = [
    { id: 'cb1', camp_id: CAMP_ID, name: 'Morning', sort_order: 0, start_time: '09:00', end_time: '10:00' },
    { id: 'cb2', camp_id: CAMP_ID, name: 'Afternoon', sort_order: 1, start_time: '13:00', end_time: '14:00' },
  ]
  let specialBlocks
  function emptyDayFixtures() {
    specialBlocks = []
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: SD_ID, camp_id: CAMP_ID, name: 'Color War' }])
      if (entity === 'special_day_time_blocks') return Promise.resolve(specialBlocks)
      if (entity === 'time_blocks') return Promise.resolve(campBlocks)
      if (entity === 'groups') return Promise.resolve([{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk A' }])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((_t, entity, id, field, value) => {
      if (entity === 'special_day_time_blocks') {
        let row = specialBlocks.find((b) => b.id === id)
        if (!row) { row = { id }; specialBlocks.push(row) }
        row[field] = value
      }
      return Promise.resolve({ status: 'applied' })
    })
  }

  it('offers the action when there are no blocks, copies the camp blocks on click, then hides it', async () => {
    emptyDayFixtures()
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)

    const copy = await screen.findByRole('button', { name: 'Copy time blocks' })
    fireEvent.click(copy)

    await waitFor(() => expect(screen.getByText('Morning')).toBeTruthy())
    expect(screen.getByText('Afternoon')).toBeTruthy()
    expect(specialBlocks.map((b) => b.name)).toEqual(['Morning', 'Afternoon'])
    expect(specialBlocks.every((b) => b.special_day_id === SD_ID)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Copy time blocks' })).toBeNull()
  })

  it('does not offer the action once the special day has blocks', async () => {
    baseFixtures()
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getByText('Opening')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Copy time blocks' })).toBeNull()
  })

  it('clears the not-placed note once the day is placed', async () => {
    emptyDayFixtures()
    const listeners = []
    localClient.onOpApplied.mockImplementation((cb) => { listeners.push(cb); return () => {} })
    const base = localClient.list.getMockImplementation()
    localClient.list.mockImplementation((entity) => {
      if (entity === 'fixed_events') return Promise.resolve([{ id: 'f1', camp_id: CAMP_ID, kind: 'recurring', name: 'Lunch 2', day_id: 'mon', time_block_id: 'cb1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a1', span_blocks: 1 }])
      if (entity === 'days_of_operation') return Promise.resolve([{ id: 'mon', camp_id: CAMP_ID, label: 'Monday' }, { id: 'tue', camp_id: CAMP_ID, label: 'Tuesday' }])
      return base(entity)
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy time blocks' }))
    expect(await screen.findByText(/Lunch waves differ by weekday/)).toBeTruthy()
    listeners.forEach((cb) => cb({ entity: 'special_day_placements', entity_id: 'p', field: 'week_id' }))
    await waitFor(() => expect(screen.queryByText(/Lunch waves differ by weekday/)).toBeNull())
  })

  it('shows no weekday note when every event is every-day', async () => {
    emptyDayFixtures()
    const base = localClient.list.getMockImplementation()
    localClient.list.mockImplementation((entity) => {
      if (entity === 'fixed_events') return Promise.resolve([{ id: 'f1', camp_id: CAMP_ID, kind: 'fixed', name: 'Carpool', day_id: null, time_block_id: 'cb1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a1', span_blocks: 1 }])
      return base(entity)
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy time blocks' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy time blocks' })).toBeNull())
    expect(screen.queryByText(/Lunch waves differ by weekday/)).toBeNull()
  })

  it('two rapid Bring clicks write one set of cells, and two rapid Copy clicks copy once', async () => {
    emptyDayFixtures()
    const base = localClient.list.getMockImplementation()
    const slots = []
    localClient.list.mockImplementation((entity) => {
      if (entity === 'fixed_events') return Promise.resolve([{ id: 'f1', camp_id: CAMP_ID, kind: 'recurring', name: 'Group Time', day_id: 'mon', time_block_id: 'cb1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a1', span_blocks: 1 }])
      if (entity === 'days_of_operation') return Promise.resolve([{ id: 'mon', camp_id: CAMP_ID, label: 'Monday' }, { id: 'tue', camp_id: CAMP_ID, label: 'Tuesday' }])
      if (entity === 'special_day_placements') return Promise.resolve([{ id: 'p', week_id: 'w', day_id: 'mon', special_day_id: SD_ID }])
      if (entity === 'special_day_slots') return Promise.resolve(slots)
      return base(entity)
    })
    const baseWrite = localClient.write.getMockImplementation()
    localClient.write.mockImplementation(async (t, entity, id, field, value) => {
      await new Promise((r) => setTimeout(r, 5))
      if (entity === 'special_day_slots') {
        let row = slots.find((x) => x.id === id)
        if (!row) { row = { id }; slots.push(row) }
        row[field] = value
      }
      return baseWrite(t, entity, id, field, value)
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    const copy = await screen.findByRole('button', { name: 'Copy time blocks' })
    fireEvent.click(copy)
    fireEvent.click(copy)
    await screen.findByText('Also bring 1 recurring event from Monday?')
    expect(specialBlocks).toHaveLength(2)
    const bring = screen.getByRole('button', { name: 'Bring' })
    fireEvent.click(bring)
    fireEvent.click(bring)
    await waitFor(() => expect(screen.queryByText(/Also bring/)).toBeNull())
    expect(slots.filter((x) => x.activity_id === 'a1')).toHaveLength(1)
  })

  it('offers recurring events after the copy and places them when the director clicks Bring', async () => {
    emptyDayFixtures()
    const base = localClient.list.getMockImplementation()
    const slotWrites = []
    localClient.list.mockImplementation((entity) => {
      if (entity === 'fixed_events') return Promise.resolve([{ id: 'f1', camp_id: CAMP_ID, kind: 'recurring', name: 'Group Time', day_id: 'mon', time_block_id: 'cb1', is_all_groups: 1, group_ids: '[]', unit_ids: '[]', activity_id: 'a1', span_blocks: 1 }])
      if (entity === 'days_of_operation') return Promise.resolve([{ id: 'mon', camp_id: CAMP_ID, label: 'Monday' }, { id: 'tue', camp_id: CAMP_ID, label: 'Tuesday' }])
      if (entity === 'special_day_placements') return Promise.resolve([{ id: 'p', week_id: 'w', day_id: 'mon', special_day_id: SD_ID }])
      return base(entity)
    })
    const baseWrite = localClient.write.getMockImplementation()
    localClient.write.mockImplementation((t, entity, id, field, value) => {
      if (entity === 'special_day_slots') slotWrites.push(field)
      return baseWrite(t, entity, id, field, value)
    })
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy time blocks' }))

    expect(await screen.findByText('Also bring 1 recurring event from Monday?')).toBeTruthy()
    expect(slotWrites).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Bring' }))
    await waitFor(() => expect(slotWrites).toContain('activity_id'))
    expect(screen.queryByText(/Also bring/)).toBeNull()
  })
})
