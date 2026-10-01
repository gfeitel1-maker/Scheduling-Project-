// Catches the "wide rename, lookup silently returns nothing" class (#696): a
// curated engine function's settings-object contract changes shape, but a call
// site still passes the OLD key name, which the function silently ignores
// (an unrecognized key in an object literal is not a syntax error).
//
// SOUNDNESS OVER COVERAGE: the registry is hand-maintained against the real
// source (see staleSettingsKey.js header). A call we cannot reason about
// safely — a spread, a computed key, a non-literal argument, OR a bare
// identifier that is not actually BOUND to the engine module by an import —
// must ABSTAIN, never guess. The last case matters because a BLOCKING check
// firing on a same-named LOCAL function (shadowing) would be a false
// positive, which is worse than missing a real rename (round-1 review).

import { describe, it, expect } from 'vitest'
import { scanStaleSettingsKeysInText, SETTINGS_CALLEE_REGISTRY } from './staleSettingsKey.js'

function check(source, path = 'fixture.js') {
  return scanStaleSettingsKeysInText(path, source)
}

describe('staleSettingsKey', () => {
  it('fires when the callee is imported from the engine module and a key is stale', () => {
    const src = `
      import { findRouteConflicts } from '../../src/engine/routeConflicts.js'
      findRouteConflicts({ slots, activities, oldAnchorName: x, events, locations })
    `
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('stale-settings-key')
    expect(findings[0].message).toContain('oldAnchorName')
    expect(findings[0].message).toContain('findRouteConflicts')
  })

  it('fires for a default-imported buildSchedule with a stale key', () => {
    const src = `
      import buildSchedule from '../../engine/buildSchedule.js'
      buildSchedule({ campId: c, bogusKey: 1 })
    `
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('bogusKey')
  })

  it('does not fire for the safe variant using only real keys', () => {
    const src = `
      import { findRouteConflicts } from '../../src/engine/routeConflicts.js'
      findRouteConflicts({ slots, activities, fixedEvents, electiveSetActivities, events, locations })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains on a spread property instead of guessing', () => {
    const src = `
      import buildSchedule from '../../engine/buildSchedule.js'
      buildSchedule({ ...inputs, campId: camp.id, preplacedSlots, weekId, bogusKey: 1 })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains on a computed key instead of guessing', () => {
    const src = `
      import buildSchedule from '../../engine/buildSchedule.js'
      buildSchedule({ [dynamicKey]: 1, campId: camp.id })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains when the argument is not an object literal', () => {
    const src = `
      import buildSchedule from '../../engine/buildSchedule.js'
      const settings = buildBadSettings()
      buildSchedule(settings)
    `
    expect(check(src)).toEqual([])
  })

  it('uses the union of both normalizeInput branches for buildSchedule', () => {
    const src = `
      import buildSchedule from '../../engine/buildSchedule.js'
      buildSchedule({ timeBlocks, tiers, groups, preplacedSlots, fixedEvents, campId, locations, electiveSetActivities, events, fixedEventsOnly, weekId, days, activities, cohorts })
    `
    expect(check(src)).toEqual([])
  })

  it('is a non-empty, hand-maintained registry naming both curated callees', () => {
    expect(Object.keys(SETTINGS_CALLEE_REGISTRY).sort()).toEqual(['buildSchedule', 'findRouteConflicts'])
  })

  // --- name-shadowing false-positive guard (round-1 review finding) --------

  it('abstains on a locally-declared function of the same name, even with a bad key', () => {
    const src = `
      function buildSchedule(opts) {
        return opts
      }
      buildSchedule({ anchors: 1 })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains when the name is imported from an unrelated module', () => {
    const src = `
      import { buildSchedule } from '../../some/other/unrelatedHelpers.js'
      buildSchedule({ anchors: 1 })
    `
    expect(check(src)).toEqual([])
  })

  it('abstains on a bare call with no import binding at all in the file', () => {
    const src = `
      buildSchedule({ anchors: 1 })
    `
    expect(check(src)).toEqual([])
  })
})
