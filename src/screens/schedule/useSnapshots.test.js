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
      generated: [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} }],
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
    fixedEvents: [{ id: 'anc-1' }],
    weekId: 'week-1',
    replacedDayIds: [],
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
        manual: [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-9', fixed_event_id: null, is_fixed_event: false, flags: {} }],
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
    expect(props.setActionError).toHaveBeenCalledWith('Admin only.')
    expect(props.setSnapshots).not.toHaveBeenCalled()
  })

  it('deleteSnapshot surfaces a non-applied status without dropping the row', async () => {
    const repo = makeRepo({ deleteEntity: vi.fn(async () => ({ status: 'rejected' })) })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.deleteSnapshot('snap-1') })
    expect(props.setActionError).toHaveBeenCalledWith("Couldn't delete that version.")
    expect(props.setSnapshots).not.toHaveBeenCalled()
  })

  it('restoreSnapshot clears undo/redo, restores rows, and reloads slots/stats/findings', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_fixed_event: false, flags: {} }]),
    }
    const freshSlots = [{ id: 's1', is_fixed_event: false, activity_id: 'act-1' }]
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      reloadSlots: vi.fn(async () => freshSlots),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

    expect(props.resetUndoRedo).toHaveBeenCalledTimes(1)
    expect(repo.restoreSnapshotRows).toHaveBeenCalledWith('tid-generated', expect.any(Array))
    expect(props.setSlots).toHaveBeenCalledWith(freshSlots)
    expect(props.recalcStats).toHaveBeenCalledWith(freshSlots)
    expect(props.setFindings).toHaveBeenCalledTimes(1)
    expect(props.setDismissedFindingKeys).toHaveBeenCalledTimes(1)
  })

  it('restoreSnapshot first saves the current schedule as an auto version, so the restore can be undone', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_fixed_event: false, flags: {} }]),
    }
    const order = []
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      writeSnapshotFields: vi.fn(async () => { order.push('save'); return { status: 'applied' } }),
      restoreSnapshotRows: vi.fn(async () => { order.push('restore'); return { status: 'applied' } }),
    })
    const { result } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

    expect(order).toEqual(['save', 'restore'])
    const [, fields] = repo.writeSnapshotFields.mock.calls[0]
    expect(fields).toMatchObject({ template_id: 'tid-generated', is_auto: true })
    expect(JSON.parse(fields.slots)).toHaveLength(1)
  })

  it('restoreSnapshot does not restore, and says so, when the pre-restore save fails', async () => {
    const payload = { template_id: 'tid-generated', slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_fixed_event: false, flags: {} }]) }
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      writeSnapshotFields: vi.fn(async () => { throw new Error('disk full') }),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

    expect(repo.restoreSnapshotRows).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalled()
  })

  // T117 slice 2 — a version written by materializeImportedVersion.js (the
  // 'Imported schedule' snapshot) uses the EXACT same slot shape as any other
  // snapshot, including a mix of activity and anchor placements. Proves that
  // shape round-trips through the unchanged restore path, no special-casing.
  it('restoreSnapshot restores a version written by materializeImportedVersion, including both activity and anchor placements', async () => {
    const payload = {
      template_id: 'tid-generated',
      slots: JSON.stringify([
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} },
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, fixed_event_id: 'anc-1', is_fixed_event: true, flags: {} },
      ]),
      name: 'Imported schedule',
      is_auto: false,
    }
    const freshSlots = [
      { id: 's1', is_fixed_event: false, activity_id: 'act-1' },
      { id: 's2', is_fixed_event: true, fixed_event_id: 'anc-1' },
    ]
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => payload),
      reloadSlots: vi.fn(async () => freshSlots),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-imported' }) })

    expect(repo.restoreSnapshotRows).toHaveBeenCalledWith('tid-generated', expect.any(Array))
    const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
    expect(restoredSlots).toHaveLength(2)
    expect(restoredSlots.find((s) => s.is_fixed_event)).toMatchObject({ fixed_event_id: 'anc-1', activity_id: null })
    expect(restoredSlots.find((s) => !s.is_fixed_event)).toMatchObject({ activity_id: 'act-1', fixed_event_id: null })
    expect(props.setSlots).toHaveBeenCalledWith(freshSlots)
  })

  it('restoreSnapshot refuses a version belonging to the other route without writing', async () => {
    const repo = makeRepo({
      getSnapshot: vi.fn(async () => ({ template_id: 'tid-manual', slots: '[]' })),
    })
    const { result, props } = setup({ repo })
    await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })
    expect(props.setActionError).toHaveBeenCalledWith(
      'Belongs to the other schedule.'
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
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} },
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
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} },
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'dead-activity', fixed_event_id: null, is_fixed_event: false, flags: {} },
          { group_id: 'dead-group', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toEqual([
        { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', fixed_event_id: null, is_fixed_event: false, flags: {} },
      ])
      expect(props.setActionError).toHaveBeenCalledWith(
        'Restored; 2 cell(s) skipped (item removed).'
      )
    })

    it('drops an is_fixed_event slot with a dead fixed_event_id', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, fixed_event_id: 'dead-anchor', is_fixed_event: true, flags: {} },
        ]),
      }
      const repo = makeRepo({ getSnapshot: vi.fn(async () => payload) })
      const { result, props } = setup({ repo })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const restoredSlots = repo.restoreSnapshotRows.mock.calls[0][1]
      expect(restoredSlots).toHaveLength(0)
      expect(props.setActionError).toHaveBeenCalledWith(
        'Restored; 1 cell(s) skipped (item removed).'
      )
    })

    it('keeps an empty cell (valid group/day/block, no activity or anchor) — not counted as dropped', async () => {
      const payload = {
        template_id: 'tid-generated',
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, fixed_event_id: null, is_fixed_event: false, flags: {} },
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

  // Red Hat HIGH (round 2): the FIXED_EVENT_DUPLICATE gate is hand-duplicated at
  // three computeFindings call sites; restoreSnapshot (here, line ~175-178) is
  // one of them and was uncovered — this file mocks nothing of computeFindings,
  // so the real engine (src/engine/buildSchedule.js) runs, and the fixture
  // below is the same anchor/duplicate-regular-slot shape pinned in
  // buildSchedule.test.js's "computeFindings FIXED_EVENT_DUPLICATE" describe block.
  describe('restoreSnapshot route-gates FIXED_EVENT_DUPLICATE (real computeFindings, not mocked)', () => {
    const anchor = { id: 'anc1', activity_id: 'lunch', name: 'Lunch', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'b1', span_blocks: 1 }
    // Fresh object per test: restoreSnapshot mutates the `fullSnap` it is
    // handed (`fullSnap.slots = parsed.slots`), so a payload object SHARED
    // across tests would have its `.slots` silently flipped from a JSON
    // string to an already-parsed array by whichever test ran first.
    function makePayload(templateId) {
      return {
        template_id: templateId,
        slots: JSON.stringify([
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, fixed_event_id: null, is_fixed_event: true, flags: {} },
          { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'lunch', fixed_event_id: null, is_fixed_event: false, flags: {} },
        ]),
      }
    }
    const freshSlots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'anchor-slot', is_fixed_event: true, flags: {} },
      { id: 's2', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'lunch', is_fixed_event: false, flags: {} },
    ]

    it('generated route: an FIXED_EVENT_DUPLICATE finding reaches setFindings after restore', async () => {
      const repo = makeRepo({
        getSnapshot: vi.fn(async () => makePayload('tid-generated')),
        reloadSlots: vi.fn(async () => freshSlots),
      })
      const { result, props } = setup({
        repo,
        activities: [{ id: 'lunch', name: 'Lunch' }],
        fixedEvents: [anchor],
      })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const findings = props.setFindings.mock.calls[0][0]
      expect(findings.some(f => f.kind === 'FIXED_EVENT_DUPLICATE')).toBe(true)
    })

    it('manual route: the same anchor/duplicate data never surfaces FIXED_EVENT_DUPLICATE after restore', async () => {
      const repo = makeRepo({
        getSnapshot: vi.fn(async () => makePayload('tid-manual')),
        reloadSlots: vi.fn(async () => freshSlots),
      })
      const { result, props } = setup({
        repo,
        route: 'manual',
        templateId: 'tid-manual',
        activities: [{ id: 'lunch', name: 'Lunch' }],
        fixedEvents: [anchor],
      })
      await act(async () => { await result.current.restoreSnapshot({ id: 'snap-1' }) })

      const findings = props.setFindings.mock.calls[0][0]
      expect(findings.some(f => f.kind === 'FIXED_EVENT_DUPLICATE')).toBe(false)
    })
  })

  it('renameSnapshot writes the new name and clears the auto flag', async () => {
    const { result, props } = setup()
    await act(async () => { await result.current.renameSnapshot('snap-1', 'Final') })
    expect(props.repo.writeSnapshotFields).toHaveBeenCalledWith('snap-1', { name: 'Final', is_auto: false })
    expect(props.setSnapshots).toHaveBeenCalledTimes(1)
  })

})
