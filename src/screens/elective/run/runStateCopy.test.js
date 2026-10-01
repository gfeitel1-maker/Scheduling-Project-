// T318 — pins the two runStateCopy.js derivations that previously had no unit
// test of their own (only the screen-level ElectiveRunViews.test.jsx exercised
// them indirectly).
//
// occurrenceLabel: days_of_operation stores its name in `label`
// (electron/db/schema.sql), not `name` — a day must resolve from either.
//
// satisfactionSummary: an unordered-set preference must never be reported as a
// numbered choice (T318 (c) — "an ordinal is shown only on positive evidence of
// ordering").
import { describe, it, expect } from 'vitest'
import {
  occurrenceLabel, satisfactionSummary, camperDisambiguator, resolveCamperDisambiguators,
  groupBundleTierNotCoveredFindings, bundleTierNotCoveredGroupMessage,
  conflictFindingMessage, finalizeFindingMessage, sheetOnlyCampersMessage,
} from './runStateCopy.js'

describe('occurrenceLabel', () => {
  it('resolves the day name from `label`, the actual days_of_operation column', () => {
    const label = occurrenceLabel({
      occurrenceId: 'occ-1',
      activityId: 'act-1',
      activities: [{ id: 'act-1', name: 'Archery' }],
      occurrences: [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }],
      days: [{ id: 'day-1', label: 'Monday' }],
      timeBlocks: [{ id: 'tb-1', name: 'Period 2' }],
    })
    expect(label).toBe('Archery — Monday, Period 2')
  })
})

describe('satisfactionSummary', () => {
  it('reports an unordered-set placement as "one of their choices", never a numbered rank', () => {
    const rows = [
      {
        id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1',
        preference_rank: 2, camper_name: 'Testcamper Alpha',
      },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 2, rank_kind: 'unordered-set' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/one of their choices/)
    expect(summary).not.toMatch(/a second choice/)
  })

  it('still reports the ordinal for a genuinely ordered placement', () => {
    const rows = [
      {
        id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1',
        preference_rank: 1, camper_name: 'Testcamper Alpha',
      },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/a first choice/)
  })

  it('composes "N one of their choices" into "N got one of their choices" when it leads the sentence', () => {
    const rows = [
      { id: 'a1', camper_id: 'cam-1', occurrence_id: 'occ-1', choice_id: 'choice-1', preference_rank: 2, camper_name: 'A' },
      { id: 'a2', camper_id: 'cam-2', occurrence_id: 'occ-1', choice_id: 'choice-2', preference_rank: 3, camper_name: 'B' },
    ]
    const preferences = [
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 2, rank_kind: 'unordered-set' },
      { id: 'pref-2', camper_id: 'cam-2', choice_id: 'choice-2', occurrence_id: 'occ-1', rank: 3, rank_kind: 'unordered-set' },
    ]
    const summary = satisfactionSummary({ rows, preferences, occurrences: [], days: [], timeBlocks: [] })
    expect(summary).toMatch(/2 got one of their choices/)
  })
})

