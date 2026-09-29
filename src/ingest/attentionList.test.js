import { describe, it, expect } from 'vitest'
import { buildAttentionList, buildStructureIssues } from './attentionList.js'
import { DOMAINS } from '../components/reconciliation/domainRollup.js'
import { screenForNode } from '../components/reconciliation/rootMapNav.js'

// buildRootMapModel-shaped fixture — the exact shape rootMapModel.js returns
// ({ domains: [{ key, label, children: [{ key, roster }] }] }), narrowed to
// only the fields buildAttentionList actually reads.
function modelWith(children) {
  return {
    domains: [
      { key: 'Scheduling', label: 'Scheduling', children },
    ],
  }
}

describe('buildAttentionList', () => {
  it('returns an empty array when there is nothing unresolved anywhere', () => {
    const model = modelWith([{ key: 'Activities', roster: [{ entityId: 'a1', name: 'Kayak', state: 'understood', decisionId: null }] }])
    expect(buildAttentionList({ model, structureIssues: [] })).toEqual([])
  })

  it('surfaces reconciliation-half rows for roster entries in attention or changed state', () => {
    const model = modelWith([
      {
        key: 'Activities',
        roster: [
          { entityId: 'a1', name: 'Waterfront', state: 'attention', decisionId: 'd1' },
          { entityId: 'a2', name: 'Kayak', state: 'understood', decisionId: null },
          { entityId: null, name: 'Nature Explorers', state: 'attention', decisionId: 'd2' },
        ],
      },
    ])
    const decisionsById = new Map([
      ['d1', { id: 'd1', reason: 'No location matched.' }],
      ['d2', { id: 'd2', reason: 'Cohort unclear.' }],
    ])

    const rows = buildAttentionList({ model, decisionsById, structureIssues: [] })

    expect(rows).toEqual([
      { id: 'd1', name: 'Waterfront', why: 'No location matched.', domainTag: 'Scheduling', sourceKind: 'reconciliation' },
      { id: 'd2', name: 'Nature Explorers', why: 'Cohort unclear.', domainTag: 'Scheduling', sourceKind: 'reconciliation' },
    ])
  })

  it('falls back to a generic reason when no decision is attached to a flagged roster row', () => {
    const model = modelWith([{ key: 'Activities', roster: [{ entityId: 'a1', name: 'Waterfront', state: 'changed', decisionId: null }] }])
    const rows = buildAttentionList({ model, structureIssues: [] })
    expect(rows[0].why).toBe('Needs your review.')
  })

  it('unions the reconciliation half with the structure-issues half into one undifferentiated list', () => {
    const model = modelWith([{ key: 'Activities', roster: [] }])
    const structureIssues = [{ id: 'empty:groups', name: 'Groups', why: 'No groups set up yet.', domainTag: 'Structure', sourceKind: 'structure' }]

    const rows = buildAttentionList({ model, structureIssues })

    expect(rows).toEqual(structureIssues)
  })
})

