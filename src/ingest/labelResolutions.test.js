import { describe, it, expect } from 'vitest'
import { proposeActivityMatch, resolutionMap, RESOLUTION } from './labelResolutions.js'
import { findConnectorVariant } from './nearDuplicateNames.js'

// PRECISION IS THE WHOLE DESIGN GOAL here, inherited from nearDuplicateNames.js's
// own header: a wrong proposal costs a director a judgement call about two names
// that were never related, on a screen whose entire job is to be trustworthy. So
// most of these tests are about what it REFUSES to propose.
describe('findConnectorVariant', () => {
  it('pairs the three spellings of one connector', () => {
    expect(findConnectorVariant('Arts and Crafts', ['Arts & Crafts'])).toBe('Arts & Crafts')
    expect(findConnectorVariant('Arts & Crafts', ['Arts and Crafts'])).toBe('Arts and Crafts')
    expect(findConnectorVariant('Arts + Crafts', ['Arts & Crafts'])).toBe('Arts & Crafts')
  })

  it('is case- and whitespace-insensitive, like every other key in this pipeline', () => {
    expect(findConnectorVariant('arts   AND crafts', ['Arts & Crafts'])).toBe('Arts & Crafts')
  })

  it('does not pair names that differ anywhere else', () => {
    // The rule is EQUALITY once the connector is folded, so a single differing
    // character is a different name. "Lunch 1"/"Lunch 2" is the pair the module's
    // header names as the reason edit distance is forbidden.
    expect(findConnectorVariant('Lunch 1 and 2', ['Lunch 1 and 3'])).toBeNull()
    expect(findConnectorVariant('Arts and Craft', ['Arts & Crafts'])).toBeNull()
  })

  it('does not fire on a label with no connector at all', () => {
    // Without this guard two names differing only in whitespace would pair here,
    // which is buildActivityNameCanonicalMap's job and not this module's.
    expect(findConnectorVariant('Rock Climbing', ['RockClimbing'])).toBeNull()
  })

  it('abstains when TWO existing names fold to the same key', () => {
    // An ambiguous proposal is worse than none: the picker is still open.
    expect(findConnectorVariant('A and B', ['A & B', 'A + B'])).toBeNull()
  })

  it('gives the same answer however many times it is called', () => {
    // `RegExp.prototype.test` on a `g`-flagged regex advances lastIndex on the
    // shared object. A first draft used ONE constant for the replace and the guard
    // and abstained on every other call — a bug no single-call test can see.
    const answers = Array.from({ length: 5 }, () => findConnectorVariant('Arts and Crafts', ['Arts & Crafts']))
    expect(new Set(answers)).toEqual(new Set(['Arts & Crafts']))
  })
})

describe('proposeActivityMatch', () => {
  it('prefers the connector rule, and says which rule answered', () => {
    expect(proposeActivityMatch('Arts and Crafts', ['Swim', 'Arts & Crafts'])).toEqual({
      name: 'Arts & Crafts',
      rule: 'connector',
    })
  })

  it('falls through to the word-form rule', () => {
    expect(proposeActivityMatch('Swim Return', ['Swim Returning'])).toEqual({
      name: 'Swim Returning',
      rule: 'word-form',
    })
    // Either direction of the pair, because which spelling is the camp's is not
    // something the rule gets to decide — the camp's is the one that exists.
    expect(proposeActivityMatch('Classrooms', ['Classroom'])).toEqual({
      name: 'Classroom',
      rule: 'word-form',
    })
  })

  it('proposes nothing rather than something, which is not a failure', () => {
    // The picker opens either way. A null answer means the director scrolls; a
    // wrong answer means they are asked a question about two unrelated names.
    expect(proposeActivityMatch('Quidditch', ['Swim', 'Archery'])).toBeNull()
    expect(proposeActivityMatch('', ['Swim'])).toBeNull()
    expect(proposeActivityMatch('Swim', [])).toBeNull()
  })

  it('never proposes the label itself', () => {
    expect(proposeActivityMatch('Swim', ['Swim'])).toBeNull()
  })
})

describe('resolutionMap', () => {
  it('keys on the raw label, one entry per label', () => {
    expect(
      resolutionMap([
        { label: 'Quidditch', action: RESOLUTION.ADD_ACTIVITY },
        { label: 'Arts and Crafts', action: RESOLUTION.MAP_TO_EXISTING, activityName: 'Arts & Crafts' },
      ])
    ).toEqual({
      Quidditch: { action: 'add_activity', activityName: null },
      'Arts and Crafts': { action: 'map_to_existing', activityName: 'Arts & Crafts' },
    })
  })

  it('drops a mapping with no target, so the resolver never sees a half answer', () => {
    expect(resolutionMap([{ label: 'X', action: RESOLUTION.MAP_TO_EXISTING }])).toEqual({})
  })

  it('a later entry for one label replaces the earlier one', () => {
    // The director changed their mind, which is ordinary and must not leave two
    // answers to one question in the structure the resolver reads.
    const out = resolutionMap([
      { label: 'X', action: RESOLUTION.SPLIT_PACKED },
      { label: 'X', action: RESOLUTION.MAP_TO_EXISTING, activityName: 'Swim' },
    ])
    expect(out.X).toEqual({ action: 'map_to_existing', activityName: 'Swim' })
  })
})
