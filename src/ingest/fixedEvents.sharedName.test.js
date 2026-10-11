import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'

// F9: a weekly all-camp event that shares its name with an activity must still reach every group,
// including one that also runs the same-named activity at that block on another day.
const repro = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/synthetic/repro/r8-weekly-event-shares-name-with-activity.txt'), 'utf8')

describe('r8: weekly Swim (Wednesday 09:00, all groups) that is also an activity Otters 1 runs on Thursday', () => {
  const parsed = parseTextGrid(repro)
  const { fixedEvents } = inferFixedEvents({ pages: parsed.pages }, extractEntities(parsed), {})

  it('every group holds the Wednesday Swim event', () => {
    const wed = fixedEvents.filter((f) => f.name === 'Swim' && f.days.includes('Wednesday'))
    expect(wed).toHaveLength(1)
    expect(wed[0].scope.is_all_groups).toBe(true)
    expect(wed[0].days).toEqual(['Wednesday'])
  })

  it('the Thursday Swim Otters 1 runs stays an activity', () => {
    expect(fixedEvents.filter((f) => f.name === 'Swim' && f.days.includes('Thursday'))).toEqual([])
  })
})
