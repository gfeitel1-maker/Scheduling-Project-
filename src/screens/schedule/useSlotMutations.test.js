// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlotMutations, collectSpanTails, spanStopsAt, repairOrphanSpanTails } from './useSlotMutations'
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
    // T105
    writeElectiveSetFields: vi.fn(async () => ({ status: 'applied' })),
    writeElectiveSetActivityFields: vi.fn(async () => ({ status: 'applied' })),
    readElectiveSetIsReusable: vi.fn(async () => 0),
    getElectiveSet: vi.fn(async () => ({ id: 'existing', is_reusable: 0 })),
    deleteElectiveSet: vi.fn(async () => ({ ok: true })),
    // T108
    writeDayOverrideFields: vi.fn(async () => ({ status: 'applied' })),
    ...overrides,
  }
}

// T108 Phase 2 review round 3 — a plain vi.fn() mock (makeRepo's default
// writeDayOverrideFields above) accepts ANY id unconditionally, so it could
// never have caught the real-schema bug (day_overrides has
// UNIQUE(schedule_week_id, day_id, group_id, time_block_id); the electron/ops
// projection does INSERT OR IGNORE keyed by id, then UPDATE WHERE id=?, so a
// FRESH id for an already-overridden coordinate silently persists nothing —
// see electron/ops/dayOverrides.projections.test.js for the real-SQLite
// proof). This fake reproduces that exact semantic in memory: a row keyed by
// id; writing a NEW id whose coordinate already belongs to a DIFFERENT id is
// a no-op (mirrors "INSERT OR IGNORE finds the UNIQUE collision, UPDATE
// WHERE id=<fresh id> matches nothing"); writing an id that already owns the
// row updates it in place. Used to prove the hook-level fix (id reuse) is
// what actually prevents data loss, not merely that a mock accepted the call.
function makeRealisticDayOverrideRepo() {
  const rowsById = new Map()
  const writeDayOverrideFields = vi.fn(async (id, fields) => {
    const coordKey = `${fields.schedule_week_id}|${fields.day_id}|${fields.group_id}|${fields.time_block_id}`
    const ownerOfCoord = [...rowsById.values()].find((r) => r.coordKey === coordKey && r.id !== id)
    if (ownerOfCoord) {
      // UNIQUE collision on the tuple: INSERT OR IGNORE inserts nothing, and
      // the follow-up UPDATE WHERE id=<this id> matches no row either — a
      // total no-op, exactly like the real projection.
      return { status: 'applied' }
    }
    const existing = rowsById.get(id) ?? {}
    rowsById.set(id, { ...existing, ...fields, id, coordKey })
    return { status: 'applied' }
  })
  return {
    ...makeRepo({ writeDayOverrideFields }),
    _rowsById: rowsById,
    _rowForCoord: (coordKey) => [...rowsById.values()].find((r) => r.coordKey === coordKey),
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

// T91: replacing a span head must free every covered tail (manual
// flags.expanded blob AND generated is_span_head chain — same unified walk),
// not just rewrite the target cell and orphan the tail(s).
describe('useSlotMutations — replaceSlot (T91: span-aware tail release)', () => {
  const timeBlocks = [
    { id: 'b1', name: 'Block 1', sort_order: 1 },
    { id: 'b2', name: 'Block 2', sort_order: 2 },
    { id: 'b3', name: 'Block 3', sort_order: 3 },
    { id: 'b4', name: 'Block 4', sort_order: 4 },
  ]

  it('manual 2-block blob: palette replace frees the tail and gives the head the new activity', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: { expanded: { displacedActivityId: 'act-old', displacedActivityName: 'Old', from_block: 'b2' } } },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-old', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-new', name: 'New' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-new', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
  })

  it('manual undo: head restored to its activity + flags.expanded; tail restored to owning the head activity', async () => {
    const expandedFlag = { expanded: { displacedActivityId: 'act-old', displacedActivityName: 'Old', from_block: 'b2' } }
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: expandedFlag },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-old', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-new', name: 'New' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = props.pushUndo.mock.calls[0][0]
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-old', flags: expandedFlag })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: 'act-old', is_span_head: false, flags: {} })
  })

  it('generated >=3-block is_span_head chain: replace frees EVERY tail', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: {} },
      { id: 'row-tail1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-old', is_span_head: false, flags: {} },
      { id: 'row-tail2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'act-old', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({
      slots,
      timeBlocks,
      activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-new', name: 'New' }],
      routeState: { route: 'generated', existingTemplates: { generated: true, manual: true }, templateId: 'tid-generated' },
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-new', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail2', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(3)
  })

  it('guard: an ordinary single cell whose following block is a DIFFERENT activity is not touched (only the target write)', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: {} },
      { id: 'row-neighbor', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-other', is_span_head: true, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-other', name: 'Other' }, { id: 'act-new', name: 'New' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-new', flags: {} })
  })

  it('undo -> redo -> undo round-trip stays coherent for a span-head replace', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: {} },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-old', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-new', name: 'New' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-old', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: 'act-old', is_span_head: false, flags: {} })

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.redo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-new', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: null, is_span_head: true, flags: {} })

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-old', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: 'act-old', is_span_head: false, flags: {} })
  })

  it('guard: a following block with the SAME activity_id but is_span_head:true (a coincidental adjacent single-block instance, not a real tail) is not collected', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', is_span_head: true, flags: {} },
      { id: 'row-neighbor', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-old', is_span_head: true, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-old', name: 'Old' }, { id: 'act-new', name: 'New' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-new' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: 'act-new', flags: {} })
  })
})

// T91 (owner-approved scope extension, "Both ends of a move"): a grid-to-grid
// drag whose SOURCE is a span head must free the source's covered tails too —
// same orphan mechanism, the other end of a move. The source cell's own
// activity_id:null write is unchanged; only its tails are newly freed.
describe('useSlotMutations — replaceSlot (T91: source-side span tail release)', () => {
  const timeBlocks = [
    { id: 'b1', name: 'Block 1', sort_order: 1 },
    { id: 'b2', name: 'Block 2', sort_order: 2 },
    { id: 'b3', name: 'Block 3', sort_order: 3 },
    { id: 'b4', name: 'Block 4', sort_order: 4 },
  ]

  it('grid-to-grid: source is a manual 2-block blob — source tail freed, target (plain empty cell) unaffected', async () => {
    const slots = [
      { id: 'row-source-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: { expanded: { displacedActivityId: 'act-1', displacedActivityName: 'Swim', from_block: 'b2' } } },
      { id: 'row-source-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b3' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-head', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-tail', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(3)
  })

  it('grid-to-grid: source is a generated 3-block is_span_head chain — every source tail freed', async () => {
    const slots = [
      { id: 'row-source-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: {} },
      { id: 'row-source-tail1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
      { id: 'row-source-tail2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'act-1', is_span_head: false, flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({
      slots,
      timeBlocks,
      activities: [{ id: 'act-1', name: 'Swim' }],
      routeState: { route: 'generated', existingTemplates: { generated: true, manual: true }, templateId: 'tid-generated' },
    })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b4' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-head', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-tail1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-tail2', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(4)
  })

  it('undo restores the source span: head gets its activity + flags.expanded back, tail restored to owning it', async () => {
    const expandedFlag = { expanded: { displacedActivityId: 'act-1', displacedActivityName: 'Swim', from_block: 'b2' } }
    const slots = [
      { id: 'row-source-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: expandedFlag },
      { id: 'row-source-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b3' }
      )
    })
    const entry = props.pushUndo.mock.calls[0][0]
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-head', { activity_id: 'act-1', flags: expandedFlag })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source-tail', { activity_id: 'act-1', is_span_head: false, flags: {} })
  })
})

// T91 delta-review fix: a cell that already gets an explicit target/source
// write must never ALSO be double-written as a "freed tail" — the regression
// Red Hat found when a merged HEAD is dragged onto its own tail (or vice
// versa), which ManualBuildView allows because tail cells are independently
// droppable there.
describe('useSlotMutations — replaceSlot (T91: no double-write when target/source IS its own span partner)', () => {
  const timeBlocks = [
    { id: 'b1', name: 'Block 1', sort_order: 1 },
    { id: 'b2', name: 'Block 2', sort_order: 2 },
    { id: 'b3', name: 'Block 3', sort_order: 3 },
  ]

  it('head dragged onto its own tail: the tail cell is written exactly once, as the target drop — not also as a null tail-free', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: { expanded: { displacedActivityId: 'act-1', displacedActivityName: 'Swim', from_block: 'b2' } } },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' }, // source: the head
        { groupId: 'g1', dayId: 'd1', blockId: 'b2' } // target: its own tail
      )
    })
    const tailCalls = props.repo.writeSlotFields.mock.calls.filter(([id]) => id === 'row-tail')
    expect(tailCalls).toHaveLength(1)
    expect(tailCalls[0][1]).toEqual({ activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-head', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
  })

  it('tail dragged onto its own head: the shared cell is written exactly once, as the source clear — no double-write', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: { expanded: { displacedActivityId: 'act-1', displacedActivityName: 'Swim', from_block: 'b2' } } },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b2', activityId: 'act-1' }, // source: the tail
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' } // target: its own head
      )
    })
    const headCalls = props.repo.writeSlotFields.mock.calls.filter(([id]) => id === 'row-head')
    expect(headCalls).toHaveLength(1)
    expect(headCalls[0][1]).toEqual({ activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
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

// ADR 2026-08-21: arbitrary-length spans — flags.expanded is retired as a
// structural pointer; the is_span_head chain is the sole representation,
// and a newly-covered tail carries flags.displaced (not the head).
const spanTimeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1 },
  { id: 'b2', name: 'Block 2', sort_order: 2 },
  { id: 'b3', name: 'Block 3', sort_order: 3 },
  { id: 'b4', name: 'Block 4', sort_order: 4 },
]

