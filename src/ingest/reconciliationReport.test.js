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

// C3 — group-scope-drift signal, folded exactly like C2a's `moved`.
// electron/ops/ingest.js:1256 (fixedScopeChanged push), :1347 (attached as
// fixedEvents.scopeChanged). Same shape as `moved`: Array<{name, reason}>.
describe('buildReconciliationReport — C3 (fixedEventsReport.scopeChanged)', () => {
  it('a single scopeChanged entry buckets as changed and emits one confirm_change decision', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        scopeChanged: [{ name: 'Campfire', reason: 'scope changed from Cabin 3 to Camp-wide' }],
      },
    })
    expect(report.buckets.changed).toBe(1)
    expect(report.decisions).toHaveLength(1)
    const d = report.decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.confidence).toBe('changed')
    expect(d.entity).toBe('anchor_activities')
    expect(d.entityName).toBe('Campfire')
    expect(d.reason).toBe('scope changed from Cabin 3 to Camp-wide')
  })

  it('two identical scopeChanged entries (same name+reason) fold to one decision but count two facts', () => {
    const entry = { name: 'Campfire', reason: 'scope changed from Cabin 3 to Camp-wide' }
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { scopeChanged: [entry, { ...entry }] },
    })
    expect(report.buckets.changed).toBe(2)
    expect(report.decisions).toHaveLength(1)
  })

  it('two distinct scopeChanged entries produce two decisions and buckets.changed === 2', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        scopeChanged: [
          { name: 'Campfire', reason: 'scope changed from Cabin 3 to Camp-wide' },
          { name: 'Color War', reason: 'scope changed from Camp-wide to Cabin 5' },
        ],
      },
    })
    expect(report.buckets.changed).toBe(2)
    expect(report.decisions).toHaveLength(2)
  })

  it('a moved entry and a scopeChanged entry for the same event with different reasons yield TWO decisions', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [{ name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }],
        scopeChanged: [{ name: 'Campfire', reason: 'scope changed from Cabin 3 to Camp-wide' }],
      },
    })
    expect(report.buckets.changed).toBe(2)
    expect(report.decisions).toHaveLength(2)
  })

  it('a moved entry and a scopeChanged entry with the SAME name AND identical reason string fold to ONE decision', () => {
    // Documents the key-collapse explicitly: fixedEventDecisionId keys on
    // (entity, kind, reason, name) — NOT on which side-channel array an entry
    // came from. Both `moved` and `scopeChanged` entries are folded via the
    // same addFixedEventDecision call with kind: 'confirm_change', so an
    // identical name+reason pair from either channel collapses to the same
    // decision. This is an artificial case (ingest.js's real reason strings
    // for moved vs scope-changed always differ), asserted here so the
    // collapse is a documented behavior, not a silent surprise.
    const shared = { name: 'Campfire', reason: 'identical reason string' }
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: [shared], scopeChanged: [{ ...shared }] },
    })
    expect(report.buckets.changed).toBe(2)
    expect(report.decisions).toHaveLength(1)
  })

  it('additive proof: an absent scopeChanged key equals passing scopeChanged: []', () => {
    const withMoved = { moved: [{ name: 'Campfire', reason: 'moved from Mon/Morning to Tue/Morning' }] }
    const withoutKey = buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: withMoved,
    })
    const withEmptyScopeChanged = buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { ...withMoved, scopeChanged: [] },
    })
    expect(withoutKey).toEqual(withEmptyScopeChanged)
  })

  it('null/empty scopeChanged do not throw and are a no-op', () => {
    const base = buildReconciliationReport({ planItems: [], readiness: [] })
    expect(() => buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { scopeChanged: null },
    })).not.toThrow()
    const withNull = buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { scopeChanged: null },
    })
    expect(withNull).toEqual(base)
    const withEmpty = buildReconciliationReport({
      planItems: [], readiness: [], fixedEventsReport: { scopeChanged: [] },
    })
    expect(withEmpty).toEqual(base)
  })
})

