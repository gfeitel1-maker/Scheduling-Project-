// T257 finding 2 — a group's `unit` delta may carry a discriminated token
// ({kind, id?, name}) rather than a bare name. Director-facing copy
// (decision.proposedValue, rendered verbatim by reconciliationCards.jsx) must
// NEVER show an id — a uuid there reads as gibberish to a camp director.
// Confirms buildReconciliationReport resolves the token to its display name
// before it ever reaches a decision object, for both the medium-confidence
// update path and the human-provenance "confirm_change" path.
import { describe, it, expect } from 'vitest'
import { buildReconciliationReport } from './reconciliationReport.js'

const TOKEN = { kind: 'existing', id: 'a4904e32-b00d-46ed-9777-a6adc9f64cee', name: 'Bunk B' }

describe('buildReconciliationReport — unit token never reaches proposedValue as an id (T257)', () => {
  it('a medium-confidence unit update shows the NAME, not the token/id', () => {
    const planItems = [{
      op: 'update', entity: 'groups', entity_id: 'g1',
      fields: { unit: { from: 'Bunk A', to: TOKEN, source: 'import' } },
      evidence: { tier: 'medium', matched_name: 'Chagalls' }, _name: 'Chagalls',
    }]
    const report = buildReconciliationReport({ planItems, readiness: [] })
    const decision = report.decisions.find((d) => d.entityName === 'Chagalls')
    expect(decision).toBeTruthy()
    expect(decision.proposedValue).toBe('Bunk B')
    expect(JSON.stringify(decision)).not.toContain(TOKEN.id)
  })

  it('a human-provenance unit change (confirm_change) also shows the NAME, not the token/id', () => {
    const planItems = [{
      op: 'update', entity: 'groups', entity_id: 'g1',
      fields: { unit: { from: 'Bunk A', to: TOKEN, source: 'import' } },
      evidence: { tier: 'exact_name', matched_name: 'Chagalls' }, _name: 'Chagalls',
    }]
    const fieldProvenance = new Map([['groups:g1:unit', 'human']])
    const report = buildReconciliationReport({ planItems, readiness: [], fieldProvenance })
    const decision = report.decisions.find((d) => d.entityName === 'Chagalls')
    expect(decision).toBeTruthy()
    expect(decision.proposedValue).toBe('Bunk B')
    expect(decision.currentValue).toBe('Bunk A')
    expect(JSON.stringify(decision)).not.toContain(TOKEN.id)
  })
})
