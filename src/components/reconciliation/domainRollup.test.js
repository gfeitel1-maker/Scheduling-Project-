import { describe, it, expect } from 'vitest'
import { DOMAIN_OF, CHILD_OF, DOMAINS, DOMAIN_LABELS } from './domainRollup.js'

// W1 — vocabulary unification (docs/work/specs/2026-08-21-vocabulary-
// unification-design.md). The root-map used to call cohorts "Units" —
// exactly the inverse of the rest of the app, which calls tiers "Unit".
// Program is now the only word for cohorts anywhere. "Resources" is retired;
// the Facility domain shows its own name "Facility" (like every other domain
// shows its own — Structure, Time, …) so it does not duplicate the "Locations"
// entity node beneath it (the location word lives on the entity, not the domain).
describe('domainRollup — W1 vocabulary unification', () => {
  it('maps the cohorts child node to Program, not Units', () => {
    expect(CHILD_OF.cohorts).toBe('Program')
    expect(Object.values(CHILD_OF)).not.toContain('Units')
  })

  it('labels the Facility domain "Facility", not "Resources" (and not a second location label)', () => {
    expect(DOMAIN_LABELS.Facility).toBe('Facility')
    expect(Object.values(DOMAIN_LABELS)).not.toContain('Resources')
  })
})

// Regroup slice (owner decision 2026-08-24) — the 'Context' domain is gone.
// Events/Special Days/Electives are now ordinary Scheduling children.
describe('domainRollup — Context removed / Scheduling regroup', () => {
  it('has exactly four domains, no Context', () => {
    expect(DOMAINS).toEqual(['Structure', 'Scheduling', 'Time', 'Facility'])
    expect(DOMAINS).not.toContain('Context')
    expect(Object.values(DOMAIN_LABELS)).not.toContain('Context')
  })

  it('maps events, special_days, and elective_sets to Scheduling', () => {
    expect(DOMAIN_OF.events).toBe('Scheduling')
    expect(DOMAIN_OF.special_days).toBe('Scheduling')
    expect(DOMAIN_OF.elective_sets).toBe('Scheduling')
  })

  it('gives events, special_days, and elective_sets their own child nodes', () => {
    expect(CHILD_OF.events).toBe('Events')
    expect(CHILD_OF.special_days).toBe('Special Days')
    expect(CHILD_OF.elective_sets).toBe('Electives')
  })
})
