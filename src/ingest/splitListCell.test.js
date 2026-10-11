import { describe, it, expect } from 'vitest'
import { strictSplit, looksListLike, looseSplit } from './splitListCell.js'

describe('strictSplit', () => {
  it('splits a spaced-slash list of five', () => {
    expect(strictSplit('Hiking / Fishing / Kayaking / Orienteering / Bocce'))
      .toEqual(['Hiking', 'Fishing', 'Kayaking', 'Orienteering', 'Bocce'])
  })
  it('splits comma and semicolon lists of three', () => {
    expect(strictSplit('Art, Music, Drama')).toEqual(['Art', 'Music', 'Drama'])
    expect(strictSplit('Art; Music; Drama')).toEqual(['Art', 'Music', 'Drama'])
  })
  it.each([
    'Arts, Crafts & More', 'Arts/Crafts', 'Lunch/Rest Hour', 'Art / Music',
    'Art, Music', 'Art, , Music', 'Art, Music and Drama, Chess',
    'Art, Music, one two three four five', 'Swim', 'Art/Music/Drama',
  ])('does not split %s', (cell) => {
    expect(strictSplit(cell)).toBeNull()
  })
})

describe('strictSplit tightening', () => {
  it.each([
    'Art, Music; Drama', 'Art, Music, Drama / Chess', 'Grades 3, 4, 5', 'Bunks 1, 2, 3', '10, 20, 30',
    'Mon, Wed, Fri', 'Monday, Tuesday, Art', 'Staff: Dan, Moshe, Yossi', 'A, Music, Drama',
  ])('does not split %s', (cell) => {
    expect(strictSplit(cell)).toBeNull()
  })
  it('splits exactly three parts and parts of exactly four words', () => {
    expect(strictSplit('Art, Music, Drama')).toHaveLength(3)
    expect(strictSplit('a b c d, e f g h, Chess')).toEqual(['a b c d', 'e f g h', 'Chess'])
  })
  it('collapses duplicate parts case-insensitively', () => {
    expect(strictSplit('Art, art, Music, Drama')).toEqual(['Art', 'Music', 'Drama'])
  })
})

describe('looksListLike / looseSplit', () => {
  it('flags an unspaced slash, a two-part list and an & part as list-like', () => {
    expect(looksListLike('Arts/Crafts')).toBe(true)
    expect(looksListLike('Arts, Crafts & More')).toBe(true)
    expect(looksListLike('Swim')).toBe(false)
  })
  it('looseSplit separates on , ; / and trims', () => {
    expect(looseSplit('Arts/Crafts')).toEqual(['Arts', 'Crafts'])
    expect(looseSplit('Arts, Crafts & More')).toEqual(['Arts', 'Crafts & More'])
  })
})
