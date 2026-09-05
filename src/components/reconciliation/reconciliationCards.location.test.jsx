// @vitest-environment jsdom
//
// Piece A of the duplicate-catcher ticket — the approved "Is <word> a place?"
// card's third choice, "Use instead ->", which needs a live locations list
// threaded in to work. docs/adr/2026-09-05-unresolved-location-remembered-
// decisions-and-held-conflict-triage-coverage.md §4.
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DecisionCard } from './reconciliationCards.jsx'

function locationDecision(word = 'Barn') {
  return {
    id: 'held:activities:Swim:location:location',
    kind: 'resolve_conflict',
    entity: 'activities',
    entityId: null,
    entityName: 'Swim',
    field: ['location'],
    confidence: 'conflict',
    proposedValue: word,
    evidence: null,
    _held: true,
    _heldKind: 'location',
    _word: word,
  }
}

const locations = [
  { id: 'loc-gym', name: 'Gym' },
  { id: 'loc-barn', name: 'barn' },
  { id: 'loc-arts', name: 'Arts & Crafts' },
]

describe('DecisionCard — location held conflict, "Use instead ->" picker', () => {
  it('renders a third action offering existing locations when a list is provided', () => {
    render(
      <DecisionCard
        decision={locationDecision('Barn')}
        rank="hold"
        answer={undefined}
        onAnswer={() => {}}
        expanded={false}
        onToggleEvidence={() => {}}
        locations={locations}
      />
    )
    expect(screen.getByText(/Use instead/i)).toBeTruthy()
  })

  it('orders near-matches to the unresolved word first, then the rest alphabetically', () => {
    render(
      <DecisionCard
        decision={locationDecision('Barn')}
        rank="hold"
        answer={undefined}
        onAnswer={() => {}}
        expanded={false}
        onToggleEvidence={() => {}}
        locations={locations}
      />
    )
    fireEvent.click(screen.getByText(/Use instead/i))
    const options = screen.getAllByRole('radio')
    const labels = options.map((o) => o.closest('label').textContent)
    // "barn" (near-match, case/trim-insensitive to "Barn") sorts before the
    // alphabetical remainder ("Arts & Crafts", "Gym").
    expect(labels[0]).toMatch(/barn/i)
    expect(labels[1]).toMatch(/Arts & Crafts/i)
    expect(labels[2]).toMatch(/Gym/i)
  })

  it('binding an existing location calls onAnswer with choice "existing" and the chosen location_id', () => {
    let received = null
    render(
      <DecisionCard
        decision={locationDecision('Barn')}
        rank="hold"
        answer={undefined}
        onAnswer={(a) => { received = a }}
        expanded={false}
        onToggleEvidence={() => {}}
        locations={locations}
      />
    )
    fireEvent.click(screen.getByText(/Use instead/i))
    const gymRadio = screen.getByRole('radio', { name: /Gym/i })
    fireEvent.click(gymRadio)
    expect(received).toEqual({ choice: 'existing', location_id: 'loc-gym' })
  })

  it('with no locations list, still renders the original two-choice card (no picker)', () => {
    render(
      <DecisionCard
        decision={locationDecision('Barn')}
        rank="hold"
        answer={undefined}
        onAnswer={() => {}}
        expanded={false}
        onToggleEvidence={() => {}}
      />
    )
    expect(screen.queryByText(/Use instead/i)).toBeNull()
  })
})
