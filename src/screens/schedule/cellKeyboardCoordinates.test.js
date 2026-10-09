// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { cellKeyboardCoordinates } from './cellKeyboardCoordinates'

// A 2x2 grid of 100x50 cells, origin (0,0).
function cell(key, x, y) {
  const el = document.createElement('div')
  el.setAttribute('data-cell-key', key)
  el.getBoundingClientRect = () => ({ left: x, top: y, width: 100, height: 50, right: x + 100, bottom: y + 50 })
  document.body.appendChild(el)
  return el
}

const ctx = (left, top) => ({ context: { collisionRect: { left, top, width: 100, height: 50 } } })
const key = code => ({ code, preventDefault() {} })

describe('cellKeyboardCoordinates', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    cell('g|d1|b1', 0, 0); cell('g|d2|b1', 100, 0)
    cell('g|d1|b2', 0, 50); cell('g|d2|b2', 100, 50)
  })

  it('moves one whole cell per arrow, so the drag rect centre lands on the neighbour centre', () => {
    expect(cellKeyboardCoordinates(key('ArrowRight'), { ...ctx(0, 0), currentCoordinates: { x: 0, y: 0 } })).toEqual({ x: 100, y: 0 })
    expect(cellKeyboardCoordinates(key('ArrowDown'), { ...ctx(0, 0), currentCoordinates: { x: 0, y: 0 } })).toEqual({ x: 0, y: 50 })
    expect(cellKeyboardCoordinates(key('ArrowLeft'), { ...ctx(100, 50), currentCoordinates: { x: 100, y: 50 } })).toEqual({ x: 0, y: 50 })
    expect(cellKeyboardCoordinates(key('ArrowUp'), { ...ctx(100, 50), currentCoordinates: { x: 100, y: 50 } })).toEqual({ x: 100, y: 0 })
  })

  it('stays put at the grid edge instead of drifting off the grid', () => {
    expect(cellKeyboardCoordinates(key('ArrowLeft'), { ...ctx(0, 0), currentCoordinates: { x: 0, y: 0 } })).toEqual({ x: 0, y: 0 })
  })

  it('ignores non-arrow keys', () => {
    expect(cellKeyboardCoordinates(key('KeyA'), { ...ctx(0, 0), currentCoordinates: { x: 0, y: 0 } })).toBeUndefined()
  })
})
