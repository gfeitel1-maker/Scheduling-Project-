// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSnapshots } from './useSnapshots'

// A fake repo whose methods are spies; individual tests override behaviour.
function makeRepo(overrides = {}) {
  return {
    writeSnapshotFields: vi.fn(async () => ({ status: 'applied' })),
    deleteEntity: vi.fn(async () => ({ status: 'applied' })),
    getSnapshot: vi.fn(async () => ({})),
    restoreSnapshotRows: vi.fn(async () => ({ status: 'applied' })),
    reloadSlots: vi.fn(async () => []),
    reloadOverlays: vi.fn(async () => []),
    ...overrides,
  }
}

// All route-scoped values/setters now arrive as one `routeState` object (T31's
// useRouteState return); only genuine cross-cluster wiring is a direct param.
// The route-state keys are routed into routeState, and every value/setter is
// mirrored onto `props` so the existing assertions read unchanged.
const ROUTE_STATE_KEYS = new Set([
  'route', 'existingTemplates', 'templateIdFor', 'templateId',
  'slotsByRoute', 'overlaysByRoute', 'setSnapshotsByRoute', 'setSnapshots',
  'setSlots', 'setOverlays', 'setFindings', 'setDismissedFindingKeys',
])

function setup(overrides = {}) {
  const routeState = {
    route: 'generated',
    existingTemplates: { generated: true, manual: true },
    templateIdFor: (r) => `tid-${r}`,
    templateId: 'tid-generated',
    slotsByRoute: {
      generated: [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} }],
      manual: [],
    },
    overlaysByRoute: { generated: [], manual: [] },
    setSnapshotsByRoute: vi.fn(),
    setSnapshots: vi.fn(),
    setSlots: vi.fn(),
    setOverlays: vi.fn(),
    setFindings: vi.fn(),
    setDismissedFindingKeys: vi.fn(),
  }
  const rest = {}
  for (const [k, v] of Object.entries(overrides)) {
    if (ROUTE_STATE_KEYS.has(k)) routeState[k] = v
    else rest[k] = v
  }
  const p = {
    routeState,
    repo: makeRepo(),
    setActionError: vi.fn(),
    recalcStats: vi.fn(),
    resetUndoRedo: vi.fn(),
    groups: [{ id: 'g1', tier_id: 't1' }],
    activities: [{ id: 'act-1', name: 'Swim' }],
    days: [{ id: 'd1' }],
    ...rest,
  }
  const hook = renderHook((props) => useSnapshots(props), { initialProps: p })
  return { ...hook, props: { ...p, ...routeState } }
}

