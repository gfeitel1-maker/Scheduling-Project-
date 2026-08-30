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
    expect(screen.queryByTitle('Split this back into two periods')).toBeNull()
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
    const box = await screen.findByPlaceholderText('Type an activity…')
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

describe('SpecialDayGridEditor — back control', () => {
  it('renders the corrected "← Back to Special Schedules" label (returns to the picker list)', async () => {
    baseFixtures({})
    render(<SpecialDayGridEditor campId={CAMP_ID} specialDayId={SD_ID} onBack={() => {}} onDeletedElsewhere={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('← Back to Special Schedules')[0]).toBeTruthy())
  })
})