// C2b — legacy import-sourced priority review, batched into ONE decision.
// docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md, "Resolved
// 2026-08-11" section: OQ3 = BATCH (one "N priorities need review" decision,
// not one-per-activity). docs/adr/2026-08-10-legacy-import-priority-backfill.md
// rejected auto-clearing — source='import' cannot distinguish a manufactured
// default from a director-typed value from an accepted-conflict value, so
// Shoresh surfaces for review instead of acting.
describe('buildReconciliationReport — C2b (legacyPriorityActivities, batched review decision)', () => {
  const legacySet = [
    { entity_id: 'act-1', name: 'Swimming' },
    { entity_id: 'act-2', name: 'Archery' },
    { entity_id: 'act-3', name: 'Canoe' },
  ]

  it('N=3 legacy import-sourced priorities fold into exactly ONE needsAttention decision', () => {
    const withLegacy = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: legacySet,
    })
    const withoutLegacy = buildReconciliationReport({ planItems: [], readiness: [] })

    const legacyDecisions = withLegacy.decisions.filter((d) => d.kind === 'review_legacy_priority')
    expect(legacyDecisions).toHaveLength(1)

    const decision = legacyDecisions[0]
    expect(decision.id).toBe('activities:legacy_priority')
    expect(decision.entity).toBe('activities')
    expect(decision.entityId).toBeNull()
    expect(decision.entityName).toBeNull()
    expect(decision.field).toBe('priority')
    expect(decision.confidence).toBe('low')
    expect(decision.proposedValue).toBeNull()
    expect(decision.count).toBe(3)
    expect(decision.activities).toEqual([
      { entityId: 'act-1', name: 'Swimming' },
      { entityId: 'act-2', name: 'Archery' },
      { entityId: 'act-3', name: 'Canoe' },
    ])
    expect(decision.unknowns).toEqual([])
    expect(decision.evidence).toBeNull()
    expect(typeof decision.reason).toBe('string')
    expect(decision.reason.length).toBeGreaterThan(0)

    expect(withLegacy.buckets.needsAttention).toBe(withoutLegacy.buckets.needsAttention + 1)
  })

  it('empty legacyPriorityActivities → no decision, buckets byte-identical to the no-legacy call', () => {
    const withoutLegacy = buildReconciliationReport({ planItems: [], readiness: [] })
    const withEmpty = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: [],
    })
    expect(withEmpty).toEqual(withoutLegacy)
  })

  it('absent/undefined legacyPriorityActivities → no decision, buckets byte-identical to the no-legacy call', () => {
    const withoutLegacy = buildReconciliationReport({ planItems: [], readiness: [] })
    const withUndefined = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: undefined,
    })
    const withNull = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: null,
    })
    expect(withUndefined).toEqual(withoutLegacy)
    expect(withNull).toEqual(withoutLegacy)
  })

  it('additive proof: a report without legacyPriorityActivities is unchanged by the new field existing', () => {
    const c2aShaped = buildReconciliationReport({ planItems: [], readiness: [] })
    expect(c2aShaped.decisions.some((d) => d.kind === 'review_legacy_priority')).toBe(false)
    expect(c2aShaped.buckets).toEqual({ understood: 0, needsAttention: 0, notInSource: 0, changed: 0 })
  })

  it('never proposes clearing: proposedValue is null and no decision kind/field implies clear or removal', () => {
    const report = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: legacySet,
    })
    for (const decision of report.decisions) {
      if (decision.kind === 'review_legacy_priority') {
        expect(decision.proposedValue).toBeNull()
      }
      expect(decision.kind).not.toMatch(/clear|remove/i)
    }
  })

  it('drops malformed rows (no entity_id) but keeps well-formed ones, count reflects filtered set', () => {
    const mixed = [
      { entity_id: 'act-1', name: 'Swimming' },
      { name: 'X' }, // malformed — no entity_id
    ]
    const report = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: mixed,
    })
    const decision = report.decisions.find((d) => d.kind === 'review_legacy_priority')
    expect(decision.count).toBe(1)
    expect(decision.activities).toEqual([{ entityId: 'act-1', name: 'Swimming' }])
  })

  it('a set of only malformed rows produces no decision, buckets unchanged, does not throw', () => {
    const withoutLegacy = buildReconciliationReport({ planItems: [], readiness: [] })
    const onlyMalformed = [{ name: 'X' }, { entity_id: null, name: 'Y' }, { entity_id: undefined, name: 'Z' }]
    expect(() => buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: onlyMalformed,
    })).not.toThrow()
    const report = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: onlyMalformed,
    })
    expect(report.decisions.some((d) => d.kind === 'review_legacy_priority')).toBe(false)
    expect(report.buckets).toEqual(withoutLegacy.buckets)
  })

  it('preserves every id even when names duplicate', () => {
    const dupNames = [
      { entity_id: 'act-1', name: 'Swimming' },
      { entity_id: 'act-2', name: 'Swimming' },
    ]
    const report = buildReconciliationReport({
      planItems: [], readiness: [], legacyPriorityActivities: dupNames,
    })
    const decision = report.decisions.find((d) => d.kind === 'review_legacy_priority')
    expect(decision.count).toBe(2)
    expect(decision.activities.map((a) => a.entityId)).toEqual(['act-1', 'act-2'])
  })
})

