// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCrudScreen } from './useCrudScreen'

function makeFakeLocalClient(initialRows = []) {
  return { list: vi.fn().mockResolvedValue(initialRows) }
}

function fakeRepository(overrides = {}) {
  const calls = { createRecord: [], writeFields: [], deleteAllRecords: [] }
  return {
    calls,
    createRecord: vi.fn((entity, id, fields) => {
      calls.createRecord.push([entity, id, fields])
      return overrides.createRecord ? overrides.createRecord(entity, id, fields) : Promise.resolve()
    }),
    writeFields: vi.fn((entity, id, fields) => {
      calls.writeFields.push([entity, id, fields])
      return overrides.writeFields ? overrides.writeFields(entity, id, fields) : Promise.resolve()
    }),
    deleteAllRecords: vi.fn((entity, ids) => {
      calls.deleteAllRecords.push([entity, ids])
      return overrides.deleteAllRecords
        ? overrides.deleteAllRecords(entity, ids)
        : Promise.resolve({ succeeded: ids.length, failed: 0, failedDueToRole: false })
    }),
  }
}

const scopeFilter = (row, campId) => row.camp_id === campId

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'new-id' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('useCrudScreen — load', () => {
  it('loads rows scoped by scopeFilter', async () => {
    const localClient = makeFakeLocalClient([
      { id: 'a', camp_id: 'camp-1' },
      { id: 'b', camp_id: 'other-camp' },
    ])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('sets a generic error and stops loading when localClient.list rejects', async () => {
    const localClient = { list: vi.fn().mockRejectedValue(new Error('boom')) }
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/Couldn't load your camp setup/)
  })
})

describe('useCrudScreen — add', () => {
  it('mints an id, calls createRecord with buildCreateFields output, reloads, returns true', async () => {
    const localClient = makeFakeLocalClient([])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({
        entity: 'days_of_operation',
        campId: 'camp-1',
        localClient,
        repository,
        scopeFilter,
        buildCreateFields: (formState) => ({ label: formState.label, camp_id: 'camp-1' }),
        addFailedText: 'That day could not be added.',
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    let addResult
    await act(async () => {
      addResult = await result.current.add({ label: 'Monday' })
    })

    expect(addResult).toBe(true)
    expect(repository.calls.createRecord).toEqual([['days_of_operation', 'new-id', { label: 'Monday', camp_id: 'camp-1' }]])
    expect(localClient.list).toHaveBeenCalledTimes(2) // initial load + reload
  })

  it('surfaces a UNIQUE-collision-aware message (via describeWriteFailure) on failure, returns false', async () => {
    const localClient = makeFakeLocalClient([])
    const repository = fakeRepository({
      createRecord: () => Promise.reject(new Error('UNIQUE constraint failed: days_of_operation.name')),
    })
    const { result } = renderHook(() =>
      useCrudScreen({
        entity: 'days_of_operation',
        campId: 'camp-1',
        localClient,
        repository,
        scopeFilter,
        buildCreateFields: (formState) => formState,
        addFailedText: 'That day could not be added.',
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    let addResult
    await act(async () => {
      addResult = await result.current.add({ label: 'Monday' })
    })

    expect(addResult).toBe(false)
    expect(result.current.error).toBe('That day could not be added. Another record already has that name.')
  })
})

describe('useCrudScreen — save', () => {
  it('calls writeFields, reloads on success', async () => {
    const localClient = makeFakeLocalClient([])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f, saveFailedText: 'That day could not be saved.' })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.save('d1', { label: 'Tuesday' })
    })

    expect(repository.calls.writeFields).toEqual([['days_of_operation', 'd1', { label: 'Tuesday' }]])
  })

  it('sets error and RETHROWS on failure', async () => {
    const localClient = makeFakeLocalClient([])
    const repository = fakeRepository({ writeFields: () => Promise.reject(new Error('boom')) })
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f, saveFailedText: 'That day could not be saved.' })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => {
        await result.current.save('d1', { label: 'Tuesday' })
      })
    ).rejects.toThrow()
  })
})

