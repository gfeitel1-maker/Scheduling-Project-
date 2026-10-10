// Audit E1 (2026-10-10) — the offerings Import must recognise a CAMPER PREFERENCE
// sheet handed to it, so it can route the director to Import Camper Preferences
// instead of answering "Couldn't read that file."
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isCamperPreferenceWorkbook } from './preferenceImport.js'

const fixture = path.resolve(__dirname, '../../docs/work/specs/samples/fabricated-camper-preferences-100.csv')
const fixtureRows = fs.readFileSync(fixture, 'utf8').trim().split('\n').map((l) => l.split(','))

describe('isCamperPreferenceWorkbook (audit E1)', () => {
  it('recognises the audit fixture (Camper ID / Camper Name / Division / #1..#10)', () => {
    expect(isCamperPreferenceWorkbook([{ name: 'Sheet1', rows: fixtureRows }])).toBe(true)
  })

  it('recognises one on a second tab', () => {
    expect(isCamperPreferenceWorkbook([
      { name: 'Notes', rows: [['read me'], ['nothing here']] },
      { name: 'Prefs', rows: fixtureRows },
    ])).toBe(true)
  })

  it('does not claim an offerings grid (day x period) or a plain activity list', () => {
    const grid = [['', 'Monday', 'Tuesday'], ['Period 1', 'Archery', 'Drama'], ['Period 2', 'Art', 'Swim']]
    const list = [['Activity', 'Capacity'], ['Archery', '12'], ['Drama', '10']]
    expect(isCamperPreferenceWorkbook([{ name: 'Grid', rows: grid }])).toBe(false)
    expect(isCamperPreferenceWorkbook([{ name: 'List', rows: list }])).toBe(false)
  })

  it('a header with no camper rows under it is not a preference sheet', () => {
    expect(isCamperPreferenceWorkbook([{ name: 'S', rows: [fixtureRows[0]] }])).toBe(false)
  })

  it('tolerates nothing', () => {
    expect(isCamperPreferenceWorkbook()).toBe(false)
    expect(isCamperPreferenceWorkbook([])).toBe(false)
  })
})
