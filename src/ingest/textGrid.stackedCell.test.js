import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'

// I6 — campB prints "All Camp Activity" as two full-width lines with the time
// label (and CIT's one-line "CIT Block 3") on the line between them.
const campB = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt'), 'utf8')

describe('campB stacked "All Camp / Activity" cell', () => {
  const parsed = parseTextGrid(campB)
  const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, extractEntities(parsed), {})

  it('reads the two lines as one cell for the 13 groups, CIT keeps its own', () => {
    for (const day of ['Tuesday', 'Thursday']) {
      const page = parsed.pages.find((p) => p.title.startsWith(day))
      const row = page.rows.find((r) => r.label === '02:25-03:15')
      expect(row.cells.slice(0, 13).every((c) => c === 'All Camp Activity')).toBe(true)
      expect(row.cells[13]).toBe('CIT Block 3')
      expect(row.locations).toBeUndefined()
    }
  })

  it('never produces "Activity" or "All Camp" on its own', () => {
    const names = fixedEvents.map((f) => f.name)
    expect(names).not.toContain('Activity')
    expect(names).not.toContain('All Camp')
    const entities = JSON.stringify(extractEntities(parsed))
    expect(entities).not.toMatch(/"Activity"/)
  })

  it('"All Camp Activity" is ONE fixed event at 02:25-03:15 on Tue and Thu for 13 groups', () => {
    const events = fixedEvents.filter((f) => f.name === 'All Camp Activity')
    expect(events.length).toBeGreaterThan(0)
    const slots = JSON.stringify(events)
    expect(slots).toMatch(/Tuesday/)
    expect(slots).toMatch(/Thursday/)
    expect(slots).not.toMatch(/CIT"/)
  })
})

describe('genuine two-row layout stays two', () => {
  const lines = campB.split(/\r?\n/)
  const tail = lines.findIndex((l) => /^\s+Activity(\s+Activity){12}/.test(l))
  const cells = (edited) => {
    const out = [...lines]
    edited(out)
    const page = parseTextGrid(out.join('\n')).pages.find((p) => p.title.startsWith('Tuesday'))
    return page.rows.filter((r) => r.label.startsWith('02:25')).map((r) => r.cells)
  }

  it('control: the unedited layout joins', () => {
    expect(cells(() => {})).toEqual([Array(13).fill('All Camp Activity').concat('CIT Block 3')])
  })

  it('two different events at one time label stay two when the time stands alone between them', () => {
    const rows = cells((out) => {
      out[tail] = out[tail].replace(/Activity/g, 'Swim    ')
      out[tail - 1] = out[tail - 1].replace('CIT Block 3', '           ')
    })
    expect(rows.flat()).not.toContain('All Camp Swim')
    expect(rows.flat()).toContain('All Camp')
    expect(rows.flat()).toContain('Swim')
  })
})
