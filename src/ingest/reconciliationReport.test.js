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

  // Round-2 fix: distinct null-entity_id rows (conflict/create) must NOT
  // collapse into one decision just because they share (entity, null, reason).
  it('two distinct null-entityId conflict rows on the same entity do not collapse', () => {
    const planItems = [
      {
        op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
        fields: {}, evidence: { tier: 'exact_name', candidates: [{ id: 'x1', name: 'Art' }, { id: 'x2', name: 'Art' }] },
        _name: 'Art',
      },
      {
        op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity',
        fields: {}, evidence: { tier: 'exact_name', candidates: [{ id: 'y1', name: 'Free Time' }, { id: 'y2', name: 'Free Time' }] },
        _name: 'Free Time',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.decisions).toHaveLength(2)
    expect(report.buckets.needsAttention).toBe(2)
    const names = report.decisions.map((d) => d.entityName).sort()
    expect(names).toEqual(['Art', 'Free Time'])
  })

  it('two distinct null-entityId LOW/MEDIUM creates on the same entity do not collapse (latent C2b/C4 case)', () => {
    const planItems = [
      { op: 'create', entity: 'activities', entity_id: null, fields: {}, evidence: { tier: 'low' }, _name: 'Ceramics' },
      { op: 'create', entity: 'activities', entity_id: null, fields: {}, evidence: { tier: 'low' }, _name: 'Pottery' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.decisions).toHaveLength(2)
    expect(report.buckets.needsAttention).toBe(2)
  })

  it('non-null-entityId multi-field-delta dedup still collapses to one decision after the key fix', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a3',
        fields: {
          min_per_week: { from: 1, to: 3, source: 'import' },
          prefer_before_day: { from: null, to: 'wednesday', source: 'import' },
        },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].field).toEqual(expect.arrayContaining(['min_per_week', 'prefer_before_day']))
  })

  it('populates proposedValue from item.fields[field].to for a single-field decision', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a5',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'low', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].proposedValue).toBe('Field')
  })

  it('conflict decisions keep proposedValue null (no single proposed value)', () => {
    const planItems = [
      { op: 'conflict', entity: 'activities', entity_id: null, reason: 'ambiguous_identity', fields: {}, evidence: { tier: 'exact_name' }, _name: 'Art' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    expect(report.decisions[0].proposedValue).toBeNull()
  })
})

