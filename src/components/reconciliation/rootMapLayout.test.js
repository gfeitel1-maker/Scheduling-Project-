import { describe, it, expect } from 'vitest'
import { NODE_LAYOUT, layoutForChild } from './rootMapLayout.js'
import { DOMAINS } from './domainRollup.js'

describe('rootMapLayout', () => {
  it('every domain in DOMAINS has a NODE_LAYOUT entry with x/y in [0,1]', () => {
    for (const key of DOMAINS) {
      const entry = NODE_LAYOUT[key]
      expect(entry).toBeDefined()
      expect(entry.x).toBeGreaterThanOrEqual(0)
      expect(entry.x).toBeLessThanOrEqual(1)
      expect(entry.y).toBeGreaterThanOrEqual(0)
      expect(entry.y).toBeLessThanOrEqual(1)
    }
  })

  it('a hand-placed child returns its exact NODE_LAYOUT coordinate', () => {
    // Assert the behavior against the config, not a frozen literal — coordinate
    // tuning (snapping nodes onto the illustration's roots) changes the values
    // but must always round-trip through layoutForChild unchanged.
    const program = NODE_LAYOUT.Structure.children.Program
    expect(program).toBeDefined()
    expect(layoutForChild('Structure', 'Program', 0)).toEqual(program)
  })

  it('an unlisted child falls back to a deterministic, in-range position near its parent', () => {
    const a = layoutForChild('Structure', 'General', 0)
    const b = layoutForChild('Structure', 'General', 0)
    expect(a).toEqual(b) // deterministic given the same input

    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.x).toBeLessThanOrEqual(1)
    expect(a.y).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeLessThanOrEqual(1)
  })

  it('two unlisted children at different indices do not overlap the parent exactly', () => {
    const domain = NODE_LAYOUT.Structure
    const c0 = layoutForChild('Structure', 'General', 0)
    const c1 = layoutForChild('Structure', 'General', 1)
    expect(c0).not.toEqual({ x: domain.x, y: domain.y })
    expect(c1).not.toEqual({ x: domain.x, y: domain.y })
    expect(c0).not.toEqual(c1)
  })
})