// C4 — fieldProvenance-aware CHANGED classification for update/clear items.
// docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md, "Bucketing" rule 4:
// a delta on a 'human'-provenance field overwrites a director's confirmed
// value -> CHANGED, always a decision (confirm_change), regardless of tier.
// 'import' | absent -> routine refinement, falls through to the same
// HIGH/MEDIUM/LOW classification create/update already use.
describe('buildReconciliationReport — C4 (fieldProvenance-aware CHANGED)', () => {
  const highTierUpdate = (entityId, fields, name = 'Sail') => ({
    op: 'update', entity: 'activities', entity_id: entityId,
    fields, evidence: { tier: 'exact_name', matched_name: name }, _name: name,
  })

  it('a HIGH-tier update to a HUMAN-provenance field forces exactly one confirm_change decision, tier overridden', () => {
    const planItems = [
      highTierUpdate('a10', { location: { from: 'Dock', to: 'Field', source: 'import' } }),
    ]
    const fieldProvenance = new Map([['activities:a10:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.buckets.changed).toBe(1)
    expect(report.buckets.understood).toBe(0)
    expect(report.decisions).toHaveLength(1)
    const d = report.decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.confidence).toBe('changed')
    expect(d.entityId).toBe('a10')
    expect(d.field).toEqual(['location'])
    expect(d.proposedValue).toBe('Field')
  })

  it('the SAME update with IMPORT-provenance on that field is unaffected — HIGH tier still understood, no decision', () => {
    const planItems = [
      highTierUpdate('a11', { location: { from: 'Dock', to: 'Field', source: 'import' } }),
    ]
    const fieldProvenance = new Map([['activities:a11:location', 'import']])
    const withProvenance = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })
    const withoutProvenance = buildReconciliationReport({ planItems, readiness: [] })

    expect(withProvenance.buckets.changed).toBe(0)
    expect(withProvenance.buckets.understood).toBe(1)
    expect(withProvenance.decisions).toHaveLength(0)
    expect(withProvenance).toEqual(withoutProvenance)
  })

  it('additive proof: absent fieldProvenance input is byte-identical to the pre-C4 run', () => {
    const planItems = [
      highTierUpdate('a12', { location: { from: 'Dock', to: 'Field', source: 'import' } }),
      {
        op: 'update', entity: 'activities', entity_id: 'a13',
        fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const withoutKey = buildReconciliationReport({ planItems, readiness: [] })
    const withUndefined = buildReconciliationReport({ planItems, readiness: [], fieldProvenance: undefined })
    const withEmptyMap = buildReconciliationReport({ planItems, readiness: [], fieldProvenance: new Map() })

    expect(withUndefined).toEqual(withoutKey)
    expect(withEmptyMap).toEqual(withoutKey)
  })

  it('a MIXED row (one human + one import field, HIGH tier) collapses to ONE confirm_change decision listing only the human field', () => {
    const planItems = [
      highTierUpdate('a14', {
        location: { from: 'Dock', to: 'Field', source: 'import' },
        min_per_week: { from: 1, to: 2, source: 'import' },
      }),
    ]
    // location is human-owned (director confirmed it), min_per_week is a routine import refinement.
    const fieldProvenance = new Map([
      ['activities:a14:location', 'human'],
      ['activities:a14:min_per_week', 'import'],
    ])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    const d = report.decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.confidence).toBe('changed')
    // Only the human-provenance field is listed: that's the director-set value
    // actually at stake ("surface the director's value at stake"), not the
    // routine import refinement riding along on the same row.
    expect(d.field).toEqual(['location'])
    expect(d.proposedValue).toBe('Field')
    expect(report.buckets.changed).toBe(1)
  })

  it('a clear on a human-provenance field is CHANGED — the most destructive delta', () => {
    const planItems = [
      {
        op: 'clear', entity: 'activities', entity_id: 'a15',
        fields: { location: { from: 'Dock', to: Symbol('clear'), source: 'import' } },
        evidence: { tier: 'exact_name', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a15:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].kind).toBe('confirm_change')
    expect(report.decisions[0].confidence).toBe('changed')
    expect(report.buckets.changed).toBe(1)
  })

  it('two human-provenance fields on the same row fold into ONE confirm_change decision listing both (dedup intact)', () => {
    const planItems = [
      highTierUpdate('a16', {
        location: { from: 'Dock', to: 'Field', source: 'import' },
        min_per_week: { from: 1, to: 2, source: 'import' },
      }),
    ]
    const fieldProvenance = new Map([
      ['activities:a16:location', 'human'],
      ['activities:a16:min_per_week', 'human'],
    ])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].kind).toBe('confirm_change')
    expect(report.decisions[0].field).toEqual(expect.arrayContaining(['location', 'min_per_week']))
    expect(report.buckets.changed).toBe(1)
  })
})

