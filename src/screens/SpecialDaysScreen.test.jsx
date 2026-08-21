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
})

describe('SpecialDaysScreen — open', () => {
  it('clicking Open switches into the grid editor sub-view', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'special_days') return Promise.resolve([{ id: 'sd-1', camp_id: CAMP_ID, name: 'Color War' }])
      if (entity === 'special_day_time_blocks') return Promise.resolve([])
      if (entity === 'special_day_slots') return Promise.resolve([])
      if (entity === 'groups') return Promise.resolve([])
      if (entity === 'activities') return Promise.resolve([])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<SpecialDaysScreen campId={CAMP_ID} role="admin" />)
    await waitFor(() => expect(screen.getByText('Color War')).toBeTruthy())

    fireEvent.click(screen.getByText('Open'))
    await waitFor(() => expect(screen.getByText('← Back to Special Days')).toBeTruthy())
    expect(screen.getByText('No time blocks yet.')).toBeTruthy()
  })
})
