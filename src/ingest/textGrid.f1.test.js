import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'

// T36 F1 — a block that stacks TWO activity rows with no blank line between
// them has its second row read as the LOCATION of the first.
//
// That is right almost always: a camp prints the room under the activity. It is
// wrong when the second row is another thing happening. Owner's ruling,
// 2026-09-13:
//
//   "if something says art on line 1 and art studio on line 2, chances are art
//    studio is the place. if it is swim and swim return it isn't a place but a
//    thing happening. so i'd rather us almost not infer but just flag that this
//    isn't knowable from the way it is written"
//
// So this does NOT re-decide the strip — the reading stays exactly as it was,
// which keeps every current camp parsing identically. What changes is that when
// the document itself contradicts the reading, the director is told.
//
// The evidence is whole-document, not typographic: a text filed as a place on
// one row, which ALSO appears as an activity cell somewhere else, is a thing
// the camp does. "Art Studio" never appears as an activity. "Swim Return" does,
// if the camp schedules it.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')

describe('parseTextGrid — a trailing row that might be an activity (T36 F1)', () => {
  it('flags a stacked row whose text is scheduled elsewhere as an activity', () => {
    const text = `Bunk 1
          Monday       Tuesday      Wednesday
9:15      Swim         Art          Dance
          Swim Return  Swim Return  Swim Return

10:00     Swim Return  Dance        Art
`
    const { ambiguousLocations } = parseTextGrid(text)
    expect(ambiguousLocations.map((a) => a.text)).toContain('Swim Return')
  })

  it('does NOT flag an ordinary room printed under its activity', () => {
    // "Art Studio" is filed as a place and appears nowhere as an activity.
    // Flagging it would make the box noise on every normal camp.
    const text = `Bunk 1
          Monday       Tuesday      Wednesday
9:15      Art          Swim         Dance
          Art Studio   Art Studio   Art Studio

10:00     Dance        Art          Swim
`
    expect(parseTextGrid(text).ambiguousLocations).toEqual([])
  })

  it('leaves the reading itself alone — this is a report, not a re-decision', () => {
    const text = `Bunk 1
          Monday       Tuesday      Wednesday
9:15      Swim         Art          Dance
          Swim Return  Swim Return  Swim Return

10:00     Swim Return  Dance        Art
`
    const { pages } = parseTextGrid(text)
    // Still filed as a location on its row, exactly as before — the flag is
    // additive, so no current camp's parse moves.
    const withLoc = pages[0].rows.find((r) => (r.locations ?? []).length > 0)
    expect(withLoc).toBeTruthy()
  })

  it('says nothing on the real corpus', () => {
    // Every current-corpus period is one activity plus one location, so a flag
    // here would be a false alarm on a camp that imports correctly today.
    for (const f of ['campA-bunk-schedules.txt', 'campB-by-day.txt', 'campC-daysheet-synthetic.txt']) {
      const { ambiguousLocations } = parseTextGrid(fs.readFileSync(path.join(SAMPLES, f), 'utf8'))
      expect(ambiguousLocations).toEqual([])
    }
  })

  it('never throws, and always returns an array', () => {
    expect(parseTextGrid('').ambiguousLocations).toEqual([])
    expect(parseTextGrid(null).ambiguousLocations).toEqual([])
  })
})
