// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlotMutations } from './useSlotMutations'
import { getSlot } from './gridGeometry'

// A fake repo capturing exactly the fields handed to each write — no React, no
// Electron. The mutation cluster's whole contract is "which id + which fields
// reach the repo", so the repo is the test surface (ADR 2026-08-01 §3).
function makeRepo(overrides = {}) {
  return {
    writeSlotFields: vi.fn(async () => ({ status: 'applied' })),
    writeOverlayFields: vi.fn(async () => ({ status: 'applied' })),
    writeActivityFields: vi.fn(async () => ({ status: 'applied' })),
    deleteEntity: vi.fn(async () => ({ status: 'applied' })),
    ...overrides,
  }
}

// The route-scoped values the hook pulls off routeState. setSlots/setOverlays are
// the route-PINNED setters (in the real screen they are bound to the route the
// entry was made on); the tests assert the undo closures still target these.
function makeRouteState(overrides = {}) {
  return {
    route: 'manual',
    existingTemplates: { generated: true, manual: true },
    templateId: 'tid-manual',
    setSlots: vi.fn(),
    setOverlays: vi.fn(),
    ...overrides,
  }
}

function makeProps(overrides = {}) {
  const { routeState: rsOver, repo: repoOver, ...rest } = overrides
  return {
    routeState: makeRouteState(rsOver),
    repo: repoOver || makeRepo(),
    pushUndo: vi.fn(),
    setActionError: vi.fn(),
    recalcStats: vi.fn(),
    recalcFindings: vi.fn(),
    getSlot,
    setActivities: vi.fn(),
    slots: [],
    groups: [],
    activities: [],
    days: [],
    timeBlocks: [],
    campId: 'camp-1',
    ...rest,
  }
}

function setup(overrides = {}) {
  const props = makeProps(overrides)
  const hook = renderHook((p) => useSlotMutations(p), { initialProps: props })
  return { hook, props }
}

// A promise + resolver pair for hand-controlled write resolution order — no
// setTimeout/timing-dependent flakiness (2026-08-12 write-serialization ADR
// test seam plan).
function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

// Same stateful stand-in as the fresh-read undo snapshot describe block above,
// but exposed with a `.get()` so these tests can assert on the final slots
// array directly, without needing a re-render.
function statefulSetSlots(initialSlots) {
  let current = initialSlots
  const fn = vi.fn((updater) => {
    current = typeof updater === 'function' ? updater(current) : updater
  })
  return { fn, get: () => current }
}

// The delicate part (T32): undo closures must replay against the SAME
// route-pinned setter + repo + slot id the entry was made on — even after the
// director has switched routes — so an undo never writes the candidate on
// screen instead of the one it belongs to. Exercised directly against
// replaceSlot below (`replaceSlot`'s own describe block's "undo restores..."
// test covers the mechanism now that editSlotSave is gone).

describe('useSlotMutations — replaceSlot', () => {
  it('places the incoming activity into an empty target and pushes an undo', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' }, // palette drop: no source coords
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('replaces an occupied target — the occupant is not written anywhere, just overwritten', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-occupant', flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
  })

  it('grid-to-grid: clears the source slot in addition to writing the target', async () => {
    const slots = [
      { id: 'row-source', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b2' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
  })

  it('refuses to write onto an anchor target', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_anchor: true, activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })

  it('does nothing when the route has no template', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({
      slots,
      activities: [{ id: 'act-1', name: 'Swim' }],
      routeState: { existingTemplates: { manual: false, generated: false } },
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })

  it('undo restores both target and (grid-to-grid) source to their previous activity_id', async () => {
    const slots = [
      { id: 'row-source', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-occupant', flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b2' }
      )
    })
    const entry = props.pushUndo.mock.calls[0][0]
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-occupant', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source', { activity_id: 'act-1', flags: {} })
  })
})

