// Tier 1 patterns (docs/adr/2026-10-11-import-answer-memory.md 3.4, test plan 9).
import { describe, it, expect } from 'vitest'
import { signatureOf } from './answerMemory.js'
import { recallPattern, LEARNING_BAR, progressOf, patternGroups } from './answerPatterns.js'

const fixed = (name, over = {}) => ({
  id: name, kind: 'confirm_value', entity: 'fixed_events', entityId: null, entityName: name,
  timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  evidence: { basis: 'daily' }, ...over,
})
const elective = (name) => ({ id: name, kind: 'elective_candidate', entity: 'elective_sets', entityName: name })
const exclusion = (name, missing = ['CIT']) => ({
  id: name, kind: 'all_camp_override', entity: 'activities', entityName: name,
  evidence: { day: 'Monday', block: '01:00-01:40', missingGroups: missing, insteadByGroup: {}, attendingCount: 5, occurrences: 1 },
})

let n = 0
// A validated record view, built through the real signature so features cannot drift from it.
function rec(decision, { verdict = 'accept', importId = 'i1', role = 'instance', seq = ++n, bulk = false, qualifies = true, tap = false, recalled = false, id, at = '2026-10-01T00:00:00.000Z' } = {}) {
  const s = signatureOf(decision)
  return {
    id: id ?? `r${seq}-${decision.entityName}`, kind: 'import_answer', qkind: s.qkind, role, seq, import_id: importId,
    parts: s.parts, features: s.features, answer: { verdict, ...(tap ? { tap: true } : {}), ...(recalled ? { recalled: true } : {}) },
    bulk, qualifies, confirmed_by: 'u1', confirmed_at: at,
  }
}
const recall = (decision, records, vetoes = []) => recallPattern(decision, records, vetoes)

describe('LEARNING_BAR', () => {
  it('is 3 instances from 2 imports with 1 explicit', () => {
    expect(LEARNING_BAR.instances).toBe(3)
    expect(LEARNING_BAR.imports).toBe(2)
    expect(LEARNING_BAR.explicit).toBe(1)
  })
})

describe('bands', () => {
  it('one example: ASK', () => {
    expect(recall(fixed('Specialty 4'), [rec(fixed('Specialty 1'))])).toBeNull()
  })
  it('2 agreeing: SUGGEST and never auto-applies', () => {
    const r = recall(fixed('Specialty 4'), [rec(fixed('Specialty 1'), { role: 'evidence' }), rec(fixed('Specialty 2'), { role: 'evidence' })])
    expect(r.band).toBe('suggest')
    expect(r.autoApply).toBe(false)
  })
  it('3 distinct instances from ONE import: not established', () => {
    const records = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x) => rec(fixed(x), { importId: 'i1', verdict: 'reject' }))
    expect(recall(fixed('Specialty 4'), records).band).toBe('suggest')
  })
  it('3 from 2 imports with no explicit supporter (all looks_right evidence): SUGGEST only', () => {
    const records = [
      rec(fixed('Specialty 1'), { importId: 'i1', role: 'evidence' }),
      rec(fixed('Specialty 2'), { importId: 'i1', role: 'evidence' }),
      rec(fixed('Specialty 3'), { importId: 'i2', role: 'evidence' }),
    ]
    const r = recall(fixed('Specialty 4'), records)
    expect(r.band).toBe('suggest')
    expect(r.autoApply).toBe(false)
    expect(r.progress.missing).toContain('explicit')
  })
  it('3 from 2 imports with one explicit: ESTABLISHED, and Specialty 4 auto-applies (accepting, eligible)', () => {
    const records = [
      rec(fixed('Specialty 1'), { importId: 'i1', role: 'evidence' }),
      rec(fixed('Specialty 2'), { importId: 'i1', role: 'evidence' }),
      rec(fixed('Specialty 3'), { importId: 'i2', role: 'instance', tap: true }),
    ]
    const r = recall(fixed('Specialty 4'), records)
    expect(r.band).toBe('established')
    expect(r.autoApply).toBe(true)
    expect(r.answer.verdict).toBe('accept')
    expect(r.template).toBe('T1')
  })
  it('the same activity answered 3 times counts once', () => {
    const records = [1, 2, 3].map((i) => rec(fixed('Specialty 1'), { importId: `i${i}`, role: 'instance', tap: true }))
    expect(recall(fixed('Specialty 4'), records)).toBeNull()
  })
  it('bulk-written looks_right counts for nothing (plants 8, 9)', () => {
    const records = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i}`, role: 'evidence', bulk: true }))
    expect(recall(fixed('Specialty 4'), records)).toBeNull()
  })
  it('three looks_right from one session cannot establish', () => {
    const records = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x) => rec(fixed(x), { importId: 'same', role: 'evidence' }))
    expect(recall(fixed('Specialty 4'), records).autoApply).toBe(false)
  })
  it('a tap or edit on a RECALLED card is agreement but never the explicit supporter', () => {
    const records = [
      rec(fixed('Specialty 1'), { importId: 'i1', role: 'evidence' }),
      rec(fixed('Specialty 2'), { importId: 'i2', role: 'evidence' }),
      rec(fixed('Specialty 3'), { importId: 'i2', role: 'instance', tap: true, recalled: true }),
    ]
    expect(recall(fixed('Specialty 4'), records).band).toBe('suggest')
  })
  it('non-qualifying authors count for nothing', () => {
    const records = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i}`, qualifies: false, tap: true }))
    expect(recall(fixed('Specialty 4'), records)).toBeNull()
  })
})

