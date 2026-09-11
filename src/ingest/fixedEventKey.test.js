import { describe, it, expect } from 'vitest'
import { fixedEventKey } from './fixedEventKey.js'

// T125. Importing one real camp file logged, twice:
//   "Encountered two children with the same key,
//    Instructional Swim 11:50-12:25 Monday,Tuesday,Wednesday,Thursday"
// React's own warning says colliding children may be "duplicated and/or
// omitted" — on a list of decisions a director is about to commit, that is a
// correctness risk, not console noise.
//
// The key was name + time_block + days. Two proposed events can share all three
// and still be different events, because SCOPE separates them: the same
// activity at the same time on the same days, for different groups.
const ALL = { is_all_groups: true, groups: null }
const some = (...groups) => ({ is_all_groups: false, groups })

describe('fixedEventKey', () => {
  it('separates two events that differ only by which groups they are for', () => {
    const a = { name: 'Instructional Swim', time_block: '11:50-12:25', days: ['Monday'], scope: some('Amber Pines') }
    const b = { name: 'Instructional Swim', time_block: '11:50-12:25', days: ['Monday'], scope: some('Lanterns') }
    expect(fixedEventKey(a)).not.toBe(fixedEventKey(b))
  })

  it('separates an all-camp event from a group-scoped one', () => {
    const a = { name: 'Lunch', time_block: '12:30-1:05', days: ['Monday'], scope: ALL }
    const b = { name: 'Lunch', time_block: '12:30-1:05', days: ['Monday'], scope: some('Oaks') }
    expect(fixedEventKey(a)).not.toBe(fixedEventKey(b))
  })

  it('still separates on the fields it always did', () => {
    const base = { name: 'Swim', time_block: '9:15-9:40', days: ['Monday'], scope: ALL }
    expect(fixedEventKey(base)).not.toBe(fixedEventKey({ ...base, name: 'Art' }))
    expect(fixedEventKey(base)).not.toBe(fixedEventKey({ ...base, time_block: '10:30-11:05' }))
    expect(fixedEventKey(base)).not.toBe(fixedEventKey({ ...base, days: ['Tuesday'] }))
  })

  it('gives the same event the same key, so React keeps its identity across renders', () => {
    const ev = { name: 'Swim', time_block: '9:15-9:40', days: ['Monday', 'Tuesday'], scope: some('Oaks', 'Brook') }
    expect(fixedEventKey(ev)).toBe(fixedEventKey({ ...ev }))
  })

  it('does not confuse one comma-bearing group name with two groups', () => {
    // The reason the parts are serialised structurally rather than joined on a
    // separator: a group literally named "A,B" and the pair ["A","B"] must not
    // collapse into the same key.
    const a = { name: 'Swim', time_block: '9:00-9:30', days: ['Mon'], scope: some('A,B') }
    const b = { name: 'Swim', time_block: '9:00-9:30', days: ['Mon'], scope: some('A', 'B') }
    expect(fixedEventKey(a)).not.toBe(fixedEventKey(b))
  })

  it('tolerates a missing scope rather than throwing mid-render', () => {
    expect(() => fixedEventKey({ name: 'X', time_block: 'Y', days: [] })).not.toThrow()
  })
})