describe('useSlotMutations — expandSlot', () => {
  // b1 (head, "Swim") is stretched over b2 (tail, "Archery"); Archery is displaced.
  const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
  const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
  const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]

  function expand(hook) {
    return hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon')
  }

  it('merges the two cells (tail owned by head, carries its own displaced record) and updates state', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await expand(hook) })

    // Tail cell now belongs to the head activity, is a tail (is_span_head:
    // false), and carries what it displaced on its OWN flags — the head is
    // never written (flags.expanded is retired, ADR §1).
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', {
      activity_id: 'actHead', is_span_head: false,
      flags: { displaced: { displaced_activity_id: 'actTail', displaced_activity_name: 'Archery' } },
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('h1', expect.anything())
    // Optimistic setSlots + one undo entry (one newly-covered tail).
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('undo() releases the tail back to an empty span head', async () => {
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities, timeBlocks: spanTimeBlocks, routeState: { setSlots: setSlots.fn } })
    await act(async () => { await expand(hook) })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actTail', is_span_head: true, flags: {} })
  })

  it('extends N=2 to N=4 in one gesture: both new tails written under one claim, one undo frame per new tail', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, flags: {} },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, is_span_head: true, flags: {} },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: null, is_span_head: true, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b4') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t2', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t3', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t1', expect.anything()) // already a tail, no re-write
    expect(props.pushUndo).toHaveBeenCalledTimes(2) // one frame per newly-covered block
  })

  it('shrink-via-drag from N=4 to N=2: dropped tails are released to empty fresh heads', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, flags: {} },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'actHead', is_span_head: false, flags: {} },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: 'actHead', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t2', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t3', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t1', expect.anything()) // stays a tail, untouched
    expect(props.pushUndo).toHaveBeenCalledTimes(2) // one frame per released block
  })

  it('multi-cell atomicity: an extend superseded before dispatch writes to NEITHER new tail', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: {} },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, is_span_head: true, flags: {} },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: null, is_span_head: true, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    const p1 = hook.result.current.expandSlot('g1', 'd1', 'b1', 'b4', null, '', '', '', 'g1')
    const p2 = hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', null, '', '', '', 'g2')
    await act(async () => { await Promise.all([p1, p2]) })

    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t3', expect.anything())
    expect(props.pushUndo).toHaveBeenCalledTimes(1) // only g2's (1 new tail)
  })
})

describe('useSlotMutations — splitSlot', () => {
  // b1 is a merged head whose span covers b2; splitting frees b2 again.
  const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true, flags: {} }
  const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, flags: {} }
  const timeBlocks = spanTimeBlocks
  const days = [{ id: 'd1', label: 'Mon' }]

  it('splits the merged span back into two (tail cleared to a fresh span head)', async () => {
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('h1', expect.anything())
    expect(props.routeState.setSlots).toHaveBeenCalledTimes(1)
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('undo() restores the merged span (tail back to the head activity as a tail)', async () => {
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days, routeState: { setSlots: setSlots.fn } })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })
    const entry = props.pushUndo.mock.calls[0][0]

    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false, flags: {} })
  })

  it('splits at an interior block of N=4: blocks before the cut keep the chain, the cut block and after become independent empty heads', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, flags: {} },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'actHead', is_span_head: false, flags: {} },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: 'actHead', is_span_head: false, flags: {} },
    ]
    const { hook, props } = setup({ slots, timeBlocks, days })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1', undefined, 'b3') })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t2', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t3', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t1', expect.anything()) // before the cut: stays in the span
    expect(props.pushUndo).toHaveBeenCalledTimes(2) // one frame per released block
  })
})

// ADR 2026-08-21 test-first seam list items 1, 5, 7, 10, 13.
describe('useSlotMutations — collectSpanTails characterization (arbitrary N)', () => {
  it('walks a chain of N=3 tails', () => {
    const headRow = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true }
    const slots = [
      headRow,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'act-1', is_span_head: false },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: 'act-1', is_span_head: false },
    ]
    const tails = collectSpanTails(slots, spanTimeBlocks, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, headRow)
    expect(tails.map(t => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('walks a chain of N=4 tails (one more block than N=3)', () => {
    const fiveBlocks = [...spanTimeBlocks, { id: 'b5', name: 'Block 5', sort_order: 5 }]
    const headRow = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true }
    const slots = [
      headRow,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'act-1', is_span_head: false },
      { id: 't3', group_id: 'g1', day_id: 'd1', time_block_id: 'b4', activity_id: 'act-1', is_span_head: false },
      { id: 't4', group_id: 'g1', day_id: 'd1', time_block_id: 'b5', activity_id: 'act-1', is_span_head: false },
    ]
    const tails = collectSpanTails(slots, fiveBlocks, { groupId: 'g1', dayId: 'd1', blockId: 'b1' }, headRow)
    expect(tails.map(t => t.id)).toEqual(['t1', 't2', 't3', 't4'])
  })
})

describe('useSlotMutations — spanStopsAt (ADR §3 ordered stop conditions)', () => {
  const activities = [{ id: 'act-1', name: 'Swim' }, { id: 'act-locked', name: 'Locked', is_locked: true }]

  it('day end / deleted block: an undefined row stops', () => {
    expect(spanStopsAt(undefined, 'act-1', activities)).toBe(true)
  })
  it('an anchor stops', () => {
    expect(spanStopsAt({ is_anchor: true }, 'act-1', activities)).toBe(true)
  })
  it('a WEEK_CLOSED block stops', () => {
    expect(spanStopsAt({ flags: { WEEK_CLOSED: true } }, 'act-1', activities)).toBe(true)
  })
  it('an overridden cell stops', () => {
    expect(spanStopsAt({ is_overridden: true }, 'act-1', activities)).toBe(true)
  })
  it('a different LOCKED activity stops', () => {
    expect(spanStopsAt({ activity_id: 'act-locked' }, 'act-1', activities)).toBe(true)
  })
  it('an empty cell does not stop (absorbed)', () => {
    expect(spanStopsAt({ activity_id: null }, 'act-1', activities)).toBe(false)
  })
  it('a different UNLOCKED activity does not stop (absorbed, displacing it)', () => {
    expect(spanStopsAt({ activity_id: 'act-other' }, 'act-1', [{ id: 'act-other', name: 'Other' }])).toBe(false)
  })
})

