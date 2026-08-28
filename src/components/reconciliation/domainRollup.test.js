import { describe, it, expect } from 'vitest'
import { DOMAIN_OF, CHILD_OF, DOMAINS, DOMAIN_LABELS, understoodRosterByDomain } from './domainRollup.js'

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

// Census tiles are the interface (docs/adr/2026-08-27-roots-hub-tiles-are-
// interface.md §4) — the Understood tile reads roster rows directly instead
// of decisionIds, so a rooted row with no decision id is still visible.
describe('understoodRosterByDomain', () => {
  function model() {
    return {
      domains: [
        {
          key: 'Structure',
          children: [
            {
              key: 'Groups',
              roster: [
                { entityId: 'g1', name: 'Bogrim', state: 'understood', decisionId: null, group: null },
                { entityId: 'g2', name: 'Amitim', state: 'attention', decisionId: 'd1', group: null },
              ],
            },
            {
              key: 'Program',
              roster: [
                { entityId: 'p1', name: 'Summer 2026', state: 'understood', decisionId: 'd2', group: null },
              ],
            },
          ],
        },
        {
          key: 'Facility',
          children: [
            { key: 'Locations', roster: [{ entityId: 'l1', name: 'Pool', state: 'changed', decisionId: 'd3', group: null }] },
          ],
        },
      ],
    }
  }

  it('groups only understood roster rows by domain, across children within a domain', () => {
    const result = understoodRosterByDomain(model())
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe('Structure')
    expect(result[0].roster.map((r) => r.name).sort()).toEqual(['Bogrim', 'Summer 2026'])
  })

  it('includes a rooted row with no decision id — the fix for the latent decisionIds gap', () => {
    const result = understoodRosterByDomain(model())
    const bogrim = result[0].roster.find((r) => r.name === 'Bogrim')
    expect(bogrim).toBeTruthy()
    expect(bogrim.decisionId).toBeNull()
  })

  it('omits a domain with zero understood rows rather than rendering an empty bucket', () => {
    const result = understoodRosterByDomain(model())
    expect(result.find((d) => d.key === 'Facility')).toBeUndefined()
  })

  it('returns an empty array when nothing is understood anywhere', () => {
    const m = { domains: [{ key: 'Structure', children: [{ key: 'Groups', roster: [{ entityId: 'g1', name: 'X', state: 'attention', decisionId: 'd1', group: null }] }] }] }
    expect(understoodRosterByDomain(m)).toEqual([])
  })
})
