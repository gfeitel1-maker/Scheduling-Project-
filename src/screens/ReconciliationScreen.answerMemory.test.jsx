// @vitest-environment jsdom
//
// The review screen's half of import answer memory (docs/adr/2026-10-11-import-answer-memory.md 3.5,
// docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md 4.3 / 4.4): what the camp remembered is
// seeded only where the store says it may be, it is counted and reviewable, auto-applied answers can be
// undone for this import, a recall counts as shown only when it was rendered, and write failures are told.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    ingestReconcile: vi.fn(),
    ingestCommit: vi.fn(),
    confirmAlias: vi.fn().mockResolvedValue({}),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1' }),
    latestOpSeq: vi.fn().mockResolvedValue(0),
    ingestUndo: vi.fn(),
    matchImportAnswers: vi.fn(),
    rememberImportAnswers: vi.fn(),
    recordImportDecisions: vi.fn(),
    forgetImportAnswer: vi.fn(),
    listLearned: vi.fn(async () => ({ canWrite: true, answers: [], patterns: [] })),
  },
}))

import ReconciliationScreen from './ReconciliationScreen.jsx'
import { importSessions } from './importSessions.js'
import { localClient } from '../localClient'

const baseInputs = { approved: {}, cohort_id: null, mode: 'add' }
const NAMES = ['Specialty 1', 'Specialty 2', 'Specialty 3', 'Specialty 4', 'Specialty 5']

function reconcileResult(names) {
  return {
    planItems: [],
    fixedEventsReport: {
      created: names.map((name) => ({ name, confidence: 'low', time_block: '12:00-12:40', days: ['Monday'], reason: 'Only some groups showed this pattern.' })),
    },
    legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {},
  }
}

const exact = { source: 'instance', match: 'exact', autoApply: true, answer: { action: 'looks_right' }, memoryId: 'm-exact', answeredByName: 'Dana Cohen', answeredByYou: false, answeredAt: '2026-10-12T10:00:00Z', asRecorded: false }
const autoPattern = { source: 'pattern', match: 'pattern', band: 'established', autoApply: true, answer: { action: 'looks_right' }, memoryId: 'm-pat', baselineOk: true, why: 'You answered Fixed event for Specialty 1, Specialty 2 and Specialty 3. Specialty 5 is the same kind of thing. Established: 3 agree.' }
const suggest = { source: 'pattern', match: 'pattern', band: 'suggest', autoApply: false, answer: { action: 'looks_right' }, memoryId: 'm-sug', why: 'You answered Fixed event for Specialty 1 and Specialty 2. Specialty 3 is the same kind of thing. Suggested: 2 agree.' }
const near = { source: 'instance', match: 'near', nearKind: null, autoApply: false, answer: { action: 'edited' }, memoryId: 'm-near', answeredByYou: true, answeredAt: '2026-10-12T10:00:00Z' }

function recallByName(map) {
  localClient.matchImportAnswers.mockImplementation(async ({ decisions, suppressed = [] }) => Object.fromEntries(
    decisions.map((d) => {
      const r = map[d.entityName] ? { ...map[d.entityName] } : null
      if (r && suppressed.includes(d.id)) { r.autoApply = false; r.suppressed = true }
      return [d.id, r]
    }),
  ))
}

function mount(props = {}) {
  return render(<ReconciliationScreen baseInputs={baseInputs} sourceLabel="camp.xlsx" onCommitted={vi.fn()} onDiscard={vi.fn()} onNavigate={vi.fn()} {...props} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  importSessions.clear()
  const mem = {}
  vi.stubGlobal('localStorage', { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v }, removeItem: (k) => { delete mem[k] } })
  localClient.list.mockResolvedValue([{ id: 'x' }])
  localClient.rememberImportAnswers.mockResolvedValue({ written: [], skipped: [] })
  localClient.recordImportDecisions.mockResolvedValue({})
  localClient.ingestCommit.mockResolvedValue({ held: false, total: 1 })
  localClient.matchImportAnswers.mockResolvedValue({})
})

