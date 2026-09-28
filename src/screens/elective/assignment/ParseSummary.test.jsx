// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ParseSummary from './ParseSummary'

const CLEAN = { campers: [{ id: 'c1' }], choices: [{ label: 'Swim' }], preferences: [{ camper_id: 'c1' }], sameNameCampers: [], skippedRows: [] }

describe('ParseSummary', () => {
  it('renders stats and a Solve button when the sheet is clean', () => {
    render(<ParseSummary parsed={CLEAN} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
    expect(screen.getByText('Solve Assignments')).not.toBeNull()
  })

  it('renders the same-name refusal with names and row numbers, and NO Solve button', () => {
    const parsed = { ...CLEAN, sameNameCampers: [{ display_name: 'Ari Green', rowNumbers: [2, 3] }] }
    render(<ParseSummary parsed={parsed} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
    expect(screen.getByText("This sheet can't be assigned yet")).not.toBeNull()
    expect(screen.getByText(/Ari Green — rows 2, 3/)).not.toBeNull()
    expect(screen.queryByText('Solve Assignments')).toBeNull()
  })

  it('renders the contradictory-ranks refusal with NO Solve button', () => {
    render(<ParseSummary parsed={CLEAN} contradictoryRanks onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
    expect(screen.getByText("This sheet can't be assigned yet")).not.toBeNull()
    expect(screen.queryByText('Solve Assignments')).toBeNull()
  })

  // T285 — THE LOUD HALF, which had never been rendered anywhere in the product.
  // Every residue item the ETL produced was computed and then dropped by the UI, so
  // a design that rests on the director being told what we could not resolve told
  // them nothing.
  describe('residue', () => {
    const withResidue = (residue) => ({ ...CLEAN, residue })

    it('renders what the import could not resolve, with the sentence it produced', () => {
      render(
        <ParseSummary
          parsed={withResidue([
            { kind: 'UNRESOLVED_CHOICE_LABEL', message: 'Row 3, column C names \u201cQuidditch\u201d, which is not an activity this camp has.' },
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText(/1 thing\(s\) this import could not resolve/)).not.toBeNull()
      expect(screen.getByText(/Quidditch/)).not.toBeNull()
      // Still solvable — residue is a report, not a refusal (ADR section 3.4).
      expect(screen.getByText('Solve Assignments')).not.toBeNull()
    })

    it('groups repeats by kind so one missing activity is ONE finding, not a hundred', () => {
      // A 100-camper sheet naming one unknown activity would otherwise bury the
      // sentence that matters under a hundred copies of it.
      render(
        <ParseSummary
          parsed={withResidue([
            { kind: 'UNMATCHED_DIVISION', message: 'Ari\u2019s division reads \u201cSports Track\u201d, which is not a group.' },
            { kind: 'UNMATCHED_DIVISION', message: 'Noa\u2019s division reads \u201cArts Track\u201d, which is not a group.' },
            { kind: 'UNRECOGNISED_COLUMN', message: 'Column F is headed \u201cAdditional Comments\u201d and was not read.' },
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText(/3 thing\(s\) this import could not resolve/)).not.toBeNull()
      // Both divisions are reachable, and so is the unrelated kind.
      expect(screen.getByText(/Sports Track/)).not.toBeNull()
      expect(screen.getByText(/Arts Track/)).not.toBeNull()
      expect(screen.getByText(/Additional Comments/)).not.toBeNull()
    })

    it('shows nothing when there is no residue — non-vacuity for the disclosure', () => {
      render(<ParseSummary parsed={CLEAN} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
      expect(screen.queryByText(/could not resolve/)).toBeNull()
    })
  })
})
