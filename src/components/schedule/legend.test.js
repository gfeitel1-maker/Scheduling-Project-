import { describe, it, expect } from 'vitest'
import { LEGEND_ENTRIES, FLAG_COLORS, FLAG_SEVERITY, ANCHOR_COLOR, legendEntriesFor, activityColor, ACTIVITY_COLORS, assignActivityColors, setActivityPalette } from './slotCellConstants'

// The legend's job is to leave nothing on the grid unexplained. The original
// defect was structural, not cosmetic: the legend was rendered by iterating
// FLAG_COLORS, so it could only ever document per-slot flags, and the three
// non-flag treatments a director sees were invisible to it by construction.
//
// These tests hold the line in both directions — a new flag cannot ship
// undocumented, and the legend cannot drift into describing states that the
// grid does not actually render.

describe('grid legend', () => {
  it('documents every per-slot flag the engine can emit', () => {
    const documented = LEGEND_ENTRIES.map(e => e.flagKey).filter(Boolean)
    for (const flag of Object.keys(FLAG_COLORS)) {
      expect(documented).toContain(flag)
    }
  })

  it('uses the same colour token for a flag as the grid cell does', () => {
    for (const entry of LEGEND_ENTRIES) {
      if (!entry.flagKey) continue
      expect(entry.color).toBe(FLAG_COLORS[entry.flagKey])
    }
  })

  it('documents the structural treatments that are not flags', () => {
    const labels = LEGEND_ENTRIES.map(e => e.label)
    // DESIGN_STANDARD.md §4: "The grid legend must document anchor separately
    // from the activity key."
    expect(labels).toContain('Recurring event')
    expect(labels).toContain('Locked')
    expect(labels).toContain('Unavailable')
  })

  it('renders the fixed-event entry in the anchor token, never an activity colour', () => {
    const anchor = LEGEND_ENTRIES.find(e => e.label === 'Recurring event')
    expect(anchor.color).toBe(ANCHOR_COLOR)
  })

  it('distinguishes flags from structural chrome by shape, not colour alone', () => {
    const flags = LEGEND_ENTRIES.filter(e => e.flagKey)
    const structural = LEGEND_ENTRIES.filter(e => !e.flagKey)
    expect(flags.every(e => e.shape === 'dot')).toBe(true)
    expect(structural.every(e => e.shape !== 'dot')).toBe(true)
  })

  it('gives every entry director-facing language, not an enum key', () => {
    for (const entry of LEGEND_ENTRIES) {
      expect(entry.label).toBeTruthy()
      expect(entry.label).not.toMatch(/^[A-Z_]+$/)
      expect(entry.description).toBeTruthy()
    }
  })

  it('does not document aggregate findings as if they were slot states', () => {
    // UNDERSERVED and DISTRIBUTION are findings surfaced in the stat tiles, not
    // per-slot treatments — putting them in the grid legend would promise a cell
    // treatment that does not exist.
    const labels = LEGEND_ENTRIES.map(e => e.label.toLowerCase())
    expect(FLAG_SEVERITY.UNDERSERVED).toBeDefined()
    expect(labels).not.toContain('underserved')
    expect(labels).not.toContain('distribution')
  })
})

// The routes share a flag VOCABULARY, not an identical flag SET. A director
// learns "Overlapping" once and it means the same thing wherever it appears —
// but "Unfillable" must never appear on the manual grid, where an empty cell
// is simply not filled yet, and "Overlapping" must not appear on the
// generated grid, where the engine never makes a clashing placement.
describe('route-aware legend', () => {
  it('omits Unfillable on the manual route', () => {
    const labels = legendEntriesFor('manual').map(e => e.label)
    expect(labels).not.toContain('Unfillable')
    expect(labels).toContain('Overlapping')
  })

  it('omits Overlapping on the generated route', () => {
    const labels = legendEntriesFor('generated').map(e => e.label)
    expect(labels).toContain('Unfillable')
    expect(labels).not.toContain('Overlapping')
  })

  it('documents "Closed this week" on BOTH routes (WEEK_CLOSED is route-agnostic)', () => {
    // A closed-week placement is equally wrong on either route, so the marker —
    // and its legend entry — appears on both, unlike the route-specific
    // Unfillable / Overlapping pair.
    expect(legendEntriesFor('manual').map(e => e.label)).toContain('Closed this week')
    expect(legendEntriesFor('generated').map(e => e.label)).toContain('Closed this week')
  })

  it('documents every structural treatment on both routes', () => {
    for (const route of ['manual', 'generated']) {
      const labels = legendEntriesFor(route).map(e => e.label)
      expect(labels).toContain('Locked')
      expect(labels).toContain('Recurring event')
      expect(labels).toContain('Unavailable')
    }
  })

  it('uses the same word for the same meaning in both directions', () => {
    const manual = legendEntriesFor('manual')
    const generated = legendEntriesFor('generated')
    const shared = manual.filter(m => generated.some(g => g.label === m.label))
    for (const entry of shared) {
      const twin = generated.find(g => g.label === entry.label)
      expect(twin.description).toBe(entry.description)
      expect(twin.color).toBe(entry.color)
    }
  })
})

