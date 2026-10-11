// The pure formatting behind "What Shoresh has learned" and the review-card labels
// (docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md). The view and the cards only render
// what these return; nothing here recounts anything the store already counted.
import { describe, it, expect } from 'vitest'
import {
  buildLearnedGroups, progressLine, patternFlag, formerAnswersSentence, matchesQuery, seedFromRecall,
  memoryStripText, suggestedReason, shortDate, NEVER_APPLY_LINE,
} from './learnedView.js'

const ans = (over = {}) => ({
  id: 'a1', qkind: 'classify', role: 'instance', name: 'Lunch 1', verdict: 'accept', label: 'Fixed event', features: {},
  explicit: false, bulk: false, confirmed_at: '2026-07-03T10:00:00Z', confirmed_by: 'u-dana', confirmedByName: 'Dana',
  asRecorded: false, former: false, ...over,
})
const progress = (over = {}) => ({
  agreeing: 3, needed: 3, imports: 2, importsNeeded: 2, explicit: 1, explicitNeeded: 1, missing: [],
  neverAutoApply: false, neverReason: null, band: 'established', ...over,
})
const pattern = (over = {}) => ({
  template: 'T1', key: 'fixed_event|lunch', qkind: 'classify', band: 'established', verdict: 'accept', label: 'Fixed event',
  agree: 3, disagree: 5, names: ['Lunch 1', 'Lunch 2', 'Lunch 3'], progress: progress(), answerIds: ['a1', 'a2', 'a3'], ...over,
})
const data = (over = {}) => ({
  answers: [], patterns: [], vetoes: 0, formerUserAnswers: 0, canWrite: true, viewerUserId: 'u-me',
  diagnostics: { discarded: 0, tombstoned: 0 }, ...over,
})

describe('progressLine: the spec table, verbatim', () => {
  it.each([
    [progress({ agreeing: 1, imports: 1, explicit: 0, band: 'ask', missing: ['more_answers', 'another_import', 'explicit'] }), '1 of 3 answers - needs one more import, needs one answer you edited or declined'],
    [progress({ agreeing: 2, imports: 1, explicit: 1, band: 'suggest', missing: ['more_answers', 'another_import'] }), '2 of 3 answers - needs one more import'],
    [progress({ agreeing: 3, imports: 2, explicit: 0, band: 'suggest', missing: ['explicit'] }), '3 of 3 answers - needs one answer you edited or declined'],
    [progress({ agreeing: 2, imports: 1, explicit: 0, band: 'suggest', missing: ['more_answers', 'another_import', 'explicit'] }), '2 of 3 answers - needs one more import, needs one answer you edited or declined'],
    [progress(), '3 of 3 answers - Shoresh applies this on its own, and tells you each time'],
  ])('%#', (p, line) => expect(progressLine(p, { disagree: 0 })).toBe(line))

  it('a demoted pattern says the latest answer disagrees', () => {
    expect(progressLine(progress({ agreeing: 1, band: 'ask', missing: ['more_answers'] }), { disagree: 2 }))
      .toBe('Your latest answer disagrees - 2 more agreeing answers to suggest again')
  })

  it('a kind that never auto-applies counts agreement but says it still asks', () => {
    const p = progress({ agreeing: 2, neverAutoApply: true, neverReason: 'kind', band: 'suggest' })
    expect(progressLine(p, { disagree: 0 })).toBe('2 of 3 answers agree - once established it pre-selects the answer, and you still confirm.')
    expect(NEVER_APPLY_LINE).toBe('Always asks you: this kind only pre-selects.')
  })
})

describe('patternFlag: words, never a percentage', () => {
  it('maps band and eligibility to the director vocabulary', () => {
    expect(patternFlag(pattern())).toMatchObject({ text: 'Applies automatically', tone: 'success' })
    expect(patternFlag(pattern({ progress: progress({ neverAutoApply: true, neverReason: 'kind' }) }))).toMatchObject({ text: 'Pre-selects for you', tone: 'primary' })
    expect(patternFlag(pattern({ band: 'suggest', progress: progress({ band: 'suggest' }) }))).toMatchObject({ text: 'Suggested', tone: 'primary' })
    expect(patternFlag(pattern({ band: 'ask', progress: progress({ band: 'ask' }) }))).toMatchObject({ text: 'Still asks', tone: 'neutral' })
  })
})