describe('contradiction and demotion', () => {
  const established = () => [
    rec(fixed('Specialty 1'), { importId: 'i1', role: 'evidence' }),
    rec(fixed('Specialty 2'), { importId: 'i1', role: 'evidence' }),
    rec(fixed('Specialty 3'), { importId: 'i2', role: 'instance', tap: true }),
  ]
  it('a contradicting newest answer drops to ASK at once', () => {
    const records = [...established(), rec(fixed('Specialty 5'), { importId: 'i3', verdict: 'reject' })]
    expect(recall(fixed('Specialty 6'), records)).toBeNull()
  })
  it('one override never flips to the opposite auto-apply', () => {
    const records = [...established(), rec(fixed('Specialty 5'), { importId: 'i3', verdict: 'reject' }), rec(fixed('Specialty 6'), { importId: 'i4', verdict: 'reject' })]
    const r = recall(fixed('Specialty 7'), records)
    expect(r.answer.verdict).toBe('reject')
    expect(r.band).toBe('suggest')
    expect(r.autoApply).toBe(false)
  })
  it('the explanation counts disagreement across all live records', () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => rec(fixed(`Specialty ${i + 10}`), { importId: 'old', verdict: 'reject' })),
      ...established(),
    ]
    const r = recall(fixed('Specialty 4'), records)
    expect(r.agree).toBe(3)
    expect(r.disagree).toBe(5)
    expect(r.why).toMatch(/3 agree, 5 earlier disagreed/)
  })
  it('a rejecting answer never auto-applies even when ESTABLISHED', () => {
    const records = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i}`, verdict: 'reject', role: 'instance' }))
    const r = recall(fixed('Specialty 4'), records)
    expect(r.band).toBe('established')
    expect(r.autoApply).toBe(false)
  })
})

describe('baselines cap at SUGGEST', () => {
  const base = () => ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i % 2}`, role: i === 2 ? 'instance' : 'evidence', tap: i === 2 }))
  it('equal shapes establish', () => {
    expect(recall(fixed('Specialty 4'), base()).band).toBe('established')
  })
  it('dayShape mismatch', () => {
    const r = recall(fixed('Specialty 4', { days: ['Monday'], evidence: { basis: 'weekly' } }), base())
    expect(r.band).toBe('suggest')
    expect(r.autoApply).toBe(false)
  })
  it('blockLenClass mismatch', () => {
    const r = recall(fixed('Specialty 4', { timeBlock: '12:00-13:30' }), base())
    expect(r.band).toBe('suggest')
  })
  it('scopeShape mismatch', () => {
    const r = recall(fixed('Specialty 4', { evidence: { basis: 'daily', scope: 'subset' } }), base())
    expect(r.band).toBe('suggest')
  })
})

