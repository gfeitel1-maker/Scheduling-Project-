// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { list: vi.fn() },
}))

import { localClient } from '../localClient'
import { useCurrentStructureCounts } from './useCurrentStructureCounts.js'
import { buildStructureIssues } from '../ingest/attentionList.js'

beforeEach(() => {
  localClient.list.mockReset()
})

describe('useCurrentStructureCounts', () => {
  it('fetches every structure collection via localClient.list and returns them keyed by entity', async () => {
    localClient.list.mockImplementation((entity) => Promise.resolve(entity === 'groups' ? [{ id: 'g1' }] : []))

    const { result } = renderHook(() => useCurrentStructureCounts('camp-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.collections.groups).toEqual([{ id: 'g1' }])
    expect(localClient.list).toHaveBeenCalledWith('tiers')
    expect(localClient.list).toHaveBeenCalledWith('groups')
    expect(localClient.list).toHaveBeenCalledWith('days_of_operation')
    expect(localClient.list).toHaveBeenCalledWith('time_blocks')
    expect(localClient.list).toHaveBeenCalledWith('locations')
    expect(localClient.list).toHaveBeenCalledWith('activities')
    expect(localClient.list).toHaveBeenCalledWith('fixed_events')
  })

  it('degrades a failing collection to an empty array rather than failing the whole hook', async () => {
    localClient.list.mockImplementation((entity) =>
      entity === 'locations' ? Promise.reject(new Error('boom')) : Promise.resolve([]),
    )

    const { result } = renderHook(() => useCurrentStructureCounts('camp-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.collections.locations).toEqual([])
  })

  it('refetches on every mount — no cross-render cache', async () => {
    localClient.list.mockResolvedValue([])
    const { unmount } = renderHook(() => useCurrentStructureCounts('camp-1'))
    await waitFor(() => expect(localClient.list).toHaveBeenCalled())
    unmount()
    localClient.list.mockClear()

    renderHook(() => useCurrentStructureCounts('camp-1'))
    await waitFor(() => expect(localClient.list).toHaveBeenCalledWith('groups'))
  })

  // T299 — WHAT THIS HOOK LOADS AND WHAT THE ATTENTION SURFACE READS ARE ONE
  // CONTRACT, and it was silently broken: `campers` was missing from the list, so
  // buildStructureIssues' unattributed-subject branch — T285's only reader of
  // campers.is_unattributed — produced nothing in the running app. Every test of
  // that branch passed anyway, because they all hand buildStructureIssues a
  // collections object this hook never produced.
  //
  // Asserted THROUGH the real consumer rather than as another
  // `toHaveBeenCalledWith('campers')` line: the cases above are a hand-kept list of
  // names, which is the same thing that drifted. This one fails if the entity stops
  // being fetched, whatever the list happens to say.
  it('produces a collections object the attention surface can find a subject in', async () => {
    const subject = { id: 'camper1:sub', display_name: 'planner', external_id: 'sub-ffff', is_unattributed: 1 }
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'campers' ? [subject] : [])
    )

    const { result } = renderHook(() => useCurrentStructureCounts('camp-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const rows = buildStructureIssues(result.current.collections)
      .filter((i) => i.sourceKind === 'unattributed-camper')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('unattributed-camper:camper1:sub')
  })
})
