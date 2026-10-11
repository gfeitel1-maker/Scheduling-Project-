import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'

// F8: a cell wrapped over two lines, where the continuation line reaches half or more of the columns,
// was read as a second value row, splitting "Arts and / Crafts" into two activities.
const repro = (name) => fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/synthetic/repro', name), 'utf8')

describe('a wrap that fills half or more of the columns is one cell', () => {
  it('r3: "Arts and / Crafts" on 3 of 5 days joins', () => {
    const page = parseTextGrid(repro('r3-wrap-in-half-the-columns.txt')).pages[0]
    const row = page.rows.find((r) => r.label.startsWith('09:00'))
    expect(row.cells).toEqual(['Arts and Crafts', 'Music', 'Arts and Crafts', 'Drama', 'Arts and Crafts'])
    expect(page.rows).toHaveLength(2)
  })

  it('r4: "Closing / Ceremony" wrapped in every column joins', () => {
    const page = parseTextGrid(repro('r4-event-wraps-in-every-column.txt')).pages[0]
    const row = page.rows.find((r) => r.label.startsWith('10:00'))
    expect(row.cells).toEqual(['Closing Ceremony', 'Closing Ceremony', 'Closing Ceremony'])
  })
})

describe('the join does not swallow a separate row (plants)', () => {
  const header = '   Time           Monday     Tuesday    Wednesday'
  const page = (...body) => parseTextGrid([header, '', ...body].join('\n')).pages[0].rows
  // Swim and Archery each also print as whole cells elsewhere on the page, so they are complete names.
  const known = [
    '09:00-09:45       Swim       Swim       Swim', '',
    '10:00-10:45       Archery    Archery    Archery', '',
  ]

  it('a second line reaching a column the first lacks stays its own row', () => {
    const rows = page(
      '09:00-09:45       Swim       Swim',
      '                  Archery    Archery    Archery',
    )
    expect(rows.flatMap((r) => r.cells)).not.toContain('Swim Archery')
  })

  it('a time-labelled nested row stays its own row', () => {
    const rows = page(
      '09:00-09:45       Swim       Swim       Swim',
      '10:00-10:45       Archery    Archery    Archery',
    )
    expect(rows).toHaveLength(2)
  })

  it('equal-columns stacked activities stay two rows', () => {
    const rows = page(...known, '11:00-11:45       Swim       Swim       Swim', '                  Archery    Archery    Archery')
    expect(rows.flatMap((r) => r.cells)).not.toContain('Swim Archery')
    expect(rows).toHaveLength(4)
  })

  it('a room row under an activity on a labelled page is not welded onto the name', () => {
    const rows = page(...known, '11:00-11:45       Swim       Swim       Swim', '                  Pool       Pool       Pool')
    expect(rows.flatMap((r) => r.cells)).not.toContain('Swim Pool')
  })
})
