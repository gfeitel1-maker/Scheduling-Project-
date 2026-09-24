import { describe, it, expect } from 'vitest'
import { applyTrayState, commitTrayState } from './reconciliationTray'

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

// T253 — the post-commit exit tray (Amendment, docs/adr/2026-08-17-onescreen-
// reconciliation-undo.md). Undo eligibility is gated on `undoCapable` ALONE
// (the caller derives it from Array.isArray(outcome.invertibleOps) — see
// Invariant 3), never re-derived here from mode.
describe('commitTrayState', () => {
  it('secondary is null when the commit was not undo-capable (replace mode)', () => {
    const tray = commitTrayState({ notices: [], undoCapable: false, undoState: { total: 40 } })
    expect(tray.secondary).toBeNull()
    expect(tray.hint).toBe('Setup replaced and ready.')
    expect(tray.receipt).toBeNull()
  })

  it('secondary is non-null when the commit is undo-capable and the window is live', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'live', isLive: true, isPending: false, total: 40, secondsLeft: null },
    })
    expect(tray.secondary).not.toBeNull()
    expect(tray.secondary.label).toBe('Undo this import')
    expect(tray.hint).toBe('Imported 40 records.')
  })

  it('the not-undoable state never mentions undo, per Invariant 5c', () => {
    const tray = commitTrayState({ notices: [], undoCapable: false, undoState: { total: 40 } })
    expect(tray.hint.toLowerCase()).not.toMatch(/undo/)
    expect(tray.hint.toLowerCase()).not.toMatch(/always/)
  })

  it('says "for the next few minutes" with more than 60s left', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'live', isLive: true, isPending: false, total: 1, secondsLeft: null },
    })
    expect(tray.secondary.note).toBe('for the next few minutes')
    expect(tray.hint).toBe('Imported 1 record.')
  })

  it('shows a live countdown in the last 60 seconds', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'live', isLive: true, isPending: false, total: 40, secondsLeft: 42 },
    })
    expect(tray.secondary.note).toBe('42s left')
  })

  it('shows "Undoing…" with the note hidden while an undo is in flight', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'live', isLive: true, isPending: true, total: 40, secondsLeft: 10 },
    })
    expect(tray.secondary.label).toBe('Undoing…')
    expect(tray.secondary.pending).toBe(true)
    expect(tray.secondary.note).toBeUndefined()
  })

  it('removes secondary entirely (not disabled) once undo succeeds, and shows "Undo complete."', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'used', isLive: false, isPending: false, total: 40, deleted: [], skipped: [], kept: [] },
    })
    expect(tray.hint).toBe('Undo complete.')
    expect(tray.secondary).toBeNull()
  })

  it('a failed undo keeps the import-succeeded hint and offers a retryable secondary', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'live', isLive: true, isPending: false, total: 40, secondsLeft: null, undoError: 'This import could not be undone. Please try again.' },
    })
    expect(tray.hint).toBe('Imported 40 records.')
    expect(tray.secondary.label).toBe('Undo this import')
    expect(tray.secondary.disabled).toBe(false)
  })

  it('an expired window keeps the hint unchanged and drops the secondary', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'expired', isLive: false, isPending: false, total: 40 },
    })
    expect(tray.hint).toBe('Imported 40 records.')
    expect(tray.secondary).toBeNull()
  })

  it('builds a three-bucket receipt summary and detail after a successful undo', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: {
        status: 'used',
        isLive: false,
        isPending: false,
        total: 40,
        deleted: [{ entity: 'activities', entity_id: 'a1' }, { entity: 'activities', entity_id: 'a2' }],
        skipped: [{ entity: 'activities', entity_id: 'a3', field: 'name' }],
        kept: [{ name: 'Swim', reason: 'referenced', referencedByCount: 3 }],
      },
    })
    expect(tray.receipt.summary).toBe('Removed 2 records. Kept 1 changed since import, and 1 still in use.')
    expect(tray.receipt.detail).toEqual([
      'Kept — changed since import: name',
      'Kept — still in use: Swim (used by 3 other records)',
    ])
  })

  it('summarizes deletions-only with no kept clause', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'used', isLive: false, isPending: false, total: 40, deleted: [{ entity: 'a', entity_id: '1' }], skipped: [], kept: [] },
    })
    expect(tray.receipt.summary).toBe('Removed 1 record.')
    expect(tray.receipt.detail).toEqual([])
  })

  it('says nothing was removed when everything had changed since import', () => {
    const tray = commitTrayState({
      notices: [],
      undoCapable: true,
      undoState: { status: 'used', isLive: false, isPending: false, total: 40, deleted: [], skipped: [{ entity: 'a', entity_id: '1', field: 'name' }], kept: [] },
    })
    expect(tray.receipt.summary).toBe('Nothing removed — everything had changed since import.')
  })

  it('is not thrown by missing undoState', () => {
    expect(() => commitTrayState({ notices: [], undoCapable: false })).not.toThrow()
  })
})