// Round-2 hardening — FIX 1: a merge collision on (entity, entityId) must
// never DOWNGRADE stakes. CHANGED (confirm_change) dominates confirm_value
// on merge — see the merge-rule comment in buildReconciliationReport.
describe('buildReconciliationReport — round-2 FIX 1 (merge preserves CHANGED classification)', () => {
  it('an ordinary field decision arriving BEFORE a human-field decision on the same row merges to confirm_change, preserving the human field + proposedValue', () => {
    // Two synthetic planItems on the SAME entity_id simulate a future multi-item
    // source colliding in decisionsByKey (today's single-item-per-row buildPlan
    // never produces this, but the merge must be correct regardless — Red Hat).
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a20',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a20',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a20:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const decisions = report.decisions.filter((d) => d.entityId === 'a20')
    expect(decisions).toHaveLength(1)
    const merged = decisions[0]
    expect(merged.kind).toBe('confirm_change')
    expect(merged.confidence).toBe('changed')
    expect(merged.field).toEqual(expect.arrayContaining(['location', 'min_per_week']))
    // field.length > 1 after the merge, so proposedValue must be a field->value
    // map combining BOTH sides' values (round-2 FIX: proposedValue must never
    // revert to a scalar that silently drops the loser's value).
    expect(merged.proposedValue).toEqual({ location: 'Field', min_per_week: 2 })

    // buckets stay consistent with the final (merged) decision content: exactly
    // one CHANGED decision exists, so buckets.changed must be >= 1, and the
    // needsAttention count from the first (now-superseded) classification must
    // not leave a phantom confirm_value decision behind.
    expect(report.buckets.changed).toBeGreaterThanOrEqual(1)
    expect(report.decisions.filter((d) => d.entityId === 'a20' && d.kind === 'confirm_value')).toHaveLength(0)
  })

  it('the reverse order (human-field decision arrives FIRST) also merges to confirm_change', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a21',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a21',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a21:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const decisions = report.decisions.filter((d) => d.entityId === 'a21')
    expect(decisions).toHaveLength(1)
    expect(decisions[0].kind).toBe('confirm_change')
    expect(decisions[0].field).toEqual(expect.arrayContaining(['location', 'min_per_week']))
    expect(decisions[0].proposedValue).toEqual({ location: 'Field', min_per_week: 2 })
  })
})