// T250 B2 — satisfactionSummary must count CAMPERS and PLACEMENTS separately.
// A camper has one row per occurrence, so `rows.length` alone reports
// placements as though they were campers (a 26-camper run with a 2-block
// activity read "52 campers placed").
describe('T250 B2 — satisfactionSummary distinguishes campers from placements', () => {
  it('reports zero rows as "No campers placed yet."', () => {
    expect(satisfactionSummary({ rows: [] })).toBe('No campers placed yet.')
  })

  it('reports one camper with one placement in the singular', () => {
    const rows = [{ camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 }]
    expect(satisfactionSummary({ rows })).toMatch(/^1 camper placed, 1 placement across 1 occurrence\./)
  })

  it('counts DISTINCT campers, not rows, when one camper has two placements (a multi-occurrence activity)', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', occurrence_id: 'occ-2', preference_rank: 1 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^1 camper placed, 2 placements across 2 occurrences\./)
  })

  it('pluralizes campers, placements and occurrences independently', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', occurrence_id: 'occ-2', preference_rank: 1 },
      { camper_id: 'c2', occurrence_id: 'occ-1', preference_rank: 2 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^2 campers placed, 3 placements across 2 occurrences\./)
  })

  // Round 2 FIX 5(b) (Code Reviewer, LOW) — elective_assignments.camper_id is
  // nullable in the schema (a null-camper row is schema-permitted, not known
  // to be produced today). `new Set(rows.map(r => r.camper_id)).size` counts
  // a null camper_id as ONE distinct "camper" alongside every real one, so a
  // run with two real campers and one null-camper row reported "3 campers
  // placed" — one camper too many. The row still counts toward placements.
  it('does not count a null camper_id as a distinct camper, but still counts its placement', () => {
    const rows = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c2', occurrence_id: 'occ-1', preference_rank: 2 },
      { camper_id: null, occurrence_id: 'occ-1', preference_rank: 1 },
    ]
    expect(satisfactionSummary({ rows })).toMatch(/^2 campers placed, 3 placements across 1 occurrence\./)
  })
})

describe('T250 B3 — camperDisambiguator degrades group name -> external_id -> nothing', () => {
  it('prefers the group name when present', () => {
    expect(camperDisambiguator({ groupName: 'Bogrim A', externalId: 'CM-42' })).toBe('Bogrim A')
  })

  it('falls back to the external id when there is no group', () => {
    expect(camperDisambiguator({ groupName: null, externalId: 'CM-42' })).toBe('CM-42')
  })

  it('returns null rather than a placeholder when neither is present', () => {
    expect(camperDisambiguator({ groupName: null, externalId: null })).toBeNull()
  })

  it('never returns the raw camper_id — it is not one of the function\'s inputs at all', () => {
    const result = camperDisambiguator({ groupName: null, externalId: null, camperId: 'camper-123' })
    expect(result).not.toBe('camper-123')
  })
})

// Round 2 FIX 3 (Red Hat, MEDIUM) — camperDisambiguator degrades per camper
// with no awareness of whether its pick actually distinguishes anyone. Two
// same-named campers in the same group both printed "Jordan Lee · Cabin 4" —
// identical strings that read as resolved when they are not.
describe('T250 round 2 FIX 3 — resolveCamperDisambiguators is collision-aware across the listed set', () => {
  it('two same-named campers in the same group WITH external_ids show the external_ids, not the (colliding) group name', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-1' },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-2' },
    ])
    expect(result.get('c1')).toBe('CM-1')
    expect(result.get('c2')).toBe('CM-2')
  })

  it('the same pair with no external_id shows nothing — a genuinely unresolvable residual, never an index or the raw id', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
    ])
    expect(result.get('c1')).toBeNull()
    expect(result.get('c2')).toBeNull()
  })

  it('two same-named campers in DIFFERENT groups are told apart by group name', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: null },
      { id: 'c2', name: 'Jordan Lee', groupName: 'Cabin 7', externalId: null },
    ])
    expect(result.get('c1')).toBe('Cabin 4')
    expect(result.get('c2')).toBe('Cabin 7')
  })

  it('a camper whose name is unique in the set gets no disambiguator', () => {
    const result = resolveCamperDisambiguators([
      { id: 'c1', name: 'Jordan Lee', groupName: 'Cabin 4', externalId: 'CM-1' },
      { id: 'c2', name: 'Ari Green', groupName: 'Cabin 4', externalId: 'CM-2' },
    ])
    expect(result.get('c1')).toBeNull()
    expect(result.get('c2')).toBeNull()
  })
})

