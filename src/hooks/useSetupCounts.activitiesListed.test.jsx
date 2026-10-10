// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { activitiesListed } from '../screens/setupListSelectors.js'

// Audit follow-up: the sidebar Activities count included pinned-event rows
// (activities backing fixed events), so it read higher than the Activities
// screen. The count must be the screen's own selector over the same rows.
const rows = [
  { id: 'a1', camp_id: 'c1', name: 'Swim' },
  { id: 'a2', camp_id: 'c1', name: 'Art', catalog_role: null },
  { id: 'p1', camp_id: 'c1', name: 'Mifkad', catalog_role: 'pinned_event' },
  { id: 'p2', camp_id: 'c1', name: 'Lunch', catalog_role: 'pinned_event' },
  { id: 'x1', camp_id: 'OTHER', name: 'Elsewhere' },
]

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(async (table) => (table === 'activities' ? rows : [])),
    getCamp: vi.fn(async () => ({ name: 'Camp' })),
    onOpApplied: () => () => {},
    onLocalWrite: () => () => {},
  },
}))
const { useSetupCounts } = await import('./useSetupCounts')

describe('useSetupCounts — Activities count equals the Activities screen', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('excludes pinned-event rows, matching activitiesListed', async () => {
    const { result } = renderHook(() => useSetupCounts('c1'))
    await waitFor(() => expect(result.current.counts).not.toBeNull())
    expect(result.current.counts.activities).toBe(activitiesListed(rows, { campId: 'c1' }).length)
    expect(result.current.counts.activities).toBe(2)
  })
})