// Deviation A (2026-08-12 drag-FSM gesture-correlation ADR): the undo snapshot
// must reflect the freshest known state, not the `slots` this render closed
// over — a second same-cell replaceSlot call, made before a re-render, must not
// capture the same stale "previous activity" the first call already captured.
describe('useSlotMutations — replaceSlot fresh-read undo snapshot (Issue 2)', () => {
  // A stateful stand-in for the route-pinned setSlots setter: real React
  // applies a functional update's `prev` in true chronological order even
  // without a re-render, which is exactly the guarantee slotsRef relies on.
  // The plain `vi.fn()` used elsewhere in this file never calls the updater at
  // all, so it can't exercise that guarantee — this test needs one that does.
  function makeStatefulSetSlots(initialSlots) {
    let current = initialSlots
    const fn = vi.fn((updater) => {
      current = typeof updater === 'function' ? updater(current) : updater
    })
    return fn
  }

  it('two fast same-cell replaceSlot calls (no re-render between them): the second undo restores what the FIRST call actually placed, not the original pre-both-drags state', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-1', name: 'First Drag' },
      { id: 'act-2', name: 'Second Drag' },
    ]
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: makeStatefulSetSlots(slots) } })

    // Drag 1: places act-1 over the original occupant. Its own optimistic
    // setSlots call lands (updating slotsRef), same as it would in the app —
    // but the hook is never re-rendered with a fresh `slots` prop afterward,
    // reproducing "two fast drags before a re-render".
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const firstEntry = props.pushUndo.mock.calls[0][0]

    // Drag 2: places act-2 over what drag 1 just placed. Called on the SAME
    // hook instance, still closed over the original stale `slots` prop.
    props.repo.writeSlotFields.mockClear()
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const secondEntry = props.pushUndo.mock.calls[1][0]

    // The second drag's undo must restore act-1 (what drag 1 actually left
    // behind), never act-orig (the pre-either-drag value both calls' stale
    // `slots` closure would have agreed on before this fix).
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await secondEntry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })

    // And the first drag's own undo is untouched by this fix — still restores
    // the true original.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await firstEntry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-orig', flags: {} })
  })

  it('a single drag keeps byte-identical undo/redo semantics (regression guard for the fresh-read change)', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-occupant', flags: { someFlag: true } },
    ]
    const activities = [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }]
    const { hook, props } = setup({ slots, activities })

    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-occupant', flags: { someFlag: true } })

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.redo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
  })
})

describe('useSlotMutations — releaseCell', () => {
  it('writes is_released and updates the route setter', async () => {
    const { hook, props } = setup()
    await act(async () => { await hook.result.current.releaseCell('s9') })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s9', { is_released: true })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
  })
})

describe('useSlotMutations — overlays', () => {
  it('addOverlay writes the overlay fields and appends to the route overlays', async () => {
    const { hook, props } = setup()
    await act(async () => {
      await hook.result.current.addOverlay({
        unitId: 'u1', dayId: 'd1', fromBlockOrder: 2, toBlockOrder: 4, label: 'Trip',
      })
    })
    expect(props.repo.writeOverlayFields).toHaveBeenCalledWith(
      expect.any(String),
      { template_id: 'tid-manual', unit_id: 'u1', day_id: 'd1', from_block_order: 2, to_block_order: 4, label: 'Trip' },
    )
    expect(props.routeState.setOverlays).toHaveBeenCalledTimes(1)
  })

  it('addOverlay does nothing without a unitId', async () => {
    const { hook, props } = setup()
    await act(async () => {
      await hook.result.current.addOverlay({ unitId: null, dayId: 'd1', fromBlockOrder: 0, toBlockOrder: 0, label: 'x' })
    })
    expect(props.repo.writeOverlayFields).not.toHaveBeenCalled()
    expect(props.routeState.setOverlays).not.toHaveBeenCalled()
  })

  it('removeOverlay deletes via the repo and updates the route overlays', async () => {
    const { hook, props } = setup()
    await act(async () => { await hook.result.current.removeOverlay('ov-1') })
    expect(props.repo.deleteEntity).toHaveBeenCalledWith('template_overlays', 'ov-1')
    expect(props.routeState.setOverlays).toHaveBeenCalledTimes(1)
  })
})

