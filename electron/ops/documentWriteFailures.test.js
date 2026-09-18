// @vitest-environment node
//
// T194 round 4, Defect 4. `projection_failures.error_message` stores an unbounded, arbitrary
// thrown-error string, in a table this slice calls PII-adjacent. No validator today interpolates a
// written VALUE into its thrown message, so nothing leaks yet — but if one ever does, that value
// would flow straight into this table with no bound. Truncate at write time so that stays true
// even if a future validator gets it wrong.
import { describe, it, expect } from 'vitest'
import { boundedErrorMessage } from './documentWriteFailures.js'

describe('boundedErrorMessage', () => {
  it('passes short messages through unchanged', () => {
    expect(boundedErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('truncates a message longer than the bound', () => {
    const long = 'x'.repeat(1000)
    const result = boundedErrorMessage(new Error(long))
    expect(result.length).toBeLessThan(1000)
  })

  it('falls back to "unknown" for a nullish error', () => {
    expect(boundedErrorMessage(null)).toBe('unknown')
  })
})