describe('useCrudScreen — deleteAll', () => {
  it('re-fetches fresh rows via localClient.list before building the id list, not the hook rows state', async () => {
    const localClient = {
      list: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'a', camp_id: 'camp-1' }]) // initial load
        .mockResolvedValueOnce([
          { id: 'a', camp_id: 'camp-1' },
          { id: 'b', camp_id: 'camp-1' }, // synced in after initial load
        ]) // deleteAll's fresh refetch
        .mockResolvedValueOnce([]), // reload after delete
    }
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.map((r) => r.id)).toEqual(['a'])

    await act(async () => {
      await result.current.deleteAll()
    })

    expect(localClient.list).toHaveBeenCalledTimes(3)
    expect(repository.calls.deleteAllRecords).toEqual([['days_of_operation', ['a', 'b']]])
  })

  it('shows adminOnlyDeleteAllText when deleteAllRecords reports failedDueToRole', async () => {
    const localClient = makeFakeLocalClient([{ id: 'a', camp_id: 'camp-1' }])
    const repository = fakeRepository({
      deleteAllRecords: (entity, ids) => Promise.resolve({ succeeded: 0, failed: ids.length, failedDueToRole: true }),
    })
    const { result } = renderHook(() =>
      useCrudScreen({
        entity: 'days_of_operation',
        campId: 'camp-1',
        localClient,
        repository,
        scopeFilter,
        buildCreateFields: (f) => f,
        adminOnlyDeleteAllText: 'Only an admin can delete days — no days were deleted.',
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteAll()
    })

    expect(result.current.error).toBe('Only an admin can delete days — no days were deleted.')
  })
})