// The other half of the delicate part: a redo entry must re-APPLY the new value
// against the SAME route-pinned setter + repo + slot id, even after a route
// switch — the exact mirror of the route-pinned undo test above.
describe('useSlotMutations — route-pinned redo closure', () => {
  const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }

  it('replaceSlot redo re-applies the new activity via the entry-route setter after a route switch', async () => {
    const originalSetSlots = vi.fn()
    const pushUndo = vi.fn()
    const repo = makeRepo()

    const props = makeProps({
      slots: [slot],
      activities: [{ id: 'act-1', name: 'Swim' }],
      repo,
      pushUndo,
      routeState: { setSlots: originalSetSlots },
    })
    const hook = renderHook((p) => useSlotMutations(p), { initialProps: props })

    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = pushUndo.mock.calls[0][0]

    // Director switches routes: the on-screen setter is now a DIFFERENT spy.
    const afterSwitchSetSlots = vi.fn()
    hook.rerender(makeProps({
      slots: [slot],
      activities: [{ id: 'act-1', name: 'Swim' }],
      repo,
      pushUndo,
      routeState: { setSlots: afterSwitchSetSlots },
    }))

    repo.writeSlotFields.mockClear()
    originalSetSlots.mockClear()
    await act(async () => { await entry.redo() })

    // Repo replays the NEW value against the ORIGINAL slot id.
    expect(repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'act-1', flags: {} })
    // Driven through the entry's route setter — NOT the one now on screen.
    expect(originalSetSlots).toHaveBeenCalled()
    expect(afterSwitchSetSlots).not.toHaveBeenCalled()
  })
})

describe('useSlotMutations — expandSlot', () => {
  // b1 (head, "Swim") is stretched over b2 (tail, "Archery"); Archery is displaced.
  const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
  const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
  const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]
  const expandedFlags = { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } }

  function expand(hook) {
    return hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon')
  }

  it('merges the two cells (tail owned by head + span flag, head gets the expanded flag) and updates state', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities })
    await act(async () => { await expand(hook) })

    // Tail cell now belongs to the head activity and is a tail (is_span_head:false).
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false })
    // Head cell records the merge in its flags.
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: expandedFlags })
    // Optimistic setSlots + one undo entry.
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('undo() reverses both writes', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities })
    await act(async () => { await expand(hook) })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })

    // Tail restored to its own activity as a span head; head's flags restored.
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actTail', is_span_head: true })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: {} })
  })
})

describe('useSlotMutations — splitSlot', () => {
  // b1 is a merged head whose span covers b2; splitting frees b2 again.
  const headSlot = {
    id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true,
    flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
  }
  const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false }
  const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
  const days = [{ id: 'd1', label: 'Mon' }]

  it('splits the merged span back into two (tail cleared to a fresh span head, head flags cleaned)', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: {} })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('undo() restores the merged span (tail back to the head activity as a tail, head expanded flag back)', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: headSlot.flags })
  })
})

describe('useSlotMutations — placeActivityManual', () => {
  const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }

  it('places an eligible activity with cleared flags and pushes an undo (manual route never flags UNFILLABLE)', async () => {
    const { hook, props } = setup({
      slots: [slot],
      groups: [{ id: 'g1', tier_id: 't1' }],
      activities: [{ id: 'a1', name: 'Swim' }],
    })
    await act(async () => { await hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'a1', flags: {} })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('flags UNFILLABLE on the generated route when the activity is ineligible for the group', async () => {
    const { hook, props } = setup({
      slots: [slot],
      groups: [{ id: 'g1', tier_id: 't1' }],
      // Eligible only for a different tier + a different group → ineligible here.
      activities: [{ id: 'a1', name: 'Swim', eligible_tier_ids: ['t2'], eligible_group_ids: ['gX'] }],
      routeState: { route: 'generated', templateId: 'tid-generated' },
    })
    await act(async () => { await hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'a1', flags: { UNFILLABLE: true } })
  })
})

describe('useSlotMutations — createActivityFromCell', () => {
  it('creates a camp-scoped activity with usage-derived rule (min_per_week=1, max=null, all-groups eligible), adds it to the palette list, and places it', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const { hook, props } = setup({ slots, activities: [], campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }] })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const createCall = props.repo.writeActivityFields.mock.calls[0]
    expect(createCall[1]).toMatchObject({
      name: 'Kayaking', camp_id: 'camp-1', min_per_week: 1, max_per_week: null,
      eligible_tier_ids: [], eligible_group_ids: [], priority: null,
    })
    expect(props.setActivities).toHaveBeenCalled()
    // placeActivityManual's own write follows — assert the slot write landed too:
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', expect.objectContaining({ activity_id: createCall[0] }))
  })

  it('a name that collapses (case/space-insensitive) to an existing activity places the existing one instead of creating a duplicate', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const { hook, props } = setup({
      slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }],
      activities: [{ id: 'act-existing', name: 'Kayaking', eligible_tier_ids: [], eligible_group_ids: [] }],
    })
    await act(async () => {
      await hook.result.current.createActivityFromCell('  kayaking  ', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeActivityFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', expect.objectContaining({ activity_id: 'act-existing' }))
  })

  it('does not place when the activity write fails', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const repo = makeRepo({ writeActivityFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({ slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }], activities: [], repo })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })
})

