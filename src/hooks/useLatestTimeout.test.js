// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLatestTimeout } from './useLatestTimeout'

describe('useLatestTimeout', () => {
  it('runs the callback after the delay', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const { result } = renderHook(() => useLatestTimeout())
      act(() => result.current.start(fn, 200))
      act(() => vi.advanceTimersByTime(199))
      expect(fn).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(fn).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('the latest start wins — a pending timer never fires late into a new one', () => {
    vi.useFakeTimers()
    try {
      const first = vi.fn()
      const second = vi.fn()
      const { result } = renderHook(() => useLatestTimeout())
      act(() => result.current.start(first, 100))
      act(() => vi.advanceTimersByTime(60))
      act(() => result.current.start(second, 100))
      // Past the FIRST timer's original deadline. It must be gone, not merely late.
      act(() => vi.advanceTimersByTime(60))
      expect(first).not.toHaveBeenCalled()
      expect(second).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(40))
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('cancel stops a pending callback', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const { result } = renderHook(() => useLatestTimeout())
      act(() => result.current.start(fn, 100))
      act(() => result.current.cancel())
      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(500))
      expect(fn).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('unmount clears the pending timer', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const { result, unmount } = renderHook(() => useLatestTimeout())
      act(() => result.current.start(fn, 100))
      // Assert BEFORE advancing: running a pending timer also empties the queue,
      // so checking the count afterwards passes whether or not unmount cleaned up.
      unmount()
      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(500))
      expect(fn).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('start and cancel are stable across renders, so they are safe as deps', () => {
    const { result, rerender } = renderHook(() => useLatestTimeout())
    const first = result.current
    rerender()
    expect(result.current.start).toBe(first.start)
    expect(result.current.cancel).toBe(first.cancel)
  })
})
