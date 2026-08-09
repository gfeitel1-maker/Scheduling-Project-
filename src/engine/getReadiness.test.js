import { describe, it, expect } from 'vitest'
import {
  getReadiness,
  describeReadiness,
  getSetupGaps,
  ALL_CATEGORIES,
  FORWARD_AREAS,
  REQUIRED_AREAS,
} from './readiness'

// ADR docs/adr/2026-08-08-s5-readiness-six-state-model.md.
//
// The six-state layer is strictly additive over getSetupGaps. These tests fence
// the two load-bearing guarantees: Missing == getSetupGaps membership (red only
// for the five required areas), and forward categories (Location/Staffing) can
// never reach Missing. The blocking core's own fence lives in readiness.test.js
// and must stay byte-identical.

const FULL = {
  cohorts: [{ id: 'c1' }],
  tiers: [{ id: 't1' }],
  groups: [{ id: 'g1' }],
  days: [{ id: 'd1' }],
  timeBlocks: [{ id: 'b1' }],
  activities: [{ id: 'a1' }],
}

const stateOf = (readiness, key) => readiness.find((r) => r.key === key)?.state

describe('getReadiness: the six-state layer', () => {
  it('marks every required area Missing on an empty camp, optionals Optional, forward Optional', () => {
    const r = getReadiness({})
    for (const area of REQUIRED_AREAS) expect(stateOf(r, area.key)).toBe('missing')
    expect(stateOf(r, 'anchors')).toBe('optional')
    expect(stateOf(r, 'dayoverrides')).toBe('optional')
    expect(stateOf(r, 'location')).toBe('optional')
    expect(stateOf(r, 'staffing')).toBe('optional')
  })

  it('marks required areas Ready once every backing collection has rows', () => {
    const r = getReadiness(FULL)
    for (const area of REQUIRED_AREAS) expect(stateOf(r, area.key)).toBe('ready')
  })

  it('marks an optional area Ready when it has rows', () => {
    const r = getReadiness({ ...FULL, anchors: [{ id: 'e1' }] })
    expect(stateOf(r, 'anchors')).toBe('ready')
  })

  // The load-bearing identity: red is exactly the set getSetupGaps blocks on.
  it('the Missing set is identical to getSetupGaps membership', () => {
    for (const input of [{}, undefined, FULL, { ...FULL, days: [], activities: [] }, { ...FULL, tiers: [] }]) {
      const missing = getReadiness(input).filter((c) => c.state === 'missing').map((c) => c.key)
      const gaps = getSetupGaps(input).map((g) => g.key)
      expect(missing).toEqual(gaps)
    }
  })

  it('never lets a non-required category reach Missing, whatever it is handed', () => {
    for (const input of [{}, undefined, FULL]) {
      for (const cat of getReadiness(input)) {
        if (cat.kind !== 'required') expect(cat.state).not.toBe('missing')
      }
    }
  })

  it('keeps Location and Staffing structurally unable to be Missing', () => {
    for (const key of FORWARD_AREAS.map((a) => a.key)) {
      // even with no data and an attention signal, forward areas never go red
      const r = getReadiness({}, { attention: { [key]: 5 } })
      expect(stateOf(r, key)).not.toBe('missing')
      expect(stateOf(r, key)).toBe('optional')
    }
    // REQUIRED_AREAS never grows to include a forward key.
    const requiredKeys = new Set(REQUIRED_AREAS.map((a) => a.key))
    for (const key of FORWARD_AREAS.map((a) => a.key)) expect(requiredKeys.has(key)).toBe(false)
  })
})

describe('getReadiness: signals drive Needs-attention and In-progress', () => {
  it('marks a category Needs-attention when signals report review items', () => {
    const r = getReadiness(FULL, { attention: { activities: 3 } })
    expect(stateOf(r, 'activities')).toBe('needs-attention')
  })

  it('marks a category In-progress when a plan is staged', () => {
    const r = getReadiness(FULL, { inProgress: { groups: true } })
    expect(stateOf(r, 'groups')).toBe('in-progress')
  })

  it('marks a category Not-applicable when the camp declares it', () => {
    const r = getReadiness(FULL, { notApplicable: { staffing: true } })
    expect(stateOf(r, 'staffing')).toBe('not-applicable')
  })

  it('lets In-progress override an otherwise-Missing required area', () => {
    const r = getReadiness({}, { inProgress: { activities: true } })
    expect(stateOf(r, 'activities')).toBe('in-progress')
  })

  it('degrades to the binary truth with no signals — only Ready/Missing/Optional', () => {
    const seen = new Set(getReadiness({ ...FULL, activities: [] }).map((c) => c.state))
    for (const state of seen) expect(['ready', 'missing', 'optional']).toContain(state)
  })

  it('never produces Needs-attention for an empty required area (Missing wins first)', () => {
    const r = getReadiness({}, { attention: { activities: 9 } })
    expect(stateOf(r, 'activities')).toBe('missing')
  })
})

describe('describeReadiness: blocking first, quiet attention second, no percentage', () => {
  it('leads with the blocking sentence, identical to describeSetupGaps', () => {
    const { blocking } = describeReadiness(getReadiness({ ...FULL, activities: [] }))
    expect(blocking).toBe('One thing still needed before you can build a week: Activities.')
  })

  it('reports Ready when nothing blocks', () => {
    const { blocking, attention } = describeReadiness(getReadiness(FULL))
    expect(blocking).toBe('Ready to build a week.')
    expect(attention).toBeNull()
  })

  it('counts Needs-attention and In-progress categories in the quiet second line', () => {
    const { attention } = describeReadiness(
      getReadiness(FULL, { attention: { activities: 2 }, inProgress: { groups: true } }),
    )
    expect(attention).toBe('2 items could use your attention.')
  })

  it('never contains a percentage or a fraction', () => {
    const { blocking, attention } = describeReadiness(
      getReadiness({ ...FULL, days: [] }, { attention: { activities: 1 } }),
    )
    expect(`${blocking} ${attention}`).not.toMatch(/%|\d+\s*\/\s*\d+/)
  })
})

describe('ALL_CATEGORIES: the stable spine', () => {
  it('lists required (setup order), then optional, then forward', () => {
    expect(ALL_CATEGORIES.map((c) => c.key)).toEqual([
      'tiers', 'groups', 'days', 'timeblocks', 'activities',
      'anchors', 'dayoverrides',
      'location', 'staffing',
    ])
  })
})
