// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'

const client = vi.hoisted(() => ({
  listLearned: vi.fn(), changeImportAnswer: vi.fn(), forgetImportAnswer: vi.fn(), forgetImportPattern: vi.fn(), keepImportAnswer: vi.fn(),
  list: vi.fn(), listDeclinedSplitNames: vi.fn(), listCompoundCellDecisions: vi.fn(),
}))
vi.mock('../localClient', () => ({ localClient: client }))

import LearnedScreen from './LearnedScreen.jsx'

const ans = (over = {}) => ({
  id: 'a1', qkind: 'classify', role: 'instance', name: 'Lunch 1', verdict: 'accept', label: 'Fixed event', features: {},
  explicit: true, bulk: false, confirmed_at: '2026-07-03T10:00:00Z', confirmed_by: 'u-dana', confirmedByName: 'Dana Cohen',
  asRecorded: false, former: false, camp_shape: { groups: 4, days: 5 }, ...over,
})
const progress = (over = {}) => ({
  agreeing: 3, needed: 3, imports: 2, importsNeeded: 2, explicit: 1, explicitNeeded: 1, missing: [],
  neverAutoApply: false, neverReason: null, band: 'established', ...over,
})
const pattern = (over = {}) => ({
  template: 'T1', key: 'fixed_event|lunch', qkind: 'classify', band: 'established', verdict: 'accept', label: 'Fixed event',
  agree: 3, disagree: 0, names: ['Lunch 1', 'Lunch 2', 'Lunch 3'], progress: progress(), answerIds: ['a1', 'a2', 'a3'], ...over,
})
const threeAnswers = [ans({ id: 'a1' }), ans({ id: 'a2', name: 'Lunch 2' }), ans({ id: 'a3', name: 'Lunch 3' })]
const learned = (over = {}) => ({
  answers: threeAnswers, patterns: [pattern()], vetoes: 0, formerUserAnswers: 0, canWrite: true, viewerUserId: 'u-me',
  diagnostics: { discarded: 0, tombstoned: 0 }, ...over,
})

