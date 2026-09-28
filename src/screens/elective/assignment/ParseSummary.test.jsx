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
    const parts = (kind, head, why) => ({ kind, head, why, message: `${head} — ${why}` })

    it('renders each item as a severity-railed row with the fact and its token', () => {
      render(
        <ParseSummary
          parsed={withResidue([
            parts('UNRESOLVED_CHOICE_LABEL', 'Row 3, column C', '“Quidditch” is not an activity this camp has.'),
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText(/1 thing\(s\) this import could not resolve/)).not.toBeNull()
      // The fact and the token are SEPARATE elements, which is what makes this a row
      // with parts rather than the paragraph it used to be.
      expect(screen.getByText('“Quidditch” is not an activity this camp has.')).not.toBeNull()
      expect(screen.getByText('Row 3, column C')).not.toBeNull()
      // Still solvable — residue is a report, not a refusal (ADR section 3.4).
      expect(screen.getByText('Solve Assignments')).not.toBeNull()
    })

    it('collapses 40 rows naming ONE unknown activity into ONE statement plus 40 tokens', () => {
      // THE CLAIM THE OLD COMMENT MADE AND THE OLD CODE DID NOT KEEP. Grouping by
      // kind alone demoted duplicates to bullets but every item was still a complete
      // self-contained sentence, so this shape rendered forty near-identical
      // paragraphs. Asserted at n=40 because it read acceptably at n=2.
      const why = '“Quidditch” is not an activity this camp has.'
      const residue = Array.from({ length: 40 }, (_, i) =>
        parts('UNRESOLVED_CHOICE_LABEL', `Row ${i + 2}, column E`, why)
      )
      render(<ParseSummary parsed={withResidue(residue)} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)

      expect(screen.getByText(/40 thing\(s\) this import could not resolve/)).not.toBeNull()
      // ONE statement. getAllByText throws nothing and returns every match, so a
      // length of 1 is the collapse; the pre-fix render would have returned 40.
      expect(screen.getAllByText(why)).toHaveLength(1)
      // FORTY tokens, all present, on one line — none silently dropped by the
      // grouping.
      const tokens = screen.getByText(/Row 2, column E/)
      for (let i = 0; i < 40; i += 1) expect(tokens.textContent).toContain(`Row ${i + 2}, column E`)
    })

    it('keeps two DIFFERENT unknown activities as two statements', () => {
      // Non-vacuity for the collapse: grouping on the shared fact must not merge
      // findings that differ. Grouping on `kind` alone would have shown one.
      render(
        <ParseSummary
          parsed={withResidue([
            parts('UNRESOLVED_CHOICE_LABEL', 'Row 2, column E', '“Quidditch” is not an activity this camp has.'),
            parts('UNRESOLVED_CHOICE_LABEL', 'Row 9, column E', '“Jousting” is not an activity this camp has.'),
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText(/Quidditch/)).not.toBeNull()
      expect(screen.getByText(/Jousting/)).not.toBeNull()
    })

    it('does not repeat UNMATCHED_DIVISION, which the solve step reports with a suggestion', () => {
      // One statement, one place to act. AssignmentPanel aggregates these per
      // division VALUE and offers suggestDivisionMatch; the parse-time item is per
      // camper and suggests nothing, so the director met the vague one first.
      render(
        <ParseSummary
          parsed={withResidue([
            parts('UNMATCHED_DIVISION', 'Ari Green', 'Division “Sports Track” is not a group or a tier this camp has.'),
            parts('UNRECOGNISED_COLUMN', 'Column F', 'Headed “Additional Comments”, which is not a field this import knows.'),
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.queryByText(/Sports Track/)).toBeNull()
      expect(screen.getByText(/Additional Comments/)).not.toBeNull()
      // The count is the count of what is SHOWN, so it cannot promise a row that
      // is not there.
      expect(screen.getByText(/1 thing\(s\) this import could not resolve/)).not.toBeNull()
    })

    it('falls back to the joined message for an item with no parts', () => {
      // A residue producer that has not been converted still renders, rather than
      // printing "undefined" at a director.
      render(
        <ParseSummary
          parsed={withResidue([{ kind: 'LEGACY', message: 'Something old said this in one sentence.' }])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText('Something old said this in one sentence.')).not.toBeNull()
    })

    it('shows nothing when there is no residue — non-vacuity for the disclosure', () => {
      render(<ParseSummary parsed={CLEAN} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
      expect(screen.queryByText(/could not resolve/)).toBeNull()
    })
  })
})
