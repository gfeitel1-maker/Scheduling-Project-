import { describe, it, expect } from 'vitest'
import { DOMAIN_OF, CHILD_OF, DOMAINS, DOMAIN_LABELS } from './domainRollup.js'
import { INGESTIBLE_ENTITIES } from '../../ingest/extractEntities.js'

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

// Context invariant (Slice 3, docs/adr/2026-08-19-roots-census-and-persistent-
// inspector.md §(g), accepted MEDIUM from Red Hat) — guards the exact
// regression the audit named: a future parser widening INGESTIBLE_ENTITIES
// to include, say, 'field_trips' as a spreadsheet-ingestible entity would
// silently re-phantom Context's "only-authored-in-app" identity. Context's
// realness in inspect mode comes ONLY from fetchCensusSnapshot's two
// non-CHILD_OF-keyed calls (existingSnapshot.js), never from an ingested
// entity — this test is the tripwire for that boundary eroding.
describe('domainRollup — Context invariant', () => {
  it('no INGESTIBLE_ENTITIES member ever maps to Context via DOMAIN_OF or CHILD_OF', () => {
    for (const entity of INGESTIBLE_ENTITIES) {
      expect(DOMAIN_OF[entity], `DOMAIN_OF.${entity}`).not.toBe('Context')
      expect(CHILD_OF[entity], `CHILD_OF.${entity}`).not.toBe('Context')
    }
  })

  it('Context has no DOMAIN_OF/CHILD_OF entry at all today, by design, while still being a real domain', () => {
    expect(Object.values(DOMAIN_OF)).not.toContain('Context')
    expect(Object.values(CHILD_OF)).not.toContain('Context')
    expect(DOMAINS).toContain('Context')
  })
})
