// @vitest-environment jsdom
// The memory strip, the Suggested state and the "Not an event" control on the review cards
// (docs/work/specs/2026-10-11-what-shoresh-has-learned-view.md section 4).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'

afterEach(cleanup)

const fixed = (recalled, over = {}) => ({
  id: 'fe:Specialty 4', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Specialty 4', confidence: 'low',
  evidence: { basis: 'daily' }, timeBlock: '12:00-12:40', days: ['Monday'], recalled, ...over,
})
const exact = {
  source: 'instance', match: 'exact', autoApply: true, answer: { action: 'looks_right' }, memoryId: 'm1',
  answeredByName: 'Dana Cohen', answeredByYou: false, answeredAt: '2026-10-12T10:00:00Z', asRecorded: false,
}
const patternSuggest = {
  source: 'pattern', match: 'pattern', band: 'suggest', autoApply: false, answer: { action: 'looks_right' }, memoryId: 'm2',
  why: 'You answered Fixed event for Specialty 1 and Specialty 2. Specialty 4 is the same kind of thing. Suggested: 2 agree.',
}
const near = {
  source: 'instance', match: 'near', nearKind: null, autoApply: false, answer: { action: 'edited' }, memoryId: 'm3',
  answeredByYou: true, answeredAt: '2026-10-12T10:00:00Z',
}

function card(props) {
  return render(<DecisionCard rank="standard" onToggleEvidence={() => {}} expanded={false} onAnswer={vi.fn()} {...props} />)
}

describe('a card with no recall', () => {
  it('shows no strip, no Suggested flag, and never reports a recall as shown', () => {
    const onRecallShown = vi.fn()
    card({ decision: fixed(undefined), answer: undefined, onRecallShown })
    expect(screen.queryByText(/Remembered from/)).toBeNull()
    expect(screen.queryByText('Suggested')).toBeNull()
    expect(onRecallShown).not.toHaveBeenCalled()
  })
})

describe('the remembered strip (exact recall, applied)', () => {
  it('names who and when, offers Change and Forget, and reports the recall as shown', () => {
    const onRecallShown = vi.fn()
    card({ decision: fixed(exact), answer: { action: 'looks_right' }, onRecallShown, onForgetRecall: vi.fn() })
    expect(screen.getByText("Remembered from Dana's answer on 12 Oct")).toBeTruthy()
    expect(screen.getByText('Change')).toBeTruthy()
    expect(screen.getByText('Forget')).toBeTruthy()
    expect(onRecallShown).toHaveBeenCalled()
  })

  it('says "your" for the viewer and "a former user\'s" when the author is gone', () => {
    card({ decision: fixed({ ...exact, answeredByYou: true }), answer: { action: 'looks_right' } })
    expect(screen.getByText('Remembered from your answer on 12 Oct')).toBeTruthy()
    cleanup()
    card({ decision: fixed({ ...exact, answeredByName: null }), answer: { action: 'looks_right' } })
    expect(screen.getByText("Remembered from a former user's answer on 12 Oct")).toBeTruthy()
  })

  it('Change returns the card to unanswered and says so', () => {
    const onAnswer = vi.fn()
    const { rerender } = card({ decision: fixed(exact), answer: { action: 'looks_right' }, onAnswer })
    fireEvent.click(screen.getByText('Change'))
    expect(onAnswer).toHaveBeenCalledWith(null)
    rerender(<DecisionCard decision={fixed(exact)} rank="standard" answer={undefined} onAnswer={onAnswer} onToggleEvidence={() => {}} expanded={false} />)
    expect(screen.getByText("You're changing a remembered answer")).toBeTruthy()
  })

  it('Forget writes through the forget handler, then unanswers the card and says it will ask every time', async () => {
    const onAnswer = vi.fn()
    const onForgetRecall = vi.fn().mockResolvedValue({ ok: true })
    const { rerender } = card({ decision: fixed(exact), answer: { action: 'looks_right' }, onAnswer, onForgetRecall })
    fireEvent.click(screen.getByText('Forget'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null))
    expect(onForgetRecall).toHaveBeenCalledWith(expect.objectContaining({ id: 'fe:Specialty 4' }))
    rerender(<DecisionCard decision={fixed(exact)} rank="standard" answer={undefined} onAnswer={onAnswer} onToggleEvidence={() => {}} expanded={false} />)
    expect(screen.getByText('Forgotten. Shoresh will ask this every time from now on.')).toBeTruthy()
  })

  it('a failed Forget stays on the card with Try again and leaves the answer', async () => {
    const onAnswer = vi.fn()
    const onForgetRecall = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true })
    card({ decision: fixed(exact), answer: { action: 'looks_right' }, onAnswer, onForgetRecall })
    fireEvent.click(screen.getByText('Forget'))
    await screen.findByText('Something went wrong saving that. Nothing was changed.')
    expect(onAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null))
  })

  it('marks a former importer\'s answer "as recorded" and flags a changed camp', () => {
    card({ decision: fixed({ ...near, answeredByYou: false, answeredByName: 'Dana Cohen', asRecorded: true }), answer: undefined, campChangedFlag: true })
    expect(screen.getByText("Remembered from Dana's answer on 12 Oct (as recorded)")).toBeTruthy()
    expect(screen.getByText('Your camp changed since you answered')).toBeTruthy()
  })
})