describe('useSnapshots', () => {
  it('saveSnapshot writes the current route payload and prepends it to that route', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.saveSnapshot('v1', false) })

    expect(props.repo.writeSnapshotFields).toHaveBeenCalledTimes(1)
    const [, fields] = props.repo.writeSnapshotFields.mock.calls[0]
    expect(fields.template_id).toBe('tid-generated')
    expect(fields.name).toBe('v1')
    expect(fields.is_auto).toBe(false)
    expect(JSON.parse(fields.slots)).toHaveLength(1)
    // Route-explicit setSnapshotsByRoute updates the correct route key.
    expect(props.setSnapshotsByRoute).toHaveBeenCalledTimes(1)
  })

  it('saveSnapshot is a no-op when the route has no template row', async () => {
    const { result, props } = setup({ existingTemplates: { generated: false, manual: false } })
    await act(async () => { await result.current.saveSnapshot(null, true) })
    expect(props.repo.writeSnapshotFields).not.toHaveBeenCalled()
  })

  it('saveSnapshot honours an explicit routeName over the current route', async () => {
    const { result, props } = setup({
      slotsByRoute: {
        generated: [],
        manual: [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-9', anchor_id: null, is_anchor: false, flags: {} }],
      },
    })
    await act(async () => { await result.current.saveSnapshot(null, true, 'manual') })
    const [, fields] = props.repo.writeSnapshotFields.mock.calls[0]
    expect(fields.template_id).toBe('tid-manual')
    expect(JSON.parse(fields.slots)[0].activity_id).toBe('act-9')
  })

  it('saveSnapshot rethrows and reports when the write fails (so generate can abort)', async () => {
    const repo = makeRepo({ writeSnapshotFields: vi.fn(async () => { throw new Error('boom') }) })
    const { result, props } = setup({ repo })
    await expect(
      act(async () => { await result.current.saveSnapshot(null, true) })
    ).rejects.toThrow('boom')
    expect(props.setActionError).toHaveBeenCalled()
  })

  it('deleteSnapshot removes the row on an applied result', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.deleteSnapshot('snap-1') })
    expect(props.repo.deleteEntity).toHaveBeenCalledWith('schedule_snapshots', 'snap-1')
    expect(props.setSnapshots).toHaveBeenCalledTimes(1)
  })

  it('deleteSnapshot surfaces an admin-only refusal and does not drop the row', async () => {
    const repo = makeRepo({ deleteEntity: vi.fn(async () => { throw new Error('admin role required') }) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.deleteSnapshot('snap-1') })
    expect(props.setActionError).toHaveBeenCalledWith('Only an admin can delete a saved version')
    expect(props.setSnapshots).not.toHaveBeenCalled()
  })

  it('deleteSnapshot surfaces a non-applied status without dropping the row', async () => {
    const repo = makeRepo({ deleteEntity: vi.fn(async () => ({ status: 'rejected' })) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.deleteSnapshot('snap-1') })
    expect(props.setActionError).toHaveBeenCalledWith('That version could not be deleted. It is still in the list.')
    expect(props.setSnapshots).not.toHaveBeenCalled()
  })

  it('restoreSnapshot clears undo/redo, restores rows, and reloads slots/overlays/stats/findings', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_anchor: false, flags: {} }]),
      overlays: JSON.stringify([]),
    }
    const freshSlots = [{ id: 's1', is_anchor: false, activity_id: 'act-1' }]
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      reloadSlots: vi.fn(async () => freshSlots),
      reloadOverlays: vi.fn(async () => []),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

    expect(props.resetUndoRedo).toHaveBeenCalledTimes(1)
    expect(repo.restoreSnapshotRows).toHaveBeenCalledWith('tid-generated', expect.any(Array), expect.any(Array))
    expect(props.setSlots).toHaveBeenCalledWith(freshSlots)
    expect(props.setOverlays).toHaveBeenCalledWith([])
    expect(props.recalcStats).toHaveBeenCalledWith(freshSlots)
    expect(props.setFindings).toHaveBeenCalledTimes(1)
    expect(props.setDismissedFindingKeys).toHaveBeenCalledTimes(1)
  })

  it('restoreSnapshot refuses a version belonging to the other route without writing', async () => {
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => ({ template_id: 'tid-manual', slots: '[]', overlays: '[]' })),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })
    expect(props.setActionError).toHaveBeenCalledWith(
      'That saved version belongs to the other schedule. Switch to it to restore this version.'
    )
    expect(repo.restoreSnapshotRows).not.toHaveBeenCalled()
  })

  it('restoreSnapshot reports an unrestorable (payload-less) version and marks it non-restorable', async () => {
    const repo = makeRepo({ getSnapshot: vi.fn(async () => ({ template_id: 'tid-generated', slots: null })) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.setSnapshots).toHaveBeenCalledTimes(1) // marks restorable:false
    expect(repo.restoreSnapshotRows).not.toHaveBeenCalled()
  })

  it('renameSnapshot writes the new name and clears the auto flag', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.renameSnapshot('snap-1', 'Final') })
    expect(props.repo.writeSnapshotFields).toHaveBeenCalledWith('snap-1', { name: 'Final', is_auto: false })
    expect(props.setSnapshots).toHaveBeenCalledTimes(1)
  })
})