describe('useSlotMutations — expandSlot boundary-crossing stop conditions (ADR §3)', () => {
  const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
  const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actLocked', name: 'Locked', is_locked: true }]

  it('caps a drag at the day\'s last block: toBlockId beyond the last block is invalid, no dispatch', async () => {
    const { hook, props } = setup({ slots: [headSlot], activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'no-such-block') })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })

  it('a path containing an anchor stops before it (R1: truncates, does not abort)', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: {} },
      { id: 'anchor1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', is_anchor: true },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b3') })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('anchor1', expect.anything())
  })

  it('a locked cell stops the extend before it (R1: truncates the valid prefix)', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: {} },
      { id: 'locked1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'actLocked', is_span_head: true, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b3') })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('locked1', expect.anything())
  })

  it('a WEEK_CLOSED block stops the extend before it', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: { WEEK_CLOSED: true } },
    ]
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2') })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })

  it('R4: a since-deleted targeted block is dropped gracefully, no write to a dead id', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: {} },
    ]
    // timeBlocks no longer contains b3/b4 (deleted mid-gesture) — the extend
    // still succeeds up to b2, the last surviving block in range.
    const shrunkBlocks = spanTimeBlocks.filter(b => b.id !== 'b3' && b.id !== 'b4')
    const { hook, props } = setup({ slots, activities, timeBlocks: shrunkBlocks })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2') })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: 'actHead', is_span_head: false, flags: {} })
  })

  it('an identical-range double-fired extend is idempotent: the second call is a no-op (no data loss, no re-write)', async () => {
    const slots = [
      headSlot,
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, is_span_head: true, flags: {} },
    ]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks, routeState: { setSlots: setSlots.fn } })
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2') })
    props.repo.writeSlotFields.mockClear()
    // Second identical-range call: t1 now reflects (via slotsRef, kept
    // current by the stateful setSlots above) the first call's result, so
    // this is a no-op — no second write, no second undo frame.
    await act(async () => { await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2') })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })
})

describe('useSlotMutations — repairOrphanSpanTails (ADR §4, pure function)', () => {
  it('flags a tail whose predecessor is not a valid head/prior-tail of the same activity', () => {
    const slots = [
      { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, is_span_head: true },
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false },
    ]
    const orphans = repairOrphanSpanTails(slots, spanTimeBlocks)
    expect(orphans.map(o => o.id)).toEqual(['t1'])
  })

  it('does not flag a valid chain', () => {
    const slots = [
      { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true },
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'act-1', is_span_head: false },
    ]
    expect(repairOrphanSpanTails(slots, spanTimeBlocks)).toEqual([])
  })

  it('does not flag a plain (non-span) slot', () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true },
    ]
    expect(repairOrphanSpanTails(slots, spanTimeBlocks)).toEqual([])
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

  // M3b re-key: locationFull is now keyed by location_id -> locations.capacity
  // (was activity_id -> max_groups_per_slot, place-blind). This closes the
  // M2-carried blind spot: dragging into an over-capacity PLACE on the
  // generated route now flags UNFILLABLE.
  describe('locationFull (M3b re-key: location_id -> locations.capacity)', () => {
    // g1 already occupies the Pool (capacity 1) via a DIFFERENT activity that
    // shares the same location_id — g2's target slot is empty.
    const occupied = { id: 's-g1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-other', flags: {} }
    const target = { id: 's-g2', group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const groups = [{ id: 'g1', tier_id: 't1' }, { id: 'g2', tier_id: 't1' }]
    const activities = [
      { id: 'act-other', name: 'Swim A', location_id: 'loc-pool', eligible_tier_ids: [], eligible_group_ids: [] },
      { id: 'act-target', name: 'Swim B', location_id: 'loc-pool', eligible_tier_ids: [], eligible_group_ids: [] },
    ]

    it('flags UNFILLABLE on the generated route when placing would push the shared PLACE over locations.capacity', async () => {
      const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
      const { hook, props } = setup({
        slots: [occupied, target], groups, activities, locations,
        routeState: { route: 'generated', templateId: 'tid-generated' },
      })
      await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g2', 'd1', 'b1') })

      expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-target', flags: { UNFILLABLE: true } })
    })

    it('capacity 0 sentinel: does not spuriously flag UNFILLABLE (the `> 0` fix, was `!= null`)', async () => {
      const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 0 }]
      const { hook, props } = setup({
        slots: [occupied, target], groups, activities, locations,
        routeState: { route: 'generated', templateId: 'tid-generated' },
      })
      await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g2', 'd1', 'b1') })

      expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-target', flags: {} })
    })

    it('an activity with no location_id is never place-full (no place to be full at)', async () => {
      const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
      const noLocationActivities = [
        { id: 'act-other', name: 'Swim A', location_id: 'loc-pool', eligible_tier_ids: [], eligible_group_ids: [] },
        { id: 'act-target', name: 'Swim B', location_id: null, eligible_tier_ids: [], eligible_group_ids: [] },
      ]
      const { hook, props } = setup({
        slots: [occupied, target], groups, activities: noLocationActivities, locations,
        routeState: { route: 'generated', templateId: 'tid-generated' },
      })
      await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g2', 'd1', 'b1') })

      expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-target', flags: {} })
    })

    it('the manual route never flags UNFILLABLE even when the shared place is over capacity', async () => {
      const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
      const { hook, props } = setup({ slots: [occupied, target], groups, activities, locations })
      await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g2', 'd1', 'b1') })

      expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-target', flags: {} })
    })
  })

  // Round-2 fix pass (Code Reviewer MEDIUM x2): the self-count false positive
  // (A2) and the lost per-activity over-book warning (A3).
  describe('locationFull round-2: self-count exclusion + activity-cap arm restored (A2/A3)', () => {
    it('A2: excludes the target group\'s OWN existing slot at this (day,block) — dragging a same-place activity onto a cell the group already occupies there is not spuriously flagged', async () => {
      const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
      // g1's own slot here is already bound to the same place via a DIFFERENT
      // activity; dragging another loc-pool activity onto THIS SAME cell must
      // not count g1's own outgoing slot against the capacity it's vacating.
      const occupied = { id: 's-g1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-other', flags: {} }
      const groups = [{ id: 'g1', tier_id: 't1' }]
      const activities = [
        { id: 'act-other', name: 'Swim A', location_id: 'loc-pool', eligible_tier_ids: [], eligible_group_ids: [] },
        { id: 'act-target', name: 'Swim B', location_id: 'loc-pool', eligible_tier_ids: [], eligible_group_ids: [] },
      ]
      const { hook, props } = setup({
        slots: [occupied], groups, activities, locations,
        routeState: { route: 'generated', templateId: 'tid-generated' },
      })
      await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g1', 'd1', 'b1') })

      expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g1', { activity_id: 'act-target', flags: {} })
    })

    describe('A3: activity-cap arm (max_groups_per_slot) restored ALONGSIDE the place-cap arm — either alone trips UNFILLABLE, no min()', () => {
      const groups = [{ id: 'g1', tier_id: 't1' }, { id: 'g2', tier_id: 't1' }]
      const occupiedWith = (activityId) => ({ id: 's-g1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: activityId, flags: {} })
      const target = { id: 's-g2', group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }

      it('over-activity-cap, no location_id at all (place-blind case ADR D2 keeps a warning for)', async () => {
        const activities = [{ id: 'act-cap', name: 'Archery', location_id: null, max_groups_per_slot: 1, eligible_tier_ids: [], eligible_group_ids: [] }]
        const { hook, props } = setup({
          slots: [occupiedWith('act-cap'), target], groups, activities,
          routeState: { route: 'generated', templateId: 'tid-generated' },
        })
        await act(async () => { await hook.result.current.placeActivityManual('act-cap', 'g2', 'd1', 'b1') })
        expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-cap', flags: { UNFILLABLE: true } })
      })

      it('over-activity-cap even though the bound PLACE itself has room (independent arms, not min())', async () => {
        const locations = [{ id: 'loc-big', name: 'Big Field', capacity: 10 }]
        const activities = [{ id: 'act-cap', name: 'Archery', location_id: 'loc-big', max_groups_per_slot: 1, eligible_tier_ids: [], eligible_group_ids: [] }]
        const { hook, props } = setup({
          slots: [occupiedWith('act-cap'), target], groups, activities, locations,
          routeState: { route: 'generated', templateId: 'tid-generated' },
        })
        await act(async () => { await hook.result.current.placeActivityManual('act-cap', 'g2', 'd1', 'b1') })
        expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-cap', flags: { UNFILLABLE: true } })
      })

      it('over-place-cap even though the activity cap itself has room', async () => {
        const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
        const activities = [
          { id: 'act-other', name: 'Swim A', location_id: 'loc-pool', max_groups_per_slot: 5, eligible_tier_ids: [], eligible_group_ids: [] },
          { id: 'act-target', name: 'Swim B', location_id: 'loc-pool', max_groups_per_slot: 5, eligible_tier_ids: [], eligible_group_ids: [] },
        ]
        const { hook, props } = setup({
          slots: [occupiedWith('act-other'), target], groups, activities, locations,
          routeState: { route: 'generated', templateId: 'tid-generated' },
        })
        await act(async () => { await hook.result.current.placeActivityManual('act-target', 'g2', 'd1', 'b1') })
        expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-target', flags: { UNFILLABLE: true } })
      })

      it('both caps exceeded at once — still just one UNFILLABLE flag', async () => {
        const locations = [{ id: 'loc-pool', name: 'Pool', capacity: 1 }]
        const activities = [{ id: 'act-cap', name: 'Swim', location_id: 'loc-pool', max_groups_per_slot: 1, eligible_tier_ids: [], eligible_group_ids: [] }]
        const { hook, props } = setup({
          slots: [occupiedWith('act-cap'), target], groups, activities, locations,
          routeState: { route: 'generated', templateId: 'tid-generated' },
        })
        await act(async () => { await hook.result.current.placeActivityManual('act-cap', 'g2', 'd1', 'b1') })
        expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-cap', flags: { UNFILLABLE: true } })
      })

      it('neither cap exceeded — not flagged', async () => {
        const locations = [{ id: 'loc-big', name: 'Big Field', capacity: 10 }]
        const activities = [{ id: 'act-cap', name: 'Archery', location_id: 'loc-big', max_groups_per_slot: 5, eligible_tier_ids: [], eligible_group_ids: [] }]
        const { hook, props } = setup({
          slots: [occupiedWith('act-cap'), target], groups, activities, locations,
          routeState: { route: 'generated', templateId: 'tid-generated' },
        })
        await act(async () => { await hook.result.current.placeActivityManual('act-cap', 'g2', 'd1', 'b1') })
        expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s-g2', { activity_id: 'act-cap', flags: {} })
      })
    })
  })
})