describe('buildStructureIssues', () => {
  // T304 — AN EMPTINESS CHECK OVER AN UNREAD COLLECTION IS NOT A FINDING.
  //
  // Found by running the real screen rather than by reasoning about it: with
  // `activities` failing to load, the rail rendered "Activities — No activities
  // set up yet." for a camp with five activities. The em dash on the bento card
  // and the rail's "may be incomplete" notice were both already correct; this
  // row was a CONFIDENT FALSE CLAIM sitting between them, and it is the same
  // defect the ticket is about, one level down. An unread collection is not an
  // empty one, and the difference is the whole ticket.
  it('does not report an area as empty when its collection could not be read', () => {
    const collections = { tiers: [], groups: [], days_of_operation: [], time_blocks: [], activities: [] }

    const issues = buildStructureIssues(collections, new Set(['activities']))

    expect(issues.some((i) => i.id === 'empty:activities')).toBe(false)
  })

  // NON-VACUITY. The assertion above passes just as well if the unread set
  // silenced EVERY area, which would replace a false claim with no claim at all
  // and hide four real findings to fix one wrong one.
  it('still reports the areas that WERE read as empty', () => {
    const collections = { tiers: [], groups: [], days_of_operation: [], time_blocks: [], activities: [] }

    const issues = buildStructureIssues(collections, new Set(['activities']))

    expect(issues.some((i) => i.id === 'empty:tiers')).toBe(true)
    expect(issues.some((i) => i.id === 'empty:groups')).toBe(true)
    expect(issues.some((i) => i.id === 'empty:days_of_operation')).toBe(true)
    expect(issues.some((i) => i.id === 'empty:time_blocks')).toBe(true)
  })

  // The second argument is optional, so every existing caller and test keeps
  // working unchanged and a caller that forgets it gets the old behaviour
  // rather than a crash.
  it('treats a missing unread set as "everything was read"', () => {
    const collections = { tiers: [], groups: [], days_of_operation: [], time_blocks: [], activities: [] }

    expect(buildStructureIssues(collections).some((i) => i.id === 'empty:activities')).toBe(true)
  })

  it('returns no issues for null/undefined collections', () => {
    expect(buildStructureIssues(null)).toEqual([])
    expect(buildStructureIssues(undefined)).toEqual([])
  })

  it('flags each required area that is genuinely empty', () => {
    const collections = {
      tiers: [], groups: [{ id: 'g1', name: 'Bunk 1', tier_id: null }],
      days_of_operation: [{ id: 'd1' }], time_blocks: [], activities: [{ id: 'a1', name: 'Kayak', eligible_tier_ids: [], eligible_group_ids: [] }],
      locations: [],
    }
    const issues = buildStructureIssues(collections)
    const ids = issues.map((i) => i.id)
    expect(ids).toContain('empty:tiers')
    expect(ids).toContain('empty:time_blocks')
    expect(ids).not.toContain('empty:groups')
    expect(ids).not.toContain('empty:days_of_operation')
    expect(ids).not.toContain('empty:activities')
  })

  it('flags a group that no activity is eligible for, when activities exist', () => {
    const collections = {
      tiers: [{ id: 't1' }], groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1' }],
      days_of_operation: [{ id: 'd1' }], time_blocks: [{ id: 'tb1' }],
      activities: [{ id: 'a1', name: 'Kayak', eligible_tier_ids: ['t-other'], eligible_group_ids: [] }],
      locations: [],
    }
    const issues = buildStructureIssues(collections)
    expect(issues.find((i) => i.id === 'group-no-activities:g1')).toEqual({
      id: 'group-no-activities:g1',
      name: 'Bunk 1',
      why: 'No activities are eligible for this group.',
      domainTag: 'Structure',
      sourceKind: 'structure',
    })
  })

  it('does not flag a group when an unrestricted activity (open to everyone) exists', () => {
    const collections = {
      tiers: [{ id: 't1' }], groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1' }],
      days_of_operation: [{ id: 'd1' }], time_blocks: [{ id: 'tb1' }],
      activities: [{ id: 'a1', name: 'Kayak', eligible_tier_ids: [], eligible_group_ids: [] }],
      locations: [],
    }
    const issues = buildStructureIssues(collections)
    expect(issues.find((i) => i.id === 'group-no-activities:g1')).toBeUndefined()
  })

  it('does not flag any group-eligibility issue when there are no activities at all (already covered by empty:activities)', () => {
    const collections = {
      tiers: [{ id: 't1' }], groups: [{ id: 'g1', name: 'Bunk 1', tier_id: 't1' }],
      days_of_operation: [{ id: 'd1' }], time_blocks: [{ id: 'tb1' }], activities: [], locations: [],
    }
    const issues = buildStructureIssues(collections)
    expect(issues.find((i) => i.id?.startsWith('group-no-activities'))).toBeUndefined()
  })

  // T237 — RootsHomeScreen resolves an attention row's click destination via
  // rootMapNav.screenForNode(row.domainTag) (structure rows carry NO
  // childKey, so this always falls through to the DOMAIN_SCREEN fallback).
  // A row must never carry a domainTag rootMapNav has no target for, or
  // clicking it silently does nothing. Exercises the REAL emitted values
  // (buildStructureIssues' every REQUIRED_EMPTY_AREAS/group-eligibility
  // domainTag, plus buildAttentionList's reconciliation half, which reads
  // domain.label straight off the model — DOMAINS, in real usage, per
  // rootMapModel.js/domainRollup.js) rather than a hand-copied list that
  // could itself drift from what attentionList.js actually emits.
  it('every domainTag a structure issue can emit resolves to a real screen (T237)', () => {
    const collections = {
      tiers: [], groups: [{ id: 'g1', name: 'Bunk 1', tier_id: null }],
      days_of_operation: [], time_blocks: [], activities: [{ id: 'a1', name: 'Kayak', eligible_tier_ids: ['nope'], eligible_group_ids: [] }],
      locations: [],
    }
    const issues = buildStructureIssues(collections)
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(screenForNode(issue.domainTag), issue.domainTag).not.toBeNull()
    }
  })

  it('every reconciliation-half domainTag (DOMAINS, the real model.domains[].label vocabulary) resolves to a real screen (T237)', () => {
    for (const domain of DOMAINS) {
      const model = modelWith([{ key: 'X', roster: [{ entityId: 'e1', name: 'Thing', state: 'attention', decisionId: 'd1' }] }])
      model.domains[0].label = domain
      const rows = buildAttentionList({ model, structureIssues: [] })
      expect(rows).toHaveLength(1)
      expect(screenForNode(rows[0].domainTag), domain).not.toBeNull()
    }
  })
})

