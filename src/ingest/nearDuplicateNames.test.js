import { describe, it, expect } from 'vitest'
import { findNameVariantCandidates } from './nearDuplicateNames'

// T144 — docs/work/tickets/T144-word-form-name-variants-never-reach-a-director.md
//
// The whitespace/case fold in extractEntities already heals "Lunch2" -> "Lunch
// 2". This detector covers the class it deliberately will not touch: word-form
// variants, where one name is exactly the other plus a grammatical suffix.
// Those cannot be merged deterministically (a wrong merge malforms
// generation), so this only ever PROPOSES, and precision matters far more than
// recall — every false candidate is a question a director should not have been
// asked.
const counts = (obj) => Object.entries(obj).map(([name, count]) => ({ name, count }))

describe('findNameVariantCandidates', () => {
  it('pairs a stem with its -ing form, canonical = the more frequent spelling', () => {
    const out = findNameVariantCandidates(counts({ 'Swim Return': 17, 'Swim Returning': 1, Sports: 9 }))
    expect(out).toEqual([
      { canonical: 'Swim Return', variant: 'Swim Returning', canonicalCount: 17, variantCount: 1 },
    ])
  })

  it('pairs a plural with its singular', () => {
    const out = findNameVariantCandidates(counts({ Project: 6, Projects: 2 }))
    expect(out).toEqual([{ canonical: 'Project', variant: 'Projects', canonicalCount: 6, variantCount: 2 }])
  })

  it('compares whitespace- and case-insensitively', () => {
    const out = findNameVariantCandidates(counts({ classroom: 4, Classrooms: 1 }))
    expect(out).toEqual([{ canonical: 'classroom', variant: 'Classrooms', canonicalCount: 4, variantCount: 1 }])
  })

  it('lets frequency, not length, pick the canonical spelling', () => {
    // The variant being the COMMON one happens; the stem is not automatically
    // the right answer.
    const out = findNameVariantCandidates(counts({ 'Swim Return': 1, 'Swim Returning': 12 }))
    expect(out[0].canonical).toBe('Swim Returning')
    expect(out[0].variant).toBe('Swim Return')
  })

  it('breaks a frequency tie toward the shorter stem, deterministically', () => {
    const out = findNameVariantCandidates(counts({ Projects: 3, Project: 3 }))
    expect(out[0].canonical).toBe('Project')
    expect(out[0].variant).toBe('Projects')
  })

  // --- precision guards: every one of these must propose NOTHING ---

  it('never offers numbered siblings', () => {
    expect(findNameVariantCandidates(counts({ 'Lunch 1': 25, 'Lunch 2': 25, 'Lunch 3': 12 }))).toEqual([])
    expect(findNameVariantCandidates(counts({ 'CIT Block 1': 5, 'CIT Block 2': 5 }))).toEqual([])
  })

  it('never offers unrelated names that merely share a prefix', () => {
    expect(findNameVariantCandidates(counts({ Swim: 18, 'Swim Return': 17 }))).toEqual([])
    expect(findNameVariantCandidates(counts({ 'Gaga Pit': 6, 'Gaga Field': 5 }))).toEqual([])
  })

  it('never offers a suffix that is not a word-form ending', () => {
    expect(findNameVariantCandidates(counts({ Art: 4, Artistry: 2 }))).toEqual([])
  })

  it('ignores names too short to judge', () => {
    expect(findNameVariantCandidates(counts({ Ar: 3, Ars: 1 }))).toEqual([])
  })

  it('returns nothing for a clean list', () => {
    expect(findNameVariantCandidates(counts({ Sports: 9, Music: 8, Drama: 7 }))).toEqual([])
  })

  it('is stable regardless of input order', () => {
    const a = findNameVariantCandidates(counts({ 'Swim Returning': 1, 'Swim Return': 17 }))
    const b = findNameVariantCandidates(counts({ 'Swim Return': 17, 'Swim Returning': 1 }))
    expect(a).toEqual(b)
  })

  it('proposes each pair once, never both directions', () => {
    const out = findNameVariantCandidates(counts({ 'Swim Return': 17, 'Swim Returning': 1 }))
    expect(out.length).toBe(1)
  })

  it('tolerates missing counts and junk entries', () => {
    expect(findNameVariantCandidates([{ name: 'Project' }, { name: 'Projects' }, null, { name: '' }]))
      .toEqual([{ canonical: 'Project', variant: 'Projects', canonicalCount: 0, variantCount: 0 }])
  })
})
