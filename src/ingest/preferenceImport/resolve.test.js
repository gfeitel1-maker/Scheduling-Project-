// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  resolvePreferenceImport,
  IDENTITY_STATUS,
  IDENTITY_REASONS,
  CHOICE_STATUS,
  CHOICE_REASONS,
  ROW_ERROR_REASONS,
} from './resolve.js'

const HEADERS = ['Display Name', 'Group', 'External Id', 'Choice 1', 'Choice 2']
const MAPPING = {
  displayName: 0,
  group: 1,
  externalId: 2,
  noPreferenceValues: ['None'],
  choices: [
    { label: 'Choice 1', isLinked: false, memberColumns: [3] },
    { label: 'Choice 2', isLinked: false, memberColumns: [4] },
  ],
}

const GROUPS = [
  { id: 'group-a', name: 'Bunk A' },
  { id: 'group-b', name: 'Bunk B' },
]

const OCCURRENCE_INDEX = [{ id: 'occ-swim' }, { id: 'occ-art' }]
const ACTIVITY_INDEX = { Swim: ['act-swim'], Art: ['act-art'], Chess: ['act-chess'] }
const OFFERING_INDEX = { 'act-swim': ['occ-swim'], 'act-art': ['occ-art'], 'act-chess': [] }

function row(displayName, group, externalId, choice1, choice2) {
  return { 'Display Name': displayName, Group: group, 'External Id': externalId, 'Choice 1': choice1, 'Choice 2': choice2 }
}

function resolveOne(r, overrides = {}) {
  return resolvePreferenceImport({
    rows: [r],
    headers: HEADERS,
    mapping: MAPPING,
    roster: [],
    groups: GROUPS,
    occurrenceIndex: OCCURRENCE_INDEX,
    activityIndex: ACTIVITY_INDEX,
    offeringIndex: OFFERING_INDEX,
    ...overrides,
  })
}

describe('identity resolution', () => {
  it('matches an existing camper by external_id', () => {
    const roster = [{ id: 'camper-1', display_name: 'Alice Cohen', group_id: 'group-a', external_id: 'ext-1' }]
    const result = resolveOne(row('Alice Cohen', 'Bunk A', 'ext-1', 'Swim', 'Art'), { roster })
    expect(result.camperResolutions[0]).toMatchObject({ status: IDENTITY_STATUS.MATCHED, camperId: 'camper-1' })
  })

  it('offers a name+group match for confirmation without external_id (near-miss: still resolves)', () => {
    const roster = [{ id: 'camper-1', display_name: 'Alice Cohen', group_id: 'group-a', external_id: null }]
    const result = resolveOne(row('Alice Cohen', 'Bunk A', '', 'Swim', 'Art'), { roster })
    expect(result.camperResolutions[0]).toMatchObject({ status: IDENTITY_STATUS.OFFERED, camperId: 'camper-1' })
  })

  it('blocks on a missing group', () => {
    const result = resolveOne(row('New Kid', '', '', 'Swim', 'Art'))
    expect(result.camperResolutions[0]).toMatchObject({
      status: IDENTITY_STATUS.BLOCKED,
      reason: IDENTITY_REASONS.MISSING_GROUP,
    })
    expect(result.blockedCount).toBe(1)
  })

  it('offers create-new-camper when no roster match exists and the group is known (near-miss for MISSING_GROUP)', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Swim', 'Art'))
    expect(result.camperResolutions[0]).toMatchObject({ status: IDENTITY_STATUS.OFFERED_NEW, groupId: 'group-a' })
    expect(result.blockedCount).toBe(0)
  })

  it('blocks on the same display name existing in a different group (duplicate across groups)', () => {
    const roster = [{ id: 'camper-1', display_name: 'Sam Levi', group_id: 'group-b', external_id: null }]
    const result = resolveOne(row('Sam Levi', 'Bunk A', '', 'Swim', 'Art'), { roster })
    expect(result.camperResolutions[0]).toMatchObject({
      status: IDENTITY_STATUS.BLOCKED,
      reason: IDENTITY_REASONS.DUPLICATE_NAME_ACROSS_GROUPS,
    })
  })

  it('blocks with disambiguation candidates on same display name in the SAME group', () => {
    const roster = [
      { id: 'camper-1', display_name: 'Sam Levi', group_id: 'group-a', createdAt: '2026-01-01' },
      { id: 'camper-2', display_name: 'Sam Levi', group_id: 'group-a', createdAt: '2026-02-01' },
    ]
    const result = resolveOne(row('Sam Levi', 'Bunk A', '', 'Swim', 'Art'), { roster })
    expect(result.camperResolutions[0].status).toBe(IDENTITY_STATUS.BLOCKED)
    expect(result.camperResolutions[0].reason).toBe(IDENTITY_REASONS.AMBIGUOUS_SAME_GROUP)
    expect(result.camperResolutions[0].disambiguation.candidates).toEqual([
      { camperId: 'camper-1', createdAt: '2026-01-01' },
      { camperId: 'camper-2', createdAt: '2026-02-01' },
    ])
  })
})

