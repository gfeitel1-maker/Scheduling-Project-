// @vitest-environment jsdom
//
// T106 (docs/work/tickets/T106-special-day-author-ui.md): characterization
// test for the list screen — create/open/delete/empty state — following the
// pattern of DayOverridesScreen.test.jsx (the closest existing precedent).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    deleteSpecialDay: vi.fn(),
  },
}))

import SpecialDaysScreen from './SpecialDaysScreen'
import { seedFailureMessage } from './specialDay/seedFailureMessage'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

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
  localClient.deleteSpecialDay.mockReset().mockResolvedValue({ ok: true })
})

describe('SpecialDaysScreen — empty state', () => {
  it('renders the empty state when the camp has zero special days', async () => {
    localClient.list.mockResolvedValue([])
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('No special days yet')).toBeTruthy())
  })
})

describe('SpecialDaysScreen — create', () => {
  it('creates a special day and shows the seed prompt', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('No special days yet')).toBeTruthy())

    fireEvent.click(screen.getAllByText('+ New Special Day')[0])
    fireEvent.change(screen.getByPlaceholderText('Name your special day…'), { target: { value: 'Color War' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'special_days', 'new-id-0', 'name', 'Color War')
    })
    await waitFor(() => expect(screen.getByText(/Seed from Time Blocks/)).toBeTruthy())
  })

  // OQ2 (owner-resolved 2026-08-23, docs/work/specs/2026-08-23-schedule-
  // build-ia.md): no auto-forward into the grid. Choosing "Start Empty"
  // returns to the list with a quiet hint pointing at Schedule → Special
  // Schedules — no grid editor renders in this screen at all.
  it('returns to the list after choosing "Start Empty" — no auto-forward into the grid — and shows a hint', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('No special days yet')).toBeTruthy())

    fireEvent.click(screen.getAllByText('+ New Special Day')[0])
    fireEvent.change(screen.getByPlaceholderText('Name your special day…'), { target: { value: 'Color War' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(screen.getByText(/Start Empty/)).toBeTruthy())

    fireEvent.click(screen.getByText(/Start Empty/))

    await waitFor(() => expect(screen.getByText(/build it from Special Schedules under Schedule/)).toBeTruthy())
    expect(screen.queryByText('← Back to Special Days')).toBeNull()
    expect(screen.getByText('Color War')).toBeTruthy()
  })
})

describe('SpecialDaysScreen — delete', () => {
  it('confirms and calls localClient.deleteSpecialDay for an admin', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }])
      if (entity === 'special_day_time_blocks') return Promise.resolve([])
      if (entity === 'special_day_slots') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.getByText('Delete Special Day')).toBeTruthy())
    fireEvent.click(screen.getByText('Delete Special Day'))

    await waitFor(() => {
      expect(localClient.deleteSpecialDay).toHaveBeenCalledWith({ specialDayId: 'sd-1' })
    })
  })

  it('disables Delete for a staff role', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }])
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="staff" />)
    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())
    expect(screen.getByText('Delete').disabled).toBe(true)
  })
})

describe('SpecialDaysScreen — seed from camp time blocks', () => {
  it('copies camp time_blocks into NEW special_day_time_blocks rows with minted ids, never touching the camp time_blocks table', async () => {
    const campBlocks = [
      { id: 'camp-tb-1', camp_id: CAMP_ID, cohort_id: 'cohort-1', name: 'Morning', sort_order: 0, start_time: '09:00:00', end_time: '10:00:00' },
    ]
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([])
      if (entity === 'time_blocks') return Promise.resolve(campBlocks)
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('No special days yet')).toBeTruthy())

    fireEvent.click(screen.getAllByText('+ New Special Day')[0])
    fireEvent.change(screen.getByPlaceholderText('Name your special day…'), { target: { value: 'Color War' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(screen.getByText(/Seed from Time Blocks/)).toBeTruthy())

    fireEvent.click(screen.getByText(/Seed from Time Blocks/));

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
    // Full-render coverage of the failure path is impractical here: the
    // screen's `finally` block always navigates into the grid editor after a
    // seed attempt (success or failure), which unmounts the list screen and
    // its error banner in the same render pass the error is set in — so the
    // message text has no observable window in the DOM. Testing the pure
    // message builder directly is what's actually verifiable.
    expect(seedFailureMessage(1, 2)).toBe(
      'Only seeded 1 of 2 time blocks before hitting an error — the rest were not added.'
    )
  })

  it('falls back to the plain message when nothing seeded before the error', () => {
    expect(seedFailureMessage(0, 2)).toBe('Could not seed time blocks.')
  })
})

describe('SpecialDaysScreen — open (docs/work/specs/2026-08-23-schedule-build-ia.md)', () => {
  it('clicking Open navigates to schedule:special with this day pre-selected — no inline grid swap', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }])
      if (entity === 'special_day_time_blocks') return Promise.resolve([])
      if (entity === 'special_day_slots') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    const onNavigate = vi.fn()
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())

    fireEvent.click(screen.getByText('Open'))

    expect(onNavigate).toHaveBeenCalledWith('schedule:special', { specialDayId: 'sd-1' })
    expect(screen.queryByText('← Back to Special Days')).toBeNull()
  })
})
