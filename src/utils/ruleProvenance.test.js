import { describe, it, expect } from 'vitest'
import {
  RULE_FIELDS,
  tierForField,
  worstTier,
  deriveActivityProvenance,
  TIER_LABEL,
  TIER_DOT_COLOR,
  tierShapeStyle,
  tierForCapacitySource,
} from './ruleProvenance.js'

describe('tierForField', () => {
  it('is confirmed when source is null (hand-created, never imported)', () => {
    expect(tierForField(null, null)).toBe('confirmed')
  })

  it('is confirmed when source is human, regardless of any evidence tag', () => {
    expect(tierForField('human', 'inferred')).toBe('confirmed')
  })

  it('is observed when source is import and evidence tag is observed', () => {
    expect(tierForField('import', 'observed')).toBe('observed')
  })

  it('is inferred when source is import and evidence tag is inferred', () => {
    expect(tierForField('import', 'inferred')).toBe('inferred')
  })

  it('is inferred when source is import and evidence tag is unknown', () => {
    expect(tierForField('import', 'unknown')).toBe('inferred')
  })

  it('is inferred (no detail) when source is import but there is no evidence row at all', () => {
    expect(tierForField('import', null)).toBe('inferred')
  })
})

describe('worstTier', () => {
  it('returns null for an empty list', () => {
    expect(worstTier([])).toBe(null)
  })

  it('picks inferred over observed and confirmed', () => {
    expect(worstTier(['confirmed', 'observed', 'inferred'])).toBe('inferred')
  })

  it('picks observed over confirmed when nothing is inferred', () => {
    expect(worstTier(['confirmed', 'observed'])).toBe('observed')
  })

  it('is confirmed only when everything is confirmed', () => {
    expect(worstTier(['confirmed', 'confirmed'])).toBe('confirmed')
  })
})

describe('deriveActivityProvenance', () => {
  it('covers exactly the 3 scoped rule fields (min/max-per-week, eligible groups, location)', () => {
    const rows = deriveActivityProvenance({}, {})
    expect(rows.map((r) => r.key)).toEqual(['min_per_week', 'eligible_group_ids', 'location_id'])
  })

  it('derives each row tier from its own field sources + evidence', () => {
    const fieldSources = { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: 'human', location_id: 'import' }
    const evidenceByField = {
      min_per_week: { tag: 'inferred', confidence: 'low', support: {} },
      location: { tag: 'observed', confidence: 'high', support: { location: 'Pool Deck' } },
    }
    const rows = deriveActivityProvenance(fieldSources, evidenceByField)
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey.min_per_week.tier).toBe('inferred')
    expect(byKey.eligible_group_ids.tier).toBe('confirmed')
    expect(byKey.location_id.tier).toBe('observed')
  })

  it('has no evidence row on a field with no import_evidence, so it renders as a plain confirmed/inferred row without a support sentence', () => {
    const fieldSources = { min_per_week: null, max_per_week: null, eligible_group_ids: null, location_id: null }
    const rows = deriveActivityProvenance(fieldSources, {})
    expect(rows.every((r) => r.evidence === null)).toBe(true)
    expect(rows.every((r) => r.tier === 'confirmed')).toBe(true)
  })
})

// T119 (locations capacity provenance, mirroring Activities' pattern) — the
// tier vocabulary is shared across both screens so the color/shape/label
// meaning of "confirmed"/"observed"/"inferred" can never drift between them.
describe('shared tier vocabulary (TIER_LABEL, TIER_DOT_COLOR, tierShapeStyle)', () => {
  it('has a label for every tier', () => {
    expect(TIER_LABEL).toEqual({ confirmed: 'Confirmed', observed: 'Observed', inferred: 'Inferred' })
  })

  it('has a dot color for every tier', () => {
    expect(Object.keys(TIER_DOT_COLOR).sort()).toEqual(['confirmed', 'inferred', 'observed'])
  })

  it('gives confirmed a plain filled dot', () => {
    expect(tierShapeStyle('confirmed')).toEqual({ background: TIER_DOT_COLOR.confirmed, border: 'none', boxShadow: 'none' })
  })

  it('gives observed a ring (no fill) so it is distinguishable by shape, not just hue', () => {
    const style = tierShapeStyle('observed')
    expect(style.background).toBe('transparent')
    expect(style.border).toContain(TIER_DOT_COLOR.observed)
  })

  it('gives inferred a filled dot with a surface gap ring', () => {
    const style = tierShapeStyle('inferred')
    expect(style.background).toBe(TIER_DOT_COLOR.inferred)
    expect(style.boxShadow).toContain(TIER_DOT_COLOR.inferred)
  })
})

// T119 — locationCapacityProvenanceHandler (electron/main.js) returns a
// binary 'confirmed'|'unconfirmed' (capacity has no import_evidence record,
// unlike the activity rule fields, so there is no separate 'observed' case).
// This maps that binary onto the shared 3-tier vocabulary for the dot/popover.
describe('tierForCapacitySource', () => {
  it('maps confirmed to confirmed', () => {
    expect(tierForCapacitySource('confirmed')).toBe('confirmed')
  })

  it('maps unconfirmed to inferred', () => {
    expect(tierForCapacitySource('unconfirmed')).toBe('inferred')
  })

  it('defaults missing/unknown values to confirmed (no data means nothing to flag)', () => {
    expect(tierForCapacitySource(undefined)).toBe('confirmed')
    expect(tierForCapacitySource(null)).toBe('confirmed')
  })
})
