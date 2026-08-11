// C1 slice — see docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md.
// Test-first: this file is written before reconciliationReport.js exists.

import { describe, it, expect } from 'vitest'
import { buildReconciliationReport } from './reconciliationReport.js'

function readinessRow(key, state) {
  return { key, label: key, screen: null, kind: 'core', state, message: '' }
}

describe('buildReconciliationReport — C1 (plan items + readiness only)', () => {
  it('classifies all five ops, folds buckets from the same pass, and dedups by root cause', () => {
    const planItems = [
      // unchanged -> understood
      {
        op: 'unchanged', entity: 'activities', entity_id: 'a1', fields: {},
        evidence: { tier: 'exact_name', matched_name: 'Swim' }, _name: 'Swim',
      },
      // create, tier 'new' -> HIGH -> understood
      {
        op: 'create', entity: 'activities', entity_id: null, fields: {},
        evidence: { tier: 'new' }, _name: 'Archery',
      },
      // update, HIGH-identity tier (exact_name) -> understood, no decision
      {
        op: 'update', entity: 'activities', entity_id: 'a2',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'exact_name', matched_name: 'Canoe' }, _name: 'Canoe',
      },
      // update, MEDIUM tier, TWO field deltas on the SAME row -> ONE decision (dedup)
      {
        op: 'update', entity: 'activities', entity_id: 'a3',
        fields: {
          min_per_week: { from: 1, to: 3, source: 'import' },
          prefer_before_day: { from: null, to: 'wednesday', source: 'import' },
        },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
      // clear, LOW tier -> one decision
      {
        op: 'clear', entity: 'activities', entity_id: 'a4',
        fields: { location: { from: 'Dock', to: Symbol('clear'), source: 'import' } },
        evidence: { tier: 'low', matched_name: 'Sail' }, _name: 'Sail',
      },
      // conflict -> always a decision, never understood
      {
        op: 'conflict', entity: 'activities', entity_id: null,
        reason: 'ambiguous_identity', fields: {},
        evidence: { tier: 'exact_name', candidates: [{ id: 'x1', name: 'Art' }, { id: 'x2', name: 'Art' }] },
        _name: 'Art',
      },
      // conflict with entity_id present (missing_target)
      {
        op: 'conflict', entity: 'activities', entity_id: 'gone-1',
        reason: 'missing_target', fields: {},
        evidence: { tier: 'uuid' }, _name: 'Fishing',
      },
    ]

    const readiness = [
      readinessRow('groups', 'ready'),
      readinessRow('anchors', 'optional'),
      readinessRow('location', 'optional'),
    ]

    const report = buildReconciliationReport({ planItems, readiness })

    expect(report.buckets).toEqual({
      understood: 3, // unchanged + create(new/HIGH) + update(HIGH-identity)
      needsAttention: 4, // medium-update(1 row) + low-clear(1) + 2 conflicts
      notInSource: 2,
      changed: 0,
    })

    // decisions: medium-update(1, deduped) + low-clear(1) + conflict(1) + conflict(1) = 4
    expect(report.decisions).toHaveLength(4)

    const kayak = report.decisions.find((d) => d.entityId === 'a3')
    expect(kayak).toBeTruthy()
    expect(kayak.kind).toBe('confirm_value')
    expect(kayak.confidence).toBe('medium')
    expect(kayak.entity).toBe('activities')
    expect(kayak.entityName).toBe('Kayak')
    expect(kayak.field).toEqual(expect.arrayContaining(['min_per_week', 'prefer_before_day']))

    const sail = report.decisions.find((d) => d.entityId === 'a4')
    expect(sail).toBeTruthy()
    expect(sail.confidence).toBe('low')

    const ambiguous = report.decisions.find((d) => d.reason === 'ambiguous_identity')
    expect(ambiguous).toBeTruthy()
    expect(ambiguous.kind).toBe('resolve_conflict')
    expect(ambiguous.confidence).toBe('conflict')
    expect(ambiguous.entityId).toBeNull()
    expect(ambiguous.field).toBeNull()

    const missingTarget = report.decisions.find((d) => d.reason === 'missing_target')
    expect(missingTarget).toBeTruthy()
    expect(missingTarget.kind).toBe('resolve_conflict')
    expect(missingTarget.entityId).toBe('gone-1')

    expect(report.meta.planItemCount).toBe(planItems.length)
    expect(report.meta.generatedAt).toBeNull()
  })

  it('emits ZERO decisions for not-in-source readiness rows', () => {
    const readiness = [
      readinessRow('anchors', 'optional'),
      readinessRow('dayoverrides', 'optional'),
      readinessRow('location', 'optional'),
      readinessRow('staffing', 'optional'),
    ]
    const report = buildReconciliationReport({ planItems: [], readiness })
    expect(report.buckets.notInSource).toBe(4)
    expect(report.decisions).toHaveLength(0)
  })

  it('empty plan -> all-zero buckets, empty decisions', () => {
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    expect(report.buckets).toEqual({ understood: 0, needsAttention: 0, notInSource: 0, changed: 0 })
    expect(report.decisions).toEqual([])
    expect(report.meta.planItemCount).toBe(0)
  })

  it('all-conflict plan -> every item a decision, understood 0', () => {
    const planItems = [
      { op: 'conflict', entity: 'groups', entity_id: null, reason: 'ambiguous_identity', fields: {}, evidence: { tier: 'exact_name' }, _name: 'Reds' },
      { op: 'conflict', entity: 'groups', entity_id: 'g1', reason: 'missing_target', fields: {}, evidence: { tier: 'uuid' }, _name: 'Blues' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.buckets.understood).toBe(0)
    expect(report.buckets.needsAttention).toBe(2)
    expect(report.decisions).toHaveLength(2)
  })

  it('missing evidence.tier defaults deterministically to the safest (LOW) bucket, never throws', () => {
    const planItems = [
      { op: 'create', entity: 'activities', entity_id: null, fields: {}, evidence: {}, _name: 'Mystery' },
      { op: 'update', entity: 'activities', entity_id: 'a9', fields: { location: { from: 'A', to: 'B', source: 'import' } }, evidence: {}, _name: 'Mystery2' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.buckets.needsAttention).toBe(2)
    expect(report.decisions).toHaveLength(2)
    expect(report.decisions.every((d) => d.confidence === 'low')).toBe(true)
  })

  it('bucket-count invariant: understood + needsAttention accounts for every non-notInSource item, decisions.length never exceeds needsAttention', () => {
    const planItems = [
      { op: 'unchanged', entity: 'activities', entity_id: 'a1', fields: {}, evidence: { tier: 'exact_name' }, _name: 'Swim' },
      { op: 'create', entity: 'activities', entity_id: null, fields: {}, evidence: { tier: 'new' }, _name: 'Archery' },
      { op: 'update', entity: 'activities', entity_id: 'a3', fields: { location: { from: 'A', to: 'B', source: 'import' } }, evidence: { tier: 'low', matched_name: 'Kayak' }, _name: 'Kayak' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.buckets.understood + report.buckets.needsAttention).toBe(planItems.length)
    expect(report.decisions.length).toBeLessThanOrEqual(report.buckets.needsAttention)
    // 'changed' bucket exists structurally even though C1 never populates it
    expect(report.buckets.changed).toBe(0)
  })

  it('respects an explicit input.now for meta.generatedAt (purity: never calls Date.now internally)', () => {
    const report = buildReconciliationReport({ planItems: [], readiness: [], now: '2026-08-11T00:00:00.000Z' })
    expect(report.meta.generatedAt).toBe('2026-08-11T00:00:00.000Z')
  })
})