describe('buildLearnedGroups', () => {
  it('orders the five groups, drops empty ones, and puts patterns before answers', () => {
    const groups = buildLearnedGroups(data({
      answers: [
        ans({ id: 'a1' }), ans({ id: 'v1', qkind: 'value', verdict: 'edited', name: 'Swim', label: 'edited' }),
        ans({ id: 'x1', qkind: 'exclusion', verdict: 'all_camp', name: 'Boys Cabin Day', label: 'All camp' }),
        ans({ id: 'r1', qkind: 'residue', verdict: 'added', name: 'Mystery' }),
      ],
      patterns: [pattern()],
    }))
    expect(groups.map((g) => g.label)).toEqual(['Classification', 'All camp except...', 'Values', 'Other'])
    expect(groups[0].patterns).toHaveLength(1)
    expect(groups[0].answers).toHaveLength(1)
    expect(groups[0].count).toBe(2)
  })

  it('a pattern row explains why, who and when, and shows its meter and confidence in words', () => {
    const [g] = buildLearnedGroups(data({
      answers: [
        ans({ id: 'a1', name: 'Lunch 1' }),
        ans({ id: 'a2', name: 'Lunch 2' }),
        ans({ id: 'a3', name: 'Lunch 3', confirmed_by: 'u-me', confirmed_at: '2026-10-12T10:00:00Z', confirmedByName: 'Me' }),
      ],
      patterns: [pattern()],
    }))
    const row = g.patterns[0]
    expect(row.why).toBe('You answered Fixed event for Lunch 1, Lunch 2 and Lunch 3 (Dana 3 Jul, you 12 Oct).')
    expect(row.who).toBe('Answered by Dana and you, latest 12 Oct')
    expect(row.meter).toBe(3)
    expect(row.confidence).toBe('3 agree, 5 earlier disagreed.')
    expect(row.flag.text).toBe('Applies automatically')
    expect(row.neverApply).toBeNull()
    expect(row.supporters.map((s) => s.id)).toEqual(['a1', 'a2', 'a3'])
    expect(JSON.stringify(row)).not.toMatch(/%/)
  })

  it('a never-auto-apply pattern carries the fixed line and the plain reason', () => {
    const [g] = buildLearnedGroups(data({
      answers: [ans({ id: 'a1', qkind: 'exclusion', verdict: 'all_camp', name: 'Boys Cabin Day', label: 'All camp' })],
      patterns: [pattern({ qkind: 'exclusion', answerIds: ['a1'], label: 'All camp', names: ['Boys Cabin Day'], progress: progress({ agreeing: 2, neverAutoApply: true, neverReason: 'kind', band: 'suggest' }) })],
    }))
    expect(g.patterns[0].neverApply).toEqual({
      flag: 'Always asks you', line: 'Always asks you: this kind only pre-selects.',
      reason: 'Only you know whether this group had a trip, so Shoresh never decides it for you.',
    })
    expect(g.patterns[0].flag.text).toBe('Suggested')
  })

  it('a rejection pattern gives the rejection reason', () => {
    const [g] = buildLearnedGroups(data({
      answers: [ans({ id: 'a1', verdict: 'reject', label: 'Not a fixed event' })],
      patterns: [pattern({ verdict: 'reject', answerIds: ['a1'], progress: progress({ neverAutoApply: true, neverReason: 'rejection' }) })],
    }))
    expect(g.patterns[0].neverApply.reason).toBe('Shoresh only ever applies answers that say yes. It never decides to leave something out.')
  })

  it('an answer from a former importer is labelled "as recorded", offers Keep, and a missing author is "a former user"', () => {
    const [g] = buildLearnedGroups(data({
      answers: [ans({ id: 'f1', asRecorded: true, former: true, confirmedByName: null })],
      formerUserAnswers: 1,
    }))
    const row = g.answers[0]
    expect(row.asRecorded).toBe(true)
    expect(row.canKeep).toBe(true)
    expect(row.who).toBe('Answered by a former user on 3 Jul')
    expect(row.why).toBe('A former user answered Fixed event on 3 Jul.')
  })

  it('"you" is the viewer; others by first name only', () => {
    const [g] = buildLearnedGroups(data({
      answers: [ans({ id: 'a1', confirmed_by: 'u-me', confirmedByName: 'Greg Feitel' }), ans({ id: 'a2', name: 'Lunch 2', confirmedByName: 'Dana Cohen' })],
    }))
    expect(g.answers.find((r) => r.id === 'a1').who).toBe('Answered by you on 3 Jul')
    expect(g.answers.find((r) => r.id === 'a2').who).toBe('Answered by Dana on 3 Jul')
  })
})

