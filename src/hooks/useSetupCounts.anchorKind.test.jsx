// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// T124 — the sidebar showed "Fixed Events 112" beside "Recurring Events 112":
// the same 112 anchor_activities rows counted once each. The two rows were
// deliberately un-conflated by kind; the counts never followed.
const rows = [
  { id: '1', camp_id: 'c1', kind: 'fixed', name: 'Flagpole' },
  { id: '2', camp_id: 'c1', kind: 'fixed', name: 'Lunch' },
  { id: '3', camp_id: 'c1', kind: 'recurring', name: 'Instructional Swim' },
  { id: '4', camp_id: 'c1', kind: 'recurring', name: 'Chug' },
  { id: '5', camp_id: 'c1', kind: 'recurring', name: 'Teva' },
  { id: '6', camp_id: 'OTHER', kind: 'fixed', name: 'Not this camp' },
]

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(async (table) => (table === 'anchor_activities' ? rows : [])),
    getCamp: vi.fn(async () => ({ name: 'Camp Ramah Tikvah' })),
    onOpApplied: () => () => {},
    onLocalWrite: () => () => {},
  },
}))
const { useSetupCounts } = await import('./useSetupCounts')

describe('useSetupCounts — Fixed vs Recurring', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('counts each kind separately instead of reporting the table twice', async () => {
    const { result } = renderHook(() => useSetupCounts('c1'))
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.counts.fixedevents).toBe(2)
    expect(result.current.counts.anchors).toBe(3)
  })

  it('still scopes to this camp', async () => {
    const { result } = renderHook(() => useSetupCounts('c1'))
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    // The OTHER-camp fixed row must not be counted.
    expect(result.current.counts.fixedevents).not.toBe(3)
  })
})
