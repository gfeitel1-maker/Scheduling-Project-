// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { list: vi.fn() },
}))

import { localClient } from '../localClient'
import { useCurrentStructureCounts } from './useCurrentStructureCounts.js'

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
    expect(localClient.list).toHaveBeenCalledWith('anchor_activities')
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
})
