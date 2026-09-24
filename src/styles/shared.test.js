// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { S, useNarrowViewport, useMeasuredRowCap } from './shared'

describe('S.cautionBanner', () => {
  it('uses the bronze --accent caution role via color-mix, not a hardcoded amber hex', () => {
    expect(S.cautionBanner).toBeDefined()
    expect(S.cautionBanner.background).toMatch(/color-mix\(in srgb, var\(--accent\)/)
    expect(S.cautionBanner.border).toMatch(/var\(--accent\)/)
    expect(S.cautionBanner.color).toMatch(/var\(--accent\)|var\(--text\)/)
    expect(JSON.stringify(S.cautionBanner)).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })
})

describe('S.chip', () => {
  it('renders a filled pill with white text when selected/on', () => {
    const style = S.chip('var(--primary)', true)
    expect(style.background).toBe('var(--primary)')
    expect(style.color).toBe('#fff')
    expect(style.borderRadius).toBe(20)
  })

  it('renders the unfilled/off state with the surface + text tokens', () => {
    const style = S.chip('var(--primary)', false)
    expect(style.background).toBe('var(--surface)')
    expect(style.color).toBe('var(--text)')
  })

  it('accepts overrides for radius/padding/fontSize/border without re-deriving the fill logic', () => {
    const style = S.chip('var(--warning)', true, { borderRadius: 99, padding: '2px 8px', fontSize: 11, border: 'none' })
    expect(style.borderRadius).toBe(99)
    expect(style.padding).toBe('2px 8px')
    expect(style.fontSize).toBe(11)
    expect(style.border).toBe('none')
    expect(style.background).toBe('var(--warning)')
    expect(style.color).toBe('#fff')
  })

  it('centralizes the filled-chip text color in the primitive (the one place #fff is allowed)', () => {
    // This guards only that the primitive OWNS the #fff literal — the point of
    // consolidation is that call sites reach it through S.chip rather than
    // re-hardcoding. (It does not, and cannot from here, prove no other file
    // hardcodes #fff — that boundary is enforced by review, not this test.)
    expect(S.chip('var(--primary)', true).color).toBe('#fff')
  })
})

describe('S.sectionLabel', () => {
  it('matches the byte-identical "Add X" section-header style previously forked across setup screens', () => {
    expect(S.sectionLabel).toEqual({
      fontFamily: 'var(--font-condensed)',
      fontWeight: 700,
      fontSize: 13,
      marginBottom: 10,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
    })
  })
})

describe('useNarrowViewport', () => {
  function stubMatchMedia(initialMatches) {
    const listeners = new Set()
    let matches = initialMatches
    const mql = {
      get matches() { return matches },
      addEventListener: vi.fn((event, cb) => listeners.add(cb)),
      removeEventListener: vi.fn((event, cb) => listeners.delete(cb)),
    }
    window.matchMedia = vi.fn(() => mql)
    return {
      fire(next) {
        matches = next
        for (const cb of listeners) cb({ matches: next })
      },
      listenerCount: () => listeners.size,
    }
  }

  afterEach(() => {
    delete window.matchMedia
  })

  it('reflects the initial matchMedia state', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useNarrowViewport(1150))
    expect(result.current).toBe(true)
  })

  it('updates when the media query change event fires', () => {
    const stub = stubMatchMedia(false)
    const { result } = renderHook(() => useNarrowViewport(1150))
    expect(result.current).toBe(false)

    act(() => stub.fire(true))
    expect(result.current).toBe(true)
  })

  it('removes its listener on unmount', () => {
    const stub = stubMatchMedia(false)
    const { unmount } = renderHook(() => useNarrowViewport(1150))
    expect(stub.listenerCount()).toBe(1)
    unmount()
    expect(stub.listenerCount()).toBe(0)
  })

  it('is SSR/jsdom-safe when matchMedia is unavailable', () => {
    delete window.matchMedia
    const { result } = renderHook(() => useNarrowViewport(1150))
    expect(result.current).toBe(false)
  })
})

describe('useMeasuredRowCap resize handling', () => {
  const ROW_HEIGHT = 100

  // container.children are only the CURRENTLY CAPPED rows (the caller slices
  // its list by the returned cap), so growing the cap on resize genuinely
  // requires re-exposing itemCount rows to re-measure them — this mock
  // reflects that by measuring whatever children are actually present.
  function mockRowLayout(container, top) {
    const orig = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (this === container) {
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} }
      }
      if (this.parentElement === container) {
        return { top: 0, bottom: ROW_HEIGHT, left: 0, right: 0, width: 0, height: ROW_HEIGHT, x: 0, y: 0, toJSON() {} }
      }
      return orig.call(this)
    }
    return () => {
      Element.prototype.getBoundingClientRect = orig
    }
  }

  function mockRaf() {
    const queue = []
    const orig = window.requestAnimationFrame
    window.requestAnimationFrame = vi.fn((cb) => {
      queue.push(cb)
      return queue.length
    })
    return {
      flushOne() {
        const cb = queue.shift()
        act(() => cb())
      },
      pendingCount: () => queue.length,
      restore() {
        window.requestAnimationFrame = orig
      },
    }
  }

  let container
  let restoreLayout

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    for (let i = 0; i < 10; i++) container.appendChild(document.createElement('div'))
    restoreLayout = mockRowLayout(container, 0)
    window.innerHeight = 320 // fits 3 rows of 100px
  })

  afterEach(() => {
    restoreLayout()
    document.body.removeChild(container)
  })

  it('coalesces repeated resize events into a single recompute instead of thrashing per event', () => {
    const raf = mockRaf()
    try {
      const containerRef = { current: container }
      const { result } = renderHook(() => useMeasuredRowCap({ containerRef, itemCount: 10 }))
      expect(result.current).toBe(3)

      // A drag fires 'resize' many times in the same frame.
      act(() => {
        window.dispatchEvent(new Event('resize'))
        window.dispatchEvent(new Event('resize'))
        window.dispatchEvent(new Event('resize'))
      })

      // Only one recompute should be scheduled for the whole burst, not one per event.
      expect(raf.pendingCount()).toBe(1)

      raf.flushOne() // runs the coalesced uncap, schedules the recompute
      raf.flushOne() // runs the recompute

      // After the recompute settles, the cap must reflect the real budget again —
      // no page-scroll-causing state survives the burst.
      expect(result.current).toBeLessThanOrEqual(3)
    } finally {
      raf.restore()
    }
  })

  it('shows at least one row when a single row is taller than the whole budget', () => {
    const oneRowContainer = document.createElement('div')
    document.body.appendChild(oneRowContainer)
    oneRowContainer.appendChild(document.createElement('div'))
    const restoreOne = mockRowLayout(oneRowContainer, 0)
    try {
      window.innerHeight = 10 // far smaller than ROW_HEIGHT (100)
      const containerRef = { current: oneRowContainer }
      const { result } = renderHook(() => useMeasuredRowCap({ containerRef, itemCount: 1 }))
      expect(result.current).toBe(1)
    } finally {
      restoreOne()
      document.body.removeChild(oneRowContainer)
    }
  })
})
