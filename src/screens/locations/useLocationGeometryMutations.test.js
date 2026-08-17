// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLocationGeometryMutations } from './useLocationGeometryMutations'

function makeRepository(overrides = {}) {
  return {
    writeFields: vi.fn(async () => ({ status: 'applied' })),
    ...overrides,
  }
}

// A promise + resolver pair for hand-controlled write resolution order — same
// seam as useSlotMutations.test.js's deferred() helper, no timing-dependent
// flakiness.
function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

function setup(overrides = {}) {
  const repository = overrides.repository || makeRepository()
  const hook = renderHook((p) => useLocationGeometryMutations(p), { initialProps: { repository } })
  return { hook, repository }
}

describe('useLocationGeometryMutations — writeGeometry', () => {
  it('writes locations.map_geometry as a JSON string via repository.writeFields', async () => {
    const { hook, repository } = setup()
    await act(async () => {
      await hook.result.current.writeGeometry('loc-1', { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'gesture-1')
    })
    expect(repository.writeFields).toHaveBeenCalledTimes(1)
    expect(repository.writeFields).toHaveBeenCalledWith('locations', 'loc-1', {
      map_geometry: JSON.stringify({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }),
    })
  })

  it('synthesizes a gestureId when none is supplied — a non-drag caller is never exempt from the ordering check', async () => {
    const { hook, repository } = setup()
    await act(async () => {
      await hook.result.current.writeGeometry('loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 })
    })
    expect(repository.writeFields).toHaveBeenCalledTimes(1)
  })
})

describe('useLocationGeometryMutations — per-location write serialization (copied from the write-serialization ADR test seam)', () => {
  it('a claim genuinely queued behind an in-flight write on the SAME location is superseded and never dispatched', async () => {
    const d0 = deferred()
    let call = 0
    const writeFields = vi.fn(() => {
      call += 1
      return call === 1 ? d0.promise : Promise.resolve({ status: 'applied' })
    })
    const { hook } = setup({ repository: makeRepository({ writeFields }) })

    // Gesture A claims and dispatches first — its write is left in flight.
    const pA = hook.result.current.writeGeometry('loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }, 'gesture-A')
    // Flush microtasks so A's own claim/chain check completes and its write
    // reaches repository.writeFields (call count 1, pending on d0) BEFORE B/C
    // claim — otherwise all three land in the same tick and only the LAST
    // claim's synchronous overwrite is exercised, a different scenario.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(writeFields).toHaveBeenCalledTimes(1)

    // Gesture B claims while A's write is still in flight — it queues BEHIND
    // A's real dispatched write.
    const pB = hook.result.current.writeGeometry('loc-1', { x: 0.1, y: 0, w: 0.1, h: 0.1 }, 'gesture-B')
    // Gesture C claims before B's turn ever arrives — B is superseded before
    // it ever reaches dispatch.
    const pC = hook.result.current.writeGeometry('loc-1', { x: 0.2, y: 0, w: 0.1, h: 0.1 }, 'gesture-C')

    await act(async () => { d0.resolve({ status: 'applied' }); await Promise.all([pA, pB, pC]) })

    // Exactly two writes ever reached the repository: A's (already dispatched
    // before anything superseded it) and C's (the survivor). B was superseded
    // before its own turn and was never sent to writeFields at all.
    expect(writeFields).toHaveBeenCalledTimes(2)
    expect(writeFields).toHaveBeenNthCalledWith(1, 'locations', 'loc-1', {
      map_geometry: JSON.stringify({ x: 0, y: 0, w: 0.1, h: 0.1 }),
    })
    expect(writeFields).toHaveBeenNthCalledWith(2, 'locations', 'loc-1', {
      map_geometry: JSON.stringify({ x: 0.2, y: 0, w: 0.1, h: 0.1 }),
    })
  })

  it('two DIFFERENT locations never collide — both dispatch independently, same as two non-colliding schedule cells', async () => {
    const { hook, repository } = setup()
    await act(async () => {
      await hook.result.current.writeGeometry('loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }, 'g1')
    })
    await act(async () => {
      await hook.result.current.writeGeometry('loc-2', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 'g2')
    })
    expect(repository.writeFields).toHaveBeenCalledTimes(2)
    expect(repository.writeFields).toHaveBeenNthCalledWith(1, 'locations', 'loc-1', expect.any(Object))
    expect(repository.writeFields).toHaveBeenNthCalledWith(2, 'locations', 'loc-2', expect.any(Object))
  })

  it('synchronous claim/chain: a SECOND call issued before the first has any chance to await supersedes it even with no real async gap (Red Hat mandate, D7)', async () => {
    const writeFields = vi.fn(async () => ({ status: 'applied' }))
    const { hook } = setup({ repository: makeRepository({ writeFields }) })

    let pFirst, pSecond
    // Both calls issued in the SAME synchronous tick, no await between them —
    // proves the claim (steps 1-2 of claimAndRun) runs synchronously, so the
    // second call's claim always wins before the first's dispatch can check
    // currency, regardless of timing.
    act(() => {
      pFirst = hook.result.current.writeGeometry('loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }, 'first')
      pSecond = hook.result.current.writeGeometry('loc-1', { x: 1, y: 1, w: 0.1, h: 0.1 }, 'second')
    })
    await act(async () => { await Promise.all([pFirst, pSecond]) })

    expect(writeFields).toHaveBeenCalledTimes(1)
    expect(writeFields).toHaveBeenCalledWith('locations', 'loc-1', {
      map_geometry: JSON.stringify({ x: 1, y: 1, w: 0.1, h: 0.1 }),
    })
  })

  it('no queue-clear across renders/rerenders of the owning hook instance — a later gesture on a PREVIOUSLY-touched location still serializes correctly', async () => {
    const { hook, repository } = setup()
    await act(async () => {
      await hook.result.current.writeGeometry('loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }, 'g1')
    })
    // Simulate a re-render (e.g. LocationsScreen re-rendering for an
    // unrelated reason) — the hook instance is the same mount, its queue Map
    // must persist across this, per D7's "no queue-clear, ever" mandate.
    hook.rerender({ repository })
    await act(async () => {
      await hook.result.current.writeGeometry('loc-1', { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, 'g2')
    })
    expect(repository.writeFields).toHaveBeenCalledTimes(2)
    expect(repository.writeFields).toHaveBeenNthCalledWith(2, 'locations', 'loc-1', {
      map_geometry: JSON.stringify({ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }),
    })
  })

  // Red Hat NEEDS-FIX (M6 fix round): unlike ScheduleScreen (a long-lived
  // per-session mount), LocationsScreen fully unmounts/remounts on ordinary
  // sidebar navigation. A queue scoped to one hook INSTANCE (useRef) loses
  // all knowledge of an in-flight write the moment the owning component
  // unmounts — a fresh mount's fresh Map has no prior tail for the location,
  // so a same-location write issued right after remount dispatches
  // CONCURRENTLY with the still-in-flight older write instead of queuing
  // behind it, exactly the DB-divergence race the write-queue exists to
  // prevent (docs/adr/2026-08-12-drag-live-write-serialization.md).
  it('a same-location write issued after a REMOUNT (unmount + fresh mount) queues behind a still in-flight write from the prior mount, instead of racing it', async () => {
    const d0 = deferred()
    let call = 0
    const writeFields = vi.fn(() => {
      call += 1
      return call === 1 ? d0.promise : Promise.resolve({ status: 'applied' })
    })
    const repository = makeRepository({ writeFields })

    // Mount 1 (e.g. LocationsScreen first visit) — gesture A dispatches and
    // is left in flight (its write hasn't resolved yet).
    const hook1 = renderHook((p) => useLocationGeometryMutations(p), { initialProps: { repository } })
    const pA = hook1.result.current.writeGeometry('loc-remount-1', { x: 0, y: 0, w: 0.1, h: 0.1 }, 'gesture-A')
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(writeFields).toHaveBeenCalledTimes(1)

    // The director navigates away (unmount) and back (fresh mount) —
    // LocationsScreen's ordinary sidebar-navigation lifecycle — WHILE A's
    // write is still in flight, then immediately re-drags the same location.
    hook1.unmount()
    const hook2 = renderHook((p) => useLocationGeometryMutations(p), { initialProps: { repository } })
    const pB = hook2.result.current.writeGeometry('loc-remount-1', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 'gesture-B')
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    // B must NOT have dispatched yet — it must still be queued behind A's
    // tail from the PRIOR mount. A per-mount ref queue has no memory of A at
    // all here and dispatches B immediately (2 calls before A ever resolves).
    expect(writeFields).toHaveBeenCalledTimes(1)

    d0.resolve({ status: 'applied' })
    await act(async () => { await Promise.all([pA, pB]) })

    expect(writeFields).toHaveBeenCalledTimes(2)
    expect(writeFields).toHaveBeenNthCalledWith(1, 'locations', 'loc-remount-1', {
      map_geometry: JSON.stringify({ x: 0, y: 0, w: 0.1, h: 0.1 }),
    })
    expect(writeFields).toHaveBeenNthCalledWith(2, 'locations', 'loc-remount-1', {
      map_geometry: JSON.stringify({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }),
    })
  })
})
