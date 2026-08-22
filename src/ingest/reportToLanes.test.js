// Test-first: written before reportToLanes.js exists.
// docs/adr/2026-08-17-onescreen-reconciliation-projection.md — Seam 1.
// Characterization-tested: golden-report -> golden-lanes fixtures, one per
// kind/confidence combo in current use, plus the unrecognized-kind throw case.

import { describe, it, expect } from 'vitest'
import { reportToLanes } from './reportToLanes.js'

function report(decisions, buckets = {}) {
  return {
    buckets: {
      understood: 0, needsAttention: 0, notInSource: 0, changed: 0,
      ...buckets,
    },
    decisions,
    meta: { generatedAt: null, planItemCount: decisions.length },
  }
}

function d(overrides) {
  return {
    id: 'x', kind: 'confirm_value', entity: 'activities', entityId: 'a1',
    entityName: 'Swim', field: ['priority'], confidence: 'low', proposedValue: 3,
    unknowns: [], evidence: null, reason: null,
    ...overrides,
  }
}

describe('reportToLanes', () => {
  it('resolve_conflict decisions land in hold, unconditionally', () => {
    const conflict = d({ id: 'c1', kind: 'resolve_conflict', confidence: 'conflict', entityId: null })
    const lanes = reportToLanes(report([conflict], { needsAttention: 1 }))
    expect(lanes.hold).toEqual([conflict])
    expect(lanes.standard).toEqual([])
    expect(lanes.express).toEqual([])
  })

  it('confirm_value with confidence low lands in standard', () => {
    const low = d({ id: 'v1', kind: 'confirm_value', confidence: 'low' })
    const lanes = reportToLanes(report([low], { needsAttention: 1 }))
    expect(lanes.standard).toEqual([low])
    expect(lanes.hold).toEqual([])
  })

  it('confirm_value with confidence medium lands in standard', () => {
    const med = d({ id: 'v2', kind: 'confirm_value', confidence: 'medium' })
    const lanes = reportToLanes(report([med], { needsAttention: 1 }))
    expect(lanes.standard).toEqual([med])
  })

  it('confirm_value with confidence high lands in express', () => {
    const high = d({ id: 'v3', kind: 'confirm_value', confidence: 'high' })
    const lanes = reportToLanes(report([high], { needsAttention: 1 }))
    expect(lanes.express).toEqual([high])
    expect(lanes.standard).toEqual([])
    expect(lanes.hold).toEqual([])
  })

  it('confirm_value with confidence conflict lands in hold (forward seam, not reachable via classifyItem today)', () => {
    const heldValue = d({ id: 'v4', kind: 'confirm_value', confidence: 'conflict' })
    const lanes = reportToLanes(report([heldValue], { needsAttention: 1 }))
    expect(lanes.hold).toEqual([heldValue])
  })

  it('confirm_change always lands in standard, regardless of tier, never express', () => {
    const changed = d({
      id: 'ch1', kind: 'confirm_change', entity: 'groups', entityId: 'g1',
      field: ['name'], confidence: 'changed', proposedValue: 'Chipmunks (3B)',
    })
    const lanes = reportToLanes(report([changed], { changed: 1 }))
    expect(lanes.standard).toEqual([changed])
    expect(lanes.express).toEqual([])
  })

  it('confirm_change with conflict confidence lands in hold (forward seam)', () => {
    const heldChange = d({ id: 'ch2', kind: 'confirm_change', confidence: 'conflict' })
    const lanes = reportToLanes(report([heldChange], { changed: 1 }))
    expect(lanes.hold).toEqual([heldChange])
  })

  it('review_legacy_priority sorts into standard', () => {
    const legacy = d({
      id: 'activities:legacy_priority', kind: 'review_legacy_priority', entityId: null,
      field: 'priority', confidence: 'low', count: 2, activities: [],
    })
    const lanes = reportToLanes(report([legacy], { needsAttention: 1 }))
    expect(lanes.standard).toEqual([legacy])
  })

  // Slice 3a — "never silent" means hold, regardless of band.
  it('elective_candidate sorts into hold at confirmed band', () => {
    const nudge = d({
      id: 'elective_candidate:header::Chugim', kind: 'elective_candidate', entity: 'elective_sets',
      entityId: null, field: null, confidence: 'confirmed', proposedValue: null,
    })
    const lanes = reportToLanes(report([nudge], { needsAttention: 1 }))
    expect(lanes.hold).toEqual([nudge])
    expect(lanes.standard).toEqual([])
    expect(lanes.express).toEqual([])
  })

  it('elective_candidate sorts into hold at inferred band too — never express, never standard', () => {
    const nudge = d({
      id: 'elective_candidate:shape::Blob', kind: 'elective_candidate', entity: 'elective_sets',
      entityId: null, field: null, confidence: 'inferred', proposedValue: null,
    })
    const lanes = reportToLanes(report([nudge], { needsAttention: 1 }))
    expect(lanes.hold).toEqual([nudge])
  })

  it('preserves report.decisions array order within a lane — never re-sorts', () => {
    const first = d({ id: 'a', confidence: 'low' })
    const second = d({ id: 'b', confidence: 'medium' })
    const third = d({ id: 'c', confidence: 'low' })
    const lanes = reportToLanes(report([third, first, second], { needsAttention: 3 }))
    expect(lanes.standard.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('spine has one row per bucket key in report.buckets order, plus readinessGreen', () => {
    const lanes = reportToLanes(report([], {
      understood: 480, needsAttention: 3, notInSource: 2, changed: 1,
    }))
    expect(lanes.spine.map((row) => row.bucket)).toEqual([
      'understood', 'needsAttention', 'notInSource', 'changed',
    ])
    expect(lanes.spine.find((row) => row.bucket === 'understood').count).toBe(480)
    expect(lanes.spine.find((row) => row.bucket === 'changed').count).toBe(1)
  })

  it('readinessGreen is true when no hold/standard decisions remain and no readiness rows given', () => {
    const lanes = reportToLanes(report([], { understood: 5 }))
    expect(lanes.readinessGreen).toBe(true)
  })

  it('readinessGreen is false when any hold or standard decision is pending', () => {
    const pending = d({ confidence: 'low' })
    const lanes = reportToLanes(report([pending], { needsAttention: 1 }))
    expect(lanes.readinessGreen).toBe(false)
  })

  it('readinessGreen is FALSE when a required readiness area is unsatisfied (missing), even with zero pending decisions', () => {
    const r = report([], { understood: 5 })
    r.readiness = [
      { key: 'groups', label: 'Groups', screen: 'groups', kind: 'required', state: 'missing' },
      { key: 'anchors', label: 'Anchors', screen: 'anchors', kind: 'optional', state: 'optional' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.hold).toEqual([{
      id: 'readiness:groups',
      kind: 'required_gap',
      entity: null,
      entityId: null,
      entityName: null,
      field: null,
      confidence: 'required',
      proposedValue: null,
      label: 'Groups',
      message: null,
      screen: 'groups',
      evidence: null,
    }])
    expect(lanes.standard).toEqual([])
    expect(lanes.readinessGreen).toBe(false)
  })

  it('a required readiness row with state "missing" produces a required_gap decision prepended to hold, ahead of other hold cards', () => {
    const r = report([d({ id: 'c1', kind: 'resolve_conflict', confidence: 'conflict', entityId: null })], { needsAttention: 1 })
    r.readiness = [
      { key: 'tiers', label: 'Units', screen: 'tiers', kind: 'required', state: 'missing', message: 'Add your age divisions.' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.hold).toHaveLength(2)
    expect(lanes.hold[0]).toMatchObject({ id: 'readiness:tiers', kind: 'required_gap', label: 'Units', message: 'Add your age divisions.', screen: 'tiers' })
    expect(lanes.hold[1].kind).toBe('resolve_conflict')
  })

  it('a required readiness row with state "ready" produces no required_gap decision', () => {
    const r = report([], { understood: 5 })
    r.readiness = [
      { key: 'tiers', label: 'Units', screen: 'tiers', kind: 'required', state: 'ready' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.hold).toEqual([])
  })

  it('an optional-kind readiness row never produces a required_gap decision, regardless of state', () => {
    const r = report([], { understood: 5, notInSource: 1 })
    r.readiness = [
      { key: 'anchors', label: 'Fixed Events', screen: 'anchors', kind: 'optional', state: 'optional' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.hold).toEqual([])
    expect(lanes.standard).toEqual([])
    expect(lanes.express).toEqual([])
  })

  it('readinessGreen is FALSE when a required readiness area needs attention, even with zero pending decisions', () => {
    const r = report([], { understood: 5 })
    r.readiness = [
      { key: 'staffing', label: 'Staffing', screen: 'staffing', kind: 'required', state: 'needs-attention' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.readinessGreen).toBe(false)
  })

  it('readinessGreen is TRUE when all required readiness areas are ready and no decisions are pending', () => {
    const r = report([], { understood: 5 })
    r.readiness = [
      { key: 'groups', label: 'Groups', screen: 'groups', kind: 'required', state: 'ready' },
      { key: 'staffing', label: 'Staffing', screen: 'staffing', kind: 'required', state: 'ready' },
      { key: 'anchors', label: 'Anchors', screen: 'anchors', kind: 'optional', state: 'optional' },
      { key: 'location', label: 'Locations', screen: null, kind: 'forward', state: 'not-applicable' },
    ]
    const lanes = reportToLanes(r)
    expect(lanes.readinessGreen).toBe(true)
  })

  it('understood/notInSource never produce lane rows — silent by design', () => {
    const lanes = reportToLanes(report([], { understood: 480, notInSource: 2 }))
    expect(lanes.hold).toEqual([])
    expect(lanes.standard).toEqual([])
    expect(lanes.express).toEqual([])
  })

  it('throws on an unrecognized decision.kind — exhaustiveness guard', () => {
    const mystery = d({ id: 'm1', kind: 'some_future_kind' })
    expect(() => reportToLanes(report([mystery], { needsAttention: 1 }))).toThrow(/some_future_kind/)
  })

  it('does not mutate the input report', () => {
    const r = report([d({ id: 'v1', confidence: 'low' })], { needsAttention: 1 })
    const snapshot = JSON.parse(JSON.stringify(r))
    reportToLanes(r)
    expect(r).toEqual(snapshot)
  })
})
