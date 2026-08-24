// @vitest-environment jsdom
//
// docs/work/specs/2026-08-23-electives-gap.md Part (b) — the Schedule-side
// build entry for Electives: a picker listing authored elective sets,
// opening the EXISTING ElectiveSetDetail builder unchanged on selection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
  },
}))

import ScheduleElectivesScreen from './ScheduleElectivesScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'

function byEntity(entries) {
  return (entity) => Promise.resolve(entries[entity] ?? [])
}

const BASE = {
  elective_sets: [],
  elective_set_activities: [],
  activities: [],
  locations: [],
  tiers: [],
  groups: [],
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
})

describe('ScheduleElectivesScreen — empty state', () => {
  it('shows a single-line message and a link back to Roots when nothing is authored', async () => {
    localClient.list.mockImplementation(byEntity(BASE))
    const onNavigate = vi.fn()
    render(<ScheduleElectivesScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)

    await waitFor(() => expect(screen.getByText(/No elective sets yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Go to Roots'))
    expect(onNavigate).toHaveBeenCalledWith('electives')
  })
})

describe('ScheduleElectivesScreen — list', () => {
  it('lists every elective set for the camp with an offering count', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      elective_sets: [
        { id: 'set-2', camp_id: CAMP_ID, name: 'Zeta Chugim' },
        { id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim' },
      ],
      elective_set_activities: [
        { id: 'off-1', elective_set_id: 'set-1', activity_id: 'act-1', camper_headcount: null },
      ],
    }))
    render(<ScheduleElectivesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Afternoon Chugim')).toBeTruthy())
    expect(screen.getByText('Zeta Chugim')).toBeTruthy()
    expect(screen.getByText('1 offering')).toBeTruthy()
    expect(screen.getByText('0 offerings')).toBeTruthy()

    const names = screen.getAllByText(/Afternoon Chugim|Zeta Chugim/).map((el) => el.textContent)
    expect(names.indexOf('Afternoon Chugim')).toBeLessThan(names.indexOf('Zeta Chugim'))
  })
})

describe('ScheduleElectivesScreen — selecting a row opens the existing builder', () => {
  it('opens ElectiveSetDetail unchanged when a card is clicked, and Back returns to the picker', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      elective_sets: [{ id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim' }],
    }))
    render(<ScheduleElectivesScreen campId={CAMP_ID} role="admin" />)

    await waitFor(() => expect(screen.getByText('Afternoon Chugim')).toBeTruthy())
    fireEvent.click(screen.getByText('Afternoon Chugim'))

    await waitFor(() => expect(screen.getByText('← Back to Elective Sets')).toBeTruthy())
    fireEvent.click(screen.getByText('← Back to Elective Sets'))

    await waitFor(() => expect(screen.getByText('Afternoon Chugim')).toBeTruthy())
  })

  it('opens directly to a pre-selected set when initialElectiveSetId is passed (Slice 2 drill-in / Roots "Open")', async () => {
    localClient.list.mockImplementation(byEntity({
      ...BASE,
      elective_sets: [
        { id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim' },
        { id: 'set-2', camp_id: CAMP_ID, name: 'Morning Bechirot' },
      ],
    }))
    render(<ScheduleElectivesScreen campId={CAMP_ID} role="admin" initialElectiveSetId="set-1" />)

    await waitFor(() => expect(screen.getByText('← Back to Elective Sets')).toBeTruthy())
  })
})

describe('ScheduleElectivesScreen — reduced-motion crossfade fallback', () => {
  it('applies a 0ms transition when prefers-reduced-motion is set', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })
    try {
      localClient.list.mockImplementation(byEntity({
        ...BASE,
        elective_sets: [{ id: 'set-1', camp_id: CAMP_ID, name: 'Afternoon Chugim' }],
      }))
      const { container } = render(<ScheduleElectivesScreen campId={CAMP_ID} role="admin" />)

      await waitFor(() => expect(screen.getByText('Afternoon Chugim')).toBeTruthy())
      const root = container.firstChild
      expect(root.style.transition).toContain('0ms')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
