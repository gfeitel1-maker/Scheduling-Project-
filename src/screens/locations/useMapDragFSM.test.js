// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMapDragFSM } from './useMapDragFSM'
import { MOVE, RESIZE, IDLE, RESOLVING } from './mapDragFSM'

function makeContainerRef(width = 1000, height = 500) {
  const el = { getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }) }
  return { current: el }
}

function activeFor(kind, locationId, geometry) {
  return { data: { current: { kind, locationId, geometry } } }
}

function setup(overrides = {}) {
  const writeGeometry = overrides.writeGeometry || vi.fn(async () => ({ dropped: false, result: { status: 'applied' } }))
  const containerRef = overrides.containerRef || makeContainerRef()
  const onCommitError = overrides.onCommitError || vi.fn()
  const hook = renderHook(() => useMapDragFSM({ writeGeometry, containerRef, onCommitError }))
  return { hook, writeGeometry, containerRef, onCommitError }
}

describe('useMapDragFSM — move gesture end to end', () => {
  it('drags a location body, writes the final geometry on drop, and resolves back to Idle', async () => {
    const { hook, writeGeometry } = setup()
    const el = document.createElement('div')
    hook.result.current.registerLocationEl('loc-1', el)

    act(() => {
      hook.result.current.dndProps.onDragStart({
        active: activeFor(MOVE, 'loc-1', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
      })
    })
    expect(el.getAttribute('data-dragging')).toBe('')
    expect(el.getAttribute('data-drag-kind')).toBe(MOVE)
    expect(hook.result.current.peekState().name).not.toBe(IDLE)

    act(() => {
      hook.result.current.dndProps.onDragMove({ delta: { x: 100, y: 0 } }) // 100/1000 = +0.1 on x
    })
    expect(el.style.left).toBe('20%') // 0.1 + 0.1 = 0.2
    expect(el.style.top).toBe('10%')
    expect(el.style.width).toBe('20%')
    expect(el.style.height).toBe('20%')

    await act(async () => {
      hook.result.current.dndProps.onDragEnd({ delta: { x: 100, y: 0 } })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(el.hasAttribute('data-dragging')).toBe(false)
    expect(writeGeometry).toHaveBeenCalledTimes(1)
    const [locationId, geometry] = writeGeometry.mock.calls[0]
    expect(locationId).toBe('loc-1')
    expect(geometry.x).toBeCloseTo(0.2)
    expect(geometry.w).toBeCloseTo(0.2) // move never changes w/h
    expect(hook.result.current.peekState().name).toBe(IDLE)
  })
})

describe('useMapDragFSM — resize gesture only changes w/h', () => {
  it('resizes from the bottom-right handle, x/y stay fixed', async () => {
    const { hook, writeGeometry } = setup()
    const el = document.createElement('div')
    hook.result.current.registerLocationEl('loc-1', el)

    act(() => {
      hook.result.current.dndProps.onDragStart({
        active: activeFor(RESIZE, 'loc-1', { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }),
      })
    })
    act(() => {
      hook.result.current.dndProps.onDragMove({ delta: { x: 50, y: 50 } }) // +0.05 each
    })
    expect(el.style.left).toBe('30%') // unchanged
    expect(el.style.top).toBe('30%')
    // container is 1000x500 (from makeContainerRef's defaults): +50px is
    // +0.05 fraction on the 1000-wide x axis, +0.1 fraction on the 500-tall y axis.
    expect(parseFloat(el.style.width)).toBeCloseTo(15)
    expect(parseFloat(el.style.height)).toBeCloseTo(20)

    await act(async () => {
      hook.result.current.dndProps.onDragEnd({ delta: { x: 50, y: 50 } })
      await Promise.resolve()
      await Promise.resolve()
    })
    const geometry = writeGeometry.mock.calls[0][1]
    expect(geometry.x).toBeCloseTo(0.3)
    expect(geometry.y).toBeCloseTo(0.3)
    expect(geometry.w).toBeCloseTo(0.15)
  })
})

describe('useMapDragFSM — selection (click, not drag)', () => {
  it('selectLocation marks the location data-selected and clears the previous selection', () => {
    const { hook } = setup()
    const elA = document.createElement('div')
    const elB = document.createElement('div')
    hook.result.current.registerLocationEl('loc-a', elA)
    hook.result.current.registerLocationEl('loc-b', elB)

    act(() => hook.result.current.selectLocation('loc-a'))
    expect(elA.hasAttribute('data-selected')).toBe(true)

    act(() => hook.result.current.selectLocation('loc-b'))
    expect(elA.hasAttribute('data-selected')).toBe(false)
    expect(elB.hasAttribute('data-selected')).toBe(true)
  })

  it('a click never issues a write', () => {
    const { hook, writeGeometry } = setup()
    const el = document.createElement('div')
    hook.result.current.registerLocationEl('loc-1', el)
    act(() => hook.result.current.selectLocation('loc-1'))
    expect(writeGeometry).not.toHaveBeenCalled()
  })
})

describe('useMapDragFSM — commit failure surfaces via onCommitError, state still returns to Idle', () => {
  it('calls onCommitError and resolves to Idle when the write rejects', async () => {
    const writeGeometry = vi.fn(async () => { throw new Error('offline') })
    const { hook, onCommitError } = setup({ writeGeometry })
    const el = document.createElement('div')
    hook.result.current.registerLocationEl('loc-1', el)

    act(() => {
      hook.result.current.dndProps.onDragStart({ active: activeFor(MOVE, 'loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }) })
    })
    await act(async () => {
      hook.result.current.dndProps.onDragEnd({ delta: { x: 0, y: 0 } })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onCommitError).toHaveBeenCalledTimes(1)
    expect(hook.result.current.peekState().name).toBe(IDLE)
  })
})

describe('useMapDragFSM — a lost pointerup self-heals via re-arm', () => {
  it('a fresh onDragStart while still Resolving does not throw and starts a new gesture', async () => {
    const d = { resolve: null }
    const writeGeometry = vi.fn(() => new Promise((resolve) => { d.resolve = resolve }))
    const { hook } = setup({ writeGeometry })
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    hook.result.current.registerLocationEl('loc-1', el1)
    hook.result.current.registerLocationEl('loc-2', el2)

    act(() => {
      hook.result.current.dndProps.onDragStart({ active: activeFor(MOVE, 'loc-1', { x: 0, y: 0, w: 0.1, h: 0.1 }) })
    })
    await act(async () => {
      hook.result.current.dndProps.onDragEnd({ delta: { x: 10, y: 10 } })
      await Promise.resolve() // flush the commit effect's Promise.resolve().then(() => writeGeometry(...))
    })
    expect(hook.result.current.peekState().name).toBe(RESOLVING)
    expect(writeGeometry).toHaveBeenCalledTimes(1)
    expect(typeof d.resolve).toBe('function')

    // A second gesture starts on a DIFFERENT location before the first's
    // commit resolves — must re-arm cleanly, not wedge.
    act(() => {
      hook.result.current.dndProps.onDragStart({ active: activeFor(MOVE, 'loc-2', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }) })
    })
    expect(hook.result.current.peekState().context.locationId).toBe('loc-2')

    await act(async () => { d.resolve({ status: 'applied' }); await Promise.resolve(); await Promise.resolve() })
  })
})
