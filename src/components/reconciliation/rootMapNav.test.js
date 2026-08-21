import { describe, it, expect } from 'vitest'
import { DOMAIN_SCREEN, CHILD_SCREEN, SCREEN_LABEL, screenForNode } from './rootMapNav.js'

// App.jsx's SCREENS map (mirrored, not imported — App.jsx pulls in the whole
// screen component tree, which is far heavier than this pure-config test
// needs). Keep in sync with src/App.jsx's SCREENS keys.
// T108 Phase 2 review round 2 (MED/HIGH #4) — 'dayoverrides' removed:
// DayOverridesScreen no longer exists, and neither does any pointer to it
// (rootMapNav.js's CHILD_SCREEN/SCREEN_LABEL entries were removed alongside
// this). See screenDestinationsExist.test.js for the App.jsx-sourced version
// of this same guard.
const REAL_SCREEN_KEYS = new Set([
  'readiness', 'camp', 'import', 'roots', 'conflicts', 'trash',
  'cohorts', 'tiers', 'groups', 'days', 'timeblocks', 'activities',
  'locations', 'anchors', 'schedule',
  'schedule:manual', 'schedule:generated',
])

describe('rootMapNav — every nav target is a real screen', () => {
  it('every non-null DOMAIN_SCREEN value is a real SCREENS key', () => {
    for (const [domain, screen] of Object.entries(DOMAIN_SCREEN)) {
      if (screen === null) continue
      expect(REAL_SCREEN_KEYS.has(screen), `${domain} -> ${screen}`).toBe(true)
    }
  })

  it('every CHILD_SCREEN value is a real SCREENS key', () => {
    for (const [child, screen] of Object.entries(CHILD_SCREEN)) {
      expect(REAL_SCREEN_KEYS.has(screen), `${child} -> ${screen}`).toBe(true)
    }
  })

  it('every SCREEN_LABEL key is a real SCREENS key', () => {
    for (const screen of Object.keys(SCREEN_LABEL)) {
      expect(REAL_SCREEN_KEYS.has(screen), screen).toBe(true)
    }
  })

  it('screenForNode resolves child over domain when both exist', () => {
    expect(screenForNode('Structure', 'Program')).toBe('cohorts')
  })

  // W1 — vocabulary unification (docs/work/specs/2026-08-21-vocabulary-
  // unification-design.md). Pins the de-inversion: the cohorts node reads
  // "Program", the tiers node reads "Age Division", and "Units" no longer
  // maps to cohorts anywhere in the nav.
  it('maps the cohorts node to Program and the tiers node to Age Divisions (W1 de-inversion)', () => {
    expect(SCREEN_LABEL.cohorts).toBe('Program')
    expect(SCREEN_LABEL.tiers).toBe('Age Divisions')
    expect(CHILD_SCREEN['Program']).toBe('cohorts')
    expect(CHILD_SCREEN['Units']).toBeUndefined()
  })

  it('labels the groups screen "Groups", not "Groups & Units" (W1)', () => {
    expect(SCREEN_LABEL.groups).toBe('Groups')
  })

  it('screenForNode falls back to the domain screen when child has no entry', () => {
    expect(screenForNode('Structure', 'General')).toBe('groups')
  })

  it('screenForNode resolves domain-only selection', () => {
    expect(screenForNode('Scheduling', null)).toBe('activities')
  })

  it('screenForNode returns null for Context (no edit surface)', () => {
    expect(screenForNode('Context', null)).toBe(null)
  })

  // ── Context wiring (Slice 3, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md §(g)) ──

  it('Field Trips / Special Events resolves to the schedule (manual default) — inspect-mode-only child', () => {
    expect(screenForNode('Context', 'Field Trips / Special Events')).toBe('schedule:manual')
  })

  // T108 Phase 2 review round 2 (MED/HIGH #4) — the 'Day Overrides' node no
  // longer exists (rootMapModel.js), so it must not resolve to anything;
  // an unmapped child falls back to the domain screen (Context -> null),
  // same as any other unrecognized child key.
  it('Day Overrides (removed node/mapping) falls back to Context\'s null domain screen, not a dangling pointer', () => {
    expect(screenForNode('Context', 'Day Overrides')).toBe(null)
  })
})
