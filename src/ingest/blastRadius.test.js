// Test-first: written before blastRadius.js exists.
// docs/adr/2026-08-17-onescreen-reconciliation-projection.md — Seam 2 gap fix.

import { describe, it, expect } from 'vitest'
import { buildBlastRadiusIndex } from './blastRadius.js'

describe('buildBlastRadiusIndex', () => {
  it('returns an empty Map for empty planItems', () => {
    const index = buildBlastRadiusIndex([])
    expect(index).toBeInstanceOf(Map)
    expect(index.size).toBe(0)
  })

  it('counts an existing (matched) location referenced by an updated activity', () => {
    const planItems = [
      {
        op: 'unchanged', entity: 'locations', entity_id: 'loc-1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Lake',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { location: { from: 'Dock', to: 'Lake', source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Kayaking',
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.get('locations:loc-1')).toBe(1)
  })

  it('counts a newly-created location referenced by a newly-created activity (locations cross-reference case)', () => {
    const planItems = [
      {
        op: 'create', entity: 'locations', entity_id: null, fields: {},
        evidence: { tier: 'new' }, _name: 'Lake',
      },
      {
        op: 'create', entity: 'activities', entity_id: null, fields: {},
        evidence: { tier: 'new' }, _name: 'Kayaking',
        _rule: { location: 'Lake', eligible_group_names: null },
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.get('locations:name:lake')).toBe(1)
  })

  it('counts multiple references to the same entity across separate activities', () => {
    const planItems = [
      {
        op: 'unchanged', entity: 'locations', entity_id: 'loc-1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Lake',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { location: { from: 'Dock', to: 'Lake', source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Kayaking',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a2',
        fields: { location: { from: 'Field', to: 'Lake', source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Canoeing',
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.get('locations:loc-1')).toBe(2)
  })

  it('counts a group referenced via an updated activity eligible_groups array', () => {
    const planItems = [
      {
        op: 'unchanged', entity: 'groups', entity_id: 'g1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Chipmunks',
      },
      {
        op: 'unchanged', entity: 'groups', entity_id: 'g2', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Beavers',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { eligible_groups: { from: [], to: ['Chipmunks', 'Beavers'], source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Archery',
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.get('groups:g1')).toBe(1)
    expect(index.get('groups:g2')).toBe(1)
  })

  it('counts a group referenced via a created activity _rule.eligible_group_names', () => {
    const planItems = [
      {
        op: 'unchanged', entity: 'groups', entity_id: 'g1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Chipmunks',
      },
      {
        op: 'create', entity: 'activities', entity_id: null, fields: {},
        evidence: { tier: 'new' }, _name: 'Archery',
        _rule: { eligible_group_names: ['Chipmunks'] },
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.get('groups:g1')).toBe(1)
  })

  it('does not count a reference to a name that never appears as a plan item', () => {
    const planItems = [
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { location: { from: 'Dock', to: 'Nowhere', source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Kayaking',
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.size).toBe(0)
  })

  it('ignores a CLEAR sentinel on a location field rather than throwing or counting it', () => {
    const CLEAR = Symbol('clear')
    const planItems = [
      {
        op: 'unchanged', entity: 'locations', entity_id: 'loc-1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Lake',
      },
      {
        op: 'clear', entity: 'activities', entity_id: 'a1',
        fields: { location: { from: 'Lake', to: CLEAR, source: 'import' } },
        evidence: { tier: 'low' }, _name: 'Kayaking',
      },
    ]
    const index = buildBlastRadiusIndex(planItems)
    expect(index.size).toBe(0)
  })

  it('is pure and does not mutate its input', () => {
    const planItems = [
      {
        op: 'unchanged', entity: 'locations', entity_id: 'loc-1', fields: {},
        evidence: { tier: 'exact_name' }, _name: 'Lake',
      },
      {
        op: 'update', entity: 'activities', entity_id: 'a1',
        fields: { location: { from: 'Dock', to: 'Lake', source: 'import' } },
        evidence: { tier: 'medium' }, _name: 'Kayaking',
      },
    ]
    const snapshot = JSON.parse(JSON.stringify(planItems))
    buildBlastRadiusIndex(planItems)
    expect(planItems).toEqual(snapshot)
  })
})
