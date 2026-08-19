import { describe, it, expect } from 'vitest'
import { DOMAIN_SCREEN, CHILD_SCREEN, SCREEN_LABEL, screenForNode } from './rootMapNav.js'

// App.jsx's SCREENS map (mirrored, not imported — App.jsx pulls in the whole
// screen component tree, which is far heavier than this pure-config test
// needs). Keep in sync with src/App.jsx's SCREENS keys.
const REAL_SCREEN_KEYS = new Set([
  'readiness', 'camp', 'import', 'conflicts', 'trash',
  'cohorts', 'tiers', 'groups', 'days', 'timeblocks', 'activities',
  'locations', 'anchors', 'dayoverrides', 'schedule',
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
    expect(screenForNode('Structure', 'Units')).toBe('cohorts')
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
})
