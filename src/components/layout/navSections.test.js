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
      'locations', 'anchors', 'electives', 'special-schedule-heading', 'events', 'specialdays',
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

  it('does not list import as a top-level row (Slice C: single state-aware entry point)', () => {
    expect(setupItems.some(i => i.key === 'import')).toBe(false)
  })

  it('does not mark Recurring Events optional — it is a strongly-expected anchor, not a nice-to-have', () => {
    const anchorsRow = setupItems[0].children.find(c => c.key === 'anchors')
    expect(anchorsRow).toBeTruthy()
    expect(anchorsRow.optional).toBeUndefined()
    expect(anchorsRow.expected).toBe(true)
  })
})

describe('NAV_SECTIONS schedule items — both routes stay distinct (ADR §3)', () => {
  const scheduleItems = NAV_SECTIONS.find(s => s.key === 'schedule').items

  it('lists both schedule routes as separate rows, plus the Special Schedules and Electives pickers after them', () => {
    const keys = scheduleItems.map(i => i.key)
    expect(keys).toEqual(['schedule:generated', 'schedule:manual', 'schedule:special', 'schedule:electives'])
  })

  it('does not collapse the two routes into one neutral entry', () => {
    expect(scheduleItems.some(i => i.key === 'schedule')).toBe(false)
  })
})

// docs/work/specs/2026-08-23-schedule-build-ia.md — the Schedule-side build
// entry for special days/events. Fixed row (never grows with data), no
// badge (resolved OQ1: "things you can optionally build" carry no urgency).
describe('NAV_SECTIONS schedule:special row (schedule-build-ia)', () => {
  const scheduleItems = NAV_SECTIONS.find(s => s.key === 'schedule').items
  const specialRow = scheduleItems.find(i => i.key === 'schedule:special')

  it('is present, labeled "Special Schedules", after Manual Build', () => {
    expect(specialRow).toBeTruthy()
    expect(specialRow.label).toBe('Special Schedules')
    expect(scheduleItems.indexOf(specialRow)).toBe(scheduleItems.length - 2)
  })

  it('carries no badge', () => {
    expect(specialRow.badgeKey).toBeUndefined()
  })
})

// docs/work/specs/2026-08-23-electives-gap.md — a SEPARATE sibling row to
// schedule:special, not folded into it (electives are core recurring
// structure, not an exception category). Fixed row, no badge, same posture.
describe('NAV_SECTIONS schedule:electives row (electives-gap)', () => {
  const scheduleItems = NAV_SECTIONS.find(s => s.key === 'schedule').items
  const electivesRow = scheduleItems.find(i => i.key === 'schedule:electives')

  it('is present, labeled "Elective Schedules" (distinct from Roots\'s "Electives" authoring row), as the last schedule row', () => {
    expect(electivesRow).toBeTruthy()
    expect(electivesRow.label).toBe('Elective Schedules')
    expect(scheduleItems.indexOf(electivesRow)).toBe(scheduleItems.length - 1)
  })

  it('carries no badge', () => {
    expect(electivesRow.badgeKey).toBeUndefined()
  })
})

describe('NAV_SECTIONS: no third "system" nav section', () => {
  it('only has setup and schedule sections', () => {
    expect(NAV_SECTIONS.map(s => s.key)).toEqual(['setup', 'schedule'])
  })
})

describe('Settings-gear item lists', () => {
  it('lists Camp, Re-import last year, Conflicts (with its badge key) and Trash', () => {
    const keys = ADMIN_MENU_ITEMS.map(i => i.key)
    expect(keys).toEqual(['camp', 'import', 'conflicts', 'trash'])
    const conflicts = ADMIN_MENU_ITEMS.find(i => i.key === 'conflicts')
    expect(conflicts.badgeKey).toBe('conflicts')
    const reimport = ADMIN_MENU_ITEMS.find(i => i.key === 'import')
    expect(reimport.label).toBe('Re-import last year')
  })

  it('gates LAN & Devices to admin-only items', () => {
    expect(ADMIN_ONLY_MENU_ITEMS.map(i => i.key)).toEqual(['devices'])
  })
})