// T17 (historical). `activityColor()` hashes whatever it is handed, so the SEED
// matters: feeding it an array index gives a different colour from feeding it
// the activity's id. The grid keys off the stable id (ScheduleScreen's actMap),
// and three now-removed displaced-item construction sites used to attach a
// `colorIdx` derived from activities.findIndex(...) instead. Nothing ever read
// it, so no colours actually diverged, but the field encoded the wrong
// convention. The construction sites and their tray are gone (dead
// `displacedItems` plumbing removed alongside the drag-FSM gesture-correlation
// fix); this test still guards the one colour convention `activityColor()` must
// keep.
describe('T17: one colour convention, keyed on the activity id', () => {
  it('gives the same colour for the same activity id, and a different one for an index', () => {
    const id = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890'
    expect(activityColor(id)).toBe(activityColor(id))
    // The bug's shape: index 3 and the id of the 4th activity are unrelated seeds.
    expect(activityColor(id)).not.toBe(activityColor(3))
  })

  it('always returns a colour from the published palette', () => {
    for (const seed of ['x', 0, 3, 'a1b2c3d4-5e6f', 'Copy of Archery']) {
      expect(ACTIVITY_COLORS).toContain(activityColor(seed))
    }
  })
})

// T18 (colours). Found on a real camp: with only FOUR activities, three of them
// hashed to the same palette entry, so the dot distinguished one activity out of
// four. The palette was never the problem — the assignment was.
describe('T18: activity colours are assigned, not merely hashed', () => {
  const acts = (...ids) => ids.map(id => ({ id }))

  it('gives every activity a distinct colour while the palette has room', () => {
    // The exact ids from the camp that exposed this: basketball, flag football
    // and swim all preferred #3F6690 under the bare hash.
    const real = acts(
      '3d1f7a52-2c9a-4a1e-9a3e-1f4b6c8d0e21',
      '7b2e9c14-5f6d-4c88-b0a1-2e3f4a5b6c7d',
      'c4a8e0d2-9b13-4f57-8e6a-0d1c2b3a4958',
      'f0e1d2c3-b4a5-4968-8776-655443322110',
    )
    const assigned = assignActivityColors(real)
    expect(new Set([...assigned.values()]).size).toBe(real.length)
  })

  it('is independent of the order the activities arrive in', () => {
    const ids = acts('aaa-1', 'bbb-2', 'ccc-3', 'ddd-4')
    const forward = assignActivityColors(ids)
    const backward = assignActivityColors([...ids].reverse())
    for (const { id } of ids) expect(backward.get(id)).toBe(forward.get(id))
  })

  it('degrades to the hash preference once the palette is exhausted', () => {
    // Past six, collisions are unavoidable by pigeonhole — the name carries the
    // identity from there, and colour is supplementary.
    const many = acts(...Array.from({ length: 12 }, (_, i) => `activity-${i}`))
    const assigned = assignActivityColors(many)
    expect(assigned.size).toBe(12)
    for (const c of assigned.values()) expect(ACTIVITY_COLORS).toContain(c)
    expect(new Set([...assigned.values()]).size).toBe(ACTIVITY_COLORS.length)
  })

  it('makes every surface agree once the assignment is registered', () => {
    // The registry exists so the grid, the palettes, the edit modal and the
    // displaced chips cannot disagree — the divergence T17 was filed about.
    const list = acts('zzz-1', 'zzz-2', 'zzz-3', 'zzz-4')
    setActivityPalette(list)
    const assigned = assignActivityColors(list)
    for (const { id } of list) expect(activityColor(id)).toBe(assigned.get(id))
    setActivityPalette([]) // leave no module state behind for other tests
  })

  it('still returns a stable palette colour with no assignment registered', () => {
    setActivityPalette([])
    expect(ACTIVITY_COLORS).toContain(activityColor('unregistered-id'))
    expect(activityColor('unregistered-id')).toBe(activityColor('unregistered-id'))
  })
})
