import { describe, it, expect } from 'vitest'
import { shouldShowReconstructionMoment, ROOTS_MIN_FACT_COUNT } from './reconstructionMoment.gate.js'

describe('shouldShowReconstructionMoment', () => {
  it('shows when at the fact-count floor, first import, motion allowed', () => {
    expect(shouldShowReconstructionMoment({
      factCount: ROOTS_MIN_FACT_COUNT,
      isFirstImport: true,
      prefersReducedMotion: false,
    })).toBe(true)
  })

  it('shows well above the floor', () => {
    expect(shouldShowReconstructionMoment({
      factCount: ROOTS_MIN_FACT_COUNT + 100,
      isFirstImport: true,
      prefersReducedMotion: false,
    })).toBe(true)
  })

  it('skips one fact below the floor', () => {
    expect(shouldShowReconstructionMoment({
      factCount: ROOTS_MIN_FACT_COUNT - 1,
      isFirstImport: true,
      prefersReducedMotion: false,
    })).toBe(false)
  })

  it('skips when factCount is zero (state E, "thin air")', () => {
    expect(shouldShowReconstructionMoment({
      factCount: 0,
      isFirstImport: true,
      prefersReducedMotion: false,
    })).toBe(false)
  })

  it('skips when not the first import, even with plenty of facts', () => {
    expect(shouldShowReconstructionMoment({
      factCount: ROOTS_MIN_FACT_COUNT + 500,
      isFirstImport: false,
      prefersReducedMotion: false,
    })).toBe(false)
  })

  it('skips under reduced motion, even above the floor on a first import', () => {
    expect(shouldShowReconstructionMoment({
      factCount: ROOTS_MIN_FACT_COUNT + 500,
      isFirstImport: true,
      prefersReducedMotion: true,
    })).toBe(false)
  })

  it('reduced motion wins even when every other gate would show it', () => {
    // ADR: reduced motion is a fourth reason to skip straight to the
    // plain-text branch, not a separate in-component code path.
    expect(shouldShowReconstructionMoment({
      factCount: 999,
      isFirstImport: true,
      prefersReducedMotion: true,
    })).toBe(false)
  })

  it('stacked skip reasons still return false, not throw', () => {
    expect(shouldShowReconstructionMoment({
      factCount: 0,
      isFirstImport: false,
      prefersReducedMotion: true,
    })).toBe(false)
  })
})