describe('choice resolution', () => {
  it('resolves a choice text that matches exactly one offering', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Swim', 'Art'))
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.RESOLVED,
      rank: 1,
      members: [{ activityId: 'act-swim', occurrenceId: 'occ-swim' }],
    })
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED, rank: 2 })
  })

  it('blocks ACTIVITY_NOT_OFFERED when the activity exists but is not offered in this run (near-miss: choice 2 still resolves)', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Chess', 'Art'))
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.BLOCKED,
      reason: CHOICE_REASONS.ACTIVITY_NOT_OFFERED,
    })
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED })
  })

  it('blocks UNKNOWN_ACTIVITY when the text matches no activity at all (near-miss: choice 2 still resolves)', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Nonexistent Thing', 'Art'))
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.BLOCKED,
      reason: CHOICE_REASONS.UNKNOWN_ACTIVITY,
    })
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED })
  })

  it('blocks AMBIGUOUS_ACTIVITY when the text matches more than one offering (near-miss: choice 2 still resolves)', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Swim', 'Art'), {
      activityIndex: { ...ACTIVITY_INDEX, Swim: ['act-swim', 'act-swim-2'] },
    })
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.BLOCKED,
      reason: CHOICE_REASONS.AMBIGUOUS_ACTIVITY,
    })
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED })
  })

  it('treats an explicitly-mapped noPreferenceValues literal as no preference, never a rank', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'None', 'Art'))
    expect(result.choiceResolutions[0]).toMatchObject({ status: CHOICE_STATUS.NO_PREFERENCE })
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED })
  })

  it('errors BLANK_RANK on a blank cell, never treating it as no-preference (near-miss: choice 2 still resolves)', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', '', 'Art'))
    expect(result.rowResults[0].rowErrors).toEqual([{ reason: ROW_ERROR_REASONS.BLANK_RANK, rank: 1 }])
    expect(result.choiceResolutions[1]).toMatchObject({ status: CHOICE_STATUS.RESOLVED })
    expect(result.blockedCount).toBe(1)
  })

  it('errors DUPLICATE_RANK when two rank slots resolve to the same occurrence', () => {
    const result = resolveOne(row('Brand New', 'Bunk A', '', 'Swim', 'Swim'))
    expect(result.rowResults[0].rowErrors).toEqual([{ reason: ROW_ERROR_REASONS.DUPLICATE_RANK, rank: 2 }])
    expect(result.blockedCount).toBe(1)
  })
})

describe('linked choice atomicity', () => {
  const LINKED_MAPPING = {
    ...MAPPING,
    choices: [{ label: 'Double Swim', isLinked: true, memberColumns: [3, 4] }],
  }

  it('resolves a valid 2-member linked choice as one choice with two members', () => {
    const result = resolvePreferenceImport({
      rows: [row('Brand New', 'Bunk A', '', 'Swim', 'Art')],
      headers: HEADERS,
      mapping: LINKED_MAPPING,
      groups: GROUPS,
      occurrenceIndex: OCCURRENCE_INDEX,
      activityIndex: ACTIVITY_INDEX,
      offeringIndex: OFFERING_INDEX,
    })
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.RESOLVED,
      isLinked: true,
      members: [
        { activityId: 'act-swim', occurrenceId: 'occ-swim' },
        { activityId: 'act-art', occurrenceId: 'occ-art' },
      ],
    })
  })

  it('blocks UNSUPPORTED_LINKED_CHOICE when one member is outside the run, and the valid member does NOT resolve independently', () => {
    const result = resolvePreferenceImport({
      rows: [row('Brand New', 'Bunk A', '', 'Swim', 'Chess')],
      headers: HEADERS,
      mapping: LINKED_MAPPING,
      groups: GROUPS,
      occurrenceIndex: OCCURRENCE_INDEX,
      activityIndex: ACTIVITY_INDEX,
      offeringIndex: OFFERING_INDEX,
    })
    expect(result.choiceResolutions).toHaveLength(1)
    expect(result.choiceResolutions[0]).toMatchObject({
      status: CHOICE_STATUS.BLOCKED,
      reason: CHOICE_REASONS.UNSUPPORTED_LINKED_CHOICE,
    })
    // The valid 'Swim' member must not appear anywhere as an independently
    // resolved member — the choice is all-or-nothing.
    expect(result.choiceResolutions[0].members).toBeUndefined()
  })
})

describe('determinism', () => {
  it('produces identical output for identical input on repeated calls', () => {
    const args = {
      rows: [row('Brand New', 'Bunk A', '', 'Swim', 'Art')],
      headers: HEADERS,
      mapping: MAPPING,
      groups: GROUPS,
      occurrenceIndex: OCCURRENCE_INDEX,
      activityIndex: ACTIVITY_INDEX,
      offeringIndex: OFFERING_INDEX,
    }
    expect(resolvePreferenceImport(args)).toEqual(resolvePreferenceImport(args))
  })
})
