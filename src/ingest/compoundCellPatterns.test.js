import { describe, expect, test } from 'vitest'
import { detectCompoundCellPatterns } from './compoundCellPatterns'

describe('detectCompoundCellPatterns', () => {
  test('detects wrapper patterns and picks the standalone part as the anchor', () => {
    const cellValues = [
      'Lunch + Leave',
      'Lunch + Leave',
      'Swim & Return',
      'Lunch & Swim',
      'Lunch',
      'Lunch',
      'Swim',
    ]

    const result = detectCompoundCellPatterns(cellValues)

    const byPattern = Object.fromEntries(result.map((c) => [c.pattern, c]))
    expect(Object.keys(byPattern).sort()).toEqual(['Lunch & Swim', 'Lunch + Leave', 'Swim & Return'])

    expect(byPattern['Lunch + Leave']).toMatchObject({
      occurrences: 2,
      parts: ['Lunch', 'Leave'],
      anchorGuess: 'Lunch',
      wrapperGuess: 'Leave',
    })
    expect(byPattern['Swim & Return']).toMatchObject({
      occurrences: 1,
      parts: ['Swim', 'Return'],
      anchorGuess: 'Swim',
      wrapperGuess: 'Return',
    })
    // Both "Lunch" and "Swim" also appear standalone in this fixture — neither
    // if/else branch fires, so this pins the ambiguous "both sides standalone"
    // case distinct from the "neither side standalone" case covered below.
    expect(byPattern['Lunch & Swim']).toMatchObject({
      occurrences: 1,
      parts: ['Lunch', 'Swim'],
      anchorGuess: null,
      wrapperGuess: null,
    })
  })

  test('excludes a compound cell whose parts only ever pair with each other', () => {
    const cellValues = [
      'Arts & Crafts',
      'Arts & Crafts',
      'Arts & Crafts',
      'Arts & Crafts',
      'Arts & Crafts',
    ]

    const result = detectCompoundCellPatterns(cellValues)

    expect(result).toEqual([])
  })

  test('detects every partner of a word with 3+ distinct pairings', () => {
    const cellValues = ['Change/Snack', 'Change/Ga Ga', 'Change/SPLAT']

    const result = detectCompoundCellPatterns(cellValues)

    expect(result.map((c) => c.pattern).sort()).toEqual([
      'Change/Ga Ga',
      'Change/SPLAT',
      'Change/Snack',
    ])
    for (const candidate of result) {
      expect(candidate.occurrences).toBe(1)
    }
  })

  test('still detects a pattern where neither part ever appears standalone', () => {
    const cellValues = [
      'Sports w/G1',
      'Sports w/G2',
      'Sports w/G3',
    ]

    const result = detectCompoundCellPatterns(cellValues)

    expect(result.map((c) => c.pattern).sort()).toEqual([
      'Sports w/G1',
      'Sports w/G2',
      'Sports w/G3',
    ])
    for (const candidate of result) {
      expect(candidate.anchorGuess).toBeNull()
      expect(candidate.wrapperGuess).toBeNull()
    }
  })

  test('returns an empty array for empty input', () => {
    expect(detectCompoundCellPatterns([])).toEqual([])
  })

  test('collapses repeated occurrences of the same pattern into one candidate', () => {
    const cellValues = [
      'Change/Snack',
      'Change/Snack',
      'Change/Snack',
      'Change/Ga Ga',
    ]

    const result = detectCompoundCellPatterns(cellValues)

    const changeSnack = result.find((c) => c.pattern === 'Change/Snack')
    expect(changeSnack.occurrences).toBe(3)
    expect(result).toHaveLength(2)
  })
})