describe('useSlotMutations — placeActivityManual same-cell race (2026-08-12 ADR, FIX 1)', () => {
  it('two empty-cell writers racing the same cell: the superseded claim\'s write is NEVER dispatched to repo.writeSlotFields', async () => {
    const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const activities = [{ id: 'a1', name: 'Swim' }, { id: 'a2', name: 'Archery' }]
    const d1 = deferred()
    const writeSlotFields = vi.fn(() => d1.promise)
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots([slot])
    const { hook, props } = setup({
      slots: [slot],
      groups: [{ id: 'g1', tier_id: 't1' }],
      activities,
      repo,
      routeState: { setSlots: setSlots.fn },
    })

    // g1 claims first, but no microtask flush happens before g2 claims — g2's
    // synchronous claim overwrite lands before g1's own async continuation
    // ever reaches its currency check, so g1 is superseded BEFORE it ever
    // calls repo.writeSlotFields (mirrors the replaceSlot atomicity tests'
    // no-flush pattern above, not the "genuinely in-flight" pattern — the
    // point here is the never-dispatched case, not the already-dispatched one).
    const p1 = hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1', undefined, 'g1')
    const p2 = hook.result.current.placeActivityManual('a2', 'g1', 'd1', 'b1', undefined, 'g2')

    d1.resolve({ status: 'applied' })
    await act(async () => { await Promise.all([p1, p2]) })

    // Only g2's write ever reaches the repo — g1's is dropped before dispatch,
    // not merely overwritten in setSlots (this is the direct fix for the same
    // silent DB-divergence class finding 1 closed for replaceSlot/expandSlot/
    // splitSlot: repo.writeSlotFields must never fire for a superseded claim).
    expect(writeSlotFields).toHaveBeenCalledTimes(1)
    expect(writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'a2', flags: {} })
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe('a2')
    expect(props.pushUndo).toHaveBeenCalledTimes(1) // only g2's — g1 pushes nothing
  })

  it('route dimension: identical (groupId, dayId, blockId) on different (route, templateId) do not collide — both dispatch independently', async () => {
    const rowManual = { id: 'row-manual', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const rowGenerated = { id: 'row-generated', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const activities = [{ id: 'a1', name: 'Swim' }]
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
      slots: [rowManual], groups: [{ id: 'g1', tier_id: 't1' }], activities, repo,
      routeState: makeRouteState({ route: 'manual', templateId: 'tid-manual', setSlots: setSlotsManual.fn }),
    })
    const { result, rerender } = renderHook((p) => useSlotMutations(p), { initialProps: manualProps })

    const pManual = result.current.placeActivityManual('a1', 'g1', 'd1', 'b1', undefined, 'g1')

    rerender({
      ...manualProps,
      slots: [rowGenerated],
      routeState: makeRouteState({ route: 'generated', templateId: 'tid-generated', setSlots: setSlotsGenerated.fn }),
    })
    const pGenerated = result.current.placeActivityManual('a1', 'g1', 'd1', 'b1', undefined, 'g2')

    await act(async () => { dManual.resolve({ status: 'applied' }); await pManual })
    await act(async () => { dGenerated.resolve({ status: 'applied' }); await pGenerated })

    expect(writeSlotFields).toHaveBeenCalledTimes(2)
    expect(setSlotsManual.get().find(s => s.id === 'row-manual').activity_id).toBe('a1')
    expect(setSlotsGenerated.get().find(s => s.id === 'row-generated').activity_id).toBe('a1')
  })

  it('a call with no gestureId (synthesized claim id, matching the paste/click call sites) still participates in the ordering and can be superseded', async () => {
    const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const activities = [{ id: 'a1', name: 'Swim' }, { id: 'a2', name: 'Archery' }]
    const d1 = deferred()
    const writeSlotFields = vi.fn(() => d1.promise)
    const repo = makeRepo({ writeSlotFields })
    const setSlots = statefulSetSlots([slot])
    const { hook } = setup({
      slots: [slot],
      groups: [{ id: 'g1', tier_id: 't1' }],
      activities,
      repo,
      routeState: { setSlots: setSlots.fn },
    })

    // No gestureId argument at all (the 6th param is omitted) — this must not
    // bypass the queue; a paste/click call site relies on the hook's own
    // internal `gestureId ?? crypto.randomUUID()` fallback for this exact shape.
    const pNoGesture = hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1')
    const pDrag = hook.result.current.placeActivityManual('a2', 'g1', 'd1', 'b1', undefined, 'g2')

    d1.resolve({ status: 'applied' })
    await act(async () => { await Promise.all([pNoGesture, pDrag]) })

    // The later claim (g2, the drag) wins; the earlier no-gestureId call is
    // superseded — proving no gestureId-undefined exemption exists here either.
    expect(writeSlotFields).toHaveBeenCalledTimes(1)
    expect(writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'a2', flags: {} })
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe('a2')
  })
})

// T82 characterization (written BEFORE the runMutation envelope extraction):
// pins the write-error short-circuit (setActionError called, no setSlots, no
// pushUndo) for all four mutations that will be routed through the envelope,
// and pins a full undo->redo->undo round trip for the three mutations that
// previously only had an undo-only or redo-only test (replaceSlot already has
// separate undo and redo coverage above, folded into one round trip here too
// so all four mutations get the identical shape of regression net).
describe('useSlotMutations — T82 characterization: write-error short-circuits', () => {
  it('replaceSlot: a failed write sets the action error and pushes no undo, no setSlots call', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const repo = makeRepo({ writeSlotFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }], repo })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.routeState.setSlots).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })

  it('placeActivityManual: a failed write sets the action error and pushes no undo, no setSlots call', async () => {
    const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const repo = makeRepo({ writeSlotFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({
      slots: [slot], groups: [{ id: 'g1', tier_id: 't1' }], activities: [{ id: 'a1', name: 'Swim' }], repo,
    })
    await act(async () => { await hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1') })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.routeState.setSlots).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })

  it('expandSlot: a failed write sets the action error and pushes no undo, no setSlots call', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]
    const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
    const repo = makeRepo({ writeSlotFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities, timeBlocks, repo })
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon')
    })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.routeState.setSlots).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })

  it('splitSlot: a failed write sets the action error and pushes no undo, no setSlots call', async () => {
    const headSlot = {
      id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true,
      flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
    }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false }
    const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
    const days = [{ id: 'd1', label: 'Mon' }]
    const repo = makeRepo({ writeSlotFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days, repo })
    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.routeState.setSlots).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })
})

