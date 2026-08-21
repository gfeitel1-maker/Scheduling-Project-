// T108 Phase 2 review round 2 (MED/HIGH #4) — guard test.
//
// The bug this closes: readiness.js's OPTIONAL_AREAS and
// rootMapNav.js's CHILD_SCREEN/DOMAIN_SCREEN each carried a 'dayoverrides'
// entry pointing at a screen key ('dayoverrides') that had no App.jsx SCREENS
// entry — DayOverridesScreen was removed, but the pointers to it were not.
// Clicking that destination silently fell back to whatever key sorts first
// in SCREENS (TiersScreen) instead of erroring, so nothing caught it until a
// director filed a "why did clicking Day Overrides open Age Divisions"
// report. This test makes that class of drift a build-time failure: every
// `screen` value named by a readiness area or a rootMap node must resolve to
// a real SCREENS entry, checked once here rather than trusted at every call
// site that introduces a new pointer.
import { describe, it, expect } from 'vitest'
import { SCREEN_KEYS as screenKeys } from './screenKeys'
import { REQUIRED_AREAS, OPTIONAL_AREAS, FORWARD_AREAS } from './engine/readiness'
import { DOMAIN_SCREEN, CHILD_SCREEN } from './components/reconciliation/rootMapNav'

describe('screen destinations exist (guard against a dangling nav/readiness pointer)', () => {
  it('every REQUIRED_AREAS screen key has a SCREENS entry', () => {
    for (const area of REQUIRED_AREAS) {
      expect(screenKeys.has(area.screen)).toBe(true)
    }
  })

  it('every OPTIONAL_AREAS screen key has a SCREENS entry', () => {
    for (const area of OPTIONAL_AREAS) {
      expect(screenKeys.has(area.screen)).toBe(true)
    }
  })

  it('every FORWARD_AREAS screen key is either null or has a SCREENS entry', () => {
    // FORWARD_AREAS (e.g. Staffing) can legitimately have no edit surface yet
    // — `screen: null` is a real, honest state, not a dangling pointer. Only
    // a NON-null value that fails to resolve is the bug.
    for (const area of FORWARD_AREAS) {
      if (area.screen === null) continue
      expect(screenKeys.has(area.screen)).toBe(true)
    }
  })

  it('every rootMapNav DOMAIN_SCREEN value is either null or has a SCREENS entry', () => {
    for (const screen of Object.values(DOMAIN_SCREEN)) {
      if (screen === null) continue
      expect(screenKeys.has(screen)).toBe(true)
    }
  })

  it('every rootMapNav CHILD_SCREEN value has a SCREENS entry', () => {
    for (const screen of Object.values(CHILD_SCREEN)) {
      expect(screenKeys.has(screen)).toBe(true)
    }
  })
})
