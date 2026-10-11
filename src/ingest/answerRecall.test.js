// The renderer-side seam of import answer memory: recall onto decisions, answers out to the store.
import { describe, it, expect } from 'vitest'
import { attachRecall, answerMemoryEntries, trackBulk } from './answerRecall.js'
import { journalEntriesFor } from './decisionJournal.js'

const fixed = (name) => ({
  id: `fe:${name}`, kind: 'confirm_value', entity: 'fixed_events', entityName: name, timeBlock: '12:00-12:40',
  days: ['Monday'], evidence: { basis: 'daily', support: { rows: Array.from({ length: 50 }, (_, i) => i) } }, reason: 'because',
})

describe('attachRecall', () => {
  it('adds { tier, answer, why, progress } as decision.recalled, without mutating the report', () => {
    const report = { decisions: [fixed('A'), fixed('B')], buckets: { understood: 0 }, readiness: [] }
    const recalled = { tier: 0, match: 'exact', answer: { action: 'looks_right' }, why: 'Remembered', progress: null, autoApply: true }
    const next = attachRecall(report, { 'fe:A': recalled, 'fe:B': null })
    expect(next.decisions[0].recalled).toEqual(recalled)
    expect('recalled' in next.decisions[1]).toBe(false)
    expect('recalled' in report.decisions[0]).toBe(false)
    expect(next.buckets).toBe(report.buckets)
  })
  it('is a no-op for an empty or missing map', () => {
    const report = { decisions: [fixed('A')], buckets: {}, readiness: [] }
    expect(attachRecall(report, undefined)).toBe(report)
    expect(attachRecall(report, {})).toBe(report)
  })
})

describe('answerMemoryEntries', () => {
  it('lists answered decisions only, with compact decisions and the bulk, tap and near flags', () => {
    const decisions = [fixed('A'), fixed('B'), fixed('C'), { ...fixed('D'), recallShown: true, recalled: { match: 'near', memoryId: 'm1', answer: { action: 'edited' }, why: 'x' } }]
    const answers = {
      'fe:A': { action: 'looks_right' },
      'fe:B': { action: 'looks_right', tap: true },
      'fe:D': { action: 'edited', rememberNear: true },
    }
    const entries = answerMemoryEntries(decisions, answers, { bulkIds: new Set(['fe:A']) })
    expect(entries.map((e) => e.decision.id)).toEqual(['fe:A', 'fe:B', 'fe:D'])
    expect(entries[0]).toMatchObject({ bulk: true })
    expect(entries[1]).toMatchObject({ bulk: false, tap: true })
    expect(entries[2]).toMatchObject({ recalled: { match: 'near' }, rememberNear: true })
    expect(entries[0].decision.recalled).toBeUndefined()
    expect(JSON.stringify(entries[0].decision).length).toBeLessThan(600)
  })
  it('a recall the director never saw is not marked recalled, so the answer is remembered as a fresh one', () => {
    const d = { ...fixed('E'), recalled: { match: 'near', memoryId: 'm1', answer: { action: 'edited' }, why: 'x' } }
    const [entry] = answerMemoryEntries([d], { 'fe:E': { action: 'edited' } })
    expect(entry.recalled).toBeUndefined()
    const [shown] = answerMemoryEntries([{ ...d, recallShown: true }], { 'fe:E': { action: 'edited' } })
    expect(shown.recalled).toEqual({ match: 'near', memoryId: 'm1' })
  })
  it('sends nothing for kinds that are not remembered', () => {
    const d = { id: 'c', kind: 'resolve_conflict', entity: 'groups', entityName: 'G' }
    expect(answerMemoryEntries([d], { c: { choice: 'create' } })).toEqual([])
  })
})

describe('the journal records what a recalled decision was learned from', () => {
  it('carries learned_from_id when the answer is the recalled one, and nothing otherwise', () => {
    const d = { ...fixed('A'), recallShown: true, recalled: { memoryId: 'm1', answer: { action: 'looks_right' } } }
    const [same] = journalEntriesFor([d], { 'fe:A': { action: 'looks_right' } }, 'imp')
    expect(same.learned_from_id).toBe('m1')
    expect(same.outcome).toBe('accepted')
    const [other] = journalEntriesFor([d], { 'fe:A': { action: 'edited' } }, 'imp')
    expect('learned_from_id' in other).toBe(false)
    const [unseen] = journalEntriesFor([{ ...d, recallShown: false }], { 'fe:A': { action: 'looks_right' } }, 'imp')
    expect('learned_from_id' in unseen).toBe(false)
    const [plain] = journalEntriesFor([fixed('B')], { 'fe:B': { action: 'looks_right' } }, 'imp')
    expect('learned_from_id' in plain).toBe(false)
  })
})

describe('trackBulk', () => {
  it('marks every id of a multi-id answer, and un-marks one answered on its own later', () => {
    const bulk = new Set()
    trackBulk(bulk, ['a', 'b', 'c'])
    expect([...bulk]).toEqual(['a', 'b', 'c'])
    trackBulk(bulk, ['b'])
    expect([...bulk]).toEqual(['a', 'c'])
    trackBulk(bulk, ['d'])
    expect(bulk.has('d')).toBe(false)
  })
})