describe('useSlotMutations — T82 characterization: undo -> redo -> undo round trips', () => {
  it('replaceSlot: undo -> redo -> undo cycles cleanly through the repo and state', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-occupant', flags: { someFlag: true } },
    ]
    const activities = [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }]
    const setSlots = statefulSetSlots(slots)
    const { hook, props } = setup({ slots, activities, routeState: { setSlots: setSlots.fn } })

    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = props.pushUndo.mock.calls[0][0]
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-1')

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-occupant')

    await act(async () => { await entry.redo() })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-1')

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 'row-target').activity_id).toBe('act-occupant')
  })

  it('placeActivityManual: undo -> redo -> undo cycles cleanly through the repo and state', async () => {
    const slot = { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} }
    const setSlots = statefulSetSlots([slot])
    const { hook, props } = setup({
      slots: [slot], groups: [{ id: 'g1', tier_id: 't1' }], activities: [{ id: 'a1', name: 'Swim' }],
      routeState: { setSlots: setSlots.fn },
    })

    await act(async () => { await hook.result.current.placeActivityManual('a1', 'g1', 'd1', 'b1') })
    const entry = props.pushUndo.mock.calls[0][0]
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe('a1')

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe(null)

    await act(async () => { await entry.redo() })
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe('a1')

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 's1').activity_id).toBe(null)
  })

  it('expandSlot: undo -> redo -> undo cycles cleanly through the repo and state', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]
    const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities, timeBlocks, routeState: { setSlots: setSlots.fn } })

    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon')
    })
    const entry = props.pushUndo.mock.calls[0][0]
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(false)

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(true)
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe('actTail')

    await act(async () => { await entry.redo() })
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(false)
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe('actHead')

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(true)
  })

  it('splitSlot: undo -> redo -> undo cycles cleanly through the repo and state', async () => {
    const headSlot = {
      id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true,
      flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
    }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false }
    const timeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]
    const days = [{ id: 'd1', label: 'Mon' }]
    const setSlots = statefulSetSlots([headSlot, tailSlot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks, days, routeState: { setSlots: setSlots.fn } })

    await act(async () => { await hook.result.current.splitSlot('g1', 'd1', 'b1') })
    const entry = props.pushUndo.mock.calls[0][0]
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe(null)

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe('actHead')
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(false)

    await act(async () => { await entry.redo() })
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe(null)
    expect(setSlots.get().find(s => s.id === 't1').is_span_head).toBe(true)

    await act(async () => { await entry.undo() })
    expect(setSlots.get().find(s => s.id === 't1').activity_id).toBe('actHead')
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

// T106 Governor addendum (Red Hat round 2): MANDATORY characterization tests
// pinning createActivityFromCell/createElectiveFromCell's weekly-path behavior
// unchanged across the createActivityHelper extraction.
describe('useSlotMutations — createActivityFromCell characterization (T106 extraction)', () => {
  it('(a) dupe-path call-counts: NO writeActivityFields, NO setActivities append', async () => {
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
    expect(props.setActivities).not.toHaveBeenCalled()
  })

  it('(b) new-path ordering: setActivities optimistic append happens before the placement write reaches repo.writeSlotFields', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const order = []
    const setActivities = vi.fn(() => { order.push('setActivities') })
    const writeSlotFields = vi.fn(async () => { order.push('writeSlotFields'); return { status: 'applied' } })
    const repo = makeRepo({ writeSlotFields })
    const { hook } = setup({ slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }], activities: [], repo, setActivities })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(order).toEqual(['setActivities', 'writeSlotFields'])
  })

  it('(c) placeActivityManual\'s 5th arg (activityOverride) is the full minted row, not just the id', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    // location_id/max_groups_per_slot on the override are read by placeActivityManual's
    // capacity checks before the activity is in the `activities` prop array at all —
    // if only the id were passed, activity lookup would fail (`activities.find` sees
    // nothing yet) and the placement write would never fire, so a successful
    // writeSlotFields call itself proves the full row reached placeActivityManual.
    const { hook, props } = setup({ slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }], activities: [] })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const [mintedId] = props.repo.writeActivityFields.mock.calls[0]
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', expect.objectContaining({ activity_id: mintedId }))
  })

  it('(d) field-default snapshot parity: min_per_week:1, max_per_week:null, same_tier_only:false, eligible_group_ids:[]', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const { hook, props } = setup({ slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }], activities: [] })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const [, fields] = props.repo.writeActivityFields.mock.calls[0]
    expect(fields).toEqual({
      name: 'Kayaking', camp_id: 'camp-1', priority: null, is_locked: false, span_blocks: 1,
      location_id: null, is_outdoor: false, max_groups_per_slot: 1, min_per_week: 1, max_per_week: null,
      same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null,
      prefer_before_day_min: null, weather_alternative_id: null, notes: null,
    })
  })

  it('(e) createElectiveFromCell member-creation loop still gets identical defaults post-extraction', async () => {
    const targetRow = { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false }
    const { hook, props } = setup({ slots: [targetRow], campId: 'camp-1', activities: [] })
    await act(async () => {
      await hook.result.current.createElectiveFromCell('Afternoon Chugim', ['Kayaking'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeActivityFields).toHaveBeenCalledTimes(1)
    const [, fields] = props.repo.writeActivityFields.mock.calls[0]
    expect(fields).toMatchObject({
      name: 'Kayaking', camp_id: 'camp-1', min_per_week: 1, max_per_week: null,
      same_tier_only: false, eligible_group_ids: [],
    })
  })
})

// 2026-07/2026-08 gesture-correlation ADR: fresh-read undo snapshots for
// expandSlot/splitSlot. Unrelated to the write-serialization queue below
// (that mechanism decides WHEN a write is sent; this one decides WHAT
// "previous" value an undo entry captures) — kept as its own describe block
// so it stays independent of whichever write-ordering mechanism is current.
describe('useSlotMutations — fresh-read undo snapshot (gesture-correlation ADR)', () => {
  it('facet 2 fixed for expandSlot: a second racing extend on the same head reads g1\'s ACTUAL result, not the stale closed-over slots prop', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const tail2Slot = { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, flags: {}, is_span_head: true }
    const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }]
    const setSlots = statefulSetSlots([headSlot, tailSlot, tail2Slot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot, tail2Slot], activities, timeBlocks: spanTimeBlocks, routeState: { setSlots: setSlots.fn } })

    // Gesture g1 expands b1 over b2 first.
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon', 'g1')
    })
    // Gesture g2, still closed over the same stale `slots` prop (no
    // re-render happened), now extends FURTHER to b3 — its diff must be
    // computed against what g1 ACTUALLY left (b2 already a tail), so it
    // writes ONLY b3, never re-writing b2.
    props.repo.writeSlotFields.mockClear()
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b3', null, '', '', '', 'g2')
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t2', { activity_id: 'actHead', is_span_head: false, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t1', expect.anything())
  })

  it('facet 2 fixed for splitSlot: a second racing split on the same head reads g1\'s ACTUAL remaining tail chain, not the stale closed-over slots prop', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true, flags: {} }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, flags: {} }
    const tail2Slot = { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'actHead', is_span_head: false, flags: {} }
    const timeBlocks = spanTimeBlocks
    const days = [{ id: 'd1', label: 'Mon' }]
    const setSlots = statefulSetSlots([headSlot, tailSlot, tail2Slot])
    const { hook, props } = setup({ slots: [headSlot, tailSlot, tail2Slot], timeBlocks, days, routeState: { setSlots: setSlots.fn } })

    // g1 cuts at b3 first — only b3 is released, b2 stays a tail.
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1', 'g1', 'b3')
    })
    // g2, still closed over the original (un-split) `slots` prop, splits
    // "everything" (no cutBlockId) — its collectSpanTails walk must read
    // g1's ACTUAL remaining chain (just b2), never re-releasing b3.
    props.repo.writeSlotFields.mockClear()
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1', 'g2')
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('t1', { activity_id: null, is_span_head: true, flags: {} })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalledWith('t2', expect.anything())
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
    const { hook, props } = setup({ slots, activities, timeBlocks: spanTimeBlocks, routeState: { setSlots: setSlots.fn } })

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

