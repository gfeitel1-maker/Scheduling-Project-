import { describe, it, expect } from 'vitest'
import { CONFIDENCE, classifyConfidence, autoAccepts, tierFromHighFlag } from './confidence.js'

describe('classifyConfidence', () => {
  it('is HIGH at or above highThreshold', () => {
    expect(classifyConfidence(0.8, { highThreshold: 0.8 })).toBe(CONFIDENCE.HIGH)
    expect(classifyConfidence(1, { highThreshold: 0.8 })).toBe(CONFIDENCE.HIGH)
  })

  it('is LOW below highThreshold when mediumThreshold defaults to highThreshold', () => {
    expect(classifyConfidence(0.79, { highThreshold: 0.8 })).toBe(CONFIDENCE.LOW)
  })

  it('never emits MEDIUM when mediumThreshold defaults to highThreshold', () => {
    for (const strength of [0, 0.1, 0.5, 0.79, 0.8, 0.9, 1]) {
      expect(classifyConfidence(strength, { highThreshold: 0.8 })).not.toBe(CONFIDENCE.MEDIUM)
    }
  })

  it('is MEDIUM between mediumThreshold and highThreshold when explicitly set', () => {
    expect(classifyConfidence(0.5, { highThreshold: 0.8, mediumThreshold: 0.4 })).toBe(CONFIDENCE.MEDIUM)
    expect(classifyConfidence(0.3, { highThreshold: 0.8, mediumThreshold: 0.4 })).toBe(CONFIDENCE.LOW)
  })

  it('activityRules-style share input: 0.8 -> HIGH, 0.79 -> LOW', () => {
    const HIGH_PRIORITY_THRESHOLD = 0.8
    expect(classifyConfidence(0.8, { highThreshold: HIGH_PRIORITY_THRESHOLD })).toBe(CONFIDENCE.HIGH)
    expect(classifyConfidence(0.79, { highThreshold: HIGH_PRIORITY_THRESHOLD })).toBe(CONFIDENCE.LOW)
  })

  it('fixedEvents-style occ/operating ratio: equal -> HIGH, less -> LOW', () => {
    expect(classifyConfidence(5 / 5, { highThreshold: 1 })).toBe(CONFIDENCE.HIGH)
    expect(classifyConfidence(4 / 5, { highThreshold: 1 })).toBe(CONFIDENCE.LOW)
  })
})

describe('tierFromHighFlag', () => {
  it('maps true -> HIGH, false -> LOW', () => {
    expect(tierFromHighFlag(true)).toBe(CONFIDENCE.HIGH)
    expect(tierFromHighFlag(false)).toBe(CONFIDENCE.LOW)
  })
})

describe('autoAccepts', () => {
  it('is true only for HIGH', () => {
    expect(autoAccepts(CONFIDENCE.HIGH)).toBe(true)
    expect(autoAccepts(CONFIDENCE.MEDIUM)).toBe(false)
    expect(autoAccepts(CONFIDENCE.LOW)).toBe(false)
    expect(autoAccepts('high')).toBe(true)
  })
})
