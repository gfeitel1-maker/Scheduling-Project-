import { describe, it, expect } from 'vitest'
import { closestEdge } from './closestEdge'

// A 40px-tall cell running from y=100 to y=140. Midline is y=120.
const rect = { top: 100, bottom: 140, left: 0, right: 200 }

describe('closestEdge', () => {
  it('resolves a point above the midline to top', () => {
    expect(closestEdge(rect, { x: 50, y: 110 })).toBe('top')
  })

  it('resolves a point below the midline to bottom', () => {
    expect(closestEdge(rect, { x: 50, y: 130 })).toBe('bottom')
  })

  // The documented tie-break: [top, mid) is 'top', [mid, bottom] is 'bottom'.
  it('resolves a point exactly on the midline to bottom', () => {
    expect(closestEdge(rect, { x: 50, y: 120 })).toBe('bottom')
  })

  it('resolves one pixel above the midline to top', () => {
    expect(closestEdge(rect, { x: 50, y: 119 })).toBe('top')
  })

  it('resolves the top edge itself to top', () => {
    expect(closestEdge(rect, { x: 50, y: 100 })).toBe('top')
  })

  it('resolves the bottom edge itself to bottom', () => {
    expect(closestEdge(rect, { x: 50, y: 140 })).toBe('bottom')
  })

  it('resolves a point above the rect entirely to top', () => {
    expect(closestEdge(rect, { x: 50, y: 0 })).toBe('top')
  })

  it('resolves a point below the rect entirely to bottom', () => {
    expect(closestEdge(rect, { x: 50, y: 999 })).toBe('bottom')
  })

  it('ignores the x coordinate', () => {
    expect(closestEdge(rect, { x: -500, y: 110 })).toBe('top')
    expect(closestEdge(rect, { x: 5000, y: 130 })).toBe('bottom')
  })

  // A collapsed block can render a zero-height row; top === bottom === midline,
  // so the strict `<` sends it to 'bottom' with no special case.
  it('resolves a zero-height rect to bottom', () => {
    expect(closestEdge({ top: 60, bottom: 60 }, { x: 0, y: 60 })).toBe('bottom')
  })

  it('works for a rect at the viewport origin', () => {
    expect(closestEdge({ top: 0, bottom: 30 }, { x: 0, y: 14 })).toBe('top')
    expect(closestEdge({ top: 0, bottom: 30 }, { x: 0, y: 15 })).toBe('bottom')
  })
})