describe('buildReconciliationReport — C2a (fixedEventsReport side channel)', () => {
  it('a single moved entry buckets as changed and emits one confirm_change decision', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: [{ name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }] },
    })
    expect(report.buckets.changed).toBe(1)
    expect(report.decisions).toHaveLength(1)
    const d = report.decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.entity).toBe('anchor_activities')
    expect(d.entityId).toBeNull()
    expect(d.entityName).toBe('Campfire')
    expect(d.field).toBeNull()
    expect(d.reason).toBe('moved from Mon/Morning to Tue/Morning')
  })

  it('two distinct moved entries produce two decisions and buckets.changed === 2', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [
          { name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' },
          { name: 'Color War', reason: 'moved from Wed/Afternoon to Thu/Afternoon' },
        ],
      },
    })
    expect(report.buckets.changed).toBe(2)
    expect(report.decisions).toHaveLength(2)
  })

  it('two identical moved entries (same name and reason) fold to one decision but count two facts in buckets.changed', () => {
    const entry = { name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: [entry, { ...entry }] },
    })
    // buckets fold over every fact seen (mirrors how C1 folds buckets over every plan item)
    expect(report.buckets.changed).toBe(2)
    // decisions dedup by root cause (entity, null, kind, reason, name) — same as C1's create/conflict keying
    expect(report.decisions).toHaveLength(1)
  })

  it('a partial entry buckets as needsAttention and emits one confirm_value decision', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { partial: [{ name: 'Scavenger Hunt', reason: 'groups not imported' }] },
    })
    expect(report.buckets.needsAttention).toBe(1)
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].kind).toBe('confirm_value')
    expect(report.decisions[0].entity).toBe('anchor_activities')
    expect(report.decisions[0].entityName).toBe('Scavenger Hunt')
    expect(report.decisions[0].reason).toBe('groups not imported')
  })

  it('a moved entry and a partial entry sharing the same name+reason yield TWO decisions (kind-qualified dedup key)', () => {
    const shared = { name: 'Campfire', reason: 'groups not imported' }
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: [shared], partial: [{ ...shared }] },
    })
    expect(report.decisions).toHaveLength(2)
    const kinds = report.decisions.map((d) => d.kind).sort()
    expect(kinds).toEqual(['confirm_change', 'confirm_value'])
  })

  it('skipped entries contribute neither a decision nor any bucket', () => {
    const before = buildReconciliationReport({ planItems: [], readiness: [] })
    const after = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { skipped: [{ name: 'Ghost Event', reason: 'time block or day not created' }] },
    })
    expect(after.buckets).toEqual(before.buckets)
    expect(after.decisions).toEqual(before.decisions)
  })

  it('rejected entries (director-tombstoned slots) contribute neither a decision nor any bucket', () => {
    const before = buildReconciliationReport({ planItems: [], readiness: [] })
    const after = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { rejected: [{ name: 'Declined Anchor', reason: 'previously rejected by director' }] },
    })
    expect(after.buckets).toEqual(before.buckets)
    expect(after.decisions).toEqual(before.decisions)
  })

  it('created and unchanged entries bucket as understood and emit no decision', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        created: [{ name: 'New Anchor', reason: null }],
        unchanged: [{ name: 'Stable Anchor', reason: null }],
      },
    })
    expect(report.buckets.understood).toBe(2)
    expect(report.decisions).toHaveLength(0)
  })

  it('a fixture literally shaped like ingest.js output (moved/partial/skipped/created/unchanged/rejected) folds non-empty', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        created: [{ name: 'New Anchor', reason: null }],
        unchanged: [{ name: 'Stable Anchor', reason: null }],
        skipped: [{ name: 'Ghost Event', reason: 'time block or day not created' }],
        partial: [{ name: 'Scavenger Hunt', reason: 'groups not imported' }],
        rejected: [{ name: 'Declined Anchor', reason: 'previously rejected by director' }],
        moved: [{ name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }],
      },
    })
    expect(report.buckets.changed).toBe(1)
    expect(report.buckets.needsAttention).toBe(1)
    expect(report.buckets.understood).toBe(2)
    expect(report.decisions).toHaveLength(2)
  })

  it('every decision this slice emits has confidence within the ADR-documented 5-value set', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [{ name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }],
        partial: [{ name: 'Scavenger Hunt', reason: 'groups not imported' }],
      },
    })
    const allowed = new Set(['high', 'medium', 'low', 'conflict', 'changed'])
    expect(report.decisions.length).toBeGreaterThan(0)
    expect(report.decisions.every((d) => allowed.has(d.confidence))).toBe(true)
  })

  it('null side-channel fields do not throw and are a no-op (defaults only cover undefined, not null)', () => {
    const base = buildReconciliationReport({ planItems: [], readiness: [] })
    expect(() => buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { moved: null, partial: null },
    })).not.toThrow()
    const withNulls = buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { moved: null, partial: null },
    })
    expect(withNulls).toEqual(base)
  })

  it('additive proof: an absent fixedEventsReport key equals passing all-empty arrays explicitly', () => {
    const base = { planItems: [], readiness: [] }
    const withoutKey = buildReconciliationReport(base)
    const withEmptyArrays = buildReconciliationReport({
      ...base,
      fixedEventsReport: { moved: [], partial: [], skipped: [], created: [], unchanged: [], rejected: [] },
    })
    expect(withoutKey).toEqual(withEmptyArrays)
  })

  it('malformed/empty fixedEventsReport input does not throw and is a no-op', () => {
    const base = buildReconciliationReport({ planItems: [], readiness: [] })
    expect(() => buildReconciliationReport({ planItems: [], readiness: [], fixedEventsReport: {} })).not.toThrow()
    const withEmptyObject = buildReconciliationReport({ planItems: [], readiness: [], fixedEventsReport: {} })
    expect(withEmptyObject).toEqual(base)
  })
})
