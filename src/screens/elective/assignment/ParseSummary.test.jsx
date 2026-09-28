// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    const parts = (kind, head, why, extra = {}) => ({ kind, head, why, message: `${head} — ${why}`, ...extra })
    const unknown = (head, label = 'Quidditch') =>
      parts('UNRESOLVED_CHOICE_LABEL', head, `“${label}” is not an activity this camp has.`, { label })

    it('renders each item as a severity-railed row with the fact and its token', () => {
      render(
        <ParseSummary parsed={withResidue([unknown('Row 3, column C')])} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />
      )
      // The fact and the token are SEPARATE elements, which is what makes this a row
      // with parts rather than the paragraph it used to be.
      expect(screen.getByText('“Quidditch” is not an activity this camp has.')).not.toBeNull()
      expect(screen.getByText('Row 3, column C')).not.toBeNull()
      // Still solvable — residue is a report, not a refusal (ADR section 3.4).
      expect(screen.getByText('Solve Assignments')).not.toBeNull()
    })

    it('THE COUNT NAMES DECISIONS, not the instances that produced them', () => {
      // 43 residue items, 3 statements, ONE of them a decision. The old label said
      // "43 thing(s) this import could not resolve", which told a director they had
      // 43 problems when they had one thing to settle. Planting the defect: if the
      // label counted items again, this reads 43.
      const residue = [
        parts('SKIPPED_PREAMBLE', 'Row(s) 1, 2', 'Above the table, so not read.'),
        parts('UNRECOGNISED_COLUMN', 'Column F', 'Not a field this import knows.'),
        parts('UNRECOGNISED_COLUMN', 'Column G', 'Not a field this import knows.'),
        ...Array.from({ length: 40 }, (_, i) => unknown(`Row ${i + 4}, column C`)),
      ]
      render(<ParseSummary parsed={withResidue(residue)} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)

      expect(screen.getByText('1 thing to decide · 2 things noted')).not.toBeNull()
      // The INSTANCE count must not appear in the label at all. "Row 43" legitimately
      // contains 43 inside the token line below, so this is asserted on the summary.
      const summary = screen.getByText(/things noted/)
      expect(summary.tagName).toBe('SUMMARY')
      expect(summary.textContent).not.toMatch(/43/)
    })

    it('collapses 40 rows naming ONE unknown activity into ONE statement, and folds the invariant token', () => {
      // THE CLAIM THE OLD COMMENT MADE AND THE OLD CODE DID NOT KEEP, plus the fold:
      // "column C" was printed forty times carrying no information after the first.
      const why = '“Quidditch” is not an activity this camp has.'
      const residue = Array.from({ length: 40 }, (_, i) => unknown(`Row ${i + 4}, column C`))
      render(<ParseSummary parsed={withResidue(residue)} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)

      // ONE statement; the pre-fix render returned 40.
      expect(screen.getAllByText(why)).toHaveLength(1)
      // The invariant is stated ONCE and the forty varying parts follow it, so
      // "column C" appears exactly once in the whole token line.
      const tokens = screen.getByText(/Column C/)
      expect(tokens.textContent.match(/column C/gi)).toHaveLength(1)
      for (let i = 0; i < 40; i += 1) expect(tokens.textContent).toContain(`Row ${i + 4}`)
    })

    it('does NOT fold when the repeated segment is not actually invariant', () => {
      // Non-vacuity for the fold: two unrecognised columns share no segment, so
      // factoring anything out would be an invention. Also proves the fold is not
      // just "drop the last segment".
      render(
        <ParseSummary
          parsed={withResidue([
            parts('UNRECOGNISED_COLUMN', 'Column F (“Comments”)', 'Not a field this import knows.'),
            parts('UNRECOGNISED_COLUMN', 'Column G (“Notes”)', 'Not a field this import knows.'),
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      const tokens = screen.getByText(/Column F/)
      expect(tokens.textContent).toContain('Column F (“Comments”)')
      expect(tokens.textContent).toContain('Column G (“Notes”)')
    })

    it('keeps two DIFFERENT unknown activities as two statements', () => {
      // Non-vacuity for the collapse: grouping on the shared fact must not merge
      // findings that differ. Grouping on `kind` alone would have shown one.
      render(
        <ParseSummary
          parsed={withResidue([unknown('Row 2, column E'), unknown('Row 9, column E', 'Jousting')])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      expect(screen.getByText(/Quidditch/)).not.toBeNull()
      expect(screen.getByText(/Jousting/)).not.toBeNull()
      expect(screen.getByText('2 things to decide')).not.toBeNull()
    })

    describe('decision vs acknowledgment', () => {
      it('offers the resolution on a DECISION, once per label rather than once per row', async () => {
        const onAddActivity = vi.fn()
        const residue = Array.from({ length: 40 }, (_, i) => unknown(`Row ${i + 4}, column C`))
        render(
          <ParseSummary
            parsed={withResidue(residue)}
            onAddActivity={onAddActivity}
            onSolve={vi.fn()}
            onChooseDifferentFile={vi.fn()}
          />
        )
        // FORTY rows naming one activity is ONE activity to add.
        const buttons = screen.getAllByText('Add “Quidditch” as an activity')
        expect(buttons).toHaveLength(1)
        await userEvent.click(buttons[0])
        expect(onAddActivity).toHaveBeenCalledWith('Quidditch')
      })

      it('offers NOTHING on an acknowledgment — there is nothing to decide', () => {
        render(
          <ParseSummary
            parsed={withResidue([parts('SKIPPED_PREAMBLE', 'Row(s) 1, 2', 'Above the table, so not read.')])}
            onAddActivity={vi.fn()}
            onSolve={vi.fn()}
            onChooseDifferentFile={vi.fn()}
          />
        )
        expect(screen.queryByRole('button', { name: /as an activity/ })).toBeNull()
        expect(screen.getByText('1 thing noted')).not.toBeNull()
      })

      it('renders NO action at all when the host supplies no handler', () => {
        // The standing rule against a control whose options are all inert: with no
        // way to add an activity, the affordance is absent, not disabled.
        render(
          <ParseSummary parsed={withResidue([unknown('Row 3, column C')])} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />
        )
        expect(screen.queryByText(/as an activity/)).toBeNull()
      })

      it('puts the decision ABOVE the acknowledgments whatever order they arrived in', () => {
        render(
          <ParseSummary
            parsed={withResidue([
              parts('SKIPPED_PREAMBLE', 'Row(s) 1, 2', 'Above the table, so not read.'),
              unknown('Row 3, column C'),
            ])}
            onSolve={vi.fn()}
            onChooseDifferentFile={vi.fn()}
          />
        )
        const text = document.body.textContent
        expect(text.indexOf('Quidditch')).toBeLessThan(text.indexOf('Above the table'))
      })

      it('replaces the action with its outcome once the label is resolved', () => {
        render(
          <ParseSummary
            parsed={withResidue([unknown('Row 3, column C')])}
            onAddActivity={vi.fn()}
            resolvedLabels={['Quidditch']}
            onSolve={vi.fn()}
            onChooseDifferentFile={vi.fn()}
          />
        )
        expect(screen.queryByText(/Add “Quidditch”/)).toBeNull()
        expect(screen.getByText('Added as an activity')).not.toBeNull()
      })
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
      expect(screen.getByText('1 thing noted')).not.toBeNull()
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
      expect(screen.queryByText(/to decide|noted/)).toBeNull()
    })
  })
})