describe('an auto-applied pattern card', () => {
  const applied = { ...patternSuggest, band: 'established', autoApply: true, why: 'You answered Fixed event for Specialty 1, Specialty 2 and Specialty 3. Specialty 4 is the same kind of thing. Established: 3 agree.' }
  it('says it was applied automatically and why, with Change', () => {
    card({ decision: fixed(applied), answer: { action: 'looks_right' } })
    expect(screen.getByText(/Applied automatically/)).toBeTruthy()
    expect(screen.getByText(/You answered Fixed event for Specialty 1, Specialty 2 and Specialty 3/)).toBeTruthy()
    expect(screen.getByText('Change')).toBeTruthy()
  })
  it('after Undo for this import it reads "Back to unanswered for this import."', () => {
    card({ decision: fixed(applied), answer: undefined, returned: true })
    expect(screen.getByText('Back to unanswered for this import.')).toBeTruthy()
    expect(screen.queryByText('Suggested')).toBeNull()
  })
})

describe('the Suggested state', () => {
  it('pre-selects with a dashed outline, a Suggested flag and the reason, and is not answered', () => {
    const onRecallShown = vi.fn()
    card({ decision: fixed(patternSuggest), answer: undefined, onRecallShown })
    expect(screen.getByText('Suggested')).toBeTruthy()
    expect(screen.getByText('You answered Fixed event for Specialty 1 and Specialty 2. Specialty 4 is the same kind of thing.')).toBeTruthy()
    expect(screen.getByText('Add it').style.outlineStyle).toBe('dashed')
    expect(screen.getByText('Don’t add').style.outlineStyle).toBe('')
    expect(screen.queryByText(/Remembered from/)).toBeNull()
    expect(onRecallShown).toHaveBeenCalled()
  })

  it('"Remember as a pattern" stages the confirm with the explicit tap and then reads Pattern remembered', () => {
    const onAnswer = vi.fn()
    const { rerender } = card({ decision: fixed(patternSuggest), answer: undefined, onAnswer })
    expect(screen.getByText('Next time, similar questions will be pre-selected for you.')).toBeTruthy()
    fireEvent.click(screen.getByText('Remember as a pattern'))
    fireEvent.click(screen.getByText('Add it'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'looks_right', tap: true })
    rerender(<DecisionCard decision={fixed(patternSuggest)} rank="standard" answer={{ action: 'looks_right', tap: true }} onAnswer={onAnswer} onToggleEvidence={() => {}} expanded={false} />)
    expect(screen.getByText('Pattern remembered')).toBeTruthy()
  })

  it('tapping Remember as a pattern after answering re-stages the same answer with the tap', () => {
    const onAnswer = vi.fn()
    card({ decision: fixed(patternSuggest), answer: { action: 'looks_right' }, onAnswer })
    fireEvent.click(screen.getByText('Remember as a pattern'))
    expect(onAnswer).toHaveBeenCalledWith({ action: 'looks_right', tap: true })
  })

  it('a near recall reads "Similar to...", offers "Also remember this", and writes rememberNear only when ticked', () => {
    const onAnswer = vi.fn()
    card({ decision: fixed(near), answer: undefined, onAnswer })
    expect(screen.getByText('Similar to your answer on 12 Oct, but something is different. Check it still applies.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Also remember this for next time'))
    fireEvent.click(screen.getByText('Don’t add'))
    expect(onAnswer).toHaveBeenLastCalledWith({ action: 'edited', rememberNear: true })
  })

  it('a near answer given WITHOUT "Also remember this" is labelled as noted only', () => {
    card({ decision: fixed(near), answer: { action: 'edited' } })
    expect(screen.getByText('Your newer answer is noted; tap Remember this to make it the remembered one')).toBeTruthy()
  })

  it('once "Also remember this" is on, the noted-only label is gone', () => {
    card({ decision: fixed(near), answer: { action: 'edited', rememberNear: true } })
    expect(screen.queryByText(/is noted; tap Remember this/)).toBeNull()
  })

  it('a near recall that is a name-key match offers "Also remember this" but not "Remember as a pattern"', () => {
    card({ decision: fixed({ ...near, nearKind: 'name_key' }), answer: undefined })
    expect(screen.getByLabelText('Also remember this for next time')).toBeTruthy()
    expect(screen.queryByText('Remember as a pattern')).toBeNull()
  })
})

describe('"Not an event, treat as an activity"', () => {
  it('is on a fixed-event confirm card, secondary, with its helper, and stages the rejecting answer', () => {
    const onAnswer = vi.fn()
    card({ decision: fixed(undefined), answer: undefined, onAnswer })
    expect(screen.getByText("Choose this if it's a regular activity, not something that blocks the schedule.")).toBeTruthy()
    fireEvent.click(screen.getByText('Not an event, treat as an activity'))
    expect(onAnswer).toHaveBeenCalledWith({ action: 'edited', notAnEvent: true })
  })

  it('resolves as "Treated as an activity"', () => {
    card({ decision: fixed(undefined), answer: { action: 'edited', notAnEvent: true } })
    expect(screen.getByText(/Treated as an activity/)).toBeTruthy()
  })

  it('is not on other cards', () => {
    card({ decision: { id: 'a', kind: 'confirm_value', entity: 'activities', entityName: 'Swim', field: ['min_per_week'], proposedValue: 2 }, answer: undefined })
    expect(screen.queryByText('Not an event, treat as an activity')).toBeNull()
  })
})