// C1 — commitElectiveRun emits one BUNDLE_TIER_NOT_COVERED finding per camper
// per bundle label, so a real camp shows 30+ near-identical rows, the same
// camper repeated. groupBundleTierNotCoveredFindings compresses that
// REPETITION (one row per (label, tier) pair), never the INFORMATION
// (Art. V) — every camper named in the finding set must still be reachable.
describe('groupBundleTierNotCoveredFindings', () => {
  const groups = [{ id: 'grp-older', tier_id: 'tier-older' }, { id: 'grp-younger', tier_id: 'tier-younger' }]
  const tiers = [{ id: 'tier-older', name: 'Older' }, { id: 'tier-younger', name: 'Younger' }]
  const campers = [
    { id: 'cam-1', display_name: 'Ari Green', group_id: 'grp-older', division_label: null },
    { id: 'cam-2', display_name: 'Noa Katz', group_id: 'grp-older', division_label: null },
    { id: 'cam-3', display_name: 'Bo Levi', group_id: 'grp-younger', division_label: null },
  ]

  it('groups findings for the same (label, tier) pair into one entry, naming every camper', () => {
    const findings = [
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-1', label: 'Ropes' },
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-2', label: 'Ropes' },
      { kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-3', label: 'Ropes' },
    ]
    const result = groupBundleTierNotCoveredFindings({ findings, campers, groups, tiers })
    expect(result).toHaveLength(2)
    const older = result.find((g) => g.tierName === 'Older')
    const younger = result.find((g) => g.tierName === 'Younger')
    expect(older.label).toBe('Ropes')
    expect(older.names.sort()).toEqual(['Ari Green', 'Noa Katz'])
    expect(younger.names).toEqual(['Bo Levi'])
  })

  it('ignores findings of other kinds', () => {
    const findings = [
      { kind: 'PREFERENCE_EDIT_HELD', camper_id: 'cam-1', preference_id: 'p1' },
    ]
    expect(groupBundleTierNotCoveredFindings({ findings, campers, groups, tiers })).toEqual([])
  })

  it("groups a camper whose tier cannot be resolved at all under a null tierName — never a fabricated tier", () => {
    const findings = [{ kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-ghost', label: 'Ropes' }]
    const result = groupBundleTierNotCoveredFindings({ findings, campers: [], groups, tiers })
    expect(result).toHaveLength(1)
    expect(result[0].tierName).toBeNull()
    // F5 (Red Hat round 3) — never a raw camper_id, even for a camper whose
    // row is entirely absent.
    expect(result[0].names).toEqual(['a camper who is no longer on the roster'])
  })

  // F5 (Red Hat round 3) — camperDisambiguator's own rule, applied here too.
  it('NEVER prints a raw camper_id when the camper row is gone — degrades truthfully instead', () => {
    const findings = [{ kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'deleted-camper-id', label: 'Ropes', tier_id: 'tier-older' }]
    const result = groupBundleTierNotCoveredFindings({ findings, campers: [], groups, tiers })
    expect(result[0].names).toEqual(['a camper who is no longer on the roster'])
    expect(JSON.stringify(result)).not.toContain('deleted-camper-id')
  })

  // Round 3 (Red Hat F3) — a finding carrying its own `tier_id` is grouped on
  // THAT value directly, never re-derived — even when campers/groups would
  // resolve to a DIFFERENT tier, proving the field, not the fallback, wins.
  it("groups on the finding's OWN tier_id, never re-deriving when the field is present — even when re-derivation would disagree", () => {
    const findings = [{ kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-1', label: 'Ropes', tier_id: 'tier-older' }]
    // This camper's campers/groups shape would re-derive to tier-younger if
    // asked — which must NOT happen, since tier_id is present.
    const misleadingCampers = [{ id: 'cam-1', display_name: 'Ari Green', group_id: 'grp-younger', division_label: null }]
    const misleadingGroups = [{ id: 'grp-younger', tier_id: 'tier-younger' }]
    const result = groupBundleTierNotCoveredFindings({ findings, campers: misleadingCampers, groups: misleadingGroups, tiers })
    expect(result[0].tierId).toBe('tier-older')
    expect(result[0].tierName).toBe('Older')
  })

  it('resolves the tier from division_label when it matches a tier name, even with no group_id', () => {
    const divisionCampers = [{ id: 'cam-9', display_name: 'Shir Cohen', group_id: null, division_label: 'Older' }]
    const findings = [{ kind: 'BUNDLE_TIER_NOT_COVERED', camper_id: 'cam-9', label: 'Ropes' }]
    const result = groupBundleTierNotCoveredFindings({ findings, campers: divisionCampers, groups, tiers })
    expect(result[0].tierName).toBe('Older')
  })
})

describe('bundleTierNotCoveredGroupMessage', () => {
  it('names the label, the tier, and the count when the tier resolved', () => {
    const message = bundleTierNotCoveredGroupMessage({ label: 'Ropes', tierName: 'Older', names: ['Ari Green', 'Noa Katz'] })
    expect(message).toBe('"Ropes" does not cover Older — 2 campers kept their request as an ordinary choice.')
  })

  it('uses singular "camper" for a group of one', () => {
    const message = bundleTierNotCoveredGroupMessage({ label: 'Ropes', tierName: 'Older', names: ['Ari Green'] })
    expect(message).toBe('"Ropes" does not cover Older — 1 camper kept their request as an ordinary choice.')
  })

  it('degrades truthfully when no tier resolved, naming no tier at all', () => {
    const message = bundleTierNotCoveredGroupMessage({ label: 'Ropes', tierName: null, names: ['Ari Green'] })
    expect(message).toBe('"Ropes" does not cover these campers’ division — 1 camper kept their request as an ordinary choice.')
  })

  // F2 (round 2 review) — an assignment-only mismatch persists with
  // choice_id null (commitElectiveRun.js's `labelsNeedingFlatChoice` is built
  // from preferences only, so no flat choice is ever minted for a solver
  // fallback placement), so getElectiveRun.js's LEFT JOIN on choice_id
  // recovers `label: null` for the cold-reopened row. Interpolating it
  // unconditionally printed the literal string "null" to a director. Must
  // degrade the same honest way the sibling tierName === null branch already
  // does — never invent a label, never print "null" or an empty quoted string.
  it('degrades truthfully when label is null, never printing the literal "null" or an empty quoted string', () => {
    const message = bundleTierNotCoveredGroupMessage({ label: null, tierName: 'Older', names: ['Ari Green'] })
    expect(message).not.toMatch(/\bnull\b/)
    expect(message).not.toMatch(/""/)
  })
})

// C2 (board item 9b) — findRouteConflicts (src/engine/routeConflicts.js)
// OUTER_RESOURCE_CONFLICT findings carry NO `.message`, only
// locationName/dayId/blockId/capacity/occupants[].label. FinalizeFindingsList
// used to fall through to the raw `.kind`, printing "OUTER_RESOURCE_CONFLICT"
// verbatim for every conflict.
describe('conflictFindingMessage', () => {
  const days = [{ id: 'day-1', label: 'Monday' }]
  const timeBlocks = [{ id: 'tb-1', name: 'First Period' }]

  it('names the location, the day/period, and the colliding activities', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ label: 'Canoeing' }, { label: 'Kayaking' }],
    }
    const message = conflictFindingMessage(finding, { days, timeBlocks })
    expect(message).toContain('Boathouse')
    expect(message).toContain('Monday')
    expect(message).toContain('First Period')
    expect(message).toContain('Canoeing')
    expect(message).toContain('Kayaking')
    expect(message).not.toContain('OUTER_RESOURCE_CONFLICT')
  })

  it('returns null for any other kind, never guessing at a shape it does not own', () => {
    expect(conflictFindingMessage({ kind: 'SOMETHING_ELSE' }, { days, timeBlocks })).toBeNull()
  })

  it('degrades by dropping the day/period detail when the occurrence catalogs do not resolve it, never printing a raw id', () => {
    const finding = { kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'ghost-day', blockId: 'ghost-tb', capacity: 1, occupants: [{ label: 'Canoeing' }] }
    const message = conflictFindingMessage(finding, { days: [], timeBlocks: [] })
    expect(message).toContain('Boathouse')
    expect(message).not.toContain('ghost-day')
    expect(message).not.toContain('ghost-tb')
  })

  // Round 5 (Red Hat/Governor, found live via the scene2 screenshot) —
  // findRouteConflicts registers ONE occupant entry PER OCCUPYING SLOT, so
  // the same activity scheduled for three different groups in the same
  // location/period appears three times in `occupants`. The real captured
  // sentence read "Canoeing and Canoeing and Canoeing and Kayaking are
  // scheduled there at once" — a director needs to know WHICH activities
  // collide, not how many groups each one came from. Dedupe by label.
  it('deduplicates a repeated occupant label — the SAME trap findRouteConflicts produces for three groups sharing one activity', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ label: 'Canoeing' }, { label: 'Canoeing' }, { label: 'Canoeing' }, { label: 'Kayaking' }],
    }
    const message = conflictFindingMessage(finding, { days, timeBlocks })
    expect(message.match(/Canoeing/g)).toHaveLength(1)
    expect(message.match(/Kayaking/g)).toHaveLength(1)
    expect(message).toContain('Canoeing and Kayaking')
  })

  // Round 5 — ordinary English list punctuation, not "and" between every
  // element: one item bare, two items "A and B", three or more
  // "A, B and C".
  it('joins exactly two distinct activities with "and", no comma', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ label: 'Canoeing' }, { label: 'Kayaking' }],
    }
    const message = conflictFindingMessage(finding, { days, timeBlocks })
    expect(message).toContain('Canoeing and Kayaking')
    expect(message).not.toContain('Canoeing, Kayaking')
  })

  it('joins three or more distinct activities with commas and a final "and"', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ label: 'Canoeing' }, { label: 'Kayaking' }, { label: 'Sailing' }],
    }
    const message = conflictFindingMessage(finding, { days, timeBlocks })
    expect(message).toContain('Canoeing, Kayaking and Sailing')
  })

  it('names a single colliding activity bare, with no "and" or comma', () => {
    const finding = {
      kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1,
      occupants: [{ label: 'Canoeing' }, { label: 'Canoeing' }],
    }
    const message = conflictFindingMessage(finding, { days, timeBlocks })
    expect(message.match(/Canoeing/g)).toHaveLength(1)
    expect(message).not.toMatch(/Canoeing\s+and\s+Canoeing/)
  })
})

