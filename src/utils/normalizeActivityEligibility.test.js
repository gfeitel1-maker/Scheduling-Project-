import { describe, it, expect } from 'vitest'
import { normalizeActivityEligibility, parseIdList } from './normalizeActivityEligibility'

// activities.eligible_tier_ids / eligible_group_ids are stored as JSON-
// stringified arrays (or NULL for "no restriction"), never real arrays —
// same class of read-boundary bug as normalizeSlots.js. '[]' is a 2-char
// truthy STRING: unnormalized, `'[]'.length === 2` and `.includes()` does a
// substring search, so the "no restrictions" case (which should always be
// eligible) always evaluated ineligible. Fixtures here are DB-shaped JSON
// strings, not JS arrays — an array fixture would pass without this fix.
describe('normalizeActivityEligibility — eligible_tier_ids / eligible_group_ids JSON columns', () => {
  it('parses a DB-shaped "[]" string into a real empty array', () => {
    const row = normalizeActivityEligibility({ id: 'act-1', eligible_tier_ids: '[]', eligible_group_ids: '[]' })
    expect(row.eligible_tier_ids).toEqual([])
    expect(row.eligible_group_ids).toEqual([])
  })

  it('parses populated JSON-string arrays into real arrays', () => {
    const row = normalizeActivityEligibility({ id: 'act-1', eligible_tier_ids: '["t1","t2"]', eligible_group_ids: '["g1"]' })
    expect(row.eligible_tier_ids).toEqual(['t1', 't2'])
    expect(row.eligible_group_ids).toEqual(['g1'])
  })

  it('defaults NULL and undefined to an empty array', () => {
    const row = normalizeActivityEligibility({ id: 'act-1', eligible_tier_ids: null, eligible_group_ids: undefined })
    expect(row.eligible_tier_ids).toEqual([])
    expect(row.eligible_group_ids).toEqual([])
  })

  it('falls back to an empty array for malformed JSON instead of throwing', () => {
    const row = normalizeActivityEligibility({ id: 'act-1', eligible_tier_ids: '{not valid json', eligible_group_ids: '[]' })
    expect(row.eligible_tier_ids).toEqual([])
  })

  it('leaves an already-parsed array unchanged (idempotent for in-memory/optimistic state)', () => {
    const row = normalizeActivityEligibility({ id: 'act-1', eligible_tier_ids: ['t1'], eligible_group_ids: [] })
    expect(row.eligible_tier_ids).toEqual(['t1'])
    expect(row.eligible_group_ids).toEqual([])
  })

  it('parseIdList is exported standalone (used directly where only one field needs parsing)', () => {
    expect(parseIdList('["a"]')).toEqual(['a'])
    expect(parseIdList('[]')).toEqual([])
    expect(parseIdList(null)).toEqual([])
  })
})
