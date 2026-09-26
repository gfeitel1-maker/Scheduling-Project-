// T257 — a group's `unit` value may now be a discriminated token
// ({kind:'existing', id, name} | {kind:'proposed', name}) rather than a bare
// string, so an existing division's id survives all the way to commit
// instead of being re-resolved by name (which can only ever find ONE of two
// same-named divisions). buildPlan is pure and holds no DB handle, so its job
// is narrower: diff the token against the snapshot's `unit_name` using
// `token.name` (never an id lookup it cannot perform), and carry the token
// through unchanged on `_link_unit` for the committer to resolve.
import { describe, it, expect } from 'vitest'
import { buildPlan } from './buildPlan.js'

const camp = 'camp-1'

describe('buildPlan unit-token diffing (T257)', () => {
  it('an existing-tier token diffs by NAME against unit_name — same name, no delta', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: { kind: 'existing', id: 'tier-b', name: 'Aleph' } } }] },
      camp_id: camp,
    }, { groups: [{ id: 'g1', name: 'Chagalls', unit_name: 'Aleph' }] })
    expect(plan.items[0].op).toBe('unchanged')
  })

  it('an existing-tier token diffs by NAME against unit_name — different name, emits update carrying the FULL token', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: { kind: 'existing', id: 'tier-b', name: 'Bet' } } }] },
      camp_id: camp,
    }, { groups: [{ id: 'g1', name: 'Chagalls', unit_name: 'Aleph' }] })
    expect(plan.items[0].op).toBe('update')
    expect(plan.items[0].fields.unit.to).toEqual({ kind: 'existing', id: 'tier-b', name: 'Bet' })
    expect(plan.items[0].fields.unit.from).toBe('Aleph')
  })

  it('a proposed-tier token (no id yet) still diffs correctly against a live name', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: { kind: 'proposed', name: 'Gimel' } } }] },
      camp_id: camp,
    }, { groups: [{ id: 'g1', name: 'Chagalls', unit_name: 'Aleph' }] })
    expect(plan.items[0].op).toBe('update')
    expect(plan.items[0].fields.unit.to).toEqual({ kind: 'proposed', name: 'Gimel' })
  })

  it('a create item carries the token through unchanged on _link_unit', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: { kind: 'existing', id: 'tier-b', name: 'Aleph' } } }] },
      camp_id: camp,
    }, null)
    expect(plan.items[0].op).toBe('create')
    expect(plan.items[0]._link_unit).toEqual({ kind: 'existing', id: 'tier-b', name: 'Aleph' })
  })
})
