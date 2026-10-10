import { describe, it, expect } from 'vitest'
import {
  RULE_FIELDS,
  tierForField,
  worstTier,
  deriveActivityProvenance,
  TIER_LABEL,
  needsLook,
  NEEDS_LOOK_DOT_STYLE,
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
  // Slice D scoped this to 3 fields because those were the only ones ingest
  // wrote evidence for. T114's follow-up added the 4th: co-schedule now infers
  // max_groups_per_slot/same_tier_only AND records why, so it earns a row here.
  // This list stays a deliberate tripwire — a field appears only once ingest
  // genuinely writes import_evidence for it, never to fill out the popover.
  it('covers exactly the 4 rule fields ingest writes evidence for', () => {
    const rows = deriveActivityProvenance({}, {})
    expect(rows.map((r) => r.key)).toEqual([
      'min_per_week', 'eligible_group_ids', 'location_id', 'max_groups_per_slot',
    ])
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
describe('shared tier vocabulary (TIER_LABEL, needsLook, NEEDS_LOOK_DOT_STYLE)', () => {
  it('has a label for every tier', () => {
    expect(TIER_LABEL).toEqual({ confirmed: 'Confirmed', observed: 'Observed', inferred: 'Inferred' })
  })

  // Owner ruling 2026-10-09 (K5): two visible states, not three.
  it('marks only an inferred field; confirmed and observed are unmarked', () => {
    expect(needsLook('inferred')).toBe(true)
    expect(needsLook('observed')).toBe(false)
    expect(needsLook('confirmed')).toBe(false)
  })

  it('the one mark is a plain bronze dot', () => {
    expect(NEEDS_LOOK_DOT_STYLE).toEqual({ background: 'var(--accent)', border: 'none', boxShadow: 'none' })
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

// Audit E4 (2026-10-10) — one field's needs-a-look state, for surfaces that show a
// single rule field (the elective offerings table's "Open to").
import { fieldNeedsLook } from './ruleProvenance.js'

describe('fieldNeedsLook (audit E4)', () => {
  const ev = { eligible_group_names: { tag: 'inferred' } }
  it('marks an import-written, inferred eligibility', () => {
    expect(fieldNeedsLook('eligible_group_ids', { eligible_group_ids: 'import' }, ev)).toBe(true)
  })
  it('clears once the director has written the field (confirm or edit)', () => {
    expect(fieldNeedsLook('eligible_group_ids', { eligible_group_ids: 'human' }, ev)).toBe(false)
    expect(fieldNeedsLook('eligible_group_ids', { eligible_group_ids: null }, ev)).toBe(false)
  })
  it('does not mark a value the file stated outright (observed)', () => {
    expect(fieldNeedsLook('eligible_group_ids', { eligible_group_ids: 'import' }, { eligible_group_names: { tag: 'observed' } })).toBe(false)
  })
  it('does not mark a hand-made activity with no history', () => {
    expect(fieldNeedsLook('eligible_group_ids', {}, {})).toBe(false)
  })
})