describe('campB re-import at the screen level: nothing the camp already answered is asked again', () => {
  it('seeds every exact memory, counts it, and leaves no open question', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(NAMES))
    recallByName(Object.fromEntries(NAMES.map((n) => [n, exact])))
    mount()
    await screen.findByText(/5 of 5 questions answered/)
    expect(screen.getByText('5 answers remembered - review')).toBeTruthy()
    expect(screen.queryByText('Add it')).toBeNull()
    expect(screen.getByText(/All 5 decided/)).toBeTruthy()
  })

  it('"review" opens the Remembered group, whose cards say who remembered them', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(NAMES.slice(0, 2)))
    recallByName({ 'Specialty 1': exact, 'Specialty 2': exact })
    mount()
    await userEvent.click(await screen.findByText('2 answers remembered - review'))
    expect((await screen.findAllByText("Remembered from Dana's answer on 12 Oct"))).toHaveLength(2)
    expect(screen.getByText('Remembered answers (2)')).toBeTruthy()
  })

  it('says "1 answer remembered - review" in the singular and shows nothing at zero', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    recallByName({ 'Specialty 1': exact })
    const { unmount } = mount()
    await screen.findByText('1 answer remembered - review')
    unmount()
    localClient.matchImportAnswers.mockResolvedValue({})
    mount()
    await screen.findByText(/0 of 1 question/)
    expect(screen.queryByText(/answers? remembered/)).toBeNull()
  })
})

describe('only what the store marks autoApply is applied', () => {
  beforeEach(() => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(NAMES.slice(0, 4)))
    recallByName({ 'Specialty 1': autoPattern, 'Specialty 2': suggest, 'Specialty 3': near, 'Specialty 4': { ...autoPattern, autoApply: false } })
  })

  it('applies the eligible pattern, leaves the suggestion, the near and the non-eligible established ones open', async () => {
    mount()
    await screen.findByText(/1 of 4 questions answered/)
    expect(screen.getByText('Auto-applied:')).toBeTruthy()
    expect(within(screen.getByTestId('auto-applied-line')).getByText('1')).toBeTruthy()
    expect(screen.getAllByText('Suggested')).toHaveLength(3)
    expect(screen.queryByText(/answers? remembered/)).toBeNull()
  })

  it('Undo for this import returns exactly those cards to unanswered and suppresses them in the next recall', async () => {
    mount()
    await userEvent.click(await screen.findByText('Undo for this import'))
    await screen.findByText(/Auto-applied: 0 - these questions are back for you to answer/)
    await screen.findByText(/0 of 4 questions answered/)
    const last = localClient.matchImportAnswers.mock.calls.at(-1)[0]
    expect(last.suppressed).toHaveLength(1)
    expect(last.suppressed[0]).toMatch(/Specialty 1/)
    expect(localClient.rememberImportAnswers).not.toHaveBeenCalled()
  })

  it('applying nothing while a pattern merely suggests: a suggestion is never auto-answered', async () => {
    recallByName({ 'Specialty 2': suggest })
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 2']))
    mount()
    await screen.findByText(/0 of 1 question/)
    expect(screen.queryByTestId('auto-applied-line')).toBeNull()
    expect(screen.getByText('Suggested')).toBeTruthy()
  })
})

