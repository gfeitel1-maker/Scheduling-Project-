// Catches the "wide rename, lookup silently returns nothing" class (#696): a
// curated engine function's settings-object contract changes shape, but a call
// site still passes the OLD key name, which the function silently ignores
// (an unrecognized key in an object literal is not a syntax error).
//
// SOUNDNESS OVER COVERAGE: the registry is hand-maintained against the real
// source (see staleSettingsKey.js header). A call we cannot reason about
// safely — a spread, a computed key, a non-literal argument — must ABSTAIN,
// never guess.

import { describe, it, expect } from 'vitest'
import { scanStaleSettingsKeysInText, SETTINGS_CALLEE_REGISTRY } from './staleSettingsKey.js'

function check(source, path = 'fixture.js') {
  return scanStaleSettingsKeysInText(path, source)
}

describe('staleSettingsKey', () => {
  it('fires when a call site passes a key the callee does not read', () => {
    const src = `
      findRouteConflicts({ slots, activities, oldAnchorName: x, events, locations })
    `
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('stale-settings-key')
    expect(findings[0].message).toContain('oldAnchorName')
    expect(findings[0].message).toContain('findRouteConflicts')
  })

  it('does not fire for the safe variant using only real keys', () => {
    const src = `
      findRouteConflicts({ slots, activities, fixedEvents, electiveSetActivities, events, locations })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains on a spread property instead of guessing', () => {
    const src = `
      buildSchedule({ ...inputs, campId: camp.id, preplacedSlots, weekId, bogusKey: 1 })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains on a computed key instead of guessing', () => {
    const src = `
      buildSchedule({ [dynamicKey]: 1, campId: camp.id })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains when the argument is not an object literal', () => {
    const src = `
      const settings = buildBadSettings()
      buildSchedule(settings)
    `
    expect(check(src)).toEqual([])
  })

  it('uses the union of both normalizeInput branches for buildSchedule', () => {
    const src = `
      buildSchedule({ timeBlocks, tiers, groups, preplacedSlots, fixedEvents, campId, locations, electiveSetActivities, events, fixedEventsOnly, weekId, days, activities, cohorts })
    `
    expect(check(src)).toEqual([])
  })

  it('is a non-empty, hand-maintained registry naming both curated callees', () => {
    expect(Object.keys(SETTINGS_CALLEE_REGISTRY).sort()).toEqual(['buildSchedule', 'findRouteConflicts'])
  })
})
