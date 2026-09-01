import { describe, it, expect } from 'vitest'
import {
  buildActivityNameCanonicalMap,
  canonicalizeActivityName,
  activityNamesFromCell,
} from './extractEntities.js'
import { inferMultiBlockCandidates } from './multiBlockCandidates.js'

// Typo-merge canonicalization (①/③ ingest fix): pure whitespace/case variants of
// an activity name fold onto one dominant spelling BEFORE any name is read into
// an entity or a fixed-event footprint. Word-form differences are NEVER merged.

function pagesWith(cellRows) {
  // one page, one column of cells per row
  return [{ title: 'G', columns: ['Monday'], rows: cellRows.map((c) => ({ label: '09:00', cells: [c] })) }]
}

describe('buildActivityNameCanonicalMap', () => {
  it('folds a whitespace/case variant onto the dominant spelling', () => {
    // "Lunch 2" x3, "Lunch2" x1 -> dominant "Lunch 2"
    const map = buildActivityNameCanonicalMap(pagesWith(['Lunch 2', 'Lunch 2', 'Lunch2', 'Lunch 2']))
    expect(map.get('lunch2')).toBe('Lunch 2')
  })

  it('NEVER merges a word-ending difference (Swim Return vs Swim Returning)', () => {
    const map = buildActivityNameCanonicalMap(pagesWith(['Swim Return', 'Swim Return', 'Swim Returning']))
    // two distinct keys -> neither is a variant of the other -> map is empty
    expect(map.has('swimreturn')).toBe(false)
    expect(map.has('swimreturning')).toBe(false)
    expect(map.size).toBe(0)
  })

  it('is a no-op for a clean file (no whitespace variance -> empty map)', () => {
    const map = buildActivityNameCanonicalMap(pagesWith(['Swim', 'Sports', 'Drama']))
    expect(map.size).toBe(0)
  })

  it('case-only variants fold together too', () => {
    const map = buildActivityNameCanonicalMap(pagesWith(['Swim', 'Swim', 'SWIM']))
    expect(map.get('swim')).toBe('Swim') // majority spelling
  })

  it('on a count tie, the spelling WITH whitespace wins (the human spelling)', () => {
    const map = buildActivityNameCanonicalMap(pagesWith(['Lunch 2', 'Lunch2']))
    expect(map.get('lunch2')).toBe('Lunch 2')
  })
})

describe('canonicalizeActivityName', () => {
  it('applies the map; unmapped names pass through unchanged', () => {
    const map = new Map([['lunch2', 'Lunch 2']])
    expect(canonicalizeActivityName('Lunch2', map)).toBe('Lunch 2')
    expect(canonicalizeActivityName('Swim', map)).toBe('Swim')
  })

  it('an undefined map is identity (no-op)', () => {
    expect(canonicalizeActivityName('Lunch2', undefined)).toBe('Lunch2')
  })
})

describe('activityNamesFromCell with a canonical map', () => {
  it('reads a variant cell to the canonical spelling', () => {
    const map = new Map([['lunch2', 'Lunch 2']])
    expect(activityNamesFromCell('Lunch2', map)).toEqual(['Lunch 2'])
  })

  it('without a map, returns the raw spelling (backward compatible)', () => {
    expect(activityNamesFromCell('Lunch2')).toEqual(['Lunch2'])
  })
})

// Red Hat HIGH: the multi-block ("Longer Blocks") import path is the THIRD
// caller of activityNamesFromCell — it must fold a typo through the same map,
// or a merged-cell "Lunch2" surfaces a candidate spelled differently from the
// catalog activity and commits a mismatched anchor.
describe('inferMultiBlockCandidates canonicalizes through proposal.canonicalMap', () => {
  it('folds a whitespace-typo in a multi-block cell onto the canonical spelling', () => {
    const parsed = {
      pages: [{
        title: 'Aleph',
        columns: ['Monday'],
        rows: [{ label: '09:00', cells: ['Lunch2'], blockSpans: [2] }],
      }],
    }
    const proposal = {
      orientation: { columns: 'days' },
      groupNameByTitle: { Aleph: 'Aleph' },
      entities: { groups: ['Aleph'] },
      canonicalMap: new Map([['lunch2', 'Lunch 2']]),
    }
    const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
    expect(multiBlockCandidates.map((c) => c.name)).toEqual(['Lunch 2'])
    expect(multiBlockCandidates.some((c) => c.name === 'Lunch2')).toBe(false)
  })
})