describe('useCrudScreen — importRows', () => {
  it('skips warned and duplicate rows, tallies added/skipped, uses createRecord', async () => {
    const localClient = makeFakeLocalClient([{ id: 'existing', camp_id: 'camp-1', label: 'monday' }])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const parsedRows = [
      { label: 'Monday', warning: null }, // duplicate of existing (case-insensitive)
      { label: '', warning: 'Missing label' }, // warned
      { label: 'Tuesday', warning: null }, // new
    ]
    const duplicateCheck = (existing, row) => existing.some((r) => String(r.label).toLowerCase() === String(row.label).toLowerCase())
    const mapRow = (row) => ({ label: row.label, camp_id: 'camp-1' })

    let importResult
    await act(async () => {
      importResult = await result.current.importRows(parsedRows, { mapRow, duplicateCheck })
    })

    expect(importResult).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 2, stoppedAt: null })
    expect(repository.calls.createRecord).toEqual([['days_of_operation', 'new-id', { label: 'Tuesday', camp_id: 'camp-1' }]])
  })

  it('does not double-add two duplicate rows within the same import batch', async () => {
    const localClient = makeFakeLocalClient([])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const parsedRows = [
      { label: 'Monday', warning: null },
      { label: 'Monday', warning: null },
    ]
    const duplicateCheck = (existing, row) => existing.some((r) => String(r.label).toLowerCase() === String(row.label).toLowerCase())
    const mapRow = (row) => ({ label: row.label, camp_id: 'camp-1' })

    let importResult
    await act(async () => {
      importResult = await result.current.importRows(parsedRows, { mapRow, duplicateCheck })
    })

    expect(importResult).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 1, stoppedAt: null })
  })

  // board q-export-columns-do-not-round-trip, B3 — findExisting/buildChangedFields replace a
  // boolean duplicateCheck with create-or-update: a changed field writes via writeFields, an
  // identical one writes nothing.
  it('updates an existing row via findExisting/buildChangedFields when a field changed, and leaves an identical one unchanged', async () => {
    const localClient = makeFakeLocalClient([
      { id: 'existing-mon', camp_id: 'camp-1', label: 'Monday', day_of_week: 1 },
      { id: 'existing-tue', camp_id: 'camp-1', label: 'Tuesday', day_of_week: 2 },
    ])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const parsedRows = [
      { label: 'Monday', day_of_week: 5, warning: null }, // changed day_of_week -> update
      { label: 'Tuesday', day_of_week: 2, warning: null }, // identical -> unchanged
    ]
    const findExisting = (seen, row) => seen.find((r) => String(r.label).toLowerCase() === String(row.label).toLowerCase())
    const buildChangedFields = (existing, row) =>
      String(existing.day_of_week) !== String(row.day_of_week) ? { day_of_week: row.day_of_week } : null
    const mapRow = (row) => ({ label: row.label, day_of_week: row.day_of_week, camp_id: 'camp-1' })

    let importResult
    await act(async () => {
      importResult = await result.current.importRows(parsedRows, { mapRow, findExisting, buildChangedFields })
    })

    expect(importResult).toEqual({ added: 0, updated: 1, unchanged: 1, skipped: 0, stoppedAt: null })
    expect(repository.calls.writeFields).toEqual([['days_of_operation', 'existing-mon', { day_of_week: 5 }]])
  })

  // Red Hat HIGH — a SECOND row sharing a natural key must diff against what the FIRST row
  // actually applied, not the stale pre-import value. Row 1 sets priority low -> high
  // (applied); row 2 sets it back to low — diffed against the stale original ('low') that
  // reads as "unchanged" and row 2's own change is silently dropped.
  it('a later row sharing the same key diffs against the FIRST row\'s applied value, not the stale original', async () => {
    const localClient = makeFakeLocalClient([
      { id: 'existing-1', camp_id: 'camp-1', label: 'Archery', priority: 'low' },
    ])
    const repository = fakeRepository()
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'activities', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const parsedRows = [
      { label: 'Archery', priority: 'high', warning: null }, // low -> high, an update
      { label: 'Archery', priority: 'low', warning: null },  // same key, back to low — must ALSO update
    ]
    const findExisting = (seen, row) => seen.find((r) => String(r.label).toLowerCase() === String(row.label).toLowerCase())
    const buildChangedFields = (existing, row) =>
      String(existing.priority) !== String(row.priority) ? { priority: row.priority } : null
    const mapRow = (row) => ({ label: row.label, priority: row.priority, camp_id: 'camp-1' })

    let importResult
    await act(async () => {
      importResult = await result.current.importRows(parsedRows, { mapRow, findExisting, buildChangedFields })
    })

    expect(importResult).toEqual({ added: 0, updated: 2, unchanged: 0, skipped: 0, stoppedAt: null })
    expect(repository.calls.writeFields).toEqual([
      ['activities', 'existing-1', { priority: 'high' }],
      ['activities', 'existing-1', { priority: 'low' }],
    ])
  })

  it('stops the loop on an unexpected createRecord failure and reports how many rows already landed', async () => {
    const localClient = makeFakeLocalClient([])
    let callCount = 0
    const repository = fakeRepository({
      createRecord: () => {
        callCount++
        return callCount === 2 ? Promise.reject(new Error('disk full')) : Promise.resolve()
      },
    })
    const { result } = renderHook(() =>
      useCrudScreen({ entity: 'days_of_operation', campId: 'camp-1', localClient, repository, scopeFilter, buildCreateFields: (f) => f })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const parsedRows = [
      { label: 'Monday', warning: null },
      { label: 'Tuesday', warning: null },
      { label: 'Wednesday', warning: null },
    ]
    const duplicateCheck = () => false
    const mapRow = (row) => ({ label: row.label, camp_id: 'camp-1' })

    let importResult
    await act(async () => {
      importResult = await result.current.importRows(parsedRows, { mapRow, duplicateCheck })
    })

    expect(importResult.added).toBe(1)
    expect(importResult.stoppedAt).toMatch(/Imported 1 of 3 rows; row 2 \('Tuesday'\) failed: disk full/)
    expect(importResult.stoppedAt).toMatch(/No further rows were written/)
    expect(importResult.stoppedAt.toLowerCase()).not.toContain('atomic')
    // Wednesday was never attempted.
    expect(repository.calls.createRecord).toHaveLength(2)
  })
})
