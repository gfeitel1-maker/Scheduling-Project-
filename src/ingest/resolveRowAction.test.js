import { describe, it, expect } from 'vitest'
import { resolveRowAction } from './resolveRowAction.js'

describe('resolveRowAction', () => {
  it('returns create when no existing row matches the natural key', () => {
    const existingByKey = new Map()
    const result = resolveRowAction('Monday', { day_of_week: 1 }, existingByKey)
    expect(result).toEqual({ action: 'create' })
  })

  it('returns unchanged when every candidate field already matches the existing row', () => {
    const existing = { id: 'abc', label: 'Monday', day_of_week: 1 }
    const existingByKey = new Map([['monday', existing]])
    const result = resolveRowAction('Monday', { day_of_week: 1 }, existingByKey)
    expect(result).toEqual({ action: 'unchanged', existing })
  })

  it('returns update with only the changed fields when a candidate field differs', () => {
    const existing = { id: 'abc', label: 'Monday', day_of_week: 1 }
    const existingByKey = new Map([['monday', existing]])
    const result = resolveRowAction('Monday', { day_of_week: 2 }, existingByKey)
    expect(result).toEqual({ action: 'update', existing, changedFields: { day_of_week: 2 } })
  })

  it('matches the natural key case-insensitively', () => {
    const existing = { id: 'abc', label: 'Monday', day_of_week: 1 }
    const existingByKey = new Map([['monday', existing]])
    const result = resolveRowAction('MONDAY', { day_of_week: 1 }, existingByKey)
    expect(result.action).toBe('unchanged')
  })

  it('treats null/undefined and empty string as equal when comparing', () => {
    const existing = { id: 'abc', name: 'Swim', notes: null }
    const existingByKey = new Map([['swim', existing]])
    const result = resolveRowAction('Swim', { notes: '' }, existingByKey)
    expect(result.action).toBe('unchanged')
  })

  it('treats a non-empty existing value and a blank candidate cell as a real change (never silently keeps the old value)', () => {
    const existing = { id: 'abc', name: 'Swim', priority: 'high' }
    const existingByKey = new Map([['swim', existing]])
    const result = resolveRowAction('Swim', { priority: '' }, existingByKey)
    expect(result).toEqual({ action: 'update', existing, changedFields: { priority: '' } })
  })

  it('only reports the fields that actually changed, not untouched ones', () => {
    const existing = { id: 'abc', name: 'Swim', capacity: 10, kind: 'pool' }
    const existingByKey = new Map([['swim', existing]])
    const result = resolveRowAction('Swim', { capacity: 20, kind: 'pool' }, existingByKey)
    expect(result).toEqual({ action: 'update', existing, changedFields: { capacity: 20 } })
  })

  // Code Reviewer HIGH+MEDIUM — a field whose column the sheet never carried must never be
  // diffed on update: its candidate value is a DEFAULT the parser filled in for a CREATE,
  // not something the file said anything about, and diffing it would silently overwrite a
  // director's own value with that default. `providedKeys` restricts the diff to fields the
  // sheet actually named (mapping.roles) or a row explicitly derived.
  describe('providedKeys', () => {
    it('ignores a changed field whose key is not in providedKeys, even though its value differs', () => {
      const existing = { id: 'abc', name: 'Archery', eligible_group_ids: ['g1', 'g2'], priority: 'high' }
      const existingByKey = new Map([['archery', existing]])
      // eligible_group_ids defaulted to [] by the parser (no column for it); priority
      // defaulted to 'low' because the priority column was absent from this sheet.
      const candidateFields = { eligible_group_ids: [], priority: 'low' }
      const providedKeys = new Set() // neither field's column was present
      const result = resolveRowAction('Archery', candidateFields, existingByKey, providedKeys)
      expect(result).toEqual({ action: 'unchanged', existing })
    })

    it('still diffs a field that IS in providedKeys, leaving an unprovided one alone', () => {
      const existing = { id: 'abc', name: 'Archery', eligible_group_ids: ['g1'], priority: 'high' }
      const existingByKey = new Map([['archery', existing]])
      const candidateFields = { eligible_group_ids: [], priority: 'low' }
      const providedKeys = new Set(['priority']) // only priority's column was present
      const result = resolveRowAction('Archery', candidateFields, existingByKey, providedKeys)
      expect(result).toEqual({ action: 'update', existing, changedFields: { priority: 'low' } })
    })

    it('with no providedKeys argument, diffs every candidate field (back-compat default)', () => {
      const existing = { id: 'abc', name: 'Swim', capacity: 10 }
      const existingByKey = new Map([['swim', existing]])
      const result = resolveRowAction('Swim', { capacity: 20 }, existingByKey)
      expect(result.action).toBe('update')
    })
  })
})
