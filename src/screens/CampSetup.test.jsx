// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { list: vi.fn(), get: vi.fn(), write: vi.fn() },
}))

import CampSetup from './CampSetup'
import { localClient } from '../localClient'
import { getSetupGaps } from '../engine/readiness'

// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §4.
//
// This screen used to own its own idea of "done": five steps, a progress bar
// over them, and a header sentence reading "The engine needs all five before it
// can build a schedule". That was false twice — Fixed Events is optional, and
// Days and Programs were missing from the list entirely. A director could see
// 5/5 and a lit-up Generate button on a camp that could not build a week.

const TABLE = {
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days: 'days_of_operation',
  timeBlocks: 'time_blocks',
  activities: 'activities',
  anchors: 'anchor_activities',
}

// One fixture shape, shared with the readiness tests, so the screen and the
// function cannot drift apart.
function mockCamp({ cohorts = 1, tiers = 1, groups = 1, days = 1, timeBlocks = 1, activities = 1, anchors = 0 } = {}) {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, camp_id: 'camp-1', name: `Row ${i}` }))
  const store = {
    [TABLE.cohorts]: rows(cohorts),
    [TABLE.tiers]: rows(tiers),
    [TABLE.groups]: rows(groups),
    [TABLE.days]: rows(days),
    [TABLE.timeBlocks]: rows(timeBlocks),
    [TABLE.activities]: rows(activities),
    [TABLE.anchors]: rows(anchors),
    camps: [{ id: 'camp-1', name: 'Camp Test' }],
  }
  localClient.list.mockImplementation((entity) => Promise.resolve(store[entity] ?? []))
  localClient.get?.mockResolvedValue?.({ id: 'camp-1', name: 'Camp Test' })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => 'token-abc', setItem: () => {}, removeItem: () => {} })
})

describe('CampSetup reads the shared required set', () => {
  it('says the camp is ready when every required area has data', async () => {
    mockCamp()
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Ready to build a week/)).toBeTruthy())
  })

  it('names Days when days are missing — the area the old five-step list omitted', async () => {
    mockCamp({ days: 0 })
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText(/One thing still needed before you can build a week: Days\./)).toBeTruthy()
    )
  })

  it('does not claim readiness while Programs are missing', async () => {
    mockCamp({ cohorts: 0 })
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/still needed/)).toBeTruthy())
    expect(screen.queryByText(/Ready to build a week/)).toBeNull()
  })

  it('is ready with no Fixed Events, because they are optional', async () => {
    mockCamp({ anchors: 0 })
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Ready to build a week/)).toBeTruthy())
    // The row is still there and still reachable — it just never reads as a problem.
    // Appears in both the step row and the summary strip below it.
    expect(screen.getAllByText('Fixed Events').length).toBeGreaterThan(0)
    expect(screen.getByText('optional')).toBeTruthy()
  })

  it('agrees with getSetupGaps rather than counting for itself', async () => {
    // The point of the shared function: one fixture, one answer, whichever
    // surface is asking.
    const gaps = getSetupGaps({ cohorts: [], tiers: [{}], groups: [{}], days: [], timeBlocks: [{}], activities: [{}] })
    expect(gaps.map((g) => g.label)).toEqual(['Programs', 'Days'])

    mockCamp({ cohorts: 0, days: 0 })
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText(/2 things still needed before you can build a week: Programs and Days\./)).toBeTruthy()
    )
  })

  it('no longer shows a progress bar over the wrong set', async () => {
    mockCamp({ days: 0 })
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/still needed/)).toBeTruthy())
    expect(screen.queryByText(/complete$/)).toBeNull()
    expect(screen.queryByText(/Progress/)).toBeNull()
  })

  it('no longer offers a second, gated way into the schedule', async () => {
    // App.jsx's neutral `schedule` entry already asks which week to open. A CTA
    // here made the director answer twice, and whichever button sat left read
    // as the default — which neither schedule is allowed to be.
    mockCamp()
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Ready to build a week/)).toBeTruthy())
    expect(screen.queryByText(/Generate Schedule/)).toBeNull()
  })

  it('keeps the plain-language descriptions a first-run director needs', async () => {
    mockCamp()
    render(<CampSetup campId="camp-1" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Ready to build a week/)).toBeTruthy())
    expect(screen.getByText(/Individual bunks or tzrifim/)).toBeTruthy()
    expect(screen.getByText(/Which days of the week camp runs/)).toBeTruthy()
  })
})
