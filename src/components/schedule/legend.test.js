import { describe, it, expect } from 'vitest'
import { LEGEND_ENTRIES, FLAG_COLORS, FLAG_SEVERITY, ANCHOR_COLOR } from './slotCellConstants'

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
    expect(labels).toContain('Fixed event')
    expect(labels).toContain('Locked')
    expect(labels).toContain('Unavailable')
  })

  it('renders the fixed-event entry in the anchor token, never an activity colour', () => {
    const anchor = LEGEND_ENTRIES.find(e => e.label === 'Fixed event')
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