// T105 — createElectiveFromCell (docs/work/specs/2026-08-20-elective-authoring-render-design.md)
describe('useSlotMutations — createElectiveFromCell', () => {
  it('mints an elective_sets row + one elective_set_activities row per member + writes the cell atomically, one-off by default', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, elective_set_id: null, flags: {} },
    ]
    const activities = [{ id: 'act-swim', name: 'Swimming' }]
    const { hook, props } = setup({ slots, activities })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('Afternoon Chugim', ['Swimming', 'Kayaking'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })

    // One existing activity reused (Swimming), one new activity minted (Kayaking).
    expect(props.repo.writeActivityFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeActivityFields.mock.calls[0][1].name).toBe('Kayaking')

    expect(props.repo.writeElectiveSetFields).toHaveBeenCalledTimes(1)
    const [setId, setFields] = props.repo.writeElectiveSetFields.mock.calls[0]
    expect(setFields).toEqual({ name: 'Afternoon Chugim', camp_id: 'camp-1', is_reusable: 0 })

    expect(props.repo.writeElectiveSetActivityFields).toHaveBeenCalledTimes(2)
    const memberActivityIds = props.repo.writeElectiveSetActivityFields.mock.calls.map(c => c[1].activity_id)
    expect(memberActivityIds).toContain('act-swim')

    // The cell write: elective_set_id set, activity_id cleared, same
    // claim/chain/dispatch primitive as every other mutation.
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { elective_set_id: setId, activity_id: null, flags: {} })
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  // T108 Phase 2 review round 2 (HIGH #2) — day_overrides has no
  // elective_set_id column in v1, so an override can never point at an
  // elective. This must be a clear BLOCK, not a silent template_slots write
  // (which applyDayOverrides would then never see) or an orphaned elective
  // set with nothing placing it.
  it('blocks elective placement in override mode — no writes at all, clear message', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, elective_set_id: null, flags: {} },
    ]
    const activities = [{ id: 'act-swim', name: 'Swimming' }]
    const { hook, props } = setup({ slots, activities, overrideModeDayId: 'd1', weekId: 'week-1' })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('Afternoon Chugim', ['Swimming'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })

    expect(props.repo.writeElectiveSetFields).not.toHaveBeenCalled()
    expect(props.repo.writeElectiveSetActivityFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.repo.writeDayOverrideFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(
      "Electives can't be overridden for a single day yet — exit Override mode to place an elective."
    )
  })

  it('does not write an empty elective when every typed member name is blank', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots })
    await act(async () => {
      await hook.result.current.createElectiveFromCell('Empty Set', ['', '   '], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeElectiveSetFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })

  it('an exact name match against a DURABLE (reusable) set places that set directly, never minting a duplicate', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const durableElectiveSets = [{ id: 'set-durable', name: 'Water Sports', is_reusable: 1 }]
    const { hook, props } = setup({ slots, durableElectiveSets })
    await act(async () => {
      await hook.result.current.createElectiveFromCell('Water Sports', ['whatever'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeElectiveSetFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { elective_set_id: 'set-durable', activity_id: null, flags: {} })
  })

  it('converting a span HEAD to an elective releases its tail(s) atomically in the same gesture (T91/T105 §3)', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-swim', is_span_head: true, flags: {} },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-swim', is_span_head: false, flags: {} },
    ]
    const timeBlocks = [{ id: 'b1', sort_order: 1 }, { id: 'b2', sort_order: 2 }]
    const activities = [{ id: 'act-swim', name: 'Swimming' }]
    const { hook, props } = setup({ slots, timeBlocks, activities })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('Chugim', ['Kayaking'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })

    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-tail', { activity_id: null, is_span_head: true, flags: {} })
    const headCall = props.repo.writeSlotFields.mock.calls.find(c => c[0] === 'row-head')
    expect(headCall[1].activity_id).toBeNull()
    expect(headCall[1]).toHaveProperty('elective_set_id')
  })

  it('undo cleans up a one-off elective set via a FRESH is_reusable read, not a value captured at forward-write time (Red Hat fold-in B)', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const setSlots = statefulSetSlots(slots)
    const readElectiveSetIsReusable = vi.fn(async () => 0) // still one-off at undo time
    const repo = makeRepo({ readElectiveSetIsReusable })
    const { hook, props } = setup({ slots, repo, routeState: { setSlots: setSlots.fn } })

    let undoFn
    props.pushUndo.mockImplementation(({ undo }) => { undoFn = undo })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('One-Off Set', ['New Activity'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    await act(async () => { await undoFn() })

    expect(readElectiveSetIsReusable).toHaveBeenCalledTimes(1)
    expect(repo.deleteElectiveSet).toHaveBeenCalledTimes(1)
  })

  it('undo does NOT delete a set that was promoted to reusable between the forward write and the undo (fresh read wins over the closure value)', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const setSlots = statefulSetSlots(slots)
    // Forward write happened while one-off; by the time undo runs, a fresh
    // read reports it has since been promoted (synced from another device,
    // or promoted locally) — undo must NOT delete it.
    const readElectiveSetIsReusable = vi.fn(async () => 1)
    const repo = makeRepo({ readElectiveSetIsReusable })
    const { hook, props } = setup({ slots, repo, routeState: { setSlots: setSlots.fn } })

    let undoFn
    props.pushUndo.mockImplementation(({ undo }) => { undoFn = undo })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('Promoted Set', ['New Activity'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    await act(async () => { await undoFn() })

    expect(readElectiveSetIsReusable).toHaveBeenCalledTimes(1)
    expect(repo.deleteElectiveSet).not.toHaveBeenCalled()
  })
})

// T105 §5 fold-in A — every runMutation call site that writes activity_id/
// elective_set_id records into ownWriteRef, INCLUDING expandSlot and splitSlot
// (the Red Hat round-2 fold-in — omitting them causes a false-negative when a
// span merge/split races an elective conversion).
describe('useSlotMutations — ownWriteRef coverage (Red Hat fold-in A)', () => {
  it('createElectiveFromCell records an elective: kind into ownWriteRef', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook } = setup({ slots })
    await act(async () => {
      await hook.result.current.createElectiveFromCell('Chugim', ['Kayaking'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const entry = hook.result.current.ownWriteRef.current.get('manual|tid-manual|g1|d1|b1')
    expect(entry).toBeTruthy()
    expect(entry.kind).toMatch(/^elective:/)
  })

  const spanTimeBlocks = [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }]

  it('expandSlot records the tail cell\'s new own-write kind', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {}, is_span_head: true },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, flags: {}, is_span_head: true },
    ]
    const activities = [{ id: 'act-1', name: 'Swim' }]
    const { hook } = setup({ slots, activities, timeBlocks: spanTimeBlocks })
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', null, '', 'Block 2', 'Mon')
    })
    const entry = hook.result.current.ownWriteRef.current.get('manual|tid-manual|g1|d1|b2')
    expect(entry).toBeTruthy()
    expect(entry.kind).toBe('activity:act-1')
  })

  it('splitSlot records the released tail cell as empty', async () => {
    const slots = [
      { id: 'row-head', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', is_span_head: true, flags: {} },
      { id: 'row-tail', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', is_span_head: false, flags: {} },
    ]
    const { hook } = setup({ slots, timeBlocks: spanTimeBlocks, days: [{ id: 'd1', label: 'Mon' }] })
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1')
    })
    const entry = hook.result.current.ownWriteRef.current.get('manual|tid-manual|g1|d1|b2')
    expect(entry).toEqual(expect.objectContaining({ kind: 'empty' }))
  })
})

