// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
  },
}))

import { useCohorts } from './useCohorts'
import { localClient } from '../localClient'

beforeEach(() => {
  localClient.list.mockReset()
})

describe('useCohorts', () => {
  it('loads cohorts for the camp, sorted by sort_order then name', async () => {
    localClient.list.mockResolvedValue([
      { id: 'b', camp_id: 'camp-1', name: 'Beta', sort_order: 2 },
      { id: 'a', camp_id: 'camp-1', name: 'Alpha', sort_order: 1 },
      { id: 'c', camp_id: 'camp-1', name: 'Charlie', sort_order: 1 },
      { id: 'z', camp_id: 'other-camp', name: 'Zulu', sort_order: 0 },
    ])
    const { result } = renderHook(() => useCohorts('camp-1'))
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.cohorts.map((c) => c.id)).toEqual(['a', 'c', 'b'])
    expect(result.current.activeCohort.id).toBe('a')
  })

  it('keeps the previously selected cohort if it still exists after reload', async () => {
    localClient.list.mockResolvedValue([
      { id: 'a', camp_id: 'camp-1', name: 'Alpha', sort_order: 1 },
      { id: 'b', camp_id: 'camp-1', name: 'Beta', sort_order: 2 },
    ])
    const { result } = renderHook(() => useCohorts('camp-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setActiveCohortId('b'))
    expect(result.current.activeCohort.id).toBe('b')

    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.activeCohort.id).toBe('b')
  })

  it('fails closed to an empty list when localClient.list rejects, without leaving loading stuck', async () => {
    localClient.list.mockRejectedValue(new Error('ipc failure'))
    const { result } = renderHook(() => useCohorts('camp-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.cohorts).toEqual([])
    expect(result.current.activeCohort).toBeNull()
  })
})
