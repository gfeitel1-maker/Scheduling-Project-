// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWeeks } from './useWeeks'

function makeRepo(overrides = {}) {
  return {
    createWeek: vi.fn(async () => ({ status: 'applied' })),
    writeWeekFields: vi.fn(async () => ({ status: 'applied' })),
    loadWeeks: vi.fn(async () => []),
    ...overrides,
  }
}

function makeLocalClient(overrides = {}) {
  return {
    duplicateWeek: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

function setup(overrides = {}) {
  const setWeeksImpl = vi.fn()
  const p = {
    weeks: [
      { id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 },
      { id: 'w2', camp_id: 'camp-1', name: 'Week 2', sort_order: 1, is_archived: 0 },
    ],
    setWeeks: setWeeksImpl,
    repo: makeRepo(),
    localClient: makeLocalClient(),
    campId: 'camp-1',
    weekId: 'w1',
    setPreferredWeekId: vi.fn(),
    setActionError: vi.fn(),
    ...overrides,
  }
  const hook = renderHook((props) => useWeeks(props), { initialProps: p })
  return { ...hook, props: p }
}

// setWeeks in the real component is a functional updater (setState). These
// tests call the functional argument with the fixture `weeks` array to
// observe the update, mirroring how React would apply it.
function applyUpdater(setWeeksMock, weeks) {
  const updater = setWeeksMock.mock.calls[0][0]
  return typeof updater === 'function' ? updater(weeks) : updater
}

describe('useWeeks', () => {
  it('createWeek calls repo.createWeek with a fresh id, campId, name, sortOrder = max+1', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.createWeek('Week 3') })
    expect(props.repo.createWeek).toHaveBeenCalledTimes(1)
    const [id, fields] = props.repo.createWeek.mock.calls[0]
    expect(typeof id).toBe('string')
    expect(fields).toEqual({ campId: 'camp-1', name: 'Week 3', sortOrder: 2 })
  })

  it('createWeek on an empty weeks array uses sortOrder = 0', async () => {
    const { result, props } = setup({ weeks: [] })
    await act(async () => { await result.current.createWeek('Week 1') })
    const [, fields] = props.repo.createWeek.mock.calls[0]
    expect(fields.sortOrder).toBe(0)
  })

  it('createWeek optimistically appends with is_archived: 0 (numeric)', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.createWeek('Week 3') })
    const updated = applyUpdater(props.setWeeks, props.weeks)
    expect(updated).toHaveLength(3)
    expect(updated[2].is_archived).toBe(0)
    expect(updated[2].name).toBe('Week 3')
  })

  it('createWeek calls setPreferredWeekId with the new id', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.createWeek('Week 3') })
    const [id] = props.repo.createWeek.mock.calls[0]
    expect(props.setPreferredWeekId).toHaveBeenCalledWith(id)
  })

  it('renameWeek calls repo.writeWeekFields(id, {name}) and updates only that week name', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.renameWeek('w1', 'Renamed') })
    expect(props.repo.writeWeekFields).toHaveBeenCalledWith('w1', { name: 'Renamed' })
    const updated = applyUpdater(props.setWeeks, props.weeks)
    expect(updated.find(w => w.id === 'w1').name).toBe('Renamed')
    expect(updated.find(w => w.id === 'w2').name).toBe('Week 2')
  })

  it('archiveWeek calls writeWeekFields with string "1" and sets numeric is_archived: 1', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.archiveWeek('w2') })
    expect(props.repo.writeWeekFields).toHaveBeenCalledWith('w2', { is_archived: '1' })
    const updated = applyUpdater(props.setWeeks, props.weeks)
    expect(updated.find(w => w.id === 'w2').is_archived).toBe(1)
  })

  it('archiveWeek on the selected week selects the next non-archived week', async () => {
    const { result, props } = setup({ weekId: 'w1' })
    await act(async () => { await result.current.archiveWeek('w1') })
    expect(props.setPreferredWeekId).toHaveBeenCalledWith('w2')
  })

  it('archiveWeek on the selected week with no other non-archived week selects null', async () => {
    const { result, props } = setup({
      weekId: 'w1',
      weeks: [
        { id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 },
        { id: 'w2', camp_id: 'camp-1', name: 'Week 2', sort_order: 1, is_archived: 1 },
      ],
    })
    await act(async () => { await result.current.archiveWeek('w1') })
    expect(props.setPreferredWeekId).toHaveBeenCalledWith(null)
  })

  it('archiveWeek on a non-selected week does not call setPreferredWeekId', async () => {
    const { result, props } = setup({ weekId: 'w1' })
    await act(async () => { await result.current.archiveWeek('w2') })
    expect(props.setPreferredWeekId).not.toHaveBeenCalled()
  })

  it('unarchiveWeek calls writeWeekFields with string "0" and sets numeric is_archived: 0', async () => {
    const { result, props } = setup({
      weeks: [{ id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 1 }],
    })
    await act(async () => { await result.current.unarchiveWeek('w1') })
    expect(props.repo.writeWeekFields).toHaveBeenCalledWith('w1', { is_archived: '0' })
    const updated = applyUpdater(props.setWeeks, props.weeks)
    expect(updated.find(w => w.id === 'w1').is_archived).toBe(0)
  })

  it('duplicateWeek calls localClient.duplicateWeek then reloads, filters, sorts, and sets weeks', async () => {
    const freshWeeks = [
      { id: 'w3', camp_id: 'camp-1', name: 'Dup', sort_order: 2, is_archived: 0 },
      { id: 'other', camp_id: 'camp-2', name: 'Other camp', sort_order: 0, is_archived: 0 },
      { id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 },
    ]
    const repo = makeRepo({ loadWeeks: vi.fn(async () => freshWeeks) })
    const localClient = makeLocalClient()
    const { result, props } = setup({ repo, localClient })
    await act(async () => { await result.current.duplicateWeek('w1') })
    expect(localClient.duplicateWeek).toHaveBeenCalledWith('w1', 'camp-1')
    expect(repo.loadWeeks).toHaveBeenCalledTimes(1)
    expect(props.setWeeks).toHaveBeenCalledWith([
      freshWeeks[2], freshWeeks[0],
    ])
  })

  it('duplicateWeek returns the raw result', async () => {
    const localClient = makeLocalClient({ duplicateWeek: vi.fn(async () => ({ ok: true, extra: 'x' })) })
    const { result } = setup({ localClient })
    let ret
    await act(async () => { ret = await result.current.duplicateWeek('w1') })
    expect(ret).toEqual({ ok: true, extra: 'x' })
  })

  it('duplicateWeek on a not-ok result does not reload, does not call setWeeks, and surfaces an error', async () => {
    const repo = makeRepo()
    const localClient = makeLocalClient({ duplicateWeek: vi.fn(async () => ({ ok: false })) })
    const { result, props } = setup({ repo, localClient })
    await act(async () => { await result.current.duplicateWeek('w1') })
    expect(repo.loadWeeks).not.toHaveBeenCalled()
    expect(props.setWeeks).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
  })

  it('confirmDeleteWeek removes the week from state', async () => {
    const { result, props } = setup({ weekId: null })
    act(() => { result.current.confirmDeleteWeek('w2') })
    const updated = applyUpdater(props.setWeeks, props.weeks)
    expect(updated).toEqual([props.weeks[0]])
  })

  it('confirmDeleteWeek on the selected week with a non-archived week remaining selects it', () => {
    const { result, props } = setup({ weekId: 'w1' })
    act(() => { result.current.confirmDeleteWeek('w1') })
    applyUpdater(props.setWeeks, props.weeks)
    expect(props.setPreferredWeekId).toHaveBeenCalledWith('w2')
  })

  it('confirmDeleteWeek on the selected week with ONLY archived weeks remaining selects remaining[0]', () => {
    const { result, props } = setup({
      weekId: 'w1',
      weeks: [
        { id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 },
        { id: 'w2', camp_id: 'camp-1', name: 'Week 2', sort_order: 1, is_archived: 1 },
      ],
    })
    act(() => { result.current.confirmDeleteWeek('w1') })
    applyUpdater(props.setWeeks, props.weeks)
    expect(props.setPreferredWeekId).toHaveBeenCalledWith('w2')
  })

  it('confirmDeleteWeek on the selected week with nothing remaining selects null', () => {
    const { result, props } = setup({
      weekId: 'w1',
      weeks: [{ id: 'w1', camp_id: 'camp-1', name: 'Week 1', sort_order: 0, is_archived: 0 }],
    })
    act(() => { result.current.confirmDeleteWeek('w1') })
    applyUpdater(props.setWeeks, props.weeks)
    expect(props.setPreferredWeekId).toHaveBeenCalledWith(null)
  })

  it('confirmDeleteWeek on a non-selected week does not call setPreferredWeekId', () => {
    const { result, props } = setup({ weekId: 'w1' })
    act(() => { result.current.confirmDeleteWeek('w2') })
    applyUpdater(props.setWeeks, props.weeks)
    expect(props.setPreferredWeekId).not.toHaveBeenCalled()
  })

  describe('write failure handling', () => {
    it('createWeek: rejected write calls setActionError and does not update state', async () => {
      const repo = makeRepo({ createWeek: vi.fn(async () => { throw new Error('ipc error') }) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.createWeek('Week 3') })
      expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
      expect(props.setWeeks).not.toHaveBeenCalled()
      expect(props.setPreferredWeekId).not.toHaveBeenCalled()
    })

    it('renameWeek: rejected write calls setActionError and does not update state', async () => {
      const repo = makeRepo({ writeWeekFields: vi.fn(async () => { throw new Error('ipc error') }) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.renameWeek('w1', 'New Name') })
      expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
      expect(props.setWeeks).not.toHaveBeenCalled()
    })

    it('archiveWeek: rejected write calls setActionError and does not update state', async () => {
      const repo = makeRepo({ writeWeekFields: vi.fn(async () => { throw new Error('ipc error') }) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.archiveWeek('w1') })
      expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
      expect(props.setWeeks).not.toHaveBeenCalled()
      expect(props.setPreferredWeekId).not.toHaveBeenCalled()
    })

    it('unarchiveWeek: rejected write calls setActionError and does not update state', async () => {
      const repo = makeRepo({ writeWeekFields: vi.fn(async () => { throw new Error('ipc error') }) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.unarchiveWeek('w1') })
      expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
      expect(props.setWeeks).not.toHaveBeenCalled()
    })

    it('duplicateWeek: rejected localClient call calls setActionError and does not update state', async () => {
      const localClient = makeLocalClient({ duplicateWeek: vi.fn(async () => { throw new Error('ipc error') }) })
      const { result, props } = setup({ localClient })
      await act(async () => { await result.current.duplicateWeek('w1') })
      expect(props.setActionError).toHaveBeenCalledWith(expect.any(String))
      expect(props.setWeeks).not.toHaveBeenCalled()
    })
  })
})
