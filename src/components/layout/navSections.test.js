import { describe, it, expect } from 'vitest'
import { NAV_SECTIONS } from './navSections'

// Roots-as-dashboard plan, Task 3: Setup Readiness is retired (its verdict
// now lives on the Roots banner). Roots is the first setup item — the home
// a director lands on and returns to.
describe('NAV_SECTIONS setup items (plan T3)', () => {
  const setupItems = NAV_SECTIONS.find(s => s.key === 'setup').items

  it('does not list a readiness item', () => {
    expect(setupItems.some(i => i.key === 'readiness')).toBe(false)
  })

  it('lists roots as the first setup item', () => {
    expect(setupItems[0].key).toBe('roots')
  })
})
