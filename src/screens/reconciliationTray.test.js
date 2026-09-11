import { describe, it, expect } from 'vitest'
import { applyTrayState } from './reconciliationTray'

// T127. Importing one real camp file left a director on a 15-screen page with
// 240 buttons and BOTH exits disabled:
//   "Use this setup"  (primary, navy)  -> "Resolve the 79 items marked for your
//                                          attention first."
//   "Apply confirmed..." (secondary)   -> "Resolve at least one item first."
// The button that looked like the way out was the locked one.
describe('applyTrayState', () => {
  it('is never disabled — there is always a way out of this screen', () => {
    const cases = [
      { totalCount: 0, doneCount: 0, confirmedCount: 0 },
      { totalCount: 79, doneCount: 0, confirmedCount: 0 },
      { totalCount: 79, doneCount: 12, confirmedCount: 12 },
      { totalCount: 79, doneCount: 79, confirmedCount: 79 },
    ]
    for (const c of cases) expect(applyTrayState(c).disabled).toBe(false)
  })

  it('offers a way forward with nothing answered — the case that was a dead end', () => {
    const state = applyTrayState({ totalCount: 79, doneCount: 0, confirmedCount: 0 })
    expect(state.disabled).toBe(false)
    expect(state.mode).toBe('confirmedOnly')
    expect(state.label).toBe('Use what Shoresh understood')
    expect(state.hint).toMatch(/79 questions are still open/)
  })

  it('says how many decisions it is about to apply, and what it leaves behind', () => {
    const state = applyTrayState({ totalCount: 79, doneCount: 12, confirmedCount: 12 })
    expect(state.label).toBe('Apply 12 decisions')
    expect(state.hint).toMatch(/67 questions stay here for later/)
  })

  it('applies everything once nothing is outstanding', () => {
    const state = applyTrayState({ totalCount: 79, doneCount: 79, confirmedCount: 79 })
    expect(state.mode).toBe('all')
    expect(state.label).toBe('Use this setup')
  })

  it('reads naturally when a file asked exactly one question', () => {
    expect(applyTrayState({ totalCount: 1, doneCount: 0, confirmedCount: 0 }).hint)
      .toMatch(/1 question is still open/)
    expect(applyTrayState({ totalCount: 2, doneCount: 1, confirmedCount: 1 }).label)
      .toBe('Apply 1 decision')
    expect(applyTrayState({ totalCount: 2, doneCount: 1, confirmedCount: 1 }).hint)
      .toMatch(/1 question stays here/)
  })

  it('handles a file that needed nothing at all', () => {
    const state = applyTrayState({ totalCount: 0, doneCount: 0, confirmedCount: 0 })
    expect(state.label).toBe('Use this setup')
    expect(state.mode).toBe('all')
  })

  it('does not go negative if done somehow exceeds total', () => {
    expect(applyTrayState({ totalCount: 2, doneCount: 5, confirmedCount: 5 }).mode).toBe('all')
  })

  it('tolerates being called with nothing', () => {
    expect(() => applyTrayState()).not.toThrow()
    expect(applyTrayState().disabled).toBe(false)
  })
})