describe('a recall is "shown" only when it was rendered', () => {
  async function commit() {
    await userEvent.click(screen.getByRole('button', { name: /Use this setup|Apply \d+ decision/ }))
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalledTimes(1))
    return localClient.rememberImportAnswers.mock.calls[0][0].entries
  }
  const entryFor = (entries, name) => entries.find((e) => e.decision.entityName === name)

  it('a remembered answer nobody opened is not recalled; the near card the director saw is', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1', 'Specialty 3']))
    recallByName({ 'Specialty 1': exact, 'Specialty 3': near })
    mount()
    await screen.findByText(/1 of 2 questions answered/)
    await userEvent.click(screen.getByText('Don’t add'))
    await screen.findByText(/All 2 decided/)
    const entries = await commit()
    expect(entryFor(entries, 'Specialty 3').recalled).toEqual({ match: 'near', memoryId: 'm-near' })
    expect(entryFor(entries, 'Specialty 1').recalled).toBeUndefined()
    const journal = localClient.recordImportDecisions.mock.calls[0][0].entries
    expect(journal.map((j) => j.learned_from_id).filter(Boolean)).toEqual(['m-near'])
  })

  it('once the Remembered group has been opened its recalls count', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    recallByName({ 'Specialty 1': exact })
    mount()
    await userEvent.click(await screen.findByText('1 answer remembered - review'))
    await screen.findByText("Remembered from Dana's answer on 12 Oct")
    const entries = await commit()
    expect(entryFor(entries, 'Specialty 1').recalled).toEqual({ match: 'exact', memoryId: 'm-exact' })
    const journal = localClient.recordImportDecisions.mock.calls[0][0].entries
    expect(journal.some((j) => j.learned_from_id === 'm-exact')).toBe(true)
  })
})

describe('Change and Forget on a remembered card', () => {
  it('Change makes it a question again and it is not re-seeded by the next dry run', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    recallByName({ 'Specialty 1': exact })
    mount()
    await userEvent.click(await screen.findByText('1 answer remembered - review'))
    await userEvent.click(await screen.findByText('Change'))
    await screen.findByText(/0 of 1 question/)
    await waitFor(() => expect(localClient.ingestReconcile.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(screen.getByText(/0 of 1 question/)).toBeTruthy())
  })

  it('Forget goes through forgetImportAnswer for the remembered record', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    recallByName({ 'Specialty 1': exact })
    localClient.forgetImportAnswer.mockResolvedValue({ ok: true })
    mount()
    await userEvent.click(await screen.findByText('1 answer remembered - review'))
    await userEvent.click(await screen.findByText('Forget'))
    await waitFor(() => expect(localClient.forgetImportAnswer).toHaveBeenCalledWith({ memoryId: 'm-exact' }))
    await screen.findByText(/0 of 1 question/)
  })
})

describe('what could not be remembered is said, inline', () => {
  async function applyOne() {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    mount()
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Add it'))
    await userEvent.click(await screen.findByRole('button', { name: 'Use this setup' }))
  }

  it('names the skipped answers and the reason in plain words, and stays silent about unchanged ones', async () => {
    localClient.rememberImportAnswers.mockResolvedValue({ written: [], skipped: [{ reason: 'too_large' }, { reason: 'unchanged' }, { reason: 'malformed' }] })
    await applyOne()
    await screen.findByText('2 answers couldn’t be remembered: they were too large to store; they couldn’t be read.')
  })

  it('says nothing when everything was written or unchanged', async () => {
    localClient.rememberImportAnswers.mockResolvedValue({ written: ['a'], skipped: [{ reason: 'unchanged' }] })
    await applyOne()
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalled())
    expect(screen.queryByText(/couldn’t be remembered/)).toBeNull()
  })

  it('a failed write is told with Try again, and retrying sends the same answers', async () => {
    localClient.rememberImportAnswers.mockRejectedValueOnce(new Error('forbidden')).mockResolvedValueOnce({ written: ['a'], skipped: [] })
    await applyOne()
    await screen.findByText(/Couldn’t remember your answers for next time/)
    await userEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalledTimes(2))
    expect(localClient.rememberImportAnswers.mock.calls[1][0].entries).toEqual(localClient.rememberImportAnswers.mock.calls[0][0].entries)
    await waitFor(() => expect(screen.queryByText(/Couldn’t remember your answers for next time/)).toBeNull())
  })
})

