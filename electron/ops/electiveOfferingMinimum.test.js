// T265 — the ONE resolution of an offering's (min_mode, min_to_run) pair, and
// the proof that the authority column actually governs.
//
// min_mode is the AUTHORITY. Under 'none' the value column is ignored ENTIRELY —
// never coerced, never compared — so a leftover value from a minimum a director
// set and then cleared cannot come back to life.
import { describe, expect, it } from 'vitest'
import { resolveOfferingMinimum } from './electiveOfferingCapacity.js'

describe('resolveOfferingMinimum', () => {
  it('reads a stated minimum', () => {
    expect(resolveOfferingMinimum({ min_mode: 'required', min_to_run: 5 }))
      .toEqual({ kind: 'required', minimum: 5 })
  })

  it('accepts a minimum of 1, the smallest the owner allows', () => {
    expect(resolveOfferingMinimum({ min_mode: 'required', min_to_run: 1 }))
      .toEqual({ kind: 'required', minimum: 1 })
  })

  it('reports no minimum when the mode says none', () => {
    expect(resolveOfferingMinimum({ min_mode: 'none', min_to_run: null }))
      .toEqual({ kind: 'none' })
  })

  // THE AUTHORITY TEST. A non-NULL leftover value under mode 'none' must behave
  // as no minimum. Without this the value column could govern on its own and the
  // two-part shape would be decoration.
  it('ignores a leftover value entirely when the mode says none', () => {
    expect(resolveOfferingMinimum({ min_mode: 'none', min_to_run: 5 }))
      .toEqual({ kind: 'none' })
  })

  // ('required', NULL) — a minimum declared but not stated, the exact mirror of
  // capacity's `unknownLimit`. It is NOT treated as a minimum of 0 and NOT
  // treated as unrunnable: coercing either way is the blank-capacity defect this
  // shape exists to avoid, so nothing is enforced and the caller decides.
  it('names a declared-but-unstated minimum rather than coercing it', () => {
    expect(resolveOfferingMinimum({ min_mode: 'required', min_to_run: null }))
      .toEqual({ kind: 'unknownMinimum' })
  })

  // The dev mock's rows are plain JS objects with no schema behind them, so a
  // row created through the ordinary "Add Offering" UI reads back with min_mode
  // literally undefined. Missing means the schema DEFAULT, not a rejection —
  // the same ruling as buildOfferings.js's H5 comment for capacity.
  it('defaults a row with no minimum columns to none', () => {
    expect(resolveOfferingMinimum({})).toEqual({ kind: 'none' })
    expect(resolveOfferingMinimum(undefined)).toEqual({ kind: 'none' })
  })
})
