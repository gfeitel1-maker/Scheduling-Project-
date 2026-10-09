import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'

// Packaged audit #13 — campB-by-day staggers lunch as "Lunch 1".."Lunch 5".
// Lunch 1-3 recur and clear arm 1/2; Lunch 4 and Lunch 5 appear on one day
// only, so neither arm admitted them and they fell through to the activity
// pass. A numbered sibling of an admitted event is the same event family.
describe('numbered siblings of an admitted fixed event', () => {
  const parsed = parseTextGrid(fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8'))
  const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, extractEntities(parsed), {})
  const names = new Set(fixedEvents.map((f) => f.name))

  it('admits every Lunch N as a fixed event', () => {
    for (const n of ['Lunch 1', 'Lunch 2', 'Lunch 3', 'Lunch 4', 'Lunch 5']) expect(names.has(n)).toBe(true)
  })

  it('a sibling-admitted event is low confidence, so the director is asked', () => {
    const lunch4 = fixedEvents.filter((f) => f.name === 'Lunch 4')
    expect(lunch4.length).toBeGreaterThan(0)
    expect(lunch4.every((f) => f.confidence === 'low' && f.support.basis === 'sibling')).toBe(true)
  })

  it('a non-numbered one-off activity is still not admitted', () => {
    expect(names.has('Archery')).toBe(false)
  })
})
