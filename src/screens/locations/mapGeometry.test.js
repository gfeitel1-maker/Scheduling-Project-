import { describe, it, expect } from 'vitest'
import {
  clamp01,
  computeMoveGeometry,
  computeResizeGeometry,
  defaultTrayGeometry,
  MIN_DIMENSION_FRACTION,
  TRAY_DEFAULT_W,
  TRAY_DEFAULT_H,
} from './mapGeometry'

describe('clamp01', () => {
  it('clamps below 0 up to 0 and above 1 down to 1', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(0.4)).toBe(0.4)
  })
})

describe('computeMoveGeometry', () => {
  const container = { width: 1000, height: 500 }

  it('converts a pixel delta into a fraction delta on x/y, leaving w/h unchanged', () => {
    const initial = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    const result = computeMoveGeometry(initial, { x: 100, y: 50 }, container)
    expect(result).toEqual({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 })
  })

  it('clamps x/y so the box never exits the left/top edge', () => {
    const initial = { x: 0.05, y: 0.05, w: 0.2, h: 0.2 }
    const result = computeMoveGeometry(initial, { x: -1000, y: -1000 }, container)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })

  it('clamps x/y so the box never exits the right/bottom edge (accounts for its own w/h)', () => {
    const initial = { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }
    const result = computeMoveGeometry(initial, { x: 5000, y: 5000 }, container)
    expect(result.x).toBe(0.7) // 1 - w
    expect(result.y).toBe(0.7) // 1 - h
  })

  it('is a no-op with zero delta', () => {
    const initial = { x: 0.3, y: 0.4, w: 0.1, h: 0.1 }
    expect(computeMoveGeometry(initial, { x: 0, y: 0 }, container)).toEqual(initial)
  })

  it('does not divide by zero when the container has no measured size yet', () => {
    const initial = { x: 0.3, y: 0.4, w: 0.1, h: 0.1 }
    const result = computeMoveGeometry(initial, { x: 100, y: 100 }, { width: 0, height: 0 })
    expect(result).toEqual(initial)
  })
})

describe('computeResizeGeometry', () => {
  const container = { width: 1000, height: 500 }

  it('changes only w/h from a positive delta, x/y (the anchor) stay fixed', () => {
    const initial = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    const result = computeResizeGeometry(initial, { x: 100, y: 50 }, container)
    expect(result.x).toBe(0.1)
    expect(result.y).toBe(0.1)
    expect(result.w).toBeCloseTo(0.3)
    expect(result.h).toBeCloseTo(0.3)
  })

  it('never shrinks w/h below MIN_DIMENSION_FRACTION', () => {
    const initial = { x: 0.1, y: 0.1, w: 0.05, h: 0.05 }
    const result = computeResizeGeometry(initial, { x: -1000, y: -1000 }, container)
    expect(result.w).toBe(MIN_DIMENSION_FRACTION)
    expect(result.h).toBe(MIN_DIMENSION_FRACTION)
  })

  it('never grows w/h past the canvas edge given the fixed x/y anchor', () => {
    const initial = { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }
    const result = computeResizeGeometry(initial, { x: 5000, y: 5000 }, container)
    expect(result.w).toBeCloseTo(0.2) // 1 - x
    expect(result.h).toBeCloseTo(0.2) // 1 - y
  })
})

describe('defaultTrayGeometry', () => {
  it('centers a TRAY_DEFAULT_W x TRAY_DEFAULT_H rectangle on the drop point', () => {
    const result = defaultTrayGeometry({ x: 0.5, y: 0.5 })
    expect(result).toEqual({
      x: 0.5 - TRAY_DEFAULT_W / 2,
      y: 0.5 - TRAY_DEFAULT_H / 2,
      w: TRAY_DEFAULT_W,
      h: TRAY_DEFAULT_H,
    })
  })

  it('clamps so the synthesized rectangle stays inside 0..1 near an edge', () => {
    const result = defaultTrayGeometry({ x: 0, y: 1 })
    expect(result.x).toBe(0)
    expect(result.y).toBe(1 - TRAY_DEFAULT_H)
    expect(result.x + result.w).toBeLessThanOrEqual(1)
    expect(result.y + result.h).toBeLessThanOrEqual(1)
  })
})