// T105 review fix (Code Reviewer HIGH) — redo must RE-CREATE a one-off
// elective set that an intervening undo deleted, with FRESH ids, rather than
// replaying a write against the now-dangling original id (which would
// silently lose the director's elective).
describe('useSlotMutations — createElectiveFromCell undo-then-redo re-create (Code Reviewer HIGH fix)', () => {
  it('undo deletes the one-off set; redo re-creates a NEW set + members and writes the cell to the NEW id', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, elective_set_id: null, flags: {} },
    ]
    const setSlots = statefulSetSlots(slots)
    // Sequence of ids: first createElectiveFromCell mints one for the member
    // activity + one for the elective set; redo's re-create mints two more
    // (member's writeElectiveSetActivityFields row id, elective set id).
    let uuidCount = 0
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCount}` })

    // getElectiveSet: "existing" until undo deletes it, then null (fresh
    // read), simulated via a mutable flag flipped by deleteElectiveSet.
    let deleted = false
    const getElectiveSet = vi.fn(async (id) => (deleted ? null : { id, is_reusable: 0 }))
    const deleteElectiveSet = vi.fn(async () => { deleted = true; return { ok: true } })
    const readElectiveSetIsReusable = vi.fn(async () => 0)
    const repo = makeRepo({ getElectiveSet, deleteElectiveSet, readElectiveSetIsReusable })

    const { hook, props } = setup({ slots, repo, routeState: { setSlots: setSlots.fn } })

    let undoFn, redoFn
    props.pushUndo.mockImplementation(({ undo, redo }) => { undoFn = undo; redoFn = redo })

    await act(async () => {
      await hook.result.current.createElectiveFromCell('One-Off Set', ['New Activity'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const originalSetId = setSlots.get().find(s => s.id === 'row-target').elective_set_id
    expect(originalSetId).toBeTruthy()

    await act(async () => { await undoFn() })
    expect(deleteElectiveSet).toHaveBeenCalledWith(originalSetId)
    expect(setSlots.get().find(s => s.id === 'row-target').elective_set_id).toBeNull()

    const writeElectiveSetFieldsCallsBefore = repo.writeElectiveSetFields.mock.calls.length
    await act(async () => { await redoFn() })

    // A NEW set was minted (writeElectiveSetFields called again).
    expect(repo.writeElectiveSetFields.mock.calls.length).toBe(writeElectiveSetFieldsCallsBefore + 1)
    const newSetCall = repo.writeElectiveSetFields.mock.calls[writeElectiveSetFieldsCallsBefore]
    const newSetId = newSetCall[0]
    expect(newSetId).not.toBe(originalSetId)
    expect(newSetCall[1]).toEqual({ name: 'One-Off Set', camp_id: 'camp-1', is_reusable: 0 })

    // The member row was re-created against the NEW set id.
    const memberCallsForNewSet = repo.writeElectiveSetActivityFields.mock.calls.filter(c => c[1].elective_set_id === newSetId)
    expect(memberCallsForNewSet.length).toBe(1)

    // The cell now points at the NEW id, not the dangling original.
    const finalSlot = setSlots.get().find(s => s.id === 'row-target')
    expect(finalSlot.elective_set_id).toBe(newSetId)
    expect(finalSlot.elective_set_id).not.toBe(originalSetId)
  })
})

// T108 (day-overrides re-point, design §6.1 — RED HAT FINDING #5 fix): a
// non-override-mode edit onto a cell with an ACTIVE override is BLOCKED, not
// silently reverted on next render. Every write path that targets an
// existing cell must check `is_overridden` before dispatching its write.
describe('useSlotMutations — override edit-block guard (is_overridden, not in override mode)', () => {
  const OVERRIDE_MESSAGE = 'This day has an override on this cell — switch to Override mode to change it.'

  it('replaceSlot: blocks a write onto an overridden target, surfaces the error, no write, no undo', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', flags: {}, is_overridden: true },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('placeActivityManual: blocks a write onto an overridden cell', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', flags: {}, is_overridden: true },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }], groups: [{ id: 'g1', tier_id: 't1' }] })
    await act(async () => {
      await hook.result.current.placeActivityManual('act-1', 'g1', 'd1', 'b1')
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('expandSlot: blocks when the head cell is overridden', async () => {
    const headSlot = { id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', flags: {}, is_span_head: true, is_overridden: true }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actTail', flags: {}, is_span_head: true }
    const { hook, props } = setup({ slots: [headSlot, tailSlot], activities: [{ id: 'actHead', name: 'Swim' }, { id: 'actTail', name: 'Archery' }] })
    await act(async () => {
      await hook.result.current.expandSlot('g1', 'd1', 'b1', 'b2', 'actTail', 'Archery', 'Block 2', 'Mon')
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('splitSlot: blocks when the tail cell is overridden', async () => {
    const headSlot = {
      id: 'h1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'actHead', is_span_head: true,
      flags: { expanded: { displacedActivityId: 'actTail', displacedActivityName: 'Archery', from_block: 'b2' } },
    }
    const tailSlot = { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'actHead', is_span_head: false, is_overridden: true }
    const { hook, props } = setup({ slots: [headSlot, tailSlot], timeBlocks: [{ id: 'b1', name: 'Block 1', sort_order: 1 }, { id: 'b2', name: 'Block 2', sort_order: 2 }], days: [{ id: 'd1', label: 'Mon' }] })
    await act(async () => {
      await hook.result.current.splitSlot('g1', 'd1', 'b1')
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('createActivityFromCell: blocks onto an overridden cell, never creates the activity', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', flags: {}, is_anchor: false, is_overridden: true },
    ]
    const { hook, props } = setup({ slots, activities: [], campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }] })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeActivityFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('createElectiveFromCell: blocks onto an overridden cell', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', flags: {}, is_anchor: false, is_overridden: true },
    ]
    const { hook, props } = setup({ slots, activities: [], campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }] })
    await act(async () => {
      await hook.result.current.createElectiveFromCell('Chugim', ['Art', 'Archery'], { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeElectiveSetFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.setActionError).toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })

  it('a non-overridden cell is unaffected — replaceSlot proceeds normally', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.setActionError).not.toHaveBeenCalledWith(OVERRIDE_MESSAGE)
  })
})

// T108 (design §6.1): the override-authoring-mode write-routing half. Phase 1
// wires the mode as a plain hook param (`overrideMode`); the UI toggle that
// sets it is Phase 2 (out of scope here, per the ticket).
describe('useSlotMutations — override-authoring mode (overrideMode: true)', () => {
  it('placeActivityManual in override mode writes a day_overrides row (kind: swap), never template_slots', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({
      slots, activities: [{ id: 'act-1', name: 'Swim' }], groups: [{ id: 'g1', tier_id: 't1' }],
      overrideModeDayId: 'd1', weekId: 'week-1',
    })
    await act(async () => {
      await hook.result.current.placeActivityManual('act-1', 'g1', 'd1', 'b1')
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.repo.writeDayOverrideFields).toHaveBeenCalled()
    const [, fields] = props.repo.writeDayOverrideFields.mock.calls[0]
    expect(fields).toMatchObject({
      schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1',
      activity_id: 'act-1', kind: 'swap',
    })
  })

  it('pullOverrideCell writes a day_overrides row with kind: pull and a null activity_id', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {} },
    ]
    const { hook, props } = setup({ slots, overrideModeDayId: 'd1', weekId: 'week-1' })
    await act(async () => {
      await hook.result.current.pullOverrideCell('g1', 'd1', 'b1')
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.repo.writeDayOverrideFields).toHaveBeenCalled()
    const [, fields] = props.repo.writeDayOverrideFields.mock.calls[0]
    expect(fields).toMatchObject({
      schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1',
      activity_id: null, kind: 'pull',
    })
  })

  it('override-mode writes still respect the edit-block guard on an already-overridden cell', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-old', flags: {}, is_overridden: true },
    ]
    const { hook, props } = setup({
      slots, activities: [{ id: 'act-1', name: 'Swim' }], groups: [{ id: 'g1', tier_id: 't1' }],
      overrideModeDayId: 'd1', weekId: 'week-1',
    })
    await act(async () => {
      await hook.result.current.placeActivityManual('act-1', 'g1', 'd1', 'b1')
    })
    // Already-overridden means a NEW override write in override mode is still
    // allowed (the guard only blocks NON-override-mode edits) — this asserts
    // the guard is gated correctly on overrideMode, not that it blocks here.
    expect(props.repo.writeDayOverrideFields).toHaveBeenCalled()
  })

  // T108 Phase 2 (design §6.1, group-view correctness) — override mode is
  // scoped to ONE (week, day); group view renders every day as a column at
  // once, so a cell on a DIFFERENT day than the active mode must still route
  // through the normal write path, never day_overrides.
  it('a cell on a different day than the active override-mode day writes normally, not to day_overrides', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({
      slots, activities: [{ id: 'act-1', name: 'Swim' }], groups: [{ id: 'g1', tier_id: 't1' }],
      overrideModeDayId: 'd1', weekId: 'week-1', // mode active for d1, this cell is on d2
    })
    await act(async () => {
      await hook.result.current.placeActivityManual('act-1', 'g1', 'd2', 'b1')
    })
    expect(props.repo.writeDayOverrideFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s1', expect.objectContaining({ activity_id: 'act-1' }))
  })

  // T108 Phase 2 review round 2 (HIGH #1) — the drag-drop path (replaceSlot,
  // what dragHandlers.js routes ALL drops/card-moves to) had NO override-mode
  // branch: dragging in override mode silently wrote template_slots for
  // every day. This pins the fix.
  it('replaceSlot in override mode writes a day_overrides row (kind: swap), never template_slots', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, is_anchor: false, flags: {} },
    ]
    const { hook, props } = setup({
      slots, activities: [{ id: 'act-1', name: 'Swim' }],
      overrideModeDayId: 'd1', weekId: 'week-1',
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.repo.writeDayOverrideFields).toHaveBeenCalled()
    const [, fields] = props.repo.writeDayOverrideFields.mock.calls[0]
    expect(fields).toMatchObject({
      schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1',
      activity_id: 'act-1', kind: 'swap',
    })
  })

  it('replaceSlot on a different day than the active override-mode day writes normally, not to day_overrides', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: null, is_anchor: false, flags: {} },
    ]
    const { hook, props } = setup({
      slots, activities: [{ id: 'act-1', name: 'Swim' }],
      overrideModeDayId: 'd1', weekId: 'week-1', // mode active for d1, drop target is d2
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd2', blockId: 'b1' })
    })
    expect(props.repo.writeDayOverrideFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('s1', { activity_id: 'act-1', flags: {} })
  })

  it('pullOverrideDay batches pullOverrideCell across the day\'s non-span, non-overridden blocks for one group', async () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {}, is_anchor: false },
      { id: 's2', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', flags: {}, is_anchor: false },
      { id: 's3', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null, flags: {}, is_anchor: true },
    ]
    const timeBlocks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
    const { hook, props } = setup({ slots, timeBlocks, overrideModeDayId: 'd1', weekId: 'week-1' })
    await act(async () => {
      await hook.result.current.pullOverrideDay('g1', 'd1')
    })
    // b1 and b2 get pull writes; b3 (anchor) is skipped.
    expect(props.repo.writeDayOverrideFields).toHaveBeenCalledTimes(2)
    const blockIds = props.repo.writeDayOverrideFields.mock.calls.map(([, fields]) => fields.time_block_id)
    expect(blockIds.sort()).toEqual(['b1', 'b2'])
  })

  // T108 Phase 2 review round 3 (HIGH — re-authoring an existing override
  // silently no-ops / data loss). Uses makeRealisticDayOverrideRepo, which
  // reproduces the real UNIQUE(schedule_week_id, day_id, group_id,
  // time_block_id) collision semantics a plain vi.fn() mock cannot — a
  // FRESH id for an already-overridden coordinate must be a documented no-op
  // here too, or this test would give the same false confidence the
  // original round-2 tests did (see electron/ops/dayOverrides.projections.test.js
  // for the real-SQLite version of this same proof).
  describe('re-authoring an existing override (coordinate id reuse)', () => {
    const slots = [
      { id: 's1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, is_anchor: false, flags: {} },
    ]

    it('placeActivityManual, re-authored: the SECOND write reuses the id findOverrideId resolves, and the row ends up with the SECOND content', async () => {
      const repo = makeRealisticDayOverrideRepo()
      const { hook, props } = setup({
        slots, activities: [{ id: 'act-art', name: 'Art' }, { id: 'act-boat', name: 'Boating' }],
        overrideModeDayId: 'd1', weekId: 'week-1', repo,
      })

      await act(async () => {
        await hook.result.current.placeActivityManual('act-art', 'g1', 'd1', 'b1')
      })
      const firstId = repo.writeDayOverrideFields.mock.calls[0][0]
      expect(repo._rowForCoord('week-1|d1|g1|b1').activity_id).toBe('act-art')

      // Simulate the real app: the composed dayOverrides state now includes
      // the row the first write created, fed back in via rerender (the same
      // way ScheduleScreen's setDayOverrides -> re-render -> updated prop
      // cycle works in production).
      hook.rerender({
        ...props,
        dayOverrides: [{ id: firstId, schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', activity_id: 'act-art', kind: 'swap', note: null }],
      })

      await act(async () => {
        await hook.result.current.placeActivityManual('act-boat', 'g1', 'd1', 'b1')
      })
      const secondId = repo.writeDayOverrideFields.mock.calls[1][0]

      // THE FIX: the second write reused the first write's id.
      expect(secondId).toBe(firstId)
      // And because the id was reused, the row's content is now the SECOND
      // override — not silently stuck on the first (the bug this closes).
      const rows = [...repo._rowsById.values()]
      expect(rows).toHaveLength(1)
      expect(rows[0].activity_id).toBe('act-boat')
    })

    it('WITHOUT id reuse (fresh id per write), the realistic repo reproduces the data-loss bug — pins why the fix is required', async () => {
      // Same scenario as above, but calling the repo directly with two FRESH
      // ids for the same coordinate — exactly what the pre-fix
      // useSlotMutations.js code did (crypto.randomUUID() unconditionally).
      // This is the control case: it demonstrates the realistic mock's
      // UNIQUE-collision behavior is real, not a tautology that always passes.
      const repo = makeRealisticDayOverrideRepo()
      await repo.writeDayOverrideFields('fresh-id-1', {
        schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', activity_id: 'act-art', kind: 'swap', note: null,
      })
      await repo.writeDayOverrideFields('fresh-id-2', {
        schedule_week_id: 'week-1', day_id: 'd1', group_id: 'g1', time_block_id: 'b1', activity_id: 'act-boat', kind: 'swap', note: null,
      })
      const rows = [...repo._rowsById.values()]
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('fresh-id-1')
      expect(rows[0].activity_id).toBe('act-art') // the second write vanished
    })

    it('setDayOverrides upserts by coordinate: after a re-authored write, the array has exactly ONE entry with the NEW content', async () => {
      const repo = makeRealisticDayOverrideRepo()
      let current = []
      const setDayOverrides = vi.fn((updater) => {
        current = typeof updater === 'function' ? updater(current) : updater
      })
      const { hook, props } = setup({
        slots, activities: [{ id: 'act-art', name: 'Art' }, { id: 'act-boat', name: 'Boating' }],
        overrideModeDayId: 'd1', weekId: 'week-1', repo, setDayOverrides,
      })

      await act(async () => {
        await hook.result.current.placeActivityManual('act-art', 'g1', 'd1', 'b1')
      })
      expect(current).toHaveLength(1)
      expect(current[0].activity_id).toBe('act-art')

      hook.rerender({ ...props, dayOverrides: current })

      await act(async () => {
        await hook.result.current.placeActivityManual('act-boat', 'g1', 'd1', 'b1')
      })
      // Upsert, not append: still exactly one entry, and applyDayOverrides'
      // find() (first match wins) now sees the fresh content immediately.
      expect(current).toHaveLength(1)
      expect(current[0].activity_id).toBe('act-boat')
    })
  })
})
