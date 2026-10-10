// @vitest-environment jsdom
//
// Audit 714 item 10 — answering an all-camp override card must count as answered.
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'
import { isDecisionResolvedFor } from '../../screens/reconciliationTriage.js'

const decision = {
  id: 'all_camp_override:Swim:Tuesday:14:25-15:15',
  kind: 'all_camp_override',
  entity: 'activities',
  entityId: null,
  entityName: 'Swim',
  field: null,
  confidence: 'inferred',
  proposedValue: null,
  unknowns: [],
  evidence: { day: 'Tuesday', block: '14:25-15:15', missingGroups: ['CIT'], insteadByGroup: {}, attendingCount: 12, totalGroups: 13, occurrences: 1 },
  reason: 'Tuesday 2:25–3:15 PM · Swim · every group except CIT. Was this an all-camp activity they were pulled out of?',
}

describe('isDecisionResolvedFor: all_camp_override', () => {
  it('either choice resolves it', () => {
    expect(isDecisionResolvedFor(decision, {})).toBe(false)
    expect(isDecisionResolvedFor(decision, { [decision.id]: { choice: 'all_camp' } })).toBe(true)
    expect(isDecisionResolvedFor(decision, { [decision.id]: { choice: 'as_written' } })).toBe(true)
  })
})

function Harness({ onAnswer }) {
  const [answer, setAnswer] = useState(undefined)
  return <DecisionCard decision={decision} answer={answer} onAnswer={(a) => { onAnswer(a); setAnswer(a ?? undefined) }} />
}

describe('all-camp override card, real clicks', () => {
  it.each([
    ['label', "It's for all camp", () => screen.getByText("It's for all camp").closest('label'), { choice: 'all_camp' }],
    ['input', "It's for all camp", () => screen.getByText("It's for all camp").closest('label').querySelector('input'), { choice: 'all_camp' }],
    ['label', 'It really excludes CIT', () => screen.getByText('It really excludes CIT').closest('label'), { choice: 'as_written' }],
    ['input', 'It really excludes CIT', () => screen.getByText('It really excludes CIT').closest('label').querySelector('input'), { choice: 'as_written' }],
  ])('clicking the %s of "%s" stages the answer and shows the card as answered', (_where, _text, target, expected) => {
    const onAnswer = vi.fn()
    render(<Harness onAnswer={onAnswer} />)
    fireEvent.click(target())
    expect(onAnswer).toHaveBeenCalledWith(expected)
    expect(screen.getByText(/^✓/)).toBeTruthy()
  })
})