// Round-2 hardening — FIX 1b (Red Hat): a mixed-kind merge collision with
// DIFFERENT fields must not drop the loser's value. Previously, when the
// merged field list grew to length > 1 but the two sides were not BOTH
// confirm_change, proposedValue reverted to the winner's bare scalar,
// silently losing the loser's value — violating the module's own contract
// that field.length > 1 implies a field->value map. Fixed by combining
// proposedValue into a map whenever the MERGED field ends up length > 1,
// regardless of which kinds are on each side.
describe('buildReconciliationReport — round-2 FIX 1b (proposedValue map combines both sides on any mixed merge)', () => {
  const humanFieldItem = (entityId) => ({
    op: 'update', entity: 'activities', entity_id: entityId,
    fields: { name: { from: 'Old Name', to: 'NewName', source: 'import' } },
    evidence: { tier: 'medium', matched_name: 'Old Name' }, _name: 'Old Name',
  })
  const importFieldItem = (entityId) => ({
    op: 'update', entity: 'activities', entity_id: entityId,
    fields: { unit: { from: 'A', to: 'B', source: 'import' } },
    evidence: { tier: 'medium', matched_name: 'Old Name' }, _name: 'Old Name',
  })

  it('human field first, then import field: merged proposedValue is a map with BOTH values', () => {
    const planItems = [humanFieldItem('a60'), importFieldItem('a60')]
    const fieldProvenance = new Map([['activities:a60:name', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const decisions = report.decisions.filter((d) => d.entityId === 'a60')
    expect(decisions).toHaveLength(1)
    const d = decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.confidence).toBe('changed')
    expect(d.field.slice().sort()).toEqual(['name', 'unit'])
    expect(d.proposedValue).toEqual({ name: 'NewName', unit: 'B' })
  })

  it('import field first, then human field (reverse order): merged proposedValue is a map with BOTH values', () => {
    const planItems = [importFieldItem('a61'), humanFieldItem('a61')]
    const fieldProvenance = new Map([['activities:a61:name', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const decisions = report.decisions.filter((d) => d.entityId === 'a61')
    expect(decisions).toHaveLength(1)
    const d = decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.confidence).toBe('changed')
    expect(d.field.slice().sort()).toEqual(['name', 'unit'])
    expect(d.proposedValue).toEqual({ name: 'NewName', unit: 'B' })
  })

  it('a single-field merged decision (both sides collapse to the same one field) keeps the scalar proposedValue shape', () => {
    // Two update items on the same entity_id/same single field (e.g. a
    // multi-source future case) should still yield a scalar, not a 1-entry map.
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a62',
        fields: { name: { from: 'Old', to: 'Mid', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Old' }, _name: 'Old',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a62',
        fields: { name: { from: 'Mid', to: 'NewName', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Old' }, _name: 'Old',
      },
    ]
    const fieldProvenance = new Map([['activities:a62:name', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const decisions = report.decisions.filter((d) => d.entityId === 'a62')
    expect(decisions).toHaveLength(1)
    expect(decisions[0].field).toEqual(['name'])
    expect(typeof decisions[0].proposedValue).not.toBe('object')
  })
})

// Round-2 hardening — FIX 2: a non-Map truthy fieldProvenance must fail
// loud at the boundary with a clear contract error, not throw a confusing
// TypeError deep inside classifyItem.
describe('buildReconciliationReport — round-2 FIX 2 (fieldProvenance boundary validation)', () => {
  it('throws a clear contract error when fieldProvenance is a plain object, not a Map', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a30',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const badFieldProvenance = { 'activities:a30:location': 'human' }
    expect(() => buildReconciliationReport({ planItems, readiness: [], fieldProvenance: badFieldProvenance }))
      .toThrow(/fieldProvenance must be a Map/)
  })

  it('null/undefined fieldProvenance still degrades silently to pre-C4 output (additive property preserved)', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a31',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    expect(() => buildReconciliationReport({ planItems, readiness: [], fieldProvenance: null })).not.toThrow()
    expect(() => buildReconciliationReport({ planItems, readiness: [], fieldProvenance: undefined })).not.toThrow()
    expect(() => buildReconciliationReport({ planItems, readiness: [] })).not.toThrow()
  })
})

// Round-2 hardening — FIX 3 (Tester): tier coverage gap + bucket invariant.
describe('buildReconciliationReport — round-2 FIX 3 (tier coverage + bucket invariant)', () => {
  it('a MEDIUM-tier update to a HUMAN-provenance field yields exactly one confirm_change decision (rule 4 overrides tier at non-HIGH)', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a40',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a40:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].kind).toBe('confirm_change')
    expect(report.decisions[0].confidence).toBe('changed')
    expect(report.buckets.changed).toBe(1)
  })

  it('a LOW-tier update to a HUMAN-provenance field yields exactly one confirm_change decision', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a41',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'low', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a41:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].kind).toBe('confirm_change')
    expect(report.decisions[0].confidence).toBe('changed')
    expect(report.buckets.changed).toBe(1)
  })

  it('a 3-field row (human, import, human) at HIGH tier yields ONE confirm_change decision listing exactly the two human fields', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a42',
        fields: {
          location: { from: 'Dock', to: 'Field', source: 'import' },
          min_per_week: { from: 1, to: 2, source: 'import' },
          prefer_before_day: { from: null, to: 'wednesday', source: 'import' },
        },
        evidence: { tier: 'exact_name', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([
      ['activities:a42:location', 'human'],
      ['activities:a42:min_per_week', 'import'],
      ['activities:a42:prefer_before_day', 'human'],
    ])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    expect(report.decisions).toHaveLength(1)
    const d = report.decisions[0]
    expect(d.kind).toBe('confirm_change')
    expect(d.field.sort()).toEqual(['location', 'prefer_before_day'])
  })

  it('bucket invariant: buckets.changed equals the number of decisions with confidence "changed" for a mixed fixture', () => {
    const planItems = [
      // understood
      { op: 'unchanged', entity: 'activities', entity_id: 'a50', fields: {}, evidence: { tier: 'exact_name' }, _name: 'Swim' },
      // needsAttention, ordinary
      {
        op: 'update', entity: 'activities', entity_id: 'a51',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
      // changed via human field
      {
        op: 'update', entity: 'activities', entity_id: 'a52',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'exact_name', matched_name: 'Sail' }, _name: 'Sail',
      },
    ]
    const fieldProvenance = new Map([['activities:a52:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })

    const changedDecisionCount = report.decisions.filter((d) => d.confidence === 'changed').length
    expect(report.buckets.changed).toBe(changedDecisionCount)
  })
})

// D3 — evidence population. buildReconciliationReport joins the caller-
// supplied evidenceSupport onto decisions by the SAME handles the module
// already uses: activities by entity_id, fixed events by name (never
// entity_id — fixed-event decisions carry entityId: null, see
// addFixedEventDecision). No recompute: the join reuses the exact support
// object passed in.
describe('buildReconciliationReport — D3 (evidence join)', () => {
  it('an activity decision (update, MEDIUM tier) carries its rule.support, joined by entity_id', () => {
    const support = { matched_groups: ['Yeladim', 'Bogrim'], appearances: 8, eligible_group_count: 2 }
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Swim' }, _name: 'Swim',
      },
    ]
    const report = buildReconciliationReport({
      planItems, readiness: [],
      evidenceSupport: { activities: { a1: support }, fixedEvents: {} },
    })
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0].evidence).toBe(support)
  })

  it('a fixed-event decision (moved) carries its fe.support, joined by NAME — the throwaway dry-run anchor entity_id is never the join key', () => {
    const support = { days: ['Monday'], occupied_days: 1, operating_days: 5, groups_in_scope: ['Yeladim'] }
    const report = buildReconciliationReport({
      planItems: [], readiness: [],
      fixedEventsReport: { moved: [{ name: 'Mifkad', reason: 'moved to a new slot' }] },
      evidenceSupport: { activities: {}, fixedEvents: { Mifkad: support } },
    })
    const decision = report.decisions.find((d) => d.entityName === 'Mifkad')
    expect(decision).toBeTruthy()
    expect(decision.evidence).toBe(support)
  })

  it('a decision with no matching support entry stays evidence: null — the honest "not available" state, not fabricated', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a9',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const report = buildReconciliationReport({
      planItems, readiness: [],
      evidenceSupport: { activities: {}, fixedEvents: {} },
    })
    expect(report.decisions[0].evidence).toBeNull()
  })

  it('regression: omitting evidenceSupport entirely produces byte-identical decisions/buckets/counts to today (additive degradation)', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 2, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Swim' }, _name: 'Swim',
      },
      { op: 'create', entity: 'activities', entity_id: null, fields: {}, evidence: { tier: 'low' }, _name: 'Ceramics' },
    ]
    const fixedEventsReport = { moved: [{ name: 'Mifkad', reason: 'moved to a new slot' }] }

    const withoutArg = buildReconciliationReport({ planItems, readiness: [], fixedEventsReport })
    const withEmptyArg = buildReconciliationReport({ planItems, readiness: [], fixedEventsReport, evidenceSupport: {} })

    expect(withoutArg).toEqual(withEmptyArg)
    expect(withoutArg.decisions.every((d) => d.evidence === null)).toBe(true)
  })
})

