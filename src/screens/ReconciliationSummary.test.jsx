// @vitest-environment jsdom
//
// D1 — the read-only reconciliation summary. Drives the component with an
// ELECTRON-shaped report object (populated changed/legacy fields), per the
// owner's resolved MOCK FIDELITY decision: the mock's ingestReconcile returns
// empty provenance/legacy for D1, so proving correct four-bucket + category
// strip + CTA rendering must not depend on mock limits — this test builds the
// report the way buildReconciliationReport actually would against a REAL
// electron dry-run, not the :5200 mock's degraded shape.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReconciliationSummary } from './ReconciliationSummary'
import { buildReconciliationReport } from '../ingest/reconciliationReport'

// A realistic electron-shaped dry-run outcome: two creates (understood), one
// medium-confidence update (needsAttention), one changed/firm update (changed,
// via fieldProvenance='human'), plus a legacy-priority batch (needsAttention)
// and an optional readiness area with no rows (notInSource).
const PLAN_ITEMS = [
  { op: 'create', entity: 'groups', entity_id: null, _name: 'Bunk 1', fields: {}, evidence: { tier: 'new' } },
  { op: 'create', entity: 'groups', entity_id: null, _name: 'Bunk 2', fields: {}, evidence: { tier: 'new' } },
  {
    op: 'update', entity: 'activities', entity_id: 'act-medium', _name: 'Archery',
    fields: { max_per_week: { from: 1, to: 2, source: 'import' } },
    evidence: { tier: 'medium', matched_name: 'Archery' },
  },
  {
    op: 'update', entity: 'activities', entity_id: 'act-changed', _name: 'Swim',
    fields: { max_per_week: { from: 3, to: 5, source: 'import' } },
    evidence: { tier: 'exact_name', matched_name: 'Swim' },
  },
]

// buildReconciliationReport requires a Map — matches what ImportScreen builds
// from ingestReconcile's plain-object IPC response (see stageReconciliationSummary).
const FIELD_PROVENANCE = new Map([
  ['activities:act-changed:max_per_week', 'human'],
])

const LEGACY_PRIORITY_ACTIVITIES = [
  { entity_id: 'act-legacy-1', name: 'Canoe' },
  { entity_id: 'act-legacy-2', name: 'Kayak' },
]

const READINESS = [
  { key: 'tiers', label: 'Units', screen: 'tiers', kind: 'required', state: 'ready' },
  { key: 'groups', label: 'Groups', screen: 'groups', kind: 'required', state: 'ready' },
  { key: 'days', label: 'Days', screen: 'days', kind: 'required', state: 'ready' },
  { key: 'timeblocks', label: 'Time Blocks', screen: 'timeblocks', kind: 'required', state: 'ready' },
  { key: 'activities', label: 'Activities', screen: 'activities', kind: 'required', state: 'needs-attention' },
  { key: 'anchors', label: 'Fixed Events', screen: 'anchors', kind: 'optional', state: 'optional' },
  { key: 'dayoverrides', label: 'Day Overrides', screen: 'dayoverrides', kind: 'optional', state: 'optional' },
  { key: 'location', label: 'Locations', screen: 'camp', kind: 'forward', state: 'optional' },
  { key: 'staffing', label: 'Staffing', screen: null, kind: 'forward', state: 'optional' },
]

function buildElectronShapedReport() {
  return buildReconciliationReport({
    planItems: PLAN_ITEMS,
    readiness: READINESS,
    now: new Date('2026-08-11T00:00:00.000Z'),
    fixedEventsReport: { created: 0, unchanged: 0, skipped: [], partial: [], rejected: [], moved: [], scopeChanged: [] },
    legacyPriorityActivities: LEGACY_PRIORITY_ACTIVITIES,
    fieldProvenance: FIELD_PROVENANCE,
  })
}

describe('ReconciliationSummary', () => {
  it('renders the four bucket counts from the report', () => {
    const report = buildElectronShapedReport()
    render(<ReconciliationSummary report={report} readiness={READINESS} />)

    expect(screen.getAllByText(String(report.buckets.understood)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(String(report.buckets.needsAttention)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(String(report.buckets.notInSource)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(String(report.buckets.changed)).length).toBeGreaterThan(0)

    expect(screen.getByText(/understood — facts reconciled without a question/)).toBeTruthy()
    expect(screen.getByText(/need your attention/)).toBeTruthy()
    expect(screen.getByText(/optional areas not in this source/)).toBeTruthy()
    expect(screen.getByText(/changed from what's already set up/)).toBeTruthy()
  })

  it('bucket counts are non-trivial for this fixture (proves the real classification pass ran)', () => {
    const report = buildElectronShapedReport()
    // 2 creates -> understood; 1 medium update -> needsAttention; 1 human-owned
    // field update -> changed; 1 legacy-priority batch -> needsAttention;
    // 2 optional readiness rows with no live data -> notInSource.
    expect(report.buckets.understood).toBe(2)
    expect(report.buckets.changed).toBe(1)
    expect(report.buckets.needsAttention).toBeGreaterThan(0)
    expect(report.buckets.notInSource).toBeGreaterThan(0)
  })

  it('renders the readiness-derived category strip (Structure / Scheduling model / Time / Resources)', () => {
    const report = buildElectronShapedReport()
    render(<ReconciliationSummary report={report} readiness={READINESS} />)

    expect(screen.getByText(/Structure/)).toBeTruthy()
    expect(screen.getByText(/Scheduling model/)).toBeTruthy()
    expect(screen.getByText(/^Time /)).toBeTruthy()
    expect(screen.getByText(/Resources/)).toBeTruthy()
  })

  it('renders a single "Review N decisions" CTA, disabled (D1 placeholder — D2 owns resolution)', () => {
    const report = buildElectronShapedReport()
    render(<ReconciliationSummary report={report} readiness={READINESS} />)

    const cta = screen.getByRole('button', { name: new RegExp(`Review ${report.decisions.length} decision`) })
    expect(cta).toBeTruthy()
    expect(cta.disabled).toBe(true)
  })

  it('renders gracefully with an empty/mock-degraded report (no provenance, no legacy)', () => {
    const emptyReport = buildReconciliationReport({
      planItems: [],
      readiness: READINESS,
      now: new Date(),
      fixedEventsReport: {},
      legacyPriorityActivities: [],
      fieldProvenance: new Map(),
    })
    render(<ReconciliationSummary report={emptyReport} readiness={READINESS} />)

    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Review 0 decisions/ })).toBeTruthy()
  })
})
