import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'

// F7: on a day sheet that prints a room under each activity, a period where only ONE column has a room
// (the others are room-less events) leaves a narrow line that was read as the tail of the activity name
// ("Pottery Loft"). The page's other periods print full room lines, which says the narrow line is a room too.
const repro = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/synthetic/repro/r5-daysheet-room-under-one-column.txt'), 'utf8')

describe('a lone room line on a page that prints rooms is a location', () => {
  const parsed = parseTextGrid(repro)

  it('r5: "Pottery" keeps "Loft" as its location', () => {
    const row = parsed.pages[0].rows.find((r) => r.label.startsWith('09:30'))
    expect(row.cells[0]).toBe('Pottery')
    expect(row.locations).toEqual(['Loft', '', '', ''])
  })

  it('r5: no activity named "Pottery Loft"', () => {
    const { entities } = extractEntities(parsed)
    expect(entities.activities).toContain('Pottery')
    expect(entities.activities).not.toContain('Pottery Loft')
  })
})

describe('a wrap stays a wrap (plants)', () => {
  const HDR = '                  Monday                 Tuesday                Wednesday'
  const page = (...body) => parseTextGrid(['', HDR, ...body].join('\n')).pages[0].rows

  it('page with no room lines: "Instructional" over "Swim" joins', () => {
    const rows = page('09:30 AM', '             Instructional             Pottery', '             Swim', '10:10 AM')
    expect(rows[0].cells[0]).toBe('Instructional Swim')
  })

  it('page with rooms: an "Instructional" over "Swim" wrap with no room stays a name when Swim is an activity elsewhere', () => {
    const rows = page(
      '09:30 AM', '             Swim                    Sailing                Drama', '             Pool                    Lake                   Hall', '10:10 AM', '',
      '10:20 AM', '             Instructional           Sailing                Drama', '             Swim', '11:00 AM',
    )
    expect(rows[1].cells[0]).toBe('Instructional Swim')
  })

  it('page with rooms: a wrap followed by its room line still joins', () => {
    const rows = page(
      '09:30 AM', '             Pottery                 Sailing                Drama', '             Loft                    Lake                   Hall', '10:10 AM', '',
      '10:20 AM', '             Instructional           Sailing                Drama', '             Swim', '             Pool                    Lake                   Hall', '11:00 AM',
    )
    expect(rows[1].cells[0]).toBe('Instructional Swim')
    expect(rows[1].locations[0]).toBe('Pool')
  })
})
