// parseGridScheduleMenu — T195 offering-grid import. The offering sheet's
// cell is a MENU (multiple activity names sharing one day/period), not one
// name per cell like parseGridSchedule's events consumer. Reuses the exact
// same orientation/time/canonicalization logic (see parseGridSchedule.js's
// detectGrid/buildAxesAndCells) — only the innermost per-cell step differs.
//
// The delimiter convention and linkage glyph set are UNVERIFIED assumptions
// (the real artifact is outside this repo and off-limits) — this file tests
// the SEAM (an injectable, swappable cellSplitter), not the convention.
import { describe, it, expect } from 'vitest'
import { parseGridScheduleMenu } from './parseGridSchedule'

function page(overrides = {}) {
  return {
    title: 'Electives',
    columns: ['Bunk A', 'Bunk B'],
    rows: [
      { label: '9:00-9:45', cells: ['Swim\nArchery\nArt', 'Zumba\nSwim'] },
      { label: '9:50-10:35', cells: ['Archery', ''] },
    ],
    ...overrides,
  }
}

describe('parseGridScheduleMenu — orientation and axes (unchanged from parseGridSchedule)', () => {
  it('detects rows-are-time exactly as the single-name parser does', () => {
    const result = parseGridScheduleMenu([page()])
    expect(result.orientation).toEqual({ axis: 'rows-are-time', confident: true })
    expect(result.timeAxis).toHaveLength(2)
    expect(result.groupAxis).toEqual([
      { name: 'Bunk A', sourceLabel: 'Bunk A', sourceIndex: 0 },
      { name: 'Bunk B', sourceLabel: 'Bunk B', sourceIndex: 1 },
    ])
  })

  it('refuses (empty result) when orientation is not confident, same as parseGridSchedule', () => {
    const notTime = page({ rows: [{ label: 'Row A', cells: ['x', 'y'] }], columns: ['Col A', 'Col B'] })
    const result = parseGridScheduleMenu([notTime])
    expect(result.orientation).toEqual({ axis: null, confident: false })
    expect(result.cells).toEqual([])
  })
})

describe('parseGridScheduleMenu — cell is a menu of names', () => {
  it('splits a multi-name cell into multiple cell entries sharing timeIndex/groupIndex', () => {
    const result = parseGridScheduleMenu([page()])
    const firstCellEntries = result.cells.filter((c) => c.timeIndex === 0 && c.groupIndex === 0)
    expect(firstCellEntries.map((c) => c.activityName).sort()).toEqual(['Archery', 'Art', 'Swim'])
    expect(new Set(firstCellEntries.map((c) => c.groupIndex))).toEqual(new Set([0]))
    expect(new Set(firstCellEntries.map((c) => c.timeIndex))).toEqual(new Set([0]))
  })

  it('a single-name cell still produces exactly one entry', () => {
    const result = parseGridScheduleMenu([page()])
    const entries = result.cells.filter((c) => c.timeIndex === 1 && c.groupIndex === 0)
    expect(entries).toEqual([{ timeIndex: 1, groupIndex: 0, activityName: 'Archery', locationName: null }])
  })

  it('a blank cell contributes nothing', () => {
    const result = parseGridScheduleMenu([page()])
    expect(result.cells.some((c) => c.timeIndex === 1 && c.groupIndex === 1)).toBe(false)
  })

  it('accepts a custom cellSplitter — the injected, swappable seam for an unverified delimiter convention', () => {
    const customPage = page({ rows: [{ label: '9:00-9:45', cells: ['Swim | Archery', ''] }] })
    const pipeSplitter = (raw) => String(raw ?? '').split('|').map((s) => s.trim()).filter(Boolean)
    const result = parseGridScheduleMenu([customPage], { cellSplitter: pipeSplitter })
    const entries = result.cells.filter((c) => c.timeIndex === 0 && c.groupIndex === 0)
    expect(entries.map((c) => c.activityName).sort()).toEqual(['Archery', 'Swim'])
  })

  it('default cellSplitter is newline/semicolon-aware', () => {
    const customPage = page({ rows: [{ label: '9:00-9:45', cells: ['Swim; Archery', ''] }] })
    const result = parseGridScheduleMenu([customPage])
    const entries = result.cells.filter((c) => c.timeIndex === 0 && c.groupIndex === 0)
    expect(entries.map((c) => c.activityName).sort()).toEqual(['Archery', 'Swim'])
  })
})

describe('parseGridScheduleMenu — linkage markers, surfaced never applied', () => {
  it('detects a known glyph on a name, strips it before matching, and reports it in linkageMarkers', () => {
    const customPage = page({ rows: [{ label: '9:00-9:45', cells: ['Swim*\nArchery', ''] }] })
    const result = parseGridScheduleMenu([customPage])

    const entries = result.cells.filter((c) => c.timeIndex === 0 && c.groupIndex === 0)
    expect(entries.map((c) => c.activityName).sort()).toEqual(['Archery', 'Swim'])

    expect(result.linkageMarkers).toEqual([
      { dayIndex: 0, periodIndex: 0, activityName: 'Swim', markerType: 'asterisk', sourceExcerpt: 'Swim*' },
    ])
  })

  it('a cell with no glyph produces no linkage marker', () => {
    const result = parseGridScheduleMenu([page()])
    expect(result.linkageMarkers).toEqual([])
  })

  it('never mutates cells, timeAxis, or groupAxis based on a detected marker', () => {
    const customPage = page({ rows: [{ label: '9:00-9:45', cells: ['Swim*', ''] }] })
    const result = parseGridScheduleMenu([customPage])
    // No span_blocks/is_span_head-like field anywhere on the cell shape.
    expect(result.cells[0]).toEqual({ timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null })
  })
})

describe('parseGridScheduleMenu — reuses canonicalization', () => {
  it('folds a whitespace/case typo-variant onto the dominant spelling, same as parseGridSchedule', () => {
    const customPage = page({
      rows: [
        { label: '9:00-9:45', cells: ['Lunch 2', ''] },
        { label: '9:50-10:35', cells: ['lunch2', ''] },
        { label: '10:40-11:25', cells: ['Lunch 2', ''] },
      ],
      columns: ['Bunk A', 'Bunk B'],
    })
    const result = parseGridScheduleMenu([customPage])
    const names = new Set(result.cells.filter((c) => c.groupIndex === 0).map((c) => c.activityName))
    expect(names.size).toBe(1)
  })
})
