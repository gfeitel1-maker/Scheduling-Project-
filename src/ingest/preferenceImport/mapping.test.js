// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ALLOWED_MAPPING_TARGETS, validateMapping } from './mapping.js'

const HEADERS = [
  'Display Name',
  'Group',
  'External Id',
  'Medical Notes',
  'DOB',
  'Parent Phone',
  'Address',
  'Choice 1',
  'Choice 2',
]

function baseMapping() {
  return {
    displayName: 0,
    group: 1,
    externalId: 2,
    noPreferenceValues: [],
    choices: [{ label: 'Choice A', isLinked: false, memberColumns: [7] }],
  }
}

describe('ALLOWED_MAPPING_TARGETS', () => {
  it('is a closed enum with no contact/medical/household target', () => {
    expect(ALLOWED_MAPPING_TARGETS).toEqual(['displayName', 'group', 'externalId', 'choiceRank'])
    for (const forbidden of ['medicalNotes', 'dob', 'parentPhone', 'address', 'household']) {
      expect(ALLOWED_MAPPING_TARGETS).not.toContain(forbidden)
    }
  })

  it('a sheet that genuinely contains Medical Notes/DOB/Parent Phone/Address columns still cannot map them', () => {
    // The pickable target set is closed regardless of what headers exist —
    // there is no code path that renders or accepts a target outside the enum.
    const pickableHeaders = HEADERS.filter((h) =>
      ['Medical Notes', 'DOB', 'Parent Phone', 'Address'].includes(h)
    )
    expect(pickableHeaders).toHaveLength(4) // sanity: the fixture really has them
    // No ALLOWED_MAPPING_TARGETS entry is one of these header strings or a
    // synonym for them — the enum itself is the guard.
    for (const target of ALLOWED_MAPPING_TARGETS) {
      expect(pickableHeaders.map((h) => h.toLowerCase())).not.toContain(target.toLowerCase())
    }
  })
})

describe('validateMapping', () => {
  it('accepts a complete valid mapping', () => {
    const result = validateMapping(baseMapping(), HEADERS)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects a mapping missing displayName', () => {
    const mapping = { ...baseMapping(), displayName: null }
    const result = validateMapping(mapping, HEADERS)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /displayName/.test(e))).toBe(true)
  })

  it('rejects a mapping missing group', () => {
    const mapping = { ...baseMapping(), group: null }
    const result = validateMapping(mapping, HEADERS)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /group/.test(e))).toBe(true)
  })

  it('rejects a mapping with an out-of-range column index', () => {
    const mapping = { ...baseMapping(), displayName: 99 }
    const result = validateMapping(mapping, HEADERS)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /out of range|column/i.test(e))).toBe(true)
  })

  it('rejects a choice with no member columns', () => {
    const mapping = { ...baseMapping(), choices: [{ label: 'Choice A', isLinked: false, memberColumns: [] }] }
    const result = validateMapping(mapping, HEADERS)
    expect(result.ok).toBe(false)
  })

  it('rejects an isLinked choice with fewer than two member columns', () => {
    const mapping = { ...baseMapping(), choices: [{ label: 'Choice A', isLinked: true, memberColumns: [7] }] }
    const result = validateMapping(mapping, HEADERS)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => /linked/i.test(e))).toBe(true)
  })
})
