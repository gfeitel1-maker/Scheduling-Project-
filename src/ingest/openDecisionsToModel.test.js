import { describe, it, expect } from 'vitest'
import { openDecisionsToModel } from './openDecisionsToModel.js'

function row(overrides = {}) {
  return {
    id: 'groups:g1',
    camp_id: 'camp1',
    entity_type: 'groups',
    cohort_id: null,
    entity_id: 'g1',
    identity_key: 'g1',
    kind: 'confirm_value',
    domain_key: 'Structure',
    child_key: 'Groups',
    entity_name: 'Bunk 1',
    reason: 'New in the import',
    import_run_id: 'run1',
    created_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('openDecisionsToModel', () => {
  it('returns an empty model and empty decisionsById for no rows', () => {
    const { model, decisionsById } = openDecisionsToModel([])
    expect(model).toEqual({ domains: [] })
    expect(decisionsById.size).toBe(0)
  })

  it('groups a single row under its precomputed domain_key/child_key', () => {
    const { model } = openDecisionsToModel([row()])
    expect(model.domains).toEqual([
      { label: 'Structure', children: [{ key: 'Groups', roster: [{ state: 'attention', decisionId: 'groups:g1', entityId: 'g1', name: 'Bunk 1' }] }] },
    ])
  })

  it('maps confirm_change to state "changed" and every other kind to "attention"', () => {
    const { model } = openDecisionsToModel([
      row({ id: 'a', kind: 'confirm_value' }),
      row({ id: 'b', kind: 'confirm_change' }),
      row({ id: 'c', kind: 'resolve_conflict' }),
    ])
    const roster = model.domains[0].children[0].roster
    const stateOf = (id) => roster.find((r) => r.decisionId === id).state
    expect(stateOf('a')).toBe('attention')
    expect(stateOf('b')).toBe('changed')
    expect(stateOf('c')).toBe('attention')
  })

  it('groups multiple rows sharing a domain/child into one roster', () => {
    const { model } = openDecisionsToModel([
      row({ id: 'groups:g1', entity_name: 'Bunk 1' }),
      row({ id: 'groups:g2', entity_id: 'g2', entity_name: 'Bunk 2' }),
    ])
    expect(model.domains).toHaveLength(1)
    expect(model.domains[0].children).toHaveLength(1)
    expect(model.domains[0].children[0].roster).toHaveLength(2)
  })

  it('splits rows across different domains/children', () => {
    const { model } = openDecisionsToModel([
      row({ id: 'groups:g1', domain_key: 'Structure', child_key: 'Groups' }),
      row({ id: 'activities:a1', entity_type: 'activities', domain_key: 'Scheduling', child_key: 'Activities', entity_name: 'Swim' }),
    ])
    const labels = model.domains.map((d) => d.label).sort()
    expect(labels).toEqual(['Scheduling', 'Structure'])
  })

  it('builds decisionsById keyed by row id, carrying only { reason }', () => {
    const { decisionsById } = openDecisionsToModel([row({ id: 'groups:g1', reason: 'Not enough info' })])
    expect(decisionsById.get('groups:g1')).toEqual({ reason: 'Not enough info' })
    expect(decisionsById.get('nope')).toBeUndefined()
  })

  it('ignores rows with no id and rows in a null/undefined list', () => {
    expect(openDecisionsToModel(null).model).toEqual({ domains: [] })
    expect(openDecisionsToModel(undefined).model).toEqual({ domains: [] })
    const { model } = openDecisionsToModel([{ ...row(), id: undefined }])
    expect(model).toEqual({ domains: [] })
  })

  it('falls back to "General" for a row missing domain_key/child_key', () => {
    const { model } = openDecisionsToModel([row({ domain_key: undefined, child_key: undefined })])
    expect(model.domains[0].label).toBe('General')
    expect(model.domains[0].children[0].key).toBe('General')
  })
})