describe('"Not an event, treat as an activity" through the screen', () => {
  const NAME = 'Specialty 1'
  const event = { name: NAME, time_block: '12:00-12:40', days: ['Monday'] }
  const inputs = { approved: { activities: [NAME] }, cohort_id: null, mode: 'add', fixedEvents: [event], pinOnlyActivityNames: [NAME] }

  it('imports the item as a catalogue activity and NOT as a fixed event, and remembers the answer', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult([NAME]))
    mount({ baseInputs: inputs })
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Not an event, treat as an activity'))
    await screen.findByText(/1 of 1 question/)
    await userEvent.click(screen.getByRole('button', { name: 'Use this setup' }))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const sent = localClient.ingestCommit.mock.calls.at(-1)[0]
    expect(sent.approved.activities).toContain(NAME)
    expect(sent.fixedEvents).toEqual([])
    expect(sent.pinOnlyActivityNames).not.toContain(NAME)
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalled())
    const entry = localClient.rememberImportAnswers.mock.calls[0][0].entries[0]
    expect(entry.answer).toMatchObject({ action: 'edited', notAnEvent: true })
  })

  it('"Don\u2019t add" still imports no activity-claim change: the event stays claimed', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult([NAME]))
    mount({ baseInputs: inputs })
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Don’t add'))
    await userEvent.click(await screen.findByRole('button', { name: 'Use this setup' }))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls.at(-1)[0].pinOnlyActivityNames).toContain(NAME)
  })
})

describe('a recall counts as recalled only by what the director could see', () => {
  const suggestMon = { ...suggest }
  async function commitEntries() {
    await userEvent.click(screen.getByRole('button', { name: /Use this setup|Apply \d+ decision/ }))
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalledTimes(1))
    return localClient.rememberImportAnswers.mock.calls[0][0].entries
  }
  const twoDays = () => ({
    planItems: [],
    fixedEventsReport: {
      created: [
        { name: 'Specialty 1', confidence: 'low', time_block: '12:00-12:40', days: ['Monday'], reason: 'r' },
        { name: 'Specialty 1', confidence: 'low', time_block: '12:00-12:40', days: ['Tuesday'], reason: 'r' },
      ],
    },
    legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {},
  })
  const byDay = (map) => localClient.matchImportAnswers.mockImplementation(async ({ decisions }) => Object.fromEntries(
    decisions.map((d) => [d.id, map[d.days?.[0]] ? { ...map[d.days[0]] } : null]),
  ))

  it('a grouped card marks shown only the ids whose recall the representative displays', async () => {
    localClient.ingestReconcile.mockResolvedValue(twoDays())
    byDay({ Monday: suggestMon, Tuesday: { ...near, memoryId: 'm-hidden' } })
    mount()
    await screen.findByText(/0 of 2 questions/)
    await userEvent.click(screen.getByText('Add it'))
    const entries = await commitEntries()
    const mon = entries.find((e) => e.decision.days[0] === 'Monday')
    const tue = entries.find((e) => e.decision.days[0] === 'Tuesday')
    expect(mon.recalled).toEqual({ match: 'pattern', memoryId: 'm-sug' })
    expect(tue.recalled).toBeUndefined()
  })

  it('a card that mounts already answered with its recall invisible is not marked shown', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    localClient.matchImportAnswers.mockResolvedValueOnce({})
    recallByName({ 'Specialty 1': suggestMon })
    mount()
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Add it'))
    await waitFor(() => expect(localClient.matchImportAnswers.mock.calls.length).toBeGreaterThan(1))
    await screen.findByText(/1 of 1 question/)
    await userEvent.click(await screen.findByText('1 resolved · Show all'))
    const entries = await commitEntries()
    expect(entries[0].recalled).toBeUndefined()
  })
})

