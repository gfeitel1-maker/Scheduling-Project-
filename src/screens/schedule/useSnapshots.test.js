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
    loadDayOverridesForWeek: vi.fn(async () => []),
    ...overrides,
  }
}

// All route-scoped values/setters now arrive as one `routeState` object (T31's
// useRouteState return); only genuine cross-cluster wiring is a direct param.
// The route-state keys are routed into routeState, and every value/setter is
// mirrored onto `props` so the existing assertions read unchanged.
const ROUTE_STATE_KEYS = new Set([
  'route', 'existingTemplates', 'templateIdFor', 'templateId',
  'slotsByRoute', 'setSnapshotsByRoute', 'setSnapshots',
  'setSlots', 'setFindings', 'setDismissedFindingKeys',
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
    setSnapshotsByRoute: vi.fn(),
    setSnapshots: vi.fn(),
    setSlots: vi.fn(),
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
    timeBlocks: [{ id: 'b1' }, { id: 'b2' }],
    anchors: [{ id: 'anc-1' }],
    weekId: 'week-1',
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

  it('restoreSnapshot clears undo/redo, restores rows, and reloads slots/stats/findings', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_anchor: false, flags: {} }]),
    }
    const freshSlots = [{ id: 's1', is_anchor: false, activity_id: 'act-1' }]
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      reloadSlots: vi.fn(async () => freshSlots),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

    expect(props.resetUndoRedo).toHaveBeenCalledTimes(1)
    expect(repo.restoreSnapshotRows).toHaveBeenCalledWith('tid-generated', expect.any(Array), [])
    expect(props.setSlots).toHaveBeenCalledWith(freshSlots)
    expect(props.recalcStats).toHaveBeenCalledWith(freshSlots)
    expect(props.setFindings).toHaveBeenCalledTimes(1)
    expect(props.setDismissedFindingKeys).toHaveBeenCalledTimes(1)
  })

  // T117 slice 2 — a version written by materializeImportedVersion.js (the
  // 'Imported schedule' snapshot) uses the EXACT same slot shape as any other
  // snapshot, including a mix of activity and anchor placements. Proves that
  // shape round-trips through the unchanged restore path, no special-casing.
  it('restoreSnapshot restores a version written by materializeImportedVersion, including both activity and anchor placements', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} },
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, anchor_id: 'anc-1', is_anchor: true, flags: {} },
      ]),
      name: 'Imported schedule',
      is_auto: false,
    }
    const freshSlots = [
      { id: 's1', is_anchor: false, activity_id: 'act-1' },
      { id: 's2', is_anchor: true, anchor_id: 'anc-1' },
    ]
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      reloadSlots: vi.fn(async () => freshSlots),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-imported' }) })

    expect(repo.restoreSnapshotRows).toHaveBeenCalledWith('tid-generated', expect.any(Array), [])
    const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
    expect(restoredSlots).toHaveLength(2)
    expect(restoredSlots.find((s) => s.is_anchor)).toMatchObject({ anchor_id: 'anc-1', activity_id: null })
    expect(restoredSlots.find((s) => !s.is_anchor)).toMatchObject({ activity_id: 'act-1', anchor_id: null })
    expect(props.setSlots).toHaveBeenCalledWith(freshSlots)
  })

  it('restoreSnapshot refuses a version belonging to the other route without writing', async () => {
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => ({ template_id: 'tid-manual', slots: '[]' })),
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

  // T117 slice 2, restore-time reference guard (Red Hat HIGH) — a Replace
  // re-import mints NEW catalog ids but does not clear existing snapshots.
  // Restoring such a version must non-destructively skip any cell whose
  // referenced ids no longer exist, rather than write dead references into
  // template_slots.
  describe('restore-time reference guard', () => {
    it('restores all slots and reports nothing when every reference is live', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toHaveLength(1)
      expect(props.setActionError).not.toHaveBeenCalledWith(expect.stringContaining('no longer exist'))
    })

    it('drops slots referencing a dead activity_id or a dead group_id and surfaces the count', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} },
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'dead-activity', anchor_id: null, is_anchor: false, flags: {} },
          { group_id: 'dead-group', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toEqual([
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', anchor_id: null, is_anchor: false, flags: {} },
      ])
      expect(props.setActionError).toHaveBeenCalledWith(
        'Restored. 2 cell(s) referenced items that no longer exist (likely from a re-import) and were skipped.'
      )
    })

    it('drops an is_anchor slot with a dead anchor_id', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: 'dead-anchor', is_anchor: true, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toHaveLength(0)
      expect(props.setActionError).toHaveBeenCalledWith(
        'Restored. 1 cell(s) referenced items that no longer exist (likely from a re-import) and were skipped.'
      )
    })

    it('keeps an empty cell (valid group/day/block, no activity or anchor) — not counted as dropped', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, anchor_id: null, is_anchor: false, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toHaveLength(1)
      expect(props.setActionError).not.toHaveBeenCalledWith(expect.stringContaining('no longer exist'))
    })
  })

  it('renameSnapshot writes the new name and clears the auto flag', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.renameSnapshot('snap-1', 'Final') })
    expect(props.repo.writeSnapshotFields).toHaveBeenCalledWith('snap-1', { name: 'Final', is_auto: false })
    expect(props.setSnapshots).toHaveBeenCalledTimes(1)
  })

  // T108 (day-overrides re-point, design §5.2): a snapshot captures the
  // WHOLE WEEK's day_overrides (all days), and restore passes them back to
  // the repository as a 4th argument.
  describe('day_overrides participation', () => {
    it('saveSnapshot captures the week\'s day_overrides into the payload', async () => {
      const dayOverrides = [
        { id: 'ov-1', schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', kind: 'swap', activity_id: 'act-art' },
      ]
      const repo = makeRepo({ loadDayOverridesForWeek: vi.fn(async () => dayOverrides) })
      const { result } = setup({ repo })
      await act(async () => { await result.current.saveSnapshot('v1', false) })

      expect(repo.loadDayOverridesForWeek).toHaveBeenCalledWith('week-1')
      const [, fields] = repo.writeSnapshotFields.mock.calls[0]
      expect(JSON.parse(fields.day_overrides_json)).toEqual(dayOverrides)
    })

    it('saveSnapshot captures an empty day_overrides array when the week has none', async () => {
      const { result, props } = setup()
      await act(async () => { await result.current.saveSnapshot('v1', false) })
      const [, fields] = props.repo.writeSnapshotFields.mock.calls[0]
      expect(JSON.parse(fields.day_overrides_json)).toEqual([])
    })

    it('restoreSnapshot passes the parsed day_overrides payload as restoreSnapshotRows\' 3rd arg', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([]),
        day_overrides_json: JSON.stringify([
          { day_id: 'd1', group_id: 'g1', time_block_id: 'b1', kind: 'pull', activity_id: null },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      expect(repo.restoreSnapshotRows).toHaveBeenCalledWith(
        'tid-generated',
        expect.any(Array),
        [{ day_id: 'd1', group_id: 'g1', time_block_id: 'b1', kind: 'pull', activity_id: null }],
      )
    })

    it('restoreSnapshot from a version saved before overrides existed passes an empty array (restore-to-no-overrides)', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([]),
        // No day_overrides_json at all — a snapshot saved before this feature shipped.
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      expect(repo.restoreSnapshotRows).toHaveBeenCalledWith(
        'tid-generated', expect.any(Array), [],
      )
    })

    // HIGH #3 (T108 review round 2) — restoreSnapshotRows writes the DB
    // correctly, but the grid recomposes from the IN-MEMORY dayOverrides
    // state (owned by useScheduleData, not useSnapshots) via applyDayOverrides.
    // Without reloading + re-setting it after a restore, the grid keeps
    // showing whatever overrides were on screen before the restore — stale
    // data the director didn't ask for and can't see is wrong.
    it('restoreSnapshot reloads day_overrides for the week and calls setDayOverrides with the fresh rows', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([]),
        day_overrides_json: JSON.stringify([
          { id: 'ov-restored', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', kind: 'swap', activity_id: 'act-art' },
        ]),
      }
      const restoredRows = [{ id: 'ov-restored', schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', kind: 'swap', activity_id: 'act-art' }]
      const repo = makeRepo({
        getSnapshot: vi.fn(async () => payload),
        loadDayOverridesForWeek: vi.fn(async () => restoredRows),
      })
      const setDayOverrides = vi.fn()
      const { result } = setup({ repo, setDayOverrides })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      expect(repo.loadDayOverridesForWeek).toHaveBeenCalledWith('week-1')
      expect(setDayOverrides).toHaveBeenCalledWith(restoredRows)
    })

    // restore-to-none: a snapshot from before overrides existed must CLEAR
    // whatever overrides are currently showing, not leave them stale.
    it('restoreSnapshot to a version with no overrides clears the in-memory dayOverrides (empty array)', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([]),
        // No day_overrides_json — pre-feature snapshot.
      }
      const repo = makeRepo({
        getSnapshot: vi.fn(async () => payload),
        loadDayOverridesForWeek: vi.fn(async () => []), // DB now has none, post-restore
      })
      const setDayOverrides = vi.fn()
      const { result } = setup({ repo, setDayOverrides })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      expect(setDayOverrides).toHaveBeenCalledWith([])
    })
  })
})
