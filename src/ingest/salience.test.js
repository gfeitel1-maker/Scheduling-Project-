// Test-first: written before salience.js exists.
// docs/adr/2026-08-17-onescreen-reconciliation-projection.md — Seam 2.
// Table-driven, no report-shape dependency — synthetic (decision, blastRadiusIndex) inputs only.

import { describe, it, expect } from 'vitest'
import { salienceOf } from './salience.js'

function decision(overrides) {
  return {
    id: 'x', kind: 'confirm_value', entity: 'activities', entityId: 'a1',
    entityName: 'Swim', field: ['priority'], confidence: 'low', proposedValue: 3,
    ...overrides,
  }
}

describe('salienceOf', () => {
  it('confirm_change is always rank 0, regardless of blast radius or confidence', () => {
    const blastRadiusIndex = new Map()
    expect(salienceOf(decision({ kind: 'confirm_change', confidence: 'changed' }), blastRadiusIndex))
      .toEqual({ rank: 0, reason: 'confirmed-change' })
  })

  it('confirm_change stays rank 0 even with zero blast radius', () => {
    const blastRadiusIndex = new Map([['activities:a1', 0]])
    const result = salienceOf(decision({ kind: 'confirm_change', confidence: 'changed' }), blastRadiusIndex)
    expect(result.rank).toBe(0)
  })

  it('a low-confidence decision with blast radius >= 1 is rank 1 (high-blast-radius)', () => {
    const blastRadiusIndex = new Map([['activities:a1', 1]])
    const result = salienceOf(decision({ confidence: 'low' }), blastRadiusIndex)
    expect(result).toEqual({ rank: 1, reason: 'high-blast-radius' })
  })

  it('a medium-confidence decision with blast radius >= 1 is rank 1', () => {
    const blastRadiusIndex = new Map([['activities:a1', 3]])
    const result = salienceOf(decision({ confidence: 'medium' }), blastRadiusIndex)
    expect(result.rank).toBe(1)
  })

  it('a decision with zero blast radius is rank 2 (routine), regardless of confidence tier', () => {
    const blastRadiusIndex = new Map()
    const result = salienceOf(decision({ confidence: 'low' }), blastRadiusIndex)
    expect(result).toEqual({ rank: 2, reason: 'routine' })
  })

  it('a decision missing from the blast radius index entirely defaults to rank 2', () => {
    const blastRadiusIndex = new Map([['locations:loc-9', 5]])
    const result = salienceOf(decision({ confidence: 'medium' }), blastRadiusIndex)
    expect(result.rank).toBe(2)
  })

  it('a high-confidence decision with blast radius is still rank 2 (blast radius only lifts low/medium)', () => {
    const blastRadiusIndex = new Map([['activities:a1', 4]])
    const result = salienceOf(decision({ confidence: 'high' }), blastRadiusIndex)
    expect(result.rank).toBe(2)
  })

  it('resolve_conflict is exempt from ranking — always rank 0, distinct reason', () => {
    const blastRadiusIndex = new Map()
    const result = salienceOf(
      decision({ kind: 'resolve_conflict', confidence: 'conflict', entityId: null }),
      blastRadiusIndex,
    )
    expect(result.rank).toBe(0)
    expect(result.reason).toBe('held-conflict')
  })

  it('review_legacy_priority (batch, entityId null) follows the ordinary confidence/blast-radius rule', () => {
    const blastRadiusIndex = new Map()
    const result = salienceOf(
      decision({ kind: 'review_legacy_priority', entityId: null, confidence: 'low' }),
      blastRadiusIndex,
    )
    expect(result).toEqual({ rank: 2, reason: 'routine' })
  })

  it('is deterministic — same inputs always produce the same rank', () => {
    const blastRadiusIndex = new Map([['activities:a1', 2]])
    const d = decision({ confidence: 'low' })
    const first = salienceOf(d, blastRadiusIndex)
    const second = salienceOf(d, blastRadiusIndex)
    expect(second).toEqual(first)
  })

  it('does not mutate the decision or the blastRadiusIndex', () => {
    const blastRadiusIndex = new Map([['activities:a1', 2]])
    const d = decision({ confidence: 'low' })
    const snapshotDecision = { ...d }
    const snapshotIndex = new Map(blastRadiusIndex)
    salienceOf(d, blastRadiusIndex)
    expect(d).toEqual(snapshotDecision)
    expect(blastRadiusIndex).toEqual(snapshotIndex)
  })

  it('defaults blastRadiusIndex to an empty Map when omitted', () => {
    const result = salienceOf(decision({ confidence: 'low' }))
    expect(result).toEqual({ rank: 2, reason: 'routine' })
  })
})