// D3 round 2 — evidence granularity matches decision granularity. Two
// fixedEventsReport entries for the SAME (kind, reason, name) dedup to one
// decision (addFixedEventDecision's existing round-2 fix); the surfaced
// evidence must be consistent with that single merged decision, not a
// per-entry artifact.
describe('buildReconciliationReport — D3 round 2 (fixed-event evidence matches name-level dedup)', () => {
  it('two moved entries for the same name dedup to ONE decision carrying the name-keyed support', () => {
    const support = { days: ['Monday'], occupied_days: 1, operating_days: 5, groups_in_scope: ['Yeladim'] }
    const report = buildReconciliationReport({
      planItems: [], readiness: [],
      fixedEventsReport: {
        moved: [
          { name: 'Mifkad', reason: 'moved to a new slot' },
          { name: 'Mifkad', reason: 'moved to a new slot' },
        ],
      },
      evidenceSupport: { activities: {}, fixedEvents: { Mifkad: support } },
    })

    const mifkadDecisions = report.decisions.filter((d) => d.entityName === 'Mifkad')
    expect(mifkadDecisions).toHaveLength(1)
    expect(mifkadDecisions[0].evidence).toBe(support)
    // buckets still fold over every fact seen (rule 5) even though the
    // decision collapsed to one — dedup is a decisions-layer property only.
    expect(report.buckets.changed).toBe(2)
  })
})

