// @vitest-environment jsdom
//
// docs/work/specs/2026-08-23-schedule-build-ia.md — the Schedule-side build
// entry: a picker listing authored special days + events, grouped the same
// way Roots's "Special Schedule" heading groups them, opening the EXISTING
// SpecialDayGridEditor/EventGridEditor unchanged on selection.
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

import SpecialSchedulesScreen from './SpecialSchedulesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
}

const BASE = {
  special_days: [],
  special_day_time_blocks: [],
  special_day_slots: [],
  groups: [],
  events: [],
  event_time_blocks: [],
  event_groups: [],
  event_slots: [],
  template_slots: [],
  days_of_operation: [],
  activities: [],
  locations: [],
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
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.onOpApplied.mockReset().mockReturnValue(() => {})
})

describe('SpecialSchedulesScreen — empty state', () => {
  it('shows a single-line message and a link back to Roots when nothing is authored', async () => {
    localClient.list.mockImplementation(byEntity(BASE))
    const onNavigate = vi.fn()
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)

    await waitFor(() => expect(screen.getByText(/No special days or events yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Go to Roots'))
    expect(onNavigate).toHaveBeenCalledWith('roots')
  })
})

describe('SpecialSchedulesScreen — list, grouped', () => {
  it('lists special days and events in two sub-groups, sorted by name, with no badge/urgency marker', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      special_days: [
        { id: 'sd-2', camp_id: CAMP_ID, name: 'Zeta Day' },
        { id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' },
      ],
      events: [
        { id: 'ev-1', camp_id: CAMP_ID, name: 'Banquet' },
      ],
    }))
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Special Days')).toBeTruthy())
    expect(screen.getByText('Events')).toBeTruthy()

    const names = screen.getAllByText(/Color War|Zeta Day|Banquet/).map((el) => el.textContent)
    expect(names.indexOf('Color War')).toBeLessThan(names.indexOf('Zeta Day'))

    // Not-started status for entities with no time blocks yet — never a
    // count badge (per resolved OQ1, no urgency marker).
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0)
  })

  it('shows completeness derived from slot fill state, reusing the same filled/total shape as the grid editors', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      special_days: [{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }],
      special_day_time_blocks: [{ id: 'tb1', special_day_id: 'sd-1', name: 'Morning', sort_order: 0 }],
      special_day_slots: [{ id: 'slot1', special_day_id: 'sd-1', group_id: 'g1', time_block_id: 'tb1', activity_id: 'act1' }],
      groups: [{ id: 'g1', camp_id: CAMP_ID, name: 'Bunk 1' }],
    }))
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Complete')).toBeTruthy())
  })
})

describe('SpecialSchedulesScreen — selecting a row opens the existing editor', () => {
  it('opens SpecialDayGridEditor unchanged when a special-day card is clicked', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      special_days: [{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }],
    }))
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())
    fireEvent.click(screen.getByText('Color War'))

    await waitFor(() => expect(screen.getAllByText('← Back to Special Schedules')[0]).toBeTruthy())
  })

  it('opens EventGridEditor unchanged when an event card is clicked, and Back returns to the picker list', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      events: [{ id: 'ev-1', camp_id: CAMP_ID, name: 'Banquet' }],
    }))
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Banquet')).toBeTruthy())
    fireEvent.click(screen.getByText('Banquet'))

    await waitFor(() => expect(screen.getAllByText('← Back to Special Schedules')[0]).toBeTruthy())
    fireEvent.click(screen.getAllByText('← Back to Special Schedules')[0])

    await waitFor(() => expect(screen.getByText('Banquet')).toBeTruthy())
  })

  it('opens directly to a pre-selected day when initialSelection is passed (Open button from Roots)', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      special_days: [
        { id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' },
        { id: 'sd-2', camp_id: CAMP_ID, name: 'Field Day' },
      ],
    }))
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" initialSelection={{ type: 'day', id: 'sd-1' }} />)

    await waitFor(() => expect(screen.getAllByText('← Back to Special Schedules')[0]).toBeTruthy())
  })
})

// Code Reviewer MEDIUM (round 2) — onDeletedElsewhere used to drop silently
// back to the list. Restored the old SpecialDaysScreen UX: return to the
// picker AND surface a quiet message, reusing the same toast treatment
// already used for the create-hint (S.errorBanner on a surface background,
// not an explainer banner).
describe('SpecialSchedulesScreen — onDeletedElsewhere surfaces a message', () => {
  it('shows "This special day was deleted." and returns to the list when the open day is gone', async () => {
    // First load has the day (so a selection can open it); the editor's own
    // reload (triggered by opening) reflects the live delete.
    let deleted = false
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve(deleted ? [] : [{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }])
      return Promise.resolve(BASE[entity] ?? [])
    })
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())

    deleted = true
    fireEvent.click(screen.getByText('Color War'))

    await waitFor(() => expect(screen.getByText('This special day was deleted.')).toBeTruthy())
    expect(screen.queryByText('← Back to Special Schedules')).toBeNull()
  })

  it('shows "This event was deleted." and returns to the list when the open event is gone', async () => {
    let deleted = false
    localClient.list.mockImplementation((entity) => {
      if (entity === 'events') return Promise.resolve(deleted ? [] : [{ id: 'ev-1', camp_id: CAMP_ID, name: 'Banquet' }])
      return Promise.resolve(BASE[entity] ?? [])
    })
    render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('Banquet')).toBeTruthy())

    deleted = true
    fireEvent.click(screen.getByText('Banquet'))

    await waitFor(() => expect(screen.getByText('This event was deleted.')).toBeTruthy())
    expect(screen.queryByText('← Back to Special Schedules')).toBeNull()
  })
})

// Code Reviewer LOW — DESIGN_STANDARD requires a reduced-motion fallback for
// every animated moment; the crossfade must drop to a 0ms transition rather
// than skipping the check silently.
describe('SpecialSchedulesScreen — reduced-motion crossfade fallback', () => {
  it('applies a 0ms transition when prefers-reduced-motion is set', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      localClient.list.mockImplementation(byEntity({
        ...BASE,
        special_days: [{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }],
      }))
      const { container } = render(<SpecialSchedulesScreen campId={CAMP_ID} role="admin" />)

      await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())
      const root = container.firstChild
      expect(root.style.transition).toContain('0ms')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
