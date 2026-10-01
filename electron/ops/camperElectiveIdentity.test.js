// The precedence table for "which tier is this camper in", pinned as a table
// because every row of it has been a defect somewhere: #670's roster-fill, the
// roster silently overriding a sheet, and a bundle choice bound from the wrong
// tier.
import { describe, it, expect } from 'vitest'
import { makeCamperIdentityResolver } from './camperElectiveIdentity.js'
import { deriveCamperId } from './electiveDerivedIds.js'

const TIERS = [{ id: 'tier-older', name: 'Older' }, { id: 'tier-younger', name: 'Younger' }]
const GROUPS = [
  { id: 'g-older-1', tier_id: 'tier-older' },
  { id: 'g-younger-1', tier_id: 'tier-younger' },
]

const resolverWith = (sheetCampers, rosterCampers = []) =>
  makeCamperIdentityResolver({ sheetCampers, rosterCampers, groups: GROUPS, tiers: TIERS })

describe('makeCamperIdentityResolver — enrichment precedence', () => {
  it('the sheet group wins when the sheet resolved one', () => {
    const r = resolverWith(
      [{ id: 'c1', group_id: 'g-older-1', division_label: 'Older' }],
      [{ id: 'c1', group_id: 'g-younger-1', division_label: 'Younger' }]
    )
    expect(r.groupIdOf('c1')).toBe('g-older-1')
    expect(r.enriched[0].division_label).toBe('Older')
  })

  it('the roster fills a null the sheet left', () => {
    const r = resolverWith(
      [{ id: 'c1', group_id: null, division_label: 'Older' }],
      [{ id: 'c1', group_id: 'g-older-1', division_label: 'Older' }]
    )
    expect(r.groupIdOf('c1')).toBe('g-older-1')
  })

  it('a camper the roster does not know keeps their nulls', () => {
    const r = resolverWith([{ id: 'c1', group_id: null, division_label: null }])
    expect(r.groupIdOf('c1')).toBe(null)
    expect(r.tierIdOf('c1')).toBe(null)
  })

  it('preserves the sheet order and length', () => {
    const r = resolverWith([{ id: 'c2' }, { id: 'c1' }], [{ id: 'c1', group_id: 'g-older-1' }])
    expect(r.enriched.map((c) => c.id)).toEqual(['c2', 'c1'])
  })
})

// T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md). The parser
// (src/ingest/preferenceSheet.js) still computes `parsed.campers[].id` as
// `deriveCamperId`'s LOOKUP key (its own comment says so explicitly: it
// cannot resolve through camper_identity_keys itself, being a pure,
// db-less preview). `campers.id` in the real roster is now a random
// `camper2:...` token with no relationship to that lookup key.
// `commitElectiveRun.js` bridges the two by resolving every parsed camper's
// `id` to the real id BEFORE calling this resolver (resolveParsedCamperId,
// electron/ops/camperIdentityResolver.js). AssignmentPanel.jsx's solve()
// path has no `db` and cannot do that — it calls this resolver directly on
// the UNRESOLVED sheet rows. Before T321 this worked by accident, because
// `campers.id` WAS `deriveCamperId`'s output; post-T321 `rosterById.get(c.id)`
// never matches, `group_id` never enriches, and every camper silently falls
// back to tier-wide attendance (every group in the tier, not just their own)
// for every real solve — not a test-only gap.
describe('makeCamperIdentityResolver — sheet lookup id vs. real roster id (T321)', () => {
  it('matches a sheet row keyed by deriveCamperId to its roster camper by recomputing the same key', () => {
    const campId = 'camp-1'
    const lookupId = deriveCamperId(campId, { externalId: 'SYN-9001' })
    const r = makeCamperIdentityResolver({
      campId,
      sheetCampers: [{ id: lookupId, group_id: null, division_label: 'Older' }],
      rosterCampers: [
        { id: 'camper2:real-random-id', group_id: 'g-older-1', division_label: 'Older', external_id: 'SYN-9001', display_name: 'Whoever' },
      ],
      groups: GROUPS,
      tiers: TIERS,
    })
    expect(r.groupIdOf(lookupId)).toBe('g-older-1')
  })

  it('matches by display_name when the roster camper has no external_id', () => {
    const campId = 'camp-1'
    const lookupId = deriveCamperId(campId, { displayName: 'Oren Halitebrook' })
    const r = makeCamperIdentityResolver({
      campId,
      sheetCampers: [{ id: lookupId, group_id: null, division_label: 'Older' }],
      rosterCampers: [
        { id: 'camper2:real-random-id-2', group_id: 'g-older-1', division_label: 'Older', external_id: null, display_name: 'Oren Halitebrook' },
      ],
      groups: GROUPS,
      tiers: TIERS,
    })
    expect(r.groupIdOf(lookupId)).toBe('g-older-1')
  })
})

