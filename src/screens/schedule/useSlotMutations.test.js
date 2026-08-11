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
    editSlot: null,
    setEditSlot: vi.fn(),
    setDisplacedItems: vi.fn(),
    recalcStats: vi.fn(),
    recalcFindings: vi.fn(),
    getSlot,
    setActivities: vi.fn(),
    slots: [],
    groups: [],
    activities: [],
    days: [],
    timeBlocks: [],
    ...rest,
  }
}

function setup(overrides = {}) {
  const props = makeProps(overrides)
  const hook = renderHook((p) => useSlotMutations(p), { initialProps: props })
  return { hook, props }
}

describe('useSlotMutations — editSlotSave', () => {
  const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'old', flags: { keep: true } }
  const editSlot = { groupId: 'g1', dayId: 'd1', blockId: 'b1' }

  it('writes activity_id + cleared flags, updates the route setter, closes the modal, and pushes an undo', async () => {
    const { hook, props } = setup({ slots: [slot], editSlot })
    await act(async () => { await hook.result.current.editSlotSave('new') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'new', flags: {} })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.setEditSlot).toHaveBeenCalledWith(null)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
    expect(props.pushUndo.mock.calls[0][0]).toMatchObject({
      undo: expect.any(Function),
      redo: expect.any(Function),
    })
  })
})

// The delicate part (T32): the undo closure must replay against the SAME
// route-pinned setter + repo + slot id the entry was made on — even after the
// director has switched routes — so an undo never writes the candidate on
// screen instead of the one it belongs to.
describe('useSlotMutations — route-pinned undo closure (the delicate part)', () => {
  const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'old', flags: { keep: true } }
  const editSlot = { groupId: 'g1', dayId: 'd1', blockId: 'b1' }

  it('editSlotSave undo writes the original activity/flags via the entry-route setter after a route switch', async () => {
    const originalSetSlots = vi.fn()
    const pushUndo = vi.fn()
    const repo = makeRepo()

    const props = makeProps({
      slots: [slot],
      editSlot,
      repo,
      pushUndo,
      routeState: { setSlots: originalSetSlots },
    })
    const hook = renderHook((p) => useSlotMutations(p), { initialProps: props })

    await act(async () => { await hook.result.current.editSlotSave('new') })
    const entry = pushUndo.mock.calls[0][0]

    // Director switches routes: the on-screen setter is now a DIFFERENT spy.
    const afterSwitchSetSlots = vi.fn()
    hook.rerender(makeProps({
      slots: [slot],
      editSlot,
      repo,
      pushUndo,
      routeState: { setSlots: afterSwitchSetSlots },
    }))

    repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })

    // Repo replays the ORIGINAL values against the ORIGINAL slot id.
    expect(repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'old', flags: { keep: true } })
    // And the setter it drives is the entry's route setter — NOT the one now on screen.
    expect(originalSetSlots).toHaveBeenCalled()
    expect(afterSwitchSetSlots).not.toHaveBeenCalled()
  })
})

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
  const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'old', flags: { keep: true } }
  const editSlot = { groupId: 'g1', dayId: 'd1', blockId: 'b1' }

  it('editSlotSave redo re-applies the new activity/cleared flags via the entry-route setter after a route switch', async () => {
    const originalSetSlots = vi.fn()
    const pushUndo = vi.fn()
    const repo = makeRepo()

    const props = makeProps({
      slots: [slot],
      editSlot,
      repo,
      pushUndo,
      routeState: { setSlots: originalSetSlots },
    })
    const hook = renderHook((p) => useSlotMutations(p), { initialProps: props })

    await act(async () => { await hook.result.current.editSlotSave('new') })
    const entry = pushUndo.mock.calls[0][0]

    // Director switches routes: the on-screen setter is now a DIFFERENT spy.
    const afterSwitchSetSlots = vi.fn()
    hook.rerender(makeProps({
      slots: [slot],
      editSlot,
      repo,
      pushUndo,
      routeState: { setSlots: afterSwitchSetSlots },
    }))

    repo.writeSlotFields.mockClear()
    originalSetSlots.mockClear()
    await act(async () => { await entry.redo() })

    // Repo replays the NEW value against the ORIGINAL slot id.
    expect(repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'new', flags: {} })
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

  it('merges the two cells (tail owned by head + span flag, head gets the expanded flag), updates state and the displaced tray', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities })
    await act(async () => { await expand(hook) })

    // Tail cell now belongs to the head activity and is a tail (is_span_head:false).
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false })
    // Head cell records the merge in its flags.
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: expandedFlags })
    // Optimistic setSlots + one displaced-tray add + one undo entry.
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.setDisplacedItems).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)

    // The displaced entry appended carries the ousted activity.
    const trayUpdater = props.setDisplacedItems.mock.calls[0][0]
    expect(trayUpdater([])).toEqual([
      { activityId: 'actTail', activityName: 'Archery', fromBlockName: 'Block 2', dayLabel: 'Mon' },
    ])
  })

  it('undo() reverses both writes and removes the displaced-tray entry', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities })
    await act(async () => { await expand(hook) })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    props.setDisplacedItems.mockClear()
    await act(async () => { await entry.undo() })

    // Tail restored to its own activity as a span head; head's flags restored.
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actTail', is_span_head: true })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: {} })
    // The tray entry added by expand is filtered back out.
    const trayUpdater = props.setDisplacedItems.mock.calls[0][0]
    expect(trayUpdater([{ activityId: 'actTail', fromBlockName: 'Block 2' }])).toEqual([])
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

  it('splits the merged span back into two (tail cleared to a fresh span head, head flags cleaned) and re-offers the displaced activity', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('h1', { flags: {} })
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.setDisplacedItems).toHaveBeenCalledTimes(1)
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
