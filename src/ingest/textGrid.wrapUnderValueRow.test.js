// F5 follow-up (b): on a labelled by-group page a two-word activity that wraps
// onto a second line under only some of the day columns ("Wilderness" over
// "Skills" on Monday and Wednesday of four days) is ONE cell, not a second row
// with the same period. With 4 columns, 2 filled reached isValueRow's floor, so
// "Skills" became its own row: the activity was imported as "Wilderness" and
// "Skills", and the 3-block span was never seen.
import { describe, it, expect } from 'vitest'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferTextSpans } from './textSpans.js'

const page = (title) => `              ${title} Schedule

   Time           Monday       Tuesday        Wednesday      Thursday

09:00–09:15       Check In     Check In       Check In       Check In

09:15–09:45       Wilderness   Kayaking       Wilderness     Archery
                  Skills                      Skills

09:45–10:15       Wilderness   Knitting       Wilderness     Pottery
                  Skills                      Skills

10:15–10:45       Wilderness   Lanyard        Wilderness     Tennis
                  Skills                      Skills

10:45–11:15       Gaga Pit     Soccer         Nature Walk    Drama

11:15–11:45       Check Out    Check Out      Check Out      Check Out
`
const text = [page('Group A'), page('Group B')].join('\n\n')

describe('textGrid: a wrap under some columns of a labelled page joins the cell above', () => {
  it('reads "Wilderness Skills" as one cell, one row per period', () => {
    const parsed = parseTextGrid(text)
    const rows = parsed.pages[0].rows
    expect(rows.map((r) => r.label)).toEqual(['09:00-09:15', '09:15-09:45', '09:45-10:15', '10:15-10:45', '10:45-11:15', '11:15-11:45'])
    expect(rows[1].cells).toEqual(['Wilderness Skills', 'Kayaking', 'Wilderness Skills', 'Archery'])
  })

  it('the activity is "Wilderness Skills" and is a 3-block span', () => {
    const parsed = parseTextGrid(text)
    const proposal = extractEntities(parsed)
    expect(proposal.entities.activities).toContain('Wilderness Skills')
    expect(proposal.entities.activities).not.toContain('Skills')
    const { spans } = inferTextSpans(parsed, proposal)
    expect(spans.get('wilderness skills')).toMatchObject({ span_blocks: 3, form: 'repeat' })
  })
})
