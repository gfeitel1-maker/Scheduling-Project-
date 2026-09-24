// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { S, useNarrowViewport } from './shared'

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
