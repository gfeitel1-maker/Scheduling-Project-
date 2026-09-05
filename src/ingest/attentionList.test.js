import { describe, it, expect } from 'vitest'
import { buildAttentionList, buildStructureIssues } from './attentionList.js'

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
})
