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
import { ticketRefsFrom, mentionedTicketsFrom, gateSummaryFrom, buildRunRecord, NEEDS_JUDGEMENT } from './newRunRecord.js'
import { AGENTS } from './check-governance.js'

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
    // omitted_agents is a pre-listed roster of stubs rather than one marker —
    // see the roster describe block below for why that is stronger.
    expect(r).toMatch(/^omitted_agents:$/m)
    expect(r).toMatch(new RegExp(`- agent: maker\\n    reason: ${NEEDS_JUDGEMENT}`))
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

describe('mentionedTicketsFrom — association, not closure', () => {
  it('picks up a bare mention that ticketRefsFrom deliberately ignores', () => {
    // Found by using the tool on its own first commit: the subject was
    // "T167 part 1: ..." — plainly about T167, and not a closure claim — which
    // produced an empty related_tickets.
    const subjects = ['T167 part 1: make filing cheap']
    expect(ticketRefsFrom(subjects)).toEqual([])
    expect(mentionedTicketsFrom(subjects)).toEqual(['T167'])
  })

  it('feeds association only, so it cannot change how a closure gate reads', () => {
    // The looser match is safe precisely because nothing downstream of it is a
    // closure check. ticketRefsFrom remains the single definition of "closes".
    expect(ticketRefsFrom(['perf: relates to T40'])).toEqual([])
    expect(mentionedTicketsFrom(['perf: relates to T40'])).toEqual(['T40'])
  })

  it('does not match a bare number or a word that merely starts with T', () => {
    expect(mentionedTicketsFrom(['fix: bump to 167', 'Tidy up the Thing'])).toEqual([])
  })
})

describe('the full roster is pre-listed, so an agent cannot be forgotten', () => {
  it('emits a stub for every Article VII agent', () => {
    // Found by filing this generator's own first record: check:governance
    // rejected it because `maker` and `grader` were simply forgotten. Article
    // VII requires every agent selected or omitted-with-a-reason, and a blank
    // template relies on someone remembering ten roles at the moment they are
    // least inclined to.
    const r = buildRunRecord({ subjects: ['x'], shas: ['a1'], ticketPaths: [], taskClass: 't', date: '2026-09-15', gateSummary: 'g' })
    for (const agent of AGENTS) {
      expect(r, `${agent} must be pre-listed`).toMatch(new RegExp(`- agent: ${agent}\\n`))
    }
    expect((r.match(/- agent: /g) || []).length).toBe(AGENTS.length)
  })

  it('every stub demands a reason rather than defaulting to one', () => {
    // The generator must not pick `not-applicable` for anyone. Turning
    // remembering into deleting is the goal; turning it into rubber-stamping is
    // the failure this whole ticket is about.
    const r = buildRunRecord({ subjects: ['x'], shas: ['a1'], ticketPaths: [], taskClass: 't', date: '2026-09-15', gateSummary: 'g' })
    expect(r).not.toMatch(/reason: (not-applicable|no-predicate|human-waived)/)
    expect((r.match(new RegExp(`reason: ${NEEDS_JUDGEMENT}`, 'g')) || []).length).toBe(AGENTS.length)
  })
})