beforeEach(() => {
  Object.values(client).forEach((f) => f.mockReset())
  client.list.mockResolvedValue([{}, {}, {}, {}])
  client.listDeclinedSplitNames.mockResolvedValue([])
  client.listCompoundCellDecisions.mockResolvedValue(new Map())
  client.listLearned.mockResolvedValue(learned())
  const mem = {}
  vi.stubGlobal('localStorage', { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v }, removeItem: (k) => { delete mem[k] } })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function open() {
  render(<LearnedScreen campId="camp-1" />)
  await screen.findByText(/Progress:/)
}

describe('LearnedScreen: rows', () => {
  it('shows a pattern first with why, who, progress meter, confidence and its flag', async () => {
    await open()
    expect(screen.getByText('Classification')).toBeTruthy()
    expect(screen.getByText('Applies automatically')).toBeTruthy()
    expect(screen.getByText(/You answered Fixed event for Lunch 1, Lunch 2 and Lunch 3/)).toBeTruthy()
    expect(screen.getByText(/Answered by Dana, latest 3 Jul/)).toBeTruthy()
    expect(screen.getByText(/3 of 3 answers - Shoresh applies this on its own, and tells you each time/)).toBeTruthy()
    expect(screen.getByText(/Confidence: 3 agree\./)).toBeTruthy()
    const text = document.body.textContent
    expect(text.indexOf('Patterns')).toBeLessThan(text.indexOf('Answers'))
    expect(text).not.toMatch(/\d%/)
  })

  it('a kind that never auto-applies says "Always asks you" with its plain reason', async () => {
    client.listLearned.mockResolvedValue(learned({
      answers: [ans({ id: 'x1', qkind: 'exclusion', verdict: 'all_camp', label: 'All camp', name: 'Boys Cabin Day' })],
      patterns: [pattern({ template: 'T3', key: 'cit', qkind: 'exclusion', label: 'All camp', names: ['Boys Cabin Day'], answerIds: ['x1'], progress: progress({ agreeing: 2, neverAutoApply: true, neverReason: 'kind', band: 'suggest' }) })],
    }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('Always asks you: this kind only pre-selects.')
    expect(screen.getByText('Suggested')).toBeTruthy()
    expect(screen.getByText(/2 of 3 answers agree - once established it pre-selects the answer, and you still confirm\./)).toBeTruthy()
    expect(screen.getByText('Always asks you').getAttribute('title')).toMatch(/Only you know whether this group had a trip/)
  })

  it('supporting answers are behind a disclosure', async () => {
    await open()
    fireEvent.click(screen.getByText('Show the 3 answers behind this'))
    await waitFor(() => expect(screen.getByText('Hide the 3 answers')).toBeTruthy())
  })

  it('shows the empty state only when nothing is learned and nothing is device-local', async () => {
    client.listLearned.mockResolvedValue(learned({ answers: [], patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('Nothing learned yet')
    expect(screen.queryByText('Remembered on this computer only')).toBeNull()
  })
})

describe('LearnedScreen: permission', () => {
  it('a viewer without groups.import sees the rows, the quiet line, and no Change/Forget/Keep at all', async () => {
    client.listLearned.mockResolvedValue(learned({ canWrite: false, formerUserAnswers: 1, answers: [ans({ id: 'a1', asRecorded: true, former: true, confirmedByName: null })], patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('You can see what Shoresh has learned. Changing it needs import permission.')
    expect(screen.queryByText('Change')).toBeNull()
    expect(screen.queryByText('Forget answer')).toBeNull()
    expect(screen.queryByText('Forget this pattern')).toBeNull()
    expect(screen.queryByText('Keep this answer')).toBeNull()
    expect(screen.getByText('1 answer is from a person who no longer imports.')).toBeTruthy()
    expect(screen.queryAllByRole('button').filter((b) => b.disabled)).toHaveLength(0)
  })

  it('an importer sees the controls and Keep this answer on a former user\'s row', async () => {
    client.listLearned.mockResolvedValue(learned({ formerUserAnswers: 1, answers: [ans({ id: 'a1', asRecorded: true, former: true, confirmedByName: null })], patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('Keep this answer')
    expect(screen.getByText('Change')).toBeTruthy()
    expect(screen.getByText('Forget answer')).toBeTruthy()
    expect(screen.queryByText('You can see what Shoresh has learned. Changing it needs import permission.')).toBeNull()
    client.keepImportAnswer.mockResolvedValue({ ok: true, id: 'a9' })
    fireEvent.click(screen.getByText('Keep this answer'))
    await waitFor(() => expect(client.keepImportAnswer).toHaveBeenCalledWith({ memoryId: 'a1' }))
  })
})

describe('LearnedScreen: Forget and Undo', () => {
  const oneAnswer = () => client.listLearned.mockResolvedValue(learned({ answers: [ans({ id: 'a1' })], patterns: [] }))

  it('Forget answer is one click, says what happens, and Undo writes it back through Change', async () => {
    oneAnswer()
    client.forgetImportAnswer.mockResolvedValue({ ok: true, retired: ['a1'] })
    client.changeImportAnswer.mockResolvedValue({ ok: true, id: 'a2' })
    render(<LearnedScreen campId="camp-1" />)
    fireEvent.click(await screen.findByText('Forget answer'))
    await screen.findByText('Forgotten')
    expect(client.forgetImportAnswer).toHaveBeenCalledWith({ memoryId: 'a1' })
    expect(screen.getByText('Shoresh will ask this question again.')).toBeTruthy()
    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(client.changeImportAnswer).toHaveBeenCalledWith({ memoryId: 'a1', verdict: 'accept' }))
  })

  it('the Undo offer lasts 8 seconds, then the row is reloaded away', async () => {
    oneAnswer()
    client.forgetImportAnswer.mockResolvedValue({ ok: true })
    render(<LearnedScreen campId="camp-1" />)
    const forget = await screen.findByText('Forget answer')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(forget)
    await screen.findByText('Undo')
    client.listLearned.mockResolvedValue(learned({ answers: [], patterns: [] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(7900) })
    expect(screen.queryByText('Undo')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => expect(screen.queryByText('Undo')).toBeNull())
    expect(await screen.findByText('Nothing learned yet')).toBeTruthy()
  })

  it('a failed write stays on its row with Try again, and nothing is removed', async () => {
    oneAnswer()
    client.forgetImportAnswer.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true })
    render(<LearnedScreen campId="camp-1" />)
    fireEvent.click(await screen.findByText('Forget answer'))
    await screen.findByText('Something went wrong saving that. Nothing was changed.')
    expect(screen.getByText('Lunch 1: Fixed event')).toBeTruthy()
    fireEvent.click(screen.getByText('Try again'))
    await screen.findByText('Forgotten')
    expect(client.forgetImportAnswer).toHaveBeenCalledTimes(2)
  })

  it('a lost permission is said plainly', async () => {
    oneAnswer()
    client.forgetImportAnswer.mockRejectedValue(new Error('not authorized: import_answers.write'))
    render(<LearnedScreen campId="camp-1" />)
    fireEvent.click(await screen.findByText('Forget answer'))
    await screen.findByText('You no longer have permission to change imports.')
  })
})

describe('LearnedScreen: Forget this pattern is a two-step confirm', () => {
  it('asks first, "Keep pattern" cancels, "Forget pattern" writes the veto for the template and key', async () => {
    client.forgetImportPattern.mockResolvedValue({ ok: true })
    await open()
    fireEvent.click(screen.getByText('Forget this pattern'))
    expect(screen.getByText('Stop using this pattern? Your 3 answers behind it stay.')).toBeTruthy()
    expect(screen.getByText('Forgetting one answer only affects that question.')).toBeTruthy()
    expect(client.forgetImportPattern).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Keep pattern'))
    expect(screen.queryByText('Stop using this pattern? Your 3 answers behind it stay.')).toBeNull()
    fireEvent.click(screen.getByText('Forget this pattern'))
    fireEvent.click(screen.getByText('Forget pattern'))
    await screen.findByText('Pattern forgotten')
    expect(client.forgetImportPattern).toHaveBeenCalledWith({ template: 'T1', key: 'fixed_event|lunch' })
    expect(screen.getByText('Your earlier answers are kept. New similar questions will ask you again.')).toBeTruthy()
  })
})

describe('LearnedScreen: Change', () => {
  it('Save appears only once a different answer is chosen, and writes through changeImportAnswer', async () => {
    client.listLearned.mockResolvedValue(learned({ answers: [ans({ id: 'a1' })], patterns: [] }))
    client.changeImportAnswer.mockResolvedValue({ ok: true, id: 'a5' })
    render(<LearnedScreen campId="camp-1" />)
    fireEvent.click(await screen.findByText('Change'))
    expect(screen.queryByText('Save')).toBeNull()
    fireEvent.click(screen.getByText('Not a fixed event'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(client.changeImportAnswer).toHaveBeenCalledWith({ memoryId: 'a1', verdict: 'reject' }))
  })
})

describe('LearnedScreen: long lists and the device-local section', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ans({ id: `m${i}`, name: `Swim ${i}`, confirmed_at: `2026-08-${String(10 + (i % 18)).padStart(2, '0')}T10:00:00Z` }))

  it('search and the kind filter appear only past 15 rows, and search narrows the rows', async () => {
    client.listLearned.mockResolvedValue(learned({ answers: many(16), patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    const box = await screen.findByPlaceholderText('Search answers and examples')
    expect(screen.getByText('All kinds')).toBeTruthy()
    fireEvent.change(box, { target: { value: 'swim 15' } })
    await waitFor(() => expect(screen.queryByText('Swim 3: Fixed event')).toBeNull())
    expect(screen.getByText('Swim 15: Fixed event')).toBeTruthy()
    fireEvent.change(box, { target: { value: 'zzz' } })
    await screen.findByText(/Nothing matches "zzz"/)
    fireEvent.click(screen.getByText('Clear search'))
    await screen.findByText('Swim 3: Fixed event')
  })

  it('at 15 rows or fewer neither search nor filter is rendered', async () => {
    client.listLearned.mockResolvedValue(learned({ answers: many(15), patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('Swim 3: Fixed event')
    expect(screen.queryByPlaceholderText('Search answers and examples')).toBeNull()
  })

  it('shows 25 rows and "Show 25 more"', async () => {
    client.listLearned.mockResolvedValue(learned({ answers: many(30), patterns: [] }))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText('Show 25 more')
    expect(screen.getAllByRole('listitem')).toHaveLength(25)
    fireEvent.click(screen.getByText('Show 25 more'))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(30))
  })

  it('"Remembered on this computer only" is read-only and present only when something is stored', async () => {
    client.listDeclinedSplitNames.mockResolvedValue(['Swim Return'])
    await open()
    const header = screen.getByText('Remembered on this computer only').closest('button')
    fireEvent.click(header)
    const section = header.closest('section')
    await within(section).findByText('This computer only')
    expect(within(section).queryAllByRole('button')).toHaveLength(1)
    expect(within(section).getByText(/can't be changed here/)).toBeTruthy()
  })
})

describe('LearnedScreen: load failure', () => {
  it('says so inline with Try again', async () => {
    client.listLearned.mockRejectedValueOnce(new Error('x'))
    render(<LearnedScreen campId="camp-1" />)
    await screen.findByText(/Couldn.t load what Shoresh has learned/)
    client.listLearned.mockResolvedValue(learned())
    fireEvent.click(screen.getByText('Try again'))
    await screen.findByText(/Progress:/)
  })
})