describe('makeCamperIdentityResolver — tier resolution order', () => {
  it('division_label beats the roster group when the two DISAGREE', () => {
    // The row that makes this module exist. buildAttendance resolves a camper's
    // ATTENDANCE tier from division_label and uses group_id only to narrow
    // WITHIN it, so a choice bound from the group's tier would be a choice this
    // camper can never be placed into.
    const r = resolverWith([{ id: 'c1', group_id: 'g-younger-1', division_label: 'Older' }])
    expect(r.tierIdOf('c1')).toBe('tier-older')
  })

  it('falls back to the group when there is no division label', () => {
    const r = resolverWith([{ id: 'c1', group_id: 'g-younger-1', division_label: null }])
    expect(r.tierIdOf('c1')).toBe('tier-younger')
  })

  it('falls back to the group when the division names no tier of this camp', () => {
    const r = resolverWith([{ id: 'c1', group_id: 'g-older-1', division_label: 'Middles' }])
    expect(r.tierIdOf('c1')).toBe('tier-older')
  })

  it('matches a division label case- and whitespace-insensitively', () => {
    const r = resolverWith([{ id: 'c1', group_id: null, division_label: ' older ' }])
    expect(r.tierIdOf('c1')).toBe('tier-older')
  })

  it('an AMBIGUOUS tier name is NO match, exactly as buildAttendance treats it', () => {
    // schema v73 lets two tiers share a name. Binding to whichever row came last
    // is the confident wrong answer; falling through to the group is not a guess
    // about which "Older" was meant.
    const r = makeCamperIdentityResolver({
      sheetCampers: [{ id: 'c1', group_id: 'g-younger-1', division_label: 'Older' }],
      groups: GROUPS,
      tiers: [{ id: 'tier-older', name: 'Older' }, { id: 'tier-older-2', name: 'Older' }],
    })
    expect(r.tierIdOf('c1')).toBe('tier-younger')
  })

  it('a roster-filled group resolves a tier the sheet alone could not', () => {
    const r = resolverWith(
      [{ id: 'c1', group_id: null, division_label: null }],
      [{ id: 'c1', group_id: 'g-older-1' }]
    )
    expect(r.tierIdOf('c1')).toBe('tier-older')
  })

  it('an unknown camper id is null, never a throw', () => {
    const r = resolverWith([{ id: 'c1', group_id: 'g-older-1' }])
    expect(r.tierIdOf('nobody')).toBe(null)
    expect(r.groupIdOf('nobody')).toBe(null)
  })

  it('a group unknown to `groups` yields no tier rather than a made-up one', () => {
    const r = resolverWith([{ id: 'c1', group_id: 'g-ghost', division_label: null }])
    expect(r.tierIdOf('c1')).toBe(null)
  })

  it('is callable with nothing at all', () => {
    const r = makeCamperIdentityResolver({})
    expect(r.enriched).toEqual([])
    expect(r.tierIdOf('c1')).toBe(null)
  })
})
