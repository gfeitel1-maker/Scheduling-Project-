import { describe, it, expect } from 'vitest'
import { buildRootMapModel } from './rootMapModel.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { DOMAINS, childOf, CHILD_OF } from '../components/reconciliation/domainRollup.js'
import { REQUIRED_AREAS } from '../engine/readiness.js'

describe('buildRootMapModel', () => {
  it('always returns all five domains, in DOMAINS order, and Context always renders absent with no children', () => {
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })

    expect(model.domains.map((d) => d.key)).toEqual(DOMAINS)

    const context = model.domains.find((d) => d.key === 'Context')
    expect(context.state).toBe('absent')
    expect(context.children).toEqual([])
  })

  it('a domain with zero decisions is understood, not absent', () => {
    // Only 'activities' (Scheduling) produces a decision; every other
    // real domain (Structure, Time, Facility) has zero decisions and must
    // read as understood, not absent — absence is reserved for Context.
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })

    const structure = model.domains.find((d) => d.key === 'Structure')
    expect(structure.state).toBe('understood')
    expect(structure.children).toEqual([])
  })

  it('a domain whose only decision is resolved reads as understood', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const decisionId = report.decisions[0].id
    const model = buildRootMapModel(report, {
      answers: { [decisionId]: { action: 'looks_right' } },
      dismissedGaps: new Set(),
    })

    const scheduling = model.domains.find((d) => d.key === 'Scheduling')
    expect(scheduling.state).toBe('understood')
    expect(scheduling.children[0].state).toBe('understood')
  })

  it('an unresolved confirm_change-only set reads as changed, never masked by attention', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a10',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'exact_name', matched_name: 'Swim' }, _name: 'Swim',
      },
    ]
    const fieldProvenance = new Map([['activities:a10:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })
    expect(report.decisions[0].kind).toBe('confirm_change')

    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })
    const scheduling = model.domains.find((d) => d.key === 'Scheduling')
    expect(scheduling.state).toBe('changed')
    expect(scheduling.children[0].state).toBe('changed')
  })

  it('a mixed unresolved set (attention + changed) reads as attention, not changed', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a10',
        fields: { location: { from: 'Dock', to: 'Field', source: 'import' } },
        evidence: { tier: 'exact_name', matched_name: 'Swim' }, _name: 'Swim',
      },
      {
        op: 'conflict', entity: 'activities', entity_id: null,
        reason: 'ambiguous_identity', fields: {},
        evidence: { tier: 'exact_name', candidates: [{ id: 'x1', name: 'Art' }, { id: 'x2', name: 'Art' }] },
        _name: 'Art',
      },
    ]
    const fieldProvenance = new Map([['activities:a10:location', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })

    const scheduling = model.domains.find((d) => d.key === 'Scheduling')
    expect(scheduling.state).toBe('attention')
  })

  it('the childOf fallback never throws for an unmapped entity and never drops a decision', () => {
    expect(childOf({ kind: 'confirm_value', entity: 'not_a_real_entity' })).toBe('General')

    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
      {
        op: 'update', entity: 'locations', entity_id: 'l1',
        fields: { capacity: { from: 10, to: 12, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Dock' }, _name: 'Dock',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })

    const totalChildDecisions = model.domains
      .flatMap((d) => d.children)
      .reduce((sum, c) => sum + c.decisionIds.length, 0)
    expect(totalChildDecisions).toBe(report.decisions.length)
  })

  // ── Slice 2: census roster (docs/adr/2026-08-19-roots-census-and-persistent-inspector.md) ──

  function makeSnapshot(overrides = {}) {
    const groups = Array.from({ length: 40 }, (_, i) => ({
      id: `g${i}`,
      name: `Group ${i}`,
      tier_id: i % 2 === 0 ? 't1' : null,
    }))
    return {
      groups,
      tiers: [{ id: 't1', name: 'Amitim' }],
      time_blocks: [{ id: 'tb1', name: 'Morning' }],
      days_of_operation: [{ id: 'day1', name: 'Monday' }],
      anchor_activities: [{ id: 'fe1', name: 'Flag Raising', time_block_id: 'tb1', day_id: 'day1' }],
      ...overrides,
    }
  }

  function sumRoster(model) {
    return model.domains.flatMap((d) => d.children).reduce((sum, c) => sum + c.roster.length, 0)
  }

  it('worked-example shape: live groups roster carries the real tier_id -> Age Division join, with a (no age division) bucket', () => {
    const planItems = [
      {
        op: 'create', entity: 'groups', entity_id: null,
        fields: {}, evidence: { tier: 'medium' }, _name: 'Ohel',
      },
      {
        op: 'create', entity: 'groups', entity_id: null,
        fields: {}, evidence: { tier: 'medium' }, _name: 'Teva',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const structure = model.domains.find((d) => d.key === 'Structure')
    const groupsChild = structure.children.find((c) => c.key === 'Groups')

    // 40 live rows + 2 proposed-new === 42 total roster entries — the ADR
    // §(a) worked example's exact arithmetic.
    expect(groupsChild.roster.length).toBe(42)

    const liveEntries = groupsChild.roster.filter((r) => r.entityId != null)
    expect(liveEntries.length).toBe(40)
    expect(liveEntries.some((r) => r.group === 'Age Division: Amitim')).toBe(true)
    expect(liveEntries.some((r) => r.group === '(no age division)')).toBe(true)

    const proposedNew = groupsChild.roster.filter((r) => r.entityId == null)
    expect(proposedNew.map((r) => r.name).sort()).toEqual(['Ohel', 'Teva'])
    expect(proposedNew.every((r) => r.state === 'attention')).toBe(true)
    expect(proposedNew.every((r) => r.group == null)).toBe(true)
  })

  it('census-completeness Part 1: live roster entries attribute back to their exact entity type, not a General fallback', () => {
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    for (const entityType of Object.keys(snapshot)) {
      const childKey = CHILD_OF[entityType]
      const child = model.domains.flatMap((d) => d.children).find((c) => c.key === childKey)
      const liveCount = child.roster.filter((r) => r.entityId != null).length
      expect(liveCount).toBe(snapshot[entityType].length)
    }
  })

  it('census-completeness Part 2: total roster count is live rows plus proposed-new decisions, in import mode', () => {
    const planItems = [
      { op: 'create', entity: 'groups', entity_id: null, fields: {}, evidence: { tier: 'medium' }, _name: 'Ohel' },
      { op: 'create', entity: 'groups', entity_id: null, fields: {}, evidence: { tier: 'medium' }, _name: 'Teva' },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const snapshotEntityCount = Object.values(snapshot).flat().length
    const proposedNewCount = report.decisions.filter((d) => d.kind === 'confirm_value' && d.entityId == null).length

    expect(sumRoster(model)).toBe(snapshotEntityCount + proposedNewCount)
  })

  it('census-completeness Part 2 collapses to live-only in inspect mode (no decisions exist at all)', () => {
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(null, { snapshot, mode: 'inspect' })

    expect(sumRoster(model)).toBe(Object.values(snapshot).flat().length)
  })

  it('a required-5 child with an empty backing table reads not_set_up, with an empty roster (not a false understood)', () => {
    const snapshot = makeSnapshot({ groups: [] })
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const groupsChild = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Groups')
    expect(groupsChild.state).toBe('not_set_up')
    expect(groupsChild.roster).toEqual([])
  })

  it('an optional child (e.g. Locations) with an empty backing table stays understood, never not_set_up', () => {
    const snapshot = makeSnapshot({ locations: [] })
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const locationsChild = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Locations')
    expect(locationsChild.state).toBe('understood')
  })

  it('characterization: REQUIRED_AREAS still names exactly the five keys not_set_up scoping assumes', () => {
    expect(REQUIRED_AREAS.map((a) => a.key).sort()).toEqual(
      ['activities', 'days', 'groups', 'timeblocks', 'tiers'].sort(),
    )
  })

  // ── Fixed Events (anchor_activities) attribution — Red Hat HIGH, round 2 ──
  // addFixedEventDecision (reconciliationReport.js) mints entityId: null for
  // EVERY anchor decision, create and change alike, so attribution can't use
  // the entityId match every other entity type uses — it must use the same
  // (name, time-block label, day label) identity key the report itself keys
  // decisions by.

  it('an existing Fixed Event with a pending confirm_change shows changed/attention in its roster row, not a false understood', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [{ name: 'Flag Raising', reason: 'moved', time_block: 'Morning', days: ['Monday'], from: 'Dock', to: 'Field' }],
      },
    })
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const fixedEvents = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Fixed Events')
    const row = fixedEvents.roster.find((r) => r.entityId === 'fe1')
    expect(row.state).toBe('changed')
    expect(row.decisionId).toBe(report.decisions[0].id)
  })

  it('a resolved existing Fixed Event change reads understood in its roster row, mirroring every other entity type', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [{ name: 'Flag Raising', reason: 'moved', time_block: 'Morning', days: ['Monday'], from: 'Dock', to: 'Field' }],
      },
    })
    const decisionId = report.decisions[0].id
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, {
      answers: { [decisionId]: { choice: 'accept' } },
      dismissedGaps: new Set(),
      snapshot,
    })

    const fixedEvents = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Fixed Events')
    const row = fixedEvents.roster.find((r) => r.entityId === 'fe1')
    expect(row.state).toBe('understood')
  })

  it('a proposed-new Fixed Event appears as a proposed-new roster entry, not silently dropped', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        created: [{ name: 'Campfire', time_block: 'Evening', days: ['Friday'], confidence: 'low' }],
      },
    })
    const snapshot = makeSnapshot({ anchor_activities: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const fixedEvents = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Fixed Events')
    expect(fixedEvents.roster.length).toBe(1)
    expect(fixedEvents.roster[0]).toMatchObject({ entityId: null, name: 'Campfire', state: 'attention' })
  })

  it('census-completeness invariants hold with anchor_activities in the mix, not just groups', () => {
    const report = buildReconciliationReport({
      planItems: [],
      readiness: [],
      fixedEventsReport: {
        moved: [{ name: 'Flag Raising', reason: 'moved', time_block: 'Morning', days: ['Monday'], from: 'Dock', to: 'Field' }],
      },
    })
    const snapshot = makeSnapshot()
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const fixedEvents = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Fixed Events')
    const liveCount = fixedEvents.roster.filter((r) => r.entityId != null).length
    expect(liveCount).toBe(snapshot.anchor_activities.length)

    const snapshotEntityCount = Object.values(snapshot).flat().length
    const proposedNewCount = report.decisions.filter((d) => d.kind === 'confirm_value' && d.entityId == null).length
    expect(sumRoster(model)).toBe(snapshotEntityCount + proposedNewCount)
  })

  // ── not_set_up vs. fetch-failure — Red Hat MEDIUM, round 2 ──

  it('a required-5 entity whose fetch errored (null, not []) never reads not_set_up — a transient failure must not lie "nothing set up"', () => {
    const snapshot = makeSnapshot({ groups: null })
    const report = buildReconciliationReport({ planItems: [], readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set(), snapshot })

    const groupsChild = model.domains.flatMap((d) => d.children).find((c) => c.key === 'Groups')
    expect(groupsChild.state).not.toBe('not_set_up')
    expect(groupsChild.state).toBe('understood')
    expect(groupsChild.roster).toEqual([])
  })

  it('with no snapshot supplied, roster construction is a no-op and existing children are untouched (backward compatible default)', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { min_per_week: { from: 1, to: 3, source: 'import' } },
        evidence: { tier: 'medium', matched_name: 'Kayak' }, _name: 'Kayak',
      },
    ]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const model = buildRootMapModel(report, { answers: {}, dismissedGaps: new Set() })

    const scheduling = model.domains.find((d) => d.key === 'Scheduling')
    expect(scheduling.children[0].roster).toEqual([])
  })
})