// T299 — a director cannot be asked "one child or two" unless they are told the
// two sheets are indistinguishable. Both sheets LAND as their own subject (the
// app does not decide which case it is); this is the telling half.
describe('buildStructureIssues — submissions indistinguishable by content (T299)', () => {
  // external_id holds the SUBMISSION key, so two subjects carrying identical
  // answers share it while having different ids. Both exported as `planner`, which
  // is why the display name cannot carry this distinction either.
  const sub = (id, external_id, display_name = 'planner') => ({
    id,
    display_name,
    external_id,
    is_unattributed: 1,
  })

  it('tells the director when two unattributed sheets carry identical answers', () => {
    const issues = buildStructureIssues({
      campers: [sub('camper1:sub-a:arrive-1', 'sub-ffff'), sub('camper1:sub-a:arrive-2', 'sub-ffff')],
    })
    const rows = issues.filter((i) => i.sourceKind === 'unattributed-camper')

    // TWO rows, one per subject — each is separately nameable, which is what makes
    // the merge possible at all. Collapsing them into one row would hide a child.
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    // Both are told, not just the second to arrive: neither is "the duplicate".
    for (const row of rows) {
      expect(row.why).toMatch(/same answers/i)
      expect(row.why).toMatch(/one camper.s sheet imported twice|two campers/i)
    }
  })

  it('does NOT claim a collision when two unattributed sheets carry different answers', () => {
    const issues = buildStructureIssues({
      campers: [sub('camper1:sub-a:arrive-1', 'sub-aaaa'), sub('camper1:sub-b:arrive-2', 'sub-bbbb')],
    })
    const rows = issues.filter((i) => i.sourceKind === 'unattributed-camper')
    expect(rows).toHaveLength(2)
    // The ordinary ask, unchanged. A guard that fires on every pair would prove
    // nothing, so this is the case that has to stay quiet.
    for (const row of rows) {
      expect(row.why).not.toMatch(/same answers/i)
      expect(row.why).toMatch(/not their name/i)
    }
  })

  it('a single unattributed sheet is never called indistinguishable from itself', () => {
    const issues = buildStructureIssues({ campers: [sub('camper1:sub-a:arrive-1', 'sub-aaaa')] })
    const rows = issues.filter((i) => i.sourceKind === 'unattributed-camper')
    expect(rows).toHaveLength(1)
    expect(rows[0].why).not.toMatch(/same answers/i)
  })

  it('an already-named camper sharing a submission key is not counted as a colliding sheet', () => {
    // The named row is what a subject becomes once a director attributes it. It
    // must not keep the remaining subject flagged as colliding with something —
    // that would leave a question on screen that has already been answered.
    //
    // THE FIXTURE IS DEFENSIVE, NOT OBSERVED, and saying so is the point.
    // `attributeElectiveSubject` writes the CALLER's external_id onto the canonical
    // row, so today a named camper carries null rather than the `sub-` key and this
    // state does not arise. What the case pins is the rule — count UNNAMED sheets
    // only — which is what would be silently wrong if the submission key were ever
    // carried across the rekey (see the KNOWN GAP note on campers.external_id in
    // electron/db/schema.sql). Without it, "count the unnamed ones" and "count the
    // ones with this key" are indistinguishable.
    const issues = buildStructureIssues({
      campers: [
        sub('camper1:sub-a:arrive-1', 'sub-ffff'),
        { id: 'camper1:name:arigreen', display_name: 'Ari Green', external_id: 'sub-ffff', is_unattributed: null },
      ],
    })
    const rows = issues.filter((i) => i.sourceKind === 'unattributed-camper')
    expect(rows).toHaveLength(1)
    expect(rows[0].why).not.toMatch(/same answers/i)
  })

  it('does not treat two subjects with no submission key at all as identical', () => {
    // A grid read with no submission key leaves external_id null. Two nulls are not
    // evidence of anything, and reading them as a match would invent a collision.
    const issues = buildStructureIssues({
      campers: [sub('camper1:x', null, 'ari-planner'), sub('camper1:y', null, 'noa-planner')],
    })
    const rows = issues.filter((i) => i.sourceKind === 'unattributed-camper')
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.why).not.toMatch(/same answers/i)
  })
})
