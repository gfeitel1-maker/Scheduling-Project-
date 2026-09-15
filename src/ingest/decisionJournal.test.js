import { describe, it, expect } from 'vitest'
import { journalEntriesFor, OUTCOMES } from './decisionJournal'

// The answer shapes here are the REAL ones, read off isDecisionResolved in
// reconciliationResolutions.js — not invented. A first draft of the module
// guessed a uniform `answer.choice` and would have recorded almost every real
// answer as UNANSWERED: not an empty journal, but a confidently wrong one, which
// is worse because every later slice trusts it. These tests exist mostly to stop
// that happening again.
const confirmValue = (id) => ({ id, kind: 'confirm_value', entity: 'activities', entityName: 'Swim' })
const backedChange = (id) => ({ id, kind: 'confirm_change', entity: 'activities', entityName: 'Swim', field: ['min_per_week'] })
const unbackedChange = (id) => ({ id, kind: 'confirm_change', entity: 'anchor_activities', entityName: 'Mifkad', field: [] })
const legacy = (id) => ({ id, kind: 'review_legacy_priority', entity: 'activities', entityName: 'Archery' })
const conflict = (id) => ({ id, kind: 'resolve_conflict', entity: 'groups', entityName: 'Bunk 1' })

function outcomeOf(decision, answer) {
  return journalEntriesFor([decision], answer ? { [decision.id]: answer } : {}, 'imp-1')[0].outcome
}

describe('journalEntriesFor — one entry per decision PRESENTED', () => {
  it('records a decision nobody answered, because that is the point', () => {
    // A question skipped every import is a question that should probably not be
    // asked — and nothing in the app currently records that it was skipped.
    const entries = journalEntriesFor([confirmValue('d1')], {}, 'imp-1')
    expect(entries).toHaveLength(1)
    expect(entries[0].outcome).toBe(OUTCOMES.UNANSWERED)
  })

  it('keeps every presented decision, answered or not', () => {
    const entries = journalEntriesFor(
      [confirmValue('d1'), confirmValue('d2')],
      { d1: { action: 'looks_right' } },
      'imp-1'
    )
    expect(entries.map((e) => e.outcome)).toEqual([OUTCOMES.ACCEPTED, OUTCOMES.UNANSWERED])
  })

  it('stamps the import id so one import\'s decisions stay together', () => {
    expect(journalEntriesFor([confirmValue('d1')], {}, 'imp-7')[0].import_id).toBe('imp-7')
  })

  it('ignores malformed decisions rather than failing an import over diagnostics', () => {
    expect(journalEntriesFor([null, {}, { id: 'x' }, confirmValue('d1')], {}, 'i')).toHaveLength(1)
  })
})

describe('outcome, per kind, against the real answer shapes', () => {
  it('confirm_value: looks_right is ACCEPTED, edited is CHANGED', () => {
    expect(outcomeOf(confirmValue('d'), { action: 'looks_right' })).toBe(OUTCOMES.ACCEPTED)
    expect(outcomeOf(confirmValue('d'), { action: 'edited' })).toBe(OUTCOMES.CHANGED)
    expect(outcomeOf(confirmValue('d'), { action: 'something-else' })).toBe(OUTCOMES.UNANSWERED)
  })

  it('backed confirm_change: accept took the overwrite, keep declined it', () => {
    // Here the PROPOSAL is the overwrite, so 'keep' is a rejection of it — not
    // an absence of an answer. Getting this backwards would teach a later slice
    // the opposite of what the director decided.
    expect(outcomeOf(backedChange('d'), { choice: 'accept' })).toBe(OUTCOMES.ACCEPTED)
    expect(outcomeOf(backedChange('d'), { choice: 'keep' })).toBe(OUTCOMES.REJECTED)
  })

  it('unbacked confirm_change resolves by acknowledgement, not by choice', () => {
    expect(outcomeOf(unbackedChange('d'), { ack: true })).toBe(OUTCOMES.ACCEPTED)
    expect(outcomeOf(unbackedChange('d'), { choice: 'accept' })).toBe(OUTCOMES.UNANSWERED)
  })

  it('review_legacy_priority resolves by a resolved flag', () => {
    expect(outcomeOf(legacy('d'), { resolved: true })).toBe(OUTCOMES.ACCEPTED)
    expect(outcomeOf(legacy('d'), {})).toBe(OUTCOMES.UNANSWERED)
  })

  it('resolve_conflict distinguishes pointing at a record from taking the default', () => {
    expect(outcomeOf(conflict('d'), { choice: 'existing', entity_id: 'g1' })).toBe(OUTCOMES.CHANGED)
    expect(outcomeOf(conflict('d'), { choice: 'create' })).toBe(OUTCOMES.ACCEPTED)
    expect(outcomeOf(conflict('d'), { choice: 'skip' })).toBe(OUTCOMES.REJECTED)
  })

  it('an UNTAUGHT kind is unanswered, never a throw and never a guess', () => {
    // A new decision kind must not be able to fail an import through the
    // journal, which is diagnostics. It shows up as a gap in the data, which is
    // the signal to teach it.
    const entry = journalEntriesFor(
      [{ id: 'd', kind: 'some_future_kind' }],
      { d: { choice: 'accept' } },
      'i'
    )[0]
    expect(entry.outcome).toBe(OUTCOMES.UNANSWERED)
  })
})

describe('what is stored', () => {
  it('stores compact JSON, not the decision object', () => {
    const fat = { ...confirmValue('d1'), sourceRows: new Array(500).fill({ big: 'payload' }) }
    const entry = journalEntriesFor([fat], { d1: { action: 'edited', value: 3 } }, 'i')[0]
    expect(entry.proposed).not.toMatch(/big/)
    expect(JSON.parse(entry.proposed)).toEqual({ entity: 'activities', entityName: 'Swim', field: null, confidence: null })
    expect(JSON.parse(entry.chosen)).toEqual({ choice: null, entity_id: null, value: 3 })
  })

  it('survives a value that will not serialize', () => {
    const cyclic = {}
    cyclic.self = cyclic
    const entry = journalEntriesFor([confirmValue('d1')], { d1: { action: 'edited', value: cyclic } }, 'i')[0]
    expect(entry.chosen).toBeNull()
    expect(entry.outcome).toBe(OUTCOMES.CHANGED)
  })

  it('records the lane a question ARRIVED in, independent of how it was answered', () => {
    const d = { ...confirmValue('d1'), _lane: 'hold' }
    expect(journalEntriesFor([d], { d1: { action: 'looks_right' } }, 'i')[0].lane).toBe('hold')
  })
})
