import { describe, it, expect } from 'vitest'
import { NAV_SECTIONS, ROOTS_ITEM, ADMIN_MENU_ITEMS, ADMIN_ONLY_MENU_ITEMS } from './navSections'

// Lifecycle IA (docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 3,
// docs/work/specs/2026-08-28-lifecycle-ia-program.md §3): Roots is a fixed,
// chevron-less top row, no longer a section with nested children; the former
// setup/schedule two-section model is replaced by three collapsible stages —
// Germination / Sprouts / Plants.
describe('ROOTS_ITEM — fixed top row, no children, no fold state', () => {
  it('is a plain nav item with no `children` and no `optional`/`expected`/`area` mark', () => {
    expect(ROOTS_ITEM.key).toBe('roots')
    expect(ROOTS_ITEM.children).toBeUndefined()
    expect(ROOTS_ITEM.area).toBeUndefined()
  })
})

describe('NAV_SECTIONS: the five-stage grouping (germination/sprouts/plants; Roots is separate)', () => {
  it('only has germination, sprouts and plants — no setup/schedule/system section, and Roots is not one of them', () => {
    expect(NAV_SECTIONS.map(s => s.key)).toEqual(['germination', 'sprouts', 'plants'])
  })
})

describe('NAV_SECTIONS germination items', () => {
  const items = NAV_SECTIONS.find(s => s.key === 'germination').items

  it('lists Age Divisions/Groups/Days/Time Blocks/Locations, flat (no nesting)', () => {
    expect(items.map(i => i.key)).toEqual(['tiers', 'groups', 'days', 'timeblocks', 'locations'])
    for (const item of items) expect(item.children).toBeUndefined()
  })

  it('marks Locations optional, and the rest required', () => {
    const locations = items.find(i => i.key === 'locations')
    expect(locations.optional).toBe(true)
    for (const key of ['tiers', 'groups', 'days', 'timeblocks']) {
      const item = items.find(i => i.key === key)
      expect(item.optional).toBeUndefined()
    }
  })
})

describe('NAV_SECTIONS sprouts items', () => {
  const items = NAV_SECTIONS.find(s => s.key === 'sprouts').items

  it('lists Activities, Fixed Events and Recurring Events as two separate rows', () => {
    const keys = items.map(i => i.key)
    expect(keys).toContain('activities')
    expect(keys).toContain('fixedevents')
    expect(keys).toContain('anchors')
    expect(items.find(i => i.key === 'fixedevents').label).toBe('Fixed Events')
    expect(items.find(i => i.key === 'anchors').label).toBe('Recurring Events')
  })

  it('does not mark Fixed Events/Recurring Events optional — both are strongly-expected, not nice-to-haves', () => {
    for (const key of ['fixedevents', 'anchors']) {
      const item = items.find(i => i.key === key)
      expect(item.optional).toBeUndefined()
      expect(item.expected).toBe(true)
    }
  })

  it('lists Electives, then a quiet "Special Events" heading, then Events and Special Days', () => {
    const keys = items.map(i => i.key)
    const electivesIdx = keys.indexOf('electives')
    const headingIdx = keys.findIndex(k => k === 'special-events-heading')
    const eventsIdx = keys.indexOf('events')
    const specialDaysIdx = keys.indexOf('specialdays')
    expect(electivesIdx).toBeGreaterThan(-1)
    expect(headingIdx).toBeGreaterThan(electivesIdx)
    expect(eventsIdx).toBeGreaterThan(headingIdx)
    expect(specialDaysIdx).toBeGreaterThan(eventsIdx)
    const heading = items.find(i => i.key === 'special-events-heading')
    expect(heading.heading).toBe('Special Events')
  })
})

describe('NAV_SECTIONS plants items — both schedule routes stay distinct (ADR §3)', () => {
  const items = NAV_SECTIONS.find(s => s.key === 'plants').items

  it('lists both schedule routes as separate rows, plus the Special Schedules and Electives pickers after them', () => {
    const keys = items.map(i => i.key)
    expect(keys).toEqual(['schedule:generated', 'schedule:manual', 'schedule:special', 'schedule:electives'])
  })

  it('does not collapse the two routes into one neutral entry', () => {
    expect(items.some(i => i.key === 'schedule')).toBe(false)
  })

  it('carries the Special Schedules and Elective Schedules rows with no badge', () => {
    const special = items.find(i => i.key === 'schedule:special')
    const electives = items.find(i => i.key === 'schedule:electives')
    expect(special.label).toBe('Special Schedules')
    expect(special.badgeKey).toBeUndefined()
    expect(electives.label).toBe('Elective Schedules')
    expect(electives.badgeKey).toBeUndefined()
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
