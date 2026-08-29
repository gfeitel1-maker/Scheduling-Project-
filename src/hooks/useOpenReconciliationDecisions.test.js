// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    listOpenReconciliationDecisions: vi.fn().mockResolvedValue([]),
    dismissOpenReconciliationDecisions: vi.fn().mockResolvedValue({ ok: true, dismissed: 1 }),
  },
}))

import { useOpenReconciliationDecisions } from './useOpenReconciliationDecisions.js'
import { localClient } from '../localClient'

function row(overrides = {}) {
  return {
    id: 'groups:g1', camp_id: 'camp1', entity_type: 'groups', cohort_id: null, entity_id: 'g1',
    identity_key: 'g1', kind: 'confirm_value', domain_key: 'Structure', child_key: 'Groups',
    entity_name: 'Bunk 1', reason: 'New in the import', import_run_id: 'run1',
    created_at: '2026-08-28T00:00:00.000Z', ...overrides,
  }
}

beforeEach(() => {
  localClient.listOpenReconciliationDecisions.mockReset().mockResolvedValue([])
  localClient.dismissOpenReconciliationDecisions.mockReset().mockResolvedValue({ ok: true, dismissed: 1 })
})

describe('useOpenReconciliationDecisions', () => {
  it('fetches on mount and exposes an empty model/rows when there are none', async () => {
    const { result } = renderHook(() => useOpenReconciliationDecisions())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toEqual([])
    expect(result.current.model).toEqual({ domains: [] })
    expect(result.current.decisionsById.size).toBe(0)
  })

  it('translates fetched rows into { model, decisionsById } via openDecisionsToModel', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([row()])
    const { result } = renderHook(() => useOpenReconciliationDecisions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.model.domains).toHaveLength(1)
    expect(result.current.decisionsById.get('groups:g1')).toEqual({ reason: 'New in the import' })
  })

  it('a fetch failure degrades to an empty list rather than throwing', async () => {
    localClient.listOpenReconciliationDecisions.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useOpenReconciliationDecisions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toEqual([])
  })

  it('dismiss calls the IPC and removes the dismissed row from local state without a refetch', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })])
    const { result } = renderHook(() => useOpenReconciliationDecisions())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(2)

    await act(async () => {
      await result.current.dismiss('a')
    })

    expect(localClient.dismissOpenReconciliationDecisions).toHaveBeenCalledWith(['a'])
    expect(result.current.rows.map((r) => r.id)).toEqual(['b'])
  })

  it('dismiss accepts an array of ids', async () => {
    localClient.listOpenReconciliationDecisions.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })])
    const { result } = renderHook(() => useOpenReconciliationDecisions())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.dismiss(['a', 'b'])
    })

    expect(result.current.rows).toEqual([])
  })
})