describe('authority registry', () => {
  it('elective_candidate through T1 never auto-applies, however strong', () => {
    const records = ['Elective Block 1', 'Elective Block 2', 'Elective Block 3'].map((x, i) => rec(elective(x), { importId: `i${i % 2}`, role: 'instance', tap: true }))
    const r = recall(elective('Elective Block 4'), records)
    expect(r.band).toBe('established')
    expect(r.autoApply).toBe(false)
    expect(r.progress.neverAutoApply).toBe(true)
  })
  it('"All camp except CIT" for 3 activities pre-selects the 4th and does not auto-apply (T3)', () => {
    const records = ['Trip', 'Color War', 'Overnight'].map((x, i) => rec(exclusion(x), { importId: `i${i % 2}`, verdict: 'as_written', role: 'instance' }))
    const r = recall(exclusion('Hike'), records)
    expect(r.template).toBe('T3')
    expect(r.answer.verdict).toBe('as_written')
    expect(r.autoApply).toBe(false)
    expect(r.progress.neverAutoApply).toBe(true)
  })
  it('a different excluded set is a different pattern', () => {
    const records = ['Trip', 'Color War', 'Overnight'].map((x) => rec(exclusion(x, ['Alufim 1']), { verdict: 'as_written' }))
    expect(recall(exclusion('Hike', ['CIT']), records)).toBeNull()
  })
})

describe('T2 meal', () => {
  it('Lunch, Menucha 2 and Snack share the meal pattern; Snack Shack does not match', () => {
    const records = ['Lunch', 'Menucha 2', 'Snack'].map((x, i) => rec(fixed(x), { importId: `i${i % 2}`, role: i === 0 ? 'instance' : 'evidence', tap: i === 0 }))
    expect(recall(fixed('Dinner'), records).template).toBe('T2')
    expect(recall(fixed('Snack Shack'), records)).toBeNull()
  })
})

describe('ordering without clocks', () => {
  it('orders by seq, not confirmed_at: a record from a device whose clock runs a day ahead does not win', () => {
    const records = [
      rec(fixed('Specialty 1'), { verdict: 'reject', seq: 1, at: '2099-01-01T00:00:00.000Z', role: 'evidence' }),
      rec(fixed('Specialty 2'), { verdict: 'accept', seq: 2, at: '2020-01-01T00:00:00.000Z', role: 'evidence' }),
      rec(fixed('Specialty 3'), { verdict: 'accept', seq: 3, at: '2020-01-02T00:00:00.000Z', role: 'evidence' }),
    ]
    const r = recall(fixed('Specialty 4'), records)
    expect(r.answer.verdict).toBe('accept')
    expect(r.band).toBe('suggest')
  })
})

describe('veto', () => {
  const records = () => ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i % 2}`, role: i === 2 ? 'instance' : 'evidence', tap: i === 2 }))
  it('ignores exactly the answers it covers; newer answers rebuild only by clearing the bar', () => {
    const rs = records()
    const veto = { qualifies: true, parts: ['T1', 'fixed_event|specialty'], covers: rs.map((r) => r.id), seq: 99 }
    expect(recall(fixed('Specialty 4'), rs, [veto])).toBeNull()
    const newer = [rec(fixed('Specialty 7'), { importId: 'i9', role: 'evidence' }), rec(fixed('Specialty 8'), { importId: 'i9', role: 'evidence' })]
    const r = recall(fixed('Specialty 4'), [...rs, ...newer], [veto])
    expect(r.band).toBe('suggest')
  })
  it('a veto from a non-qualifying author does nothing', () => {
    const rs = records()
    const veto = { qualifies: false, parts: ['T1', 'fixed_event|specialty'], covers: rs.map((r) => r.id), seq: 99 }
    expect(recall(fixed('Specialty 4'), rs, [veto]).band).toBe('established')
  })
})

describe('progress toward auto-apply (the view)', () => {
  it('reports 2 of 3 and what is missing', () => {
    const rs = [rec(fixed('Specialty 1'), { importId: 'i1', role: 'evidence' }), rec(fixed('Specialty 2'), { importId: 'i1', role: 'evidence' })]
    const group = [...patternGroups(rs, []).values()][0]
    const p = progressOf(group)
    expect(p.agreeing).toBe(2)
    expect(p.needed).toBe(3)
    expect(p.missing).toEqual(expect.arrayContaining(['more_answers', 'another_import', 'explicit']))
    expect(p.neverAutoApply).toBe(false)
  })
  it('a rejecting pattern says it only pre-selects', () => {
    const rs = ['Specialty 1', 'Specialty 2', 'Specialty 3'].map((x, i) => rec(fixed(x), { importId: `i${i % 2}`, verdict: 'reject' }))
    const p = progressOf([...patternGroups(rs, []).values()][0])
    expect(p.neverAutoApply).toBe(true)
  })
})
