import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid.js'
import { extractEntities } from './extractEntities.js'
import { inferFixedEvents } from './fixedEvents.js'
import { derivePinOnlyActivityNames } from './pinOnlyActivityNames.js'

// F9 + strict OQ3 (ADR 2026-09-26 amendment): a weekly all-camp event that shares its name with an
// activity must reach every group, AND a name that is both stays ONE ambiguous name (one name_kind
// question, default activity), never a fixed event plus leftover activity cells.
const repro = fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/synthetic/repro/r8-weekly-event-shares-name-with-activity.txt'), 'utf8')

describe('r8: weekly Swim (Wednesday 09:00, all groups) that is also an activity Otters 1 runs on Thursday', () => {
  const parsed = parseTextGrid(repro)
  const result = inferFixedEvents({ pages: parsed.pages }, extractEntities(parsed), {})

  it('Swim is dual-use: Otters 1 Thursday is outside the event days', () => {
    expect(result.dualUseNames).toContain('Swim')
  })

  it('Swim is ambiguous (one question, default activity), not a kept fixed event', () => {
    expect(result.fixedEvents.filter((f) => f.name === 'Swim')).toEqual([])
    const swim = result.ambiguousEvents.filter((f) => f.name === 'Swim')
    expect(swim).toHaveLength(1)
  })

  it('answered "fixed": the event covers every group on Wednesday only', () => {
    const [swim] = result.ambiguousEvents.filter((f) => f.name === 'Swim')
    expect(swim.scope.is_all_groups).toBe(true)
    expect(swim.days).toEqual(['Wednesday'])
  })

  it('pass 1/2 does not claim Swim', () => {
    expect(derivePinOnlyActivityNames(result.fixedEvents, result.dualUseNames).has('Swim')).toBe(false)
  })
})