describe('"Remember as a pattern" on a shown suggestion', () => {
  async function commitEntries() {
    await userEvent.click(screen.getByRole('button', { name: /Use this setup|Apply \d+ decision/ }))
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalledTimes(1))
    return localClient.rememberImportAnswers.mock.calls[0][0].entries
  }

  it('is written as an explicit answer, not as a tap-through of the recall', async () => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 3']))
    recallByName({ 'Specialty 3': suggest })
    mount()
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Remember as a pattern'))
    await userEvent.click(screen.getByText('Add it'))
    const [entry] = await commitEntries()
    expect(entry.tap).toBe(true)
    expect(entry.recalled).toBeUndefined()
    expect(entry.bulk).toBe(false)
  })

  it('a grouped card does not offer the pattern tap, since a grouped answer counts toward nothing', async () => {
    localClient.ingestReconcile.mockResolvedValue({
      planItems: [],
      fixedEventsReport: { created: ['Monday', 'Tuesday'].map((d) => ({ name: 'Specialty 3', confidence: 'low', time_block: '12:00-12:40', days: [d], reason: 'r' })) },
      legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {},
    })
    recallByName({ 'Specialty 3': suggest })
    mount()
    await screen.findByText(/0 of 2 questions/)
    expect(screen.queryByText('Remember as a pattern')).toBeNull()
    await userEvent.click(screen.getByText('Add it'))
    const entries = await commitEntries()
    expect(entries).toHaveLength(2)
    for (const e of entries) {
      expect(e.bulk).toBe(true)
      expect(e.tap).toBeUndefined()
    }
  })
})

describe('auto-applied answers: visible, undoable, remount-proof, and not their own votes', () => {
  beforeEach(() => {
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1', 'Specialty 2']))
    recallByName({ 'Specialty 1': autoPattern })
  })

  it('lists which answers were auto-applied even when it is not the first time', async () => {
    window.localStorage.setItem('learned.autoApplySeen', '1')
    mount()
    await screen.findByText('Auto-applied answers (1)')
  })

  it('after Undo the card itself says it is back to unanswered', async () => {
    mount()
    await userEvent.click(await screen.findByText('Undo for this import'))
    await screen.findByText(/Back to unanswered/)
  })

  it('an Undo survives the screen remounting for the same import', async () => {
    const first = mount()
    await userEvent.click(await screen.findByText('Undo for this import'))
    await screen.findByText(/Auto-applied: 0/)
    first.unmount()
    mount()
    await screen.findByText(/0 of 2 questions/)
    expect(localClient.matchImportAnswers.mock.calls.at(-1)[0].suppressed).toHaveLength(1)
    expect(screen.queryByTestId('auto-applied-line')).toBeNull()
  })

  it('an auto-applied seed is written marked, so it is not a fresh vote for its own pattern', async () => {
    mount()
    await screen.findByTestId('auto-applied-line')
    await userEvent.click(screen.getByText('Add it'))
    await userEvent.click(await screen.findByRole('button', { name: /Use this setup|Apply \d+ decision/ }))
    await waitFor(() => expect(localClient.rememberImportAnswers).toHaveBeenCalledTimes(1))
    const entries = localClient.rememberImportAnswers.mock.calls[0][0].entries
    expect(entries.find((e) => e.decision.entityName === 'Specialty 1').autoApplied).toBe(true)
    expect(entries.find((e) => e.decision.entityName === 'Specialty 2').autoApplied).toBeUndefined()
  })
})

describe('what could not be remembered, for a viewer who cannot write', () => {
  it('does not offer Try again when the viewer cannot write import answers', async () => {
    localClient.listLearned.mockResolvedValue({ canWrite: false, answers: [], patterns: [] })
    localClient.rememberImportAnswers.mockRejectedValue(new Error('forbidden'))
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    mount()
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Add it'))
    await userEvent.click(await screen.findByRole('button', { name: 'Use this setup' }))
    await screen.findByText(/Couldn’t remember your answers for next time/)
    expect(screen.queryByText('Try again')).toBeNull()
  })
  it('tells the director when a name was left out because it looks like a camper', async () => {
    localClient.rememberImportAnswers.mockResolvedValue({ written: [], skipped: [{ reason: 'camper_name' }] })
    localClient.ingestReconcile.mockResolvedValue(reconcileResult(['Specialty 1']))
    mount()
    await screen.findByText(/0 of 1 question/)
    await userEvent.click(screen.getByText('Add it'))
    await userEvent.click(await screen.findByRole('button', { name: 'Use this setup' }))
    await screen.findByText(/1 answer couldn’t be remembered: .*camper/)
  })
})