describe('copy helpers', () => {
  it('former importers sentence, singular and plural', () => {
    expect(formerAnswersSentence(0)).toBeNull()
    expect(formerAnswersSentence(1)).toBe('1 answer is from a person who no longer imports.')
    expect(formerAnswersSentence(3)).toBe('3 answers are from people who no longer import.')
  })
  it('search matches the title, the why text and example names', () => {
    const [g] = buildLearnedGroups(data({ answers: [ans({ id: 'a1', name: 'Lunch 1' }), ans({ id: 'a2', name: 'Swim', label: 'Fixed event' })] }))
    expect(g.answers.filter((r) => matchesQuery(r, 'lunch')).map((r) => r.id)).toEqual(['a1'])
    expect(g.answers.filter((r) => matchesQuery(r, ''))).toHaveLength(2)
  })
  it('short dates are day and month only', () => {
    expect(shortDate('2026-10-12T23:59:00Z')).toBe('12 Oct')
  })
})

const fixed = (name, recalled) => ({ id: `fe:${name}`, kind: 'confirm_value', entity: 'fixed_events', entityName: name, recalled })
const exact = { source: 'instance', match: 'exact', autoApply: true, answer: { action: 'looks_right' }, memoryId: 'm1', answeredByName: 'Dana', answeredByYou: false, answeredAt: '2026-10-12T10:00:00Z' }
const patternHit = { source: 'pattern', match: 'pattern', band: 'established', autoApply: true, answer: { action: 'looks_right' }, memoryId: 'm2', why: 'x' }

describe('seedFromRecall: only eligible, unsuppressed, unanswered decisions are applied', () => {
  it('seeds an exact recall as remembered and an eligible pattern as auto-applied', () => {
    const r = seedFromRecall([fixed('A', exact), fixed('B', patternHit)], {}, new Set())
    expect(r.seeded).toEqual({ 'fe:A': { action: 'looks_right' }, 'fe:B': { action: 'looks_right' } })
    expect(r.remembered).toEqual(['fe:A'])
    expect(r.autoApplied).toEqual(['fe:B'])
  })
  it('never seeds a suggestion, a near match, a suppressed or an already answered decision', () => {
    const suggest = { ...patternHit, band: 'suggest', autoApply: false }
    const near = { ...exact, match: 'near', autoApply: false }
    const r = seedFromRecall(
      [fixed('S', suggest), fixed('N', near), fixed('U', patternHit), fixed('Y', exact), fixed('P', { ...patternHit, autoApply: false, band: 'established' })],
      { 'fe:Y': { action: 'edited' } }, new Set(['fe:U']),
    )
    expect(r.seeded).toEqual({})
    expect(r.remembered).toEqual([])
    expect(r.autoApplied).toEqual([])
  })
})

describe('card labels', () => {
  it('provenance names who and when; "your" for the viewer; a former user; as recorded', () => {
    expect(memoryStripText({ ...exact, answeredByYou: true })).toBe('Remembered from your answer on 12 Oct')
    expect(memoryStripText(exact)).toBe("Remembered from Dana's answer on 12 Oct")
    expect(memoryStripText({ ...exact, answeredByName: null })).toBe("Remembered from a former user's answer on 12 Oct")
    expect(memoryStripText({ ...exact, asRecorded: true })).toBe("Remembered from Dana's answer on 12 Oct (as recorded)")
  })
  it('the suggested reason uses the pattern sentence, and the near sentence names what differs in plain words', () => {
    expect(suggestedReason({ source: 'pattern', band: 'suggest', why: 'You answered Fixed event for Lunch 1 and Lunch 2. Lunch 4 is the same kind of thing. Suggested: 2 agree.' }, { eligible: true }))
      .toMatch(/^You answered Fixed event for Lunch 1 and Lunch 2/)
    expect(suggestedReason({ source: 'instance', match: 'near', nearKind: null, answeredAt: '2026-10-12T10:00:00Z', answeredByYou: true }, {}))
      .toBe('Similar to your answer on 12 Oct, but something is different. Check it still applies.')
    expect(suggestedReason({ source: 'pattern', band: 'established', why: 'W' }, { eligible: false }))
      .toBe('W Pre-selected, but you always confirm this kind.')
  })
})