describe('finalizeFindingMessage', () => {
  it('renders a finding carrying its own .message verbatim, untouched', () => {
    expect(finalizeFindingMessage({ kind: 'ANYTHING', message: 'Custom text' }, {})).toBe('Custom text')
  })

  it('resolves a real OUTER_RESOURCE_CONFLICT finding via conflictFindingMessage', () => {
    const finding = { kind: 'OUTER_RESOURCE_CONFLICT', locationName: 'Boathouse', dayId: 'day-1', blockId: 'tb-1', capacity: 1, occupants: [{ label: 'Canoeing' }] }
    const message = finalizeFindingMessage(finding, { days: [{ id: 'day-1', label: 'Monday' }], timeBlocks: [{ id: 'tb-1', name: 'First Period' }] })
    expect(message).toContain('Boathouse')
    expect(message).not.toContain('OUTER_RESOURCE_CONFLICT')
  })

  it('degrades an unrecognised kind with no .message to a plain-words sentence — never the raw kind code, never JSON', () => {
    const message = finalizeFindingMessage({ kind: 'SOME_FUTURE_KIND_XYZ', somethingWeird: 1 }, {})
    expect(message).not.toContain('SOME_FUTURE_KIND_XYZ')
    expect(message).not.toMatch(/^\{/)
  })
})

// (C)(4), board item 9b — sheetOnlyCampers must be named, not just counted.
describe('sheetOnlyCampersMessage', () => {
  it('states the plural count and verb', () => {
    expect(sheetOnlyCampersMessage(2)).toBe("2 campers on this run's sheet have no ranked choice and no placement.")
  })

  it('states the singular count and verb for exactly one', () => {
    expect(sheetOnlyCampersMessage(1)).toBe("1 camper on this run's sheet has no ranked choice and no placement.")
  })
})
