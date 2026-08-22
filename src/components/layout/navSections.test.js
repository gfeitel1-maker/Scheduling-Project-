import { describe, it, expect } from 'vitest'
import { NAV_SECTIONS, ADMIN_MENU_ITEMS, ADMIN_ONLY_MENU_ITEMS } from './navSections'

// Roots-as-Hub Slice B (docs/adr/2026-08-22-roots-as-hub-setup-ia.md §2):
// the entity setup rows are Roots's own collapsible children, not flat
// siblings; Camp/Conflicts/Trash/LAN & Devices live in the Settings-gear
// item lists instead of a third nav section; both schedule routes stay
// distinct rows.
describe('NAV_SECTIONS setup items (Slice B)', () => {
  const setupItems = NAV_SECTIONS.find(s => s.key === 'setup').items

  it('lists roots as the first setup item, with the entity screens nested as its children', () => {
    expect(setupItems[0].key).toBe('roots')
    expect(Array.isArray(setupItems[0].children)).toBe(true)
    const childKeys = setupItems[0].children.map(c => c.key)
    expect(childKeys).toEqual([
      'tiers', 'groups', 'days', 'timeblocks', 'activities',
      'locations', 'anchors', 'specialdays',
    ])
  })

  it('does not list a readiness item', () => {
    expect(setupItems.some(i => i.key === 'readiness')).toBe(false)
  })

  it('keeps the entity rows off the top level — they only exist inside roots.children', () => {
    const topLevelKeys = setupItems.map(i => i.key)
    for (const entityKey of ['tiers', 'groups', 'days', 'timeblocks', 'activities']) {
      expect(topLevelKeys).not.toContain(entityKey)
    }
  })

  it('keeps import last year as a top-level row (Slice C consolidates it)', () => {
    expect(setupItems.some(i => i.key === 'import')).toBe(true)
  })
})

describe('NAV_SECTIONS schedule items — both routes stay distinct (ADR §3)', () => {
  const scheduleItems = NAV_SECTIONS.find(s => s.key === 'schedule').items

  it('lists both schedule routes as separate rows', () => {
    const keys = scheduleItems.map(i => i.key)
    expect(keys).toEqual(['schedule:generated', 'schedule:manual'])
  })

  it('does not collapse the two routes into one neutral entry', () => {
    expect(scheduleItems.some(i => i.key === 'schedule')).toBe(false)
  })
})

describe('NAV_SECTIONS: no third "system" nav section', () => {
  it('only has setup and schedule sections', () => {
    expect(NAV_SECTIONS.map(s => s.key)).toEqual(['setup', 'schedule'])
  })
})

describe('Settings-gear item lists', () => {
  it('lists Camp, Conflicts (with its badge key) and Trash', () => {
    const keys = ADMIN_MENU_ITEMS.map(i => i.key)
    expect(keys).toEqual(['camp', 'conflicts', 'trash'])
    const conflicts = ADMIN_MENU_ITEMS.find(i => i.key === 'conflicts')
    expect(conflicts.badgeKey).toBe('conflicts')
  })

  it('gates LAN & Devices to admin-only items', () => {
    expect(ADMIN_ONLY_MENU_ITEMS.map(i => i.key)).toEqual(['devices'])
  })
})
