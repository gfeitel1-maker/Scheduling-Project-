import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import { isScheduleShaped } from './scheduleShape'

// T146 — the schedule import path (ImportScreen -> workbookToPages ->
// extractEntities) must decline a workbook that never had a day or time axis,
// instead of extracting one-character residual "activities" out of it (a
// campus-map template's grid coordinates and legend keys).
//
// Positive fixtures are the SAME real-camp samples extractEntities.test.js
// already pins (docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2,
// §7) — one camp's day-columns layout, one camp's day-per-page layout — so
// this gate cannot be tightened into rejecting real corpus input.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const campA = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8'))
const campB = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-by-day.txt'), 'utf8'))
// Every real sample in the corpus is a positive, not just two. A false reject
// blocks a real camp's real file, which is far worse than a false accept, so
// this list should grow with the corpus rather than sampling it.
const campC = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campC-daysheet-synthetic.txt'), 'utf8'))

// The shape a campus-map/legend workbook produces once it survives
// sheetToPage: a "Legend" sheet's header row and body rows are grid
// coordinates and single-character keys, not days or times.
// (Shoresh-Campus-Map-Template.xlsx: sheets Read me | Campus Map | Legend.)
const mapWorkbookPages = [
  { title: 'Read me', columns: ['Notes'], rows: [{ label: '1', cells: ['See Legend tab for symbols'] }] },
  {
    title: 'Campus Map',
    columns: ['1', '2', '3', '4', '5'],
    rows: [
      { label: 'A', cells: ['L', 'L', '7', '7', 'M'] },
      { label: 'B', cells: ['3', '3', '12', '6', 'S'] },
      { label: 'C', cells: ['11', '4', '5', '8', '9'] },
    ],
  },
  {
    title: 'Legend',
    columns: ['Meaning'],
    rows: [
      { label: 'L', cells: ['Lake'] },
      { label: 'M', cells: ['Mess Hall'] },
      { label: 'S', cells: ['Sports Field'] },
    ],
  },
]

describe('isScheduleShaped (T146)', () => {
  it('declines a campus-map/legend workbook — no day or time axis anywhere', () => {
    expect(isScheduleShaped(mapWorkbookPages)).toBe(false)
  })

  it('accepts campA (day columns, time-of-day row labels)', () => {
    expect(isScheduleShaped(campA.pages)).toBe(true)
  })

  it('accepts campB (day-per-page titles, time-of-day row labels)', () => {
    expect(isScheduleShaped(campB.pages)).toBe(true)
  })

  it('accepts campC (daysheet layout)', () => {
    expect(isScheduleShaped(campC.pages)).toBe(true)
  })

  it('declines an empty page list', () => {
    expect(isScheduleShaped([])).toBe(false)
  })

  it('accepts a page whose columns are mostly day names even with odd row labels', () => {
    expect(isScheduleShaped([
      { title: 'Bunk 1', columns: ['Monday', 'Tuesday', 'Wednesday'], rows: [{ label: 'x', cells: ['Swim', 'Art', 'Swim'] }] },
    ])).toBe(true)
  })

  it('accepts a page whose title names a day even with non-day columns', () => {
    expect(isScheduleShaped([
      { title: 'Monday — All Camp', columns: ['Beavers', 'Badgers'], rows: [{ label: '9:00-9:20', cells: ['Swim', 'Art'] }] },
    ])).toBe(true)
  })
})
