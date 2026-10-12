import { describe, it, expect } from 'vitest'
import { solvableBundles } from './solvableBundles.js'

// T219 Red Hat #1: an import links every choice of a double-period elective, and the import's
// choices are POTENTIAL until the director confirms them. A bundle reaches the solve only when its
// choice is a confirmed offering of the set, so the solver never places campers on an unvouched choice.
describe('solvableBundles', () => {
  const offerings = [
    { elective_set_id: 's1', activity_id: 'pottery', status: 'confirmed' },
    { elective_set_id: 's1', activity_id: 'drama', status: 'potential' },
    { elective_set_id: 's1', activity_id: 'chess', status: null }, // hand-authored before v68: confirmed
  ]
  const bundles = [
    { id: 'b1', elective_set_id: 's1', activity_id: 'pottery' },
    { id: 'b2', elective_set_id: 's1', activity_id: 'drama' },
    { id: 'b3', elective_set_id: 's1', activity_id: 'chess' },
    { id: 'b4', elective_set_id: 's1', activity_id: 'gone' },
  ]
  const periods = bundles.map((b) => ({ id: `p-${b.id}`, bundle_id: b.id }))
  const tiers = bundles.map((b) => ({ id: `t-${b.id}`, bundle_id: b.id }))

  it('keeps only bundles whose choice is a confirmed offering, with their periods and tiers', () => {
    const out = solvableBundles({ bundles, bundlePeriods: periods, bundleTiers: tiers, offerings })
    expect(out.bundles.map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(out.bundlePeriods.map((p) => p.bundle_id)).toEqual(['b1', 'b3'])
    expect(out.bundleTiers.map((t) => t.bundle_id)).toEqual(['b1', 'b3'])
  })
})
