// Pure half of import answer memory (docs/adr/2026-10-11-import-answer-memory.md, test plan 1, 5).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  signatureOf, classifyDecision, NOT_REMEMBERED, isAutoApplyEligible, AUTO_APPLY_ELIGIBLE,
  toRecordAnswer, toUiAnswer, normalizeDay, blockKey,
} from './answerMemory.js'
import { isMealName, stemOf, numberedBase } from './nameShape.js'

const fixed = (over = {}) => ({
  id: 'x', kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: 'Lunch 1',
  timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  evidence: { basis: 'daily' }, ...over,
})
// The exact-recall KEY: the normalized parts. (The whole signature also carries features and a
// baseline, which differ for reasons that would mask a normalizer defect.)
const sig = (d) => JSON.stringify(signatureOf(d).parts)

describe('normalizers: equal after normalization', () => {
  it('days and blocks and case', () => {
    expect(normalizeDay('Thurs')).toBe(normalizeDay('Thursday'))
    expect(normalizeDay('THURSDAY')).toBe('thursday')
    expect(blockKey('2:25-3:15 PM')).toBe(blockKey('02:25-03:15'))
    expect(sig(fixed({ entityName: 'ARCHERY' }))).toBe(sig(fixed({ entityName: 'archery' })))
    expect(sig(fixed({ days: ['Thurs'] }))).toBe(sig(fixed({ days: ['Thursday'] })))
    expect(sig(fixed({ timeBlock: '2:25-3:15 PM' }))).toBe(sig(fixed({ timeBlock: '02:25-03:15' })))
  })
})

describe('normalizers: must NOT collide', () => {
  const pairs = [
    ['Lunch 1', 'Lunch 2'], ['Lunch 2', 'Lunch2'], ['Swim', 'Swim Return'], ['Alufim 1', 'Alufim1'],
    ['Arts & Crafts', 'Arts and Crafts'],
  ]
  for (const [a, b] of pairs) {
    it(`${a} vs ${b}`, () => {
      expect(sig(fixed({ entityName: a }))).not.toBe(sig(fixed({ entityName: b })))
    })
  }
  it('groups ["A,B"] vs ["A","B"] stay distinct in an exclusion', () => {
    const ex = (g) => ({ id: 'e', kind: 'all_camp_override', entity: 'activities', entityName: 'Trip', evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: g, insteadByGroup: {}, attendingCount: 5, occurrences: 1 } })
    expect(sig(ex(['A,B']))).not.toBe(sig(ex(['A', 'B'])))
  })
  it('keeps long parts whole (no truncation) so a shared prefix still differs', () => {
    const prefix = 'x'.repeat(100)
    const a = signatureOf(fixed({ entityName: prefix + 'a'.repeat(100) })).parts[0]
    const b = signatureOf(fixed({ entityName: prefix + 'b'.repeat(100) })).parts[0]
    expect(a).not.toBe(b)
    expect(a.length).toBe(200)
  })
})

describe('isMealName: collision table', () => {
  it.each(['Lunch', 'lunch 3', 'Menucha 2', 'Snack', 'Lunch2'])('matches %s', (n) => expect(isMealName(n)).toBe(true))
  it.each(['Snack Shack', 'Lunch Duty Volunteering', 'Dinner Dance', 'Bus Games', 'Pickup Basketball'])('does not match %s', (n) => expect(isMealName(n)).toBe(false))
})

describe('stemOf', () => {
  it('numbered siblings share a stem', () => {
    expect(stemOf('Lunch 1')).toBe('lunch')
    expect(stemOf('Lunch 2')).toBe(stemOf('Lunch 3'))
    expect(stemOf('Period 2')).toBe(stemOf('Period 12'))
  })
  it('alphanumeric suffix, short stems and digit stems form no pattern', () => {
    expect(stemOf('Group 2A')).toBeNull()
    expect(stemOf('Group 1b')).toBeNull()
    expect(stemOf('AB 1')).toBeNull()
    expect(stemOf('Swim')).toBeNull()
    expect(stemOf('Grade 4 Team 2')).toBeNull()
  })
  it('numberedBase is the one shared definition', () => {
    expect(numberedBase('Specialty 4')).toBe('specialty')
  })
})