describe('buildReconciliationReport — C3 follow-up: defensive edge cases', () => {
  it('a moved entry missing reason/name never interpolates literal "undefined" into the decision id', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: [{ name: 'Campfire' }, { reason: 'moved somewhere' }] },
    })
    // Both entries fold into the changed bucket...
    expect(report.buckets.changed).toBe(2)
    // ...and no decision id carries the string 'undefined' from a missing segment.
    for (const d of report.decisions) {
      expect(d.id).not.toContain('undefined')
    }
  })

  it('a non-array moved/scopeChanged side channel is coerced, never throws', () => {
    expect(() =>
      buildReconciliationReport({
        planItems: [],
        readiness: [],
        fixedEventsReport: { moved: null, scopeChanged: 'not-an-array', partial: undefined },
      })
    ).not.toThrow()

    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: { moved: null, scopeChanged: 'not-an-array' },
    })
    expect(report.buckets.changed).toBe(0)
    expect(report.decisions).toHaveLength(0)
  })
})

describe('buildReconciliationReport — blastRadiusIndex (R2\'a additive input)', () => {
  const planItems = [
    {
      op: 'update', entity: 'activities', entity_id: 'a3',
      fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
      evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
    },
    {
      op: 'clear', entity: 'activities', entity_id: 'a4',
      fields: { location: { from: 'Dock', to: Symbol('clear'), source: 'import' } },
      evidence: { tier: 'low', matched_name: 'Sail' }, _name: 'Sail',
    },
  ]

  it('omitting blastRadiusIndex is byte-identical to before this input existed — every decision.blastRadius is 0', () => {
    const withoutInput = buildReconciliationReport({ planItems, readiness: [] })
    const withEmptyMap = buildReconciliationReport({ planItems, readiness: [], blastRadiusIndex: new Map() })

    for (const d of withoutInput.decisions) expect(d.blastRadius).toBe(0)
    expect(withoutInput).toEqual(withEmptyMap)
  })

  it('an existing caller that never knew about blastRadiusIndex sees identical buckets/decisions apart from the new field', () => {
    const before = buildReconciliationReport({ planItems, readiness: [] })
    const beforeSansBlastRadius = before.decisions.map(({ blastRadius: _blastRadius, ...rest }) => rest)

    // Same shape a pre-R2'a caller would have asserted against.
    expect(beforeSansBlastRadius).toEqual([
      expect.objectContaining({ entityId: 'a3', kind: 'confirm_value', confidence: 'medium' }),
      expect.objectContaining({ entityId: 'a4', kind: 'confirm_value', confidence: 'low' }),
    ])
  })

  it('surfaces decision.blastRadius from a real blastRadiusIndex, keyed by entity:entityId', () => {
    const blastRadiusIndex = new Map([['activities:a3', 4], ['activities:a4', 0]])
    const report = buildReconciliationReport({ planItems, readiness: [], blastRadiusIndex })

    const kayak = report.decisions.find((d) => d.entityId === 'a3')
    const sail = report.decisions.find((d) => d.entityId === 'a4')
    expect(kayak.blastRadius).toBe(4)
    expect(sail.blastRadius).toBe(0)
  })

  it('a decision with no entityId (conflict) keys by entity:name:normalizedName', () => {
    const conflictItems = [{
      op: 'conflict', entity: 'activities', entity_id: null,
      reason: 'ambiguous_identity', fields: {},
      evidence: { tier: 'exact_name', candidates: [] }, _name: 'Art',
    }]
    const blastRadiusIndex = new Map([['activities:name:art', 2]])
    const report = buildReconciliationReport({ planItems: conflictItems, readiness: [], blastRadiusIndex })
    expect(report.decisions[0].blastRadius).toBe(2)
  })
})
