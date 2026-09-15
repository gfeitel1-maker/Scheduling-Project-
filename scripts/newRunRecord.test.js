// @vitest-environment node
//
// T167 part 1. The generator's value is entirely in WHERE IT DRAWS THE LINE:
// it fills what git and the gate already know, and refuses to fill judgement.
//
// So the load-bearing tests here are the refusals. A generator that helpfully
// invented `omitted_agents: [{ agent: tester, reason: not-applicable }]` would
// produce records that read as diligence and mean nothing — which is worse than
// the 283 commits with no record at all, because at least absence is honest.
import { describe, it, expect } from 'vitest'
import { ticketRefsFrom, gateSummaryFrom, buildRunRecord, NEEDS_JUDGEMENT } from './newRunRecord.js'

describe('ticketRefsFrom — the completion vocabulary, not any mention', () => {
  it('picks up closes/Merge references, case-insensitively, without duplicates', () => {
    expect(ticketRefsFrom([
      'closes T165, closes T166: both done',
      'Merge S4b: a slice',
      'closes t165: again',
    ])).toEqual(['T165', 'T166', 'S4B'])
  })

  it('ignores a bare mention — "relates to T40" is not a closure claim', () => {
    // Deliberately matches check-governance's COMPLETION_REF rule rather than
    // inventing a second, looser one: two definitions of "what closes a ticket"
    // would drift, and the gate's is the one that counts.
    expect(ticketRefsFrom(['perf: speed up the thing, relates to T40'])).toEqual([])
  })

  it('survives empty and malformed input rather than throwing', () => {
    expect(ticketRefsFrom(null)).toEqual([])
    expect(ticketRefsFrom([null, undefined, 42])).toEqual([])
  })
})

describe('gateSummaryFrom — quote the run, never a memory of it', () => {
  it('extracts the verdict and the test count', () => {
    const log = 'noise\n      Tests  5649 passed | 1 skipped (5650)\n✅ VERIFY PASSED — all green\nEXIT=0'
    expect(gateSummaryFrom(log)).toBe('✅ VERIFY PASSED — all green — Tests 5649 passed | 1 skipped (5650)')
  })

  it('reports a FAILED gate as faithfully as a passing one', () => {
    // A generator that only recognised success would quietly file a failing run
    // as though the gate had said nothing.
    expect(gateSummaryFrom('❌ VERIFY FAILED at step: test\nEXIT=1')).toMatch(/VERIFY FAILED/)
  })

  it('returns null for a log with no verdict — absence must read as absence', () => {
    // The T171/T174 defect class: a missing or unreadable result taken for a
    // pass. Here that would mean a record claiming a gate that never ran.
    expect(gateSummaryFrom('starting gate\nnpm error ENOENT')).toBeNull()
    expect(gateSummaryFrom('')).toBeNull()
    expect(gateSummaryFrom(null)).toBeNull()
  })
})

describe('buildRunRecord — fills facts, refuses judgement', () => {
  const base = {
    subjects: ['closes T167: a thing', 'fixup: another'],
    shas: ['abc1234', 'def5678'],
    ticketPaths: ['docs/work/tickets/T167-a-merged-change-should-leave-a-run-record.md'],
    taskClass: 'documentation-governance',
    date: '2026-09-15',
    gateSummary: 'VERIFY PASSED — Tests 5649 passed',
  }

  it('fills everything git and the gate already know', () => {
    const r = buildRunRecord(base)
    expect(r).toMatch(/^task: closes T167: a thing$/m)
    expect(r).toMatch(/^date: 2026-09-15$/m)
    expect(r).toMatch(/^task_class: documentation-governance$/m)
    expect(r).toMatch(/T167-a-merged-change-should-leave-a-run-record\.md/)
    expect(r).toMatch(/- commit abc1234/)
    expect(r).toMatch(/- commit def5678/)
    expect(r).toMatch(/gate: VERIFY PASSED — Tests 5649 passed/)
  })

  it('REFUSES to fill who ran and who was omitted', () => {
    // The whole point. These are judgement; a machine guessing them produces a
    // record that looks like diligence and is not.
    const r = buildRunRecord(base)
    expect(r).toMatch(new RegExp(`^selected_agents: ${NEEDS_JUDGEMENT}$`, 'm'))
    expect(r).toMatch(new RegExp(`^omitted_agents: ${NEEDS_JUDGEMENT}$`, 'm'))
    expect(r).toMatch(new RegExp(`^verdict: ${NEEDS_JUDGEMENT}$`, 'm'))
    expect(r).toMatch(new RegExp(`^archive_when: ${NEEDS_JUDGEMENT}$`, 'm'))
  })

  it('marks a MISSING gate rather than leaving the field blank', () => {
    // A blank line reads as "no gate needed". An explicit marker reads as "you
    // have not said", which is the honest state and the one part 2 can detect.
    const r = buildRunRecord({ ...base, gateSummary: null })
    expect(r).toMatch(new RegExp(`gate: ${NEEDS_JUDGEMENT}`))
    expect(r).toMatch(/paste the verify verdict line/)
  })

  it('marks an unknown task_class rather than guessing one', () => {
    const r = buildRunRecord({ ...base, ticketPaths: [], taskClass: NEEDS_JUDGEMENT })
    expect(r).toMatch(new RegExp(`^task_class: ${NEEDS_JUDGEMENT}$`, 'm'))
    expect(r).toMatch(/^related_tickets: \[\]$/m)
  })

  it('a generated record is never mistakable for a finished one', () => {
    // The property part 2 will gate on: every fresh record carries markers, so
    // "generated and forgotten" cannot be confused with "filled in".
    const r = buildRunRecord(base)
    expect(r.split(NEEDS_JUDGEMENT).length - 1).toBeGreaterThanOrEqual(5)
  })
})