describe('decision kinds are all classified', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/ingest/reconciliationReport.js'), 'utf8')
  const kinds = [...new Set([...source.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]))]
  it('finds the kinds the report emits', () => {
    expect(kinds).toEqual(expect.arrayContaining(['confirm_value', 'confirm_change', 'elective_candidate', 'all_camp_override', 'resolve_conflict']))
  })
  it.each(kinds)('%s is either remembered or on NOT_REMEMBERED', (kind) => {
    const remembered = classifyDecision({ kind, entity: 'fixed_events', field: ['x'] }) != null
    expect(remembered || NOT_REMEMBERED.has(kind)).toBe(true)
  })
  it('every kind has an explicit authority entry: only confirm_value/fixed_events is eligible', () => {
    expect(AUTO_APPLY_ELIGIBLE).toEqual([{ kind: 'confirm_value', entity: 'fixed_events' }])
    for (const kind of kinds) {
      const expected = kind === 'confirm_value'
      expect(isAutoApplyEligible({ kind, entity: 'fixed_events' }, { verdict: 'accept' })).toBe(expected)
    }
    expect(isAutoApplyEligible({ kind: 'confirm_value', entity: 'activities' }, { verdict: 'accept' })).toBe(false)
    expect(isAutoApplyEligible({ kind: 'confirm_value', entity: 'fixed_events' }, { verdict: 'reject' })).toBe(false)
    expect(isAutoApplyEligible({ kind: 'brand_new_kind', entity: 'fixed_events' }, { verdict: 'accept' })).toBe(false)
  })
})

describe('answers map to records and back', () => {
  it('fixed event: Add it is accept, Don\'t add is reject', () => {
    const d = fixed()
    expect(toRecordAnswer(d, { action: 'looks_right' })).toEqual({ verdict: 'accept' })
    expect(toRecordAnswer(d, { action: 'edited' })).toEqual({ verdict: 'reject' })
    expect(toUiAnswer(d, { verdict: 'accept' })).toEqual({ action: 'looks_right' })
    expect(toUiAnswer(d, { verdict: 'reject' })).toEqual({ action: 'edited' })
  })
  it('exclusion, elective, change and ack', () => {
    const ex = { kind: 'all_camp_override', entity: 'activities', entityName: 'Trip', evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: ['CIT'] } }
    expect(toUiAnswer(ex, toRecordAnswer(ex, { choice: 'as_written' }))).toEqual({ choice: 'as_written' })
    const el = { kind: 'elective_candidate', entity: 'elective_sets', entityName: 'Electives' }
    expect(toUiAnswer(el, toRecordAnswer(el, { choice: 'decline' }))).toEqual({ choice: 'decline' })
    const ch = { kind: 'confirm_change', entity: 'activities', entityId: 'a1', entityName: 'Swim', field: ['priority'], proposedValue: 'high' }
    expect(toRecordAnswer(ch, { choice: 'keep' })).toEqual({ verdict: 'keep' })
    const ack = { kind: 'confirm_change', entity: 'fixed_events', entityName: 'Lunch', field: null }
    expect(toUiAnswer(ack, toRecordAnswer(ack, { ack: true }))).toEqual({ ack: true })
  })
  it('an unanswered or unknown answer maps to null', () => {
    expect(toRecordAnswer(fixed(), undefined)).toBeNull()
    expect(toRecordAnswer(fixed(), { action: 'nonsense' })).toBeNull()
  })
})

describe('baseline per qkind (a mismatch downgrades exact to near)', () => {
  it('exclusion baseline carries the attending count, occurrences and what each group has instead', () => {
    const ex = (extra) => ({ id: 'e', kind: 'all_camp_override', entity: 'activities', entityName: 'Trip', evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: ['CIT'], insteadByGroup: { CIT: ['Swim'] }, attendingCount: 5, occurrences: 1, ...extra } })
    expect(signatureOf(ex()).parts).toEqual(signatureOf(ex({ attendingCount: 6 })).parts)
    expect(signatureOf(ex()).baseline).not.toEqual(signatureOf(ex({ attendingCount: 6 })).baseline)
    expect(signatureOf(ex()).baseline).not.toEqual(signatureOf(ex({ insteadByGroup: { CIT: ['Arts'] } })).baseline)
  })
  it('a new excluded group changes the exact key', () => {
    const ex = (g) => ({ id: 'e', kind: 'all_camp_override', entity: 'activities', entityName: 'Trip', evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: g, attendingCount: 5, occurrences: 1 } })
    expect(sig(ex(['CIT']))).not.toBe(sig(ex(['CIT', 'Alufim 1'])))
  })
  it('value qkind: the stored value at answer time is the baseline, the offered from is not', () => {
    const ch = (cur, from) => ({ kind: 'confirm_change', entity: 'activities', entityId: 'a1', entityName: 'Swim', field: ['priority'], proposedValue: 'high', currentValue: cur, from })
    expect(signatureOf(ch('low')).baseline).not.toEqual(signatureOf(ch('mid')).baseline)
    expect(signatureOf(ch('low', 'x')).parts).toEqual(signatureOf(ch('low', 'y')).parts)
  })
  it('classify: a different day set is a different exact key', () => {
    expect(sig(fixed())).not.toBe(sig(fixed({ days: ['Monday'] })))
  })
})
