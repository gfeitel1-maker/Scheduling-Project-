// Catches a test whose ONLY assertion is that a filtered/derived collection
// is empty — which is also trivially true if the mechanism under test never
// ran at all (the #696 class: a rename makes a lookup silently return
// nothing, and a test asserting "no X" cannot tell that apart from "X never
// checked"). Flags only when EVERY expect() in the test is absence-shaped —
// a companion assertion of any other shape proves the positive path ran.

import { describe, it, expect } from 'vitest'
import { scanVacuousFilterAssertionInText } from './vacuousFilterAssertion.js'

function check(source, path = 'fixture.test.js') {
  return scanVacuousFilterAssertionInText(path, source)
}

describe('vacuousFilterAssertion', () => {
  it('fires when the only assertion is an empty .filter() result', () => {
    const src = `
      it('has no unresolved conflicts', () => {
        const unresolved = conflicts.filter((c) => !c.resolved)
        expect(unresolved).toHaveLength(0)
      })
    `
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('vacuous-filter-assertion')
    expect(findings[0].message).toContain('unresolved')
  })

  it('fires on the direct inline .filter(...).toEqual([]) shape', () => {
    const src = `
      test('nothing stale', () => {
        expect(rows.filter((r) => r.stale)).toEqual([])
      })
    `
    expect(check(src)).toHaveLength(1)
  })

  it('does not fire when a companion assertion proves the positive path ran', () => {
    const src = `
      it('has no unresolved conflicts', () => {
        const unresolved = conflicts.filter((c) => !c.resolved)
        expect(conflicts.length).toBeGreaterThan(0)
        expect(unresolved).toHaveLength(0)
      })
    `
    expect(check(src)).toEqual([])
  })

  it('does not fire on a non-filter empty assertion', () => {
    const src = `
      it('starts empty', () => {
        expect(queue).toHaveLength(0)
      })
    `
    expect(check(src)).toEqual([])
  })

  it('does not fire on it.each/.skip/.only (member-expression callee)', () => {
    const src = `
      it.each([1, 2])('case %i', () => {
        const unresolved = conflicts.filter((c) => !c.resolved)
        expect(unresolved).toHaveLength(0)
      })
    `
    expect(check(src)).toEqual([])
  })

  it('does not fire when the test has no expect() calls at all', () => {
    const src = `
      it('is a placeholder', () => {
        doSomething()
      })
    `
    expect(check(src)).toEqual([])
  })
})
