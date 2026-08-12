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

// 2026-07/2026-08 gesture-correlation ADR: fresh-read undo snapshots for
// expandSlot/splitSlot. Unrelated to the write-serialization queue below
// (that mechanism decides WHEN a write is sent; this one decides WHAT
// "previous" value an undo entry captures) — kept as its own describe block
// so it stays independent of whichever write-ordering mechanism is current.
describe('useSlotMutations — fresh-read undo snapshot (gesture-correlation ADR)', () => {
  it('facet 2 fixed for expandSlot: two racing same-head-cell calls with no re-render between them — the second undo entry captures the FIRST call\'s actual result, not a shared stale snapshot', async () => {
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

  it('facet 2 fixed for splitSlot: same shape as expandSlot, applied to the head/tail snapshot', async () => {
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
})

// 2026-08-12 drag-live-write-serialization ADR/spec, revised: per-cell write
// serialization (cellQueueRef claim/chain/dispatch), replacing the reversed
// token-only design in full. All 8 tests from the ADR's "Test seam plan" —
// critically, these assert repo.writeSlotFields CALL COUNT AND ARGUMENTS
// directly, not just the resulting `slots` state, closing the exact gap that
// let the reversed design pass its own tests while diverging at the database
// (finding 1).
describe('useSlotMutations — per-cell write serialization (write-serialization ADR, revised)', () => {
  it('1. finding 1 fixed at the write call: a claim superseded while genuinely queued behind an in-flight write on the same cell is NEVER dispatched', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Original' },
      { id: 'act-0', name: 'Zeroth' },
      { id: 'act-1', name: 'First Drag' },
      { id: 'act-2', name: 'Second Drag' },
    ]
    // Only g0's write is deliberately slow — g1 and g2's mock writes resolve
    // immediately once dispatched. The queue itself is what serializes them.
    const d0 = deferred()
    let call = 0
    const writeSlotFields = vi.fn(() => {
      call += 1
      return call === 1 ? d0.promise : Promise.resolve({ status: 'applied' })
    })
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    // g0 claims and dispatches first — its write is left genuinely in flight.
    const p0 = hook.result.current.replaceSlot({ activityId: 'act-0' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g0')
    // Flush microtasks so g0's own claim/chain check actually completes and
    // its write reaches repo.writeSlotFields (call count 1, pending on d0)
    // BEFORE g1/g2 claim — otherwise all three claims land in the same tick
    // and only the LAST claim's own check ever passes, which is a different
    // (already-covered) scenario, not "queued behind a real in-flight write".
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(writeSlotFields).toHaveBeenCalledTimes(1)

    // g1 claims while g0's write is still in flight — it queues BEHIND g0's
    // real dispatched write, not just behind a synchronous claim overwrite.
    const p1 = hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    // g2 claims before g1's turn ever arrives — g1 is superseded before it
    // ever reaches the dispatch step.
    const p2 = hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')

    await act(async () => { d0.resolve({ status: 'applied' }); await Promise.all([p0, p1, p2]) })

    // Exactly two writes ever reached the repo: g0's (already dispatched
    // before anything superseded it) and g2's (the survivor). g1's write —
    // genuinely queued behind a real in-flight write, not just claim-
    // overwritten pre-dispatch — was superseded before its own turn and was
    // NEVER sent to repo.writeSlotFields at all.
    expect(writeSlotFields).toHaveBeenCalledTimes(2)
    expect(writeSlotFields).toHaveBeenNthCalledWith(1, 'row-target', { activity_id: 'act-0', flags: {} })
    expect(writeSlotFields).toHaveBeenNthCalledWith(2, 'row-target', { activity_id: 'act-2', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
  })

  it('2. non-colliding case is a no-op change vs. current behavior: a single call dispatches immediately, and two non-colliding calls in gesture order both dispatch', async () => {
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

    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
    expect(props.repo.writeSlotFields).toHaveBeenNthCalledWith(1, 'row-target', { activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenNthCalledWith(2, 'row-target', { activity_id: 'act-2', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
    expect(props.pushUndo).toHaveBeenCalledTimes(2)
  })

  it('3. finding 2 fixed: same (groupId, dayId, blockId) on different (route, templateId) do not collide — both dispatch independently', async () => {
    const rowManual = { id: 'row-manual', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const rowGenerated = { id: 'row-generated', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const activities = [{ id: 'act-1', name: 'Swim' }]
    const dManual = deferred()
    const dGenerated = deferred()
    let call = 0
    const writeSlotFields = vi.fn(() => {
      call += 1
      return call === 1 ? dManual.promise : dGenerated.promise
    })
    const repo = makeRepo({ writeSlotFields })
    const setSlotsManual = statefulSetSlots([rowManual])
    const setSlotsGenerated = statefulSetSlots([rowGenerated])

    const manualProps = makeProps({
      slots: [rowManual], activities, repo,
      routeState: makeRouteState({ route: 'manual', templateId: 'tid-manual', setSlots: setSlotsManual.fn }),
    })
    const { result, rerender } = renderHook((p) => useSlotMutations(p), { initialProps: manualProps })

    // Manual route claims (g1, target = the manual row) — write left in flight.
    const pManual = result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')

    // Same coordinates, Generated route/templateId — a distinct cell by identity.
    rerender({
      ...manualProps,
      slots: [rowGenerated],
      routeState: makeRouteState({ route: 'generated', templateId: 'tid-generated', setSlots: setSlotsGenerated.fn }),
    })
    const pGenerated = result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')

    await act(async () => { dManual.resolve({ status: 'applied' }); await pManual })
    await act(async () => { dGenerated.resolve({ status: 'applied' }); await pGenerated })

    // Neither claim-dropped the other — both cells got their own write.
    expect(writeSlotFields).toHaveBeenCalledTimes(2)
    expect(setSlotsManual.fn).toHaveBeenCalledTimes(1)
    expect(setSlotsGenerated.fn).toHaveBeenCalledTimes(1)
    expect(setSlotsManual.get().find(s => s.id === 'row-manual').activity_id).toBe('act-1')
    expect(setSlotsGenerated.get().find(s => s.id === 'row-generated').activity_id).toBe('act-1')
  })

  it('4. multi-cell atomicity (replaceSlot source+target): a superseded operation dispatches no write for EITHER cell, and does not push undo', async () => {
    const targetRow = { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-a', flags: {} }
    const sourceRow = { id: 'row-source', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-b', flags: {} }
    const slots = [targetRow, sourceRow]
    const activities = [{ id: 'act-a', name: 'A' }, { id: 'act-b', name: 'B' }, { id: 'act-c', name: 'C' }]
    const d1 = deferred()
    const writeSlotFields = vi.fn(() => d1.promise)
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    // g1: moves the source (b2) activity into the target (b1) — claims BOTH
    // b1 (target) and b2 (source) as one atomic unit.
    const p1 = hook.result.current.replaceSlot(
      { groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'act-b' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b1' },
      'g1'
    )
    // g2: claims the target cell (b1) only, superseding g1's claim on it
    // before g1's chain has settled.
    const p2 = hook.result.current.replaceSlot({ activityId: 'act-c' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')

    d1.resolve({ status: 'applied' })
    await act(async () => { await Promise.all([p1, p2]) })

    // g1's op must be dropped in full — no write to b1 (target) OR b2
    // (source). Only g2's single write reaches the repo.
    expect(writeSlotFields).toHaveBeenCalledTimes(1)
    expect(writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-c', flags: {} })
    expect(writeSlotFields).not.toHaveBeenCalledWith('row-source', expect.anything())
    expect(props.pushUndo).toHaveBeenCalledTimes(1) // only g2's — g1 pushes nothing
  })

  it('5. multi-cell atomicity (expandSlot head+tail): a superseded expand dispatches no write for EITHER cell', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }, { id: 'actOther', name: 'Other' }]
    const slots = [headSlot, tailSlot]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: setSlots.fn } })

    // g1's expand claims BOTH the head (b1) and tail (b2) cells atomically.
    const p1 = hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon', 'g1')
    // g2 supersedes just the head cell via a same-cell replaceSlot claim,
    // before g1's chain has settled.
    const p2 = hook.result.current.replaceSlot({ activityId: 'actOther' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')

    await act(async () => { await Promise.all([p1, p2]) })

    // g1's expand must dispatch no write to head OR tail.
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t1', expect.anything())
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { activity_id: 'actOther', flags: {} })
    expect(props.pushUndo).toHaveBeenCalledTimes(1) // only g2's replaceSlot
  })

  it('6. finding 3 fixed: undo/redo go through the identical claim/chain path — an undo run after a newer gesture has claimed the cell re-claims and writes correctly, and the newer gesture\'s redo still restores cleanly afterward', async () => {
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

    // g2 comes along afterward and claims + writes the same cell.
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-2' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g2')
    })
    const g2Entry = props.pushUndo.mock.calls[1][0]
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')

    // g1's undo is an explicit, sequential user action — it re-claims the
    // cell with its own synthesized claim id immediately before writing, so
    // it dispatches (nothing has claimed the cell since).
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g1Entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-orig', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-orig')

    // g2's redo re-claims for itself and restores cleanly.
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await g2Entry.redo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-2', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-2')
  })

  it('7. finding 4 fixed: a non-drag write (no gestureId) is never exempt — it participates in the same ordering and can supersede a drag claim', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-orig', flags: {} },
    ]
    const activities = [
      { id: 'act-orig', name: 'Orig' },
      { id: 'act-drag', name: 'Drag' },
      { id: 'act-click', name: 'Click' },
    ]
    const d1 = deferred()
    const writeSlotFields = vi.fn(() => d1.promise)
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots(slots)
    const { hook } = setup({ slots, activities, repo, routeState: { setSlots: setSlots.fn } })

    // g1: a same-cell drag write, gestureId supplied.
    const pDrag = hook.result.current.replaceSlot({ activityId: 'act-drag' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, 'g1')
    // Non-drag call arrives after — no gestureId argument at all. It must
    // still synthesize a claim id and supersede g1, not bypass the check.
    const pClick = hook.result.current.replaceSlot({ activityId: 'act-click' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })

    d1.resolve({ status: 'applied' })
    await act(async () => { await Promise.all([pDrag, pClick]) })

    // Only the non-drag call's write reaches the repo — g1's drag write was
    // dropped, proving there is no gestureId === undefined exemption.
    expect(writeSlotFields).toHaveBeenCalledTimes(1)
    expect(writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-click', flags: {} })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-click')
  })

  it('8. canonical claim ordering avoids deadlock: two multi-cell operations whose cell sets overlap in opposite order both resolve', async () => {
    const rowX = { id: 'row-x', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-x', flags: {} }
    const rowY = { id: 'row-y', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-y', flags: {} }
    const activities = [{ id: 'act-x', name: 'X' }, { id: 'act-y', name: 'Y' }]
    const slots = [rowX, rowY]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: setSlots.fn } })

    // Op A: cells [X, Y] — moves X's occupant into Y.
    const pA = hook.result.current.replaceSlot(
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-x' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b2' },
      'gA'
    )
    // Op B: cells [Y, X] — the same two cells, declared/claimed in the
    // opposite order — moves Y's occupant into X.
    const pB = hook.result.current.replaceSlot(
      { groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'act-y' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b1' },
      'gB'
    )

    // Neither call hangs — both settle. (A genuine deadlock would time out
    // the test instead of reaching this assertion.)
    await act(async () => { await Promise.all([pA, pB]) })

    expect(props.repo.writeSlotFields.mock.calls.length).toBeGreaterThan(0)
  })
})
