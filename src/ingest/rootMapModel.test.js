import { describe, it, expect } from 'vitest'
import { buildRootMapModel } from './rootMapModel.js'
import { buildReconciliationReport } from './reconciliationReport.js'
import { DOMAINS, childOf } from '../components/reconciliation/domainRollup.js'

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
})
