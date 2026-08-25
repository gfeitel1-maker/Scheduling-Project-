// @vitest-environment node
//
// Pure-function tests for TileWorldScene math — no Phaser, no canvas, no DOM.
// Tests screen coordinate calculation, painter sort order, and sub-quadrant split.
import { describe, it, expect, vi } from 'vitest'

// Phaser uses `window` at module load time — mock it before the import.
vi.mock('phaser', () => ({
  default: { Scene: class Scene { constructor() {} } },
}))

import { tileScreenPos, painterSortKey, subQuadrantOffsets } from './TileWorldScene.js'

const TILE_W = 128
const TILE_H = 64
const ORIGIN_X = 400
const ORIGIN_Y = 300

describe('tileScreenPos', () => {
  it('maps (0,0) to the origin', () => {
    const { x, y } = tileScreenPos(0, 0, ORIGIN_X, ORIGIN_Y)
    expect(x).toBe(ORIGIN_X)
    expect(y).toBe(ORIGIN_Y)
  })

  it('moving right (gx+1) shifts x positive and y positive', () => {
    const a = tileScreenPos(0, 0, ORIGIN_X, ORIGIN_Y)
    const b = tileScreenPos(1, 0, ORIGIN_X, ORIGIN_Y)
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.y).toBeGreaterThan(a.y)
    expect(b.x - a.x).toBe(TILE_W / 2)
    expect(b.y - a.y).toBe(TILE_H / 2)
  })

  it('moving down (gy+1) shifts x negative and y positive', () => {
    const a = tileScreenPos(0, 0, ORIGIN_X, ORIGIN_Y)
    const b = tileScreenPos(0, 1, ORIGIN_X, ORIGIN_Y)
    expect(b.x).toBeLessThan(a.x)
    expect(b.y).toBeGreaterThan(a.y)
    expect(a.x - b.x).toBe(TILE_W / 2)
    expect(b.y - a.y).toBe(TILE_H / 2)
  })

  it('satisfies the isometric formula', () => {
    const gx = 5
    const gy = 3
    const { x, y } = tileScreenPos(gx, gy, ORIGIN_X, ORIGIN_Y)
    expect(x).toBe((gx - gy) * (TILE_W / 2) + ORIGIN_X)
    expect(y).toBe((gx + gy) * (TILE_H / 2) + ORIGIN_Y)
  })
})

describe('painterSortKey', () => {
  it('returns gridY * 20 + gridX', () => {
    expect(painterSortKey({ grid_x: 3, grid_y: 2 })).toBe(2 * 20 + 3)
  })

  it('tiles on row 0 sort before tiles on row 1', () => {
    const a = painterSortKey({ grid_x: 19, grid_y: 0 })
    const b = painterSortKey({ grid_x: 0, grid_y: 1 })
    expect(a).toBeLessThan(b)
  })

  it('within the same row, lower gx sorts first', () => {
    const a = painterSortKey({ grid_x: 2, grid_y: 5 })
    const b = painterSortKey({ grid_x: 7, grid_y: 5 })
    expect(a).toBeLessThan(b)
  })

  it('produces a stable total order for a grid', () => {
    const locs = [
      { grid_x: 10, grid_y: 5 },
      { grid_x: 0, grid_y: 0 },
      { grid_x: 19, grid_y: 15 },
      { grid_x: 5, grid_y: 2 },
    ]
    const sorted = [...locs].sort((a, b) => painterSortKey(a) - painterSortKey(b))
    expect(sorted[0]).toEqual({ grid_x: 0, grid_y: 0 })
    expect(sorted[sorted.length - 1]).toEqual({ grid_x: 19, grid_y: 15 })
  })
})

describe('subQuadrantOffsets', () => {
  it('count 1 returns single centered offset at scale 1', () => {
    const offsets = subQuadrantOffsets(1)
    expect(offsets).toHaveLength(1)
    expect(offsets[0]).toEqual({ dx: 0, dy: 0, scale: 1 })
  })

  it('count 2 returns two symmetric offsets at scale 0.5', () => {
    const offsets = subQuadrantOffsets(2)
    expect(offsets).toHaveLength(2)
    expect(offsets[0].scale).toBe(0.5)
    expect(offsets[1].scale).toBe(0.5)
    expect(offsets[0].dx).toBeLessThan(0)
    expect(offsets[1].dx).toBeGreaterThan(0)
    expect(offsets[0].dy).toBe(0)
    expect(offsets[1].dy).toBe(0)
    expect(offsets[0].dx + offsets[1].dx).toBe(0)
  })

  it('count 3 returns three offsets at scale 0.5', () => {
    const offsets = subQuadrantOffsets(3)
    expect(offsets).toHaveLength(3)
    for (const o of offsets) expect(o.scale).toBe(0.5)
  })

  it('count 4 returns four corner offsets at scale 0.5', () => {
    const offsets = subQuadrantOffsets(4)
    expect(offsets).toHaveLength(4)
    for (const o of offsets) expect(o.scale).toBe(0.5)
    const xs = offsets.map((o) => o.dx)
    expect(new Set(xs).size).toBe(2)
  })
})