// 2026-08-12 drag-live-write-serialization ADR/spec: the per-cell
// cellGestureRef ledger. All 8 tests from the spec's "Test seam plan".
describe('useSlotMutations — recency-gated live writes (write-serialization ADR)', () => {
  it('1. facet 1 fixed: a same-cell replaceSlot whose write resolves LATE does not clobber the gesture that superseded it', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-1', name: 'First Drag' },
      { id: 'act-2', name: 'Second Drag' },
    ]
    const d1 = deferred()
    const d2 = deferred()
    let call = 0
    const writeSlotFields = vi.fn(() => {
      call += 1
      return call === 1 ? d1.promise : d2.promise
    })
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    // g1 starts first (claims the cell), write left in flight.
    const p1 = hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    // g2 starts before g1's write resolves (claims the cell over g1), write also in flight.
    const p2 = hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')

    // g2's write resolves FIRST.
    await act(async () => { d2.resolve({ status: 'applied' }); await p2 })
    // g1's write resolves AFTER — even though it's the earlier gesture.
    await act(async () => { d1.resolve({ status: 'applied' }); await p1 })

    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
  })

  it('2. happy path unchanged: same two calls resolved IN gesture order produce the same final state as today', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-1', name: 'First Drag' },
      { id: 'act-2', name: 'Second Drag' },
    ]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: setSlots.fn } })

    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')
    })

    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
    expect(props.pushUndo).toHaveBeenCalledTimes(2)
  })

  it('3. facet 2 fixed for expandSlot: two racing same-head-cell calls with no re-render between them — the second undo entry captures the FIRST call\'s actual result, not a shared stale snapshot', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities, routeState: { setSlots: setSlots.fn } })

    // Gesture g1 expands b1 over b2 first.
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon', 'g1')
    })
    // Gesture g2 does the same expand call again, still closed over the same
    // stale `slots` prop (no re-render happened) — mirrors the replaceSlot
    // fresh-read regression test's structure, applied to expandSlot.
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon', 'g2')
    })
    const g2Entry = props.pushUndo.mock.calls[1][0]

    // g2's undo must restore what g1 ACTUALLY left behind (head flags carrying
    // g1's own `expanded` marker), not the pre-either-call state both calls'
    // stale `slots` closure would agree on without the fresh-read fix.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g2Entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', {
      flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
    })
  })

  it('4. facet 2 fixed for splitSlot: same shape as expandSlot, applied to the head/tail snapshot', async () => {
    const headSlot = {
      id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true,
      flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
    }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false }
    const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
    const days = [{ id: 'd1', label: 'Mon' }]
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days, routeState: { setSlots: setSlots.fn } })

    // g1 splits first — tail is freed (activity_id: null, is_span_head: true).
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1', 'g1')
    })
    // g2 splits "again", still closed over the original (unsplit) `slots` prop.
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1', 'g2')
    })
    const g2Entry = props.pushUndo.mock.calls[1][0]

    // g2's undo must restore the tail to what g1's split ACTUALLY left it as
    // (freed: null / is_span_head true) — not the stale pre-split values
    // (owned by the head activity / is_span_head false) both calls' shared
    // `slots` closure would otherwise agree on.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g2Entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: null, is_span_head: true, flags: {} })
  })

  it('5. facet 3 fixed: a fully-superseded call does not push a phantom undo entry', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-1', name: 'First Drag' },
      { id: 'act-2', name: 'Second Drag' },
    ]
    const d1 = deferred()
    const d2 = deferred()
    let call = 0
    const writeSlotFields = vi.fn(() => {
      call += 1
      return call === 1 ? d1.promise : d2.promise
    })
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    const p1 = hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    const p2 = hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')
    await act(async () => { d2.resolve({ status: 'applied' }); await p2 })
    await act(async () => { d1.resolve({ status: 'applied' }); await p1 })

    // Only g2 (the surviving gesture) gets an undo entry — g1's fully
    // superseded call must not push a phantom entry for a change that never
    // took visible effect.
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
    expect(props.pushUndo.mock.calls[0][0].description).toMatch(/act-2|Second Drag/i)
  })

  it('6. undo/redo re-check: an undo run after a newer gesture has since claimed the cell still writes correctly, and the newer gesture\'s own redo still restores cleanly afterward', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-1', name: 'First' },
      { id: 'act-2', name: 'Second' },
    ]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: setSlots.fn } })

    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    })
    const g1Entry = props.pushUndo.mock.calls[0][0]

    // g2 comes along afterward and claims + writes the same cell — this is
    // "g2 has since claimed the cell" per the spec's test 6.
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')
    })
    const g2Entry = props.pushUndo.mock.calls[1][0]
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')

    // g1's undo is an explicit user action — it always writes — and because it
    // re-claims the cell for its own gestureId immediately before writing, the
    // ledger (and the cell) correctly reflect g1 as current again afterward.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g1Entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-orig', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-orig')

    // g2's redo re-claims for itself and restores cleanly — no crash, no
    // dropped stack entry, no doubled write.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g2Entry.redo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-2', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
  })

  it('7. gestureId === undefined always claims and always wins its own check (non-drag call regression guard)', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      // No gestureId argument at all — the CellInlineEditor / typeahead path.
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('8. cross-handler race: the target of one gesture is the SOURCE of another — the per-cell ledger (not per-call) decides the shared cell\'s final value', async () => {
    const rowA = { id: 'row-a', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-a', flags: {} }
    const rowC = { id: 'row-c', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, flags: {} }
    const activities = [{ id: 'act-a', name: 'Art' }, { id: 'act-x', name: 'Extra' }]
    const slots = [rowA, rowC]

    const dA = deferred() // g1's target (A) write
    const dB = deferred() // g2's target(C) + source(A) writes
    let call = 0
    const writeSlotFields = vi.fn(() => {
      call += 1
      return call === 1 ? dA.promise : dB.promise
    })
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    // g1: places act-x directly into cell A. Claims A for g1, write in flight.
    const p1 = hook.result.current.replaceSlot({ activityId: 'act-x' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    // g2: moves A's occupant to cell C — source=A, target=C. Claims C AND A
    // (as its source) for g2, superseding g1's claim on A. Writes in flight.
    const p2 = hook.result.current.replaceSlot(
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-a' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b3' },
      'g2'
    )

    // g2's writes (target C + source A) resolve first.
    await act(async () => { dB.resolve({ status: 'applied' }); await p2 })
    // g1's write (target A only) resolves after — but A is no longer g1's claim.
    await act(async () => { dA.resolve({ status: 'applied' }); await p1 })

    const final = setSlots.get()
    // A ends up matching g2's write (cleared, since g2 moved its occupant out),
    // not g1's write (act-x) — proving per-cell, not per-call, granularity.
    expect(final.find(s => s.id === 'row-a').activity_id).toBeNull()
    expect(final.find(s => s.id === 'row-c').activity_id).toBe('act-a')
  })
})
