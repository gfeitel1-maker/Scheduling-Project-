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

  // Board item i-same-name-sheet-solves-silently-dropping-a-camper: the refusal
  // must name each row's DIVISION so a director can see the two children are
  // different (ADR 2026-09-27 §12.2a), matching the CLI's own refusal message.
  it('names each row’s division in the same-name refusal when the sheet carried divisions', () => {
    const parsed = {
      ...CLEAN,
      sameNameCampers: [{ display_name: 'Ari Feldman', rowNumbers: [2, 4], divisionLabels: ['Alonim', 'Nitzanim'] }],
    }
    render(<ParseSummary parsed={parsed} onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} />)
    expect(screen.getByText(/Ari Feldman — rows 2, 4 \(Alonim, Nitzanim\)/)).not.toBeNull()
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
            /* T298 renamed this prop: slice 1 needed to know WHETHER a label was
               resolved, slice 2 needs to know HOW, because the row now states
               which of three resolutions was taken. Same assertion. */
            resolutions={{ Quidditch: { action: 'add_activity' } }}
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

    // Board item i-declared-camper-dropped-when-all-choices-outside-catalog —
    // NO_RECOGNISABLE_CHOICE is an ACKNOWLEDGMENT (residueKinds.js), so it goes
    // through the same generic grouping as every other acknowledgment: one
    // statement, the names (heads) grouped under it.
    it('groups every NO_RECOGNISABLE_CHOICE camper under one acknowledgment statement', () => {
      const why = 'No rank cell on this row names an activity this camp has. Imported with no preferences — add their choices by hand.'
      render(
        <ParseSummary
          parsed={withResidue([
            parts('NO_RECOGNISABLE_CHOICE', 'Ben Stone', why),
            parts('NO_RECOGNISABLE_CHOICE', 'Ari Green', why),
          ])}
          onSolve={vi.fn()}
          onChooseDifferentFile={vi.fn()}
        />
      )
      // Both campers share the identical `why`, so this is ONE acknowledgment
      // statement (grouped like the 40-row Quidditch case), not two.
      expect(screen.getAllByText(why)).toHaveLength(1)
      const tokens = screen.getByText(/Ben Stone/)
      expect(tokens.textContent).toContain('Ben Stone')
      expect(tokens.textContent).toContain('Ari Green')
      expect(screen.getByText('1 thing noted')).not.toBeNull()
      // An acknowledgment, not a decision — still solvable, no action offered.
      expect(screen.getByText('Solve Assignments')).not.toBeNull()
      expect(screen.queryByText(/as an activity/)).toBeNull()
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

// T298 — THE TWO RESOLUTIONS SLICE 1 LEFT OUT, and the rule that decides whether
// each is rendered at all. Every assertion here is about an affordance being PRESENT
// or ABSENT, never disabled: "never a control whose options are all inert" is a rule
// about rendering, and a greyed-out control satisfies it only in appearance.
describe('ParseSummary resolutions (T298)', () => {
  const withResidue = (residue) => ({ ...CLEAN, residue })
  const unknown = (label = 'Arts and Crafts') => ({
    kind: 'UNRESOLVED_CHOICE_LABEL',
    head: 'Row 3, column C',
    why: `\u201c${label}\u201d is not an activity this camp has.`,
    label,
  })
  const packed = (label = 'Archery; Ceramics; Drama', parts = ['Archery', 'Ceramics', 'Drama']) => ({
    kind: 'AMBIGUOUS_PACKED_CELL',
    head: 'Row 3, column D',
    why: `\u201c${label}\u201d is not an activity this camp has, but split up it names ${parts.length} that are. Nothing was read from the cell.`,
    label,
    parts,
  })
  const CAMP = ['Swim', 'Arts & Crafts', 'Archery']

  const open = (props) =>
    render(
      <ParseSummary onSolve={vi.fn()} onChooseDifferentFile={vi.fn()} {...props} />
    )

  describe('map to an existing activity', () => {
    it('PRESELECTS the proposal and says why, without applying it', async () => {
      const onMapToActivity = vi.fn()
      open({ parsed: withResidue([unknown()]), onMapToActivity, activityNames: CAMP })
      expect(screen.getByTestId('residue-map-select').value).toBe('Arts & Crafts')
      expect(screen.getByTestId('residue-proposal').textContent).toBe('Same name, punctuated differently')
      // PRESELECTED IS NOT APPLIED. Nothing has been called; the director presses Map.
      expect(onMapToActivity).not.toHaveBeenCalled()
    })

    it('maps the whole LABEL GROUP, not one row', async () => {
      const onMapToActivity = vi.fn()
      // Forty cells named it; the group is one row with forty tokens, and the call
      // carries the LABEL, so one press settles all of them.
      const many = Array.from({ length: 40 }, (_, i) => ({ ...unknown(), head: `Row ${i + 3}, column C` }))
      open({ parsed: withResidue(many), onMapToActivity, activityNames: CAMP })
      expect(screen.getAllByTestId('residue-map')).toHaveLength(1)
      await userEvent.click(screen.getByTestId('residue-map'))
      expect(onMapToActivity).toHaveBeenCalledWith('Arts and Crafts', 'Arts & Crafts')
    })

    it('lets the director override the proposal', async () => {
      const onMapToActivity = vi.fn()
      open({ parsed: withResidue([unknown()]), onMapToActivity, activityNames: CAMP })
      await userEvent.selectOptions(screen.getByTestId('residue-map-select'), 'Swim')
      // The explanation goes with the proposal it explained.
      expect(screen.queryByTestId('residue-proposal')).toBeNull()
      await userEvent.click(screen.getByTestId('residue-map'))
      expect(onMapToActivity).toHaveBeenCalledWith('Arts and Crafts', 'Swim')
    })

    it('is ABSENT when the camp has no activities to map to', () => {
      // The one case where every option would be inert. Not rendered empty, and not
      // rendered disabled — absent.
      open({ parsed: withResidue([unknown()]), onMapToActivity: vi.fn(), activityNames: [] })
      expect(screen.queryByTestId('residue-map-select')).toBeNull()
      expect(screen.queryByTestId('residue-map')).toBeNull()
    })

    it('is ABSENT on an acknowledgment, which has no action', () => {
      open({
        parsed: withResidue([{ kind: 'UNVERIFIED_CHOICE_LABEL', head: '\u201cSwim\u201d', why: 'Imported as a choice.', label: 'Swim' }]),
        onMapToActivity: vi.fn(),
        activityNames: CAMP,
      })
      expect(screen.queryByTestId('residue-map-select')).toBeNull()
    })

    it('states the outcome once settled, naming what it now reads as', () => {
      open({
        parsed: withResidue([unknown()]),
        onMapToActivity: vi.fn(),
        activityNames: CAMP,
        resolutions: { 'Arts and Crafts': { action: 'map_to_existing', activityName: 'Arts & Crafts' } },
      })
      expect(screen.getByText('Read as \u201cArts & Crafts\u201d')).not.toBeNull()
      expect(screen.queryByTestId('residue-map')).toBeNull()
    })
  })

  describe('a packed cell is a decision with three readings', () => {
    it('counts as something TO DECIDE, not something noted', () => {
      open({ parsed: withResidue([packed()]), activityNames: CAMP })
      expect(screen.getByText('1 thing to decide')).not.toBeNull()
    })

    it('offers all three, and names how many the split would produce', async () => {
      const onSplitPacked = vi.fn()
      open({
        parsed: withResidue([packed()]),
        onSplitPacked,
        onAddActivity: vi.fn(),
        onMapToActivity: vi.fn(),
        activityNames: CAMP,
      })
      expect(screen.getByTestId('residue-split').textContent).toBe('Read as 3 separate choices')
      expect(screen.getByTestId('residue-add')).not.toBeNull()
      expect(screen.getByTestId('residue-map')).not.toBeNull()
      await userEvent.click(screen.getByTestId('residue-split'))
      expect(onSplitPacked).toHaveBeenCalledWith('Archery; Ceramics; Drama', ['Archery', 'Ceramics', 'Drama'])
    })

    it('does not offer a split on a row with no parts to split into', () => {
      // An UNRESOLVED label is one name. Offering "read as 0 separate choices" would
      // be the inert control the standing rule forbids.
      open({ parsed: withResidue([unknown()]), onSplitPacked: vi.fn(), onAddActivity: vi.fn(), activityNames: CAMP })
      expect(screen.queryByTestId('residue-split')).toBeNull()
      expect(screen.getByTestId('residue-add')).not.toBeNull()
    })

    it('states the split outcome once settled', () => {
      open({
        parsed: withResidue([packed()]),
        onSplitPacked: vi.fn(),
        activityNames: CAMP,
        resolutions: { 'Archery; Ceramics; Drama': { action: 'split_packed' } },
      })
      expect(screen.getByText('Read as separate choices')).not.toBeNull()
      expect(screen.queryByTestId('residue-split')).toBeNull()
    })
  })

  describe('a settled decision leaves the residue list, and still says so', () => {
    // FOUND IN THE BROWSER, not in a test. Resolving re-parses, the label stops being
    // residue, and the row the director just pressed vanished — only the counts moved,
    // and a director watching the row they pressed is not watching the counts. The
    // first draft's "Read as ..." branch was therefore unreachable in the happy path.
    it('states the outcome even when the label is no longer residue at all', () => {
      open({
        parsed: withResidue([]),
        activityNames: CAMP,
        resolutions: { 'Arts and Crafts': { action: 'map_to_existing', activityName: 'Arts & Crafts' } },
      })
      expect(screen.getByTestId('residue-settled')).not.toBeNull()
      expect(screen.getByText('Read as \u201cArts & Crafts\u201d')).not.toBeNull()
      // It is a statement about what was done, so it does not read as outstanding.
      expect(screen.getByText('1 settled')).not.toBeNull()
      expect(screen.queryByText(/thing to decide/)).toBeNull()
    })

    it('does not duplicate a row that is still residue', () => {
      // `add_activity` can leave the label in residue (a mint that still does not
      // match); the group's own row owns the outcome then, and a settled row beside
      // it would state the same fact twice.
      open({
        parsed: withResidue([unknown()]),
        onAddActivity: vi.fn(),
        activityNames: CAMP,
        resolutions: { 'Arts and Crafts': { action: 'add_activity' } },
      })
      expect(screen.queryByTestId('residue-settled')).toBeNull()
      expect(screen.getAllByText('Added as an activity')).toHaveLength(1)
    })

    it('outstanding work still leads the summary', () => {
      open({
        parsed: withResidue([packed()]),
        onSplitPacked: vi.fn(),
        activityNames: CAMP,
        resolutions: { 'Arts and Crafts': { action: 'map_to_existing', activityName: 'Arts & Crafts' } },
      })
      expect(screen.getByText('1 thing to decide \u00b7 1 settled')).not.toBeNull()
    })
  })

  it('SOLVE IS AVAILABLE THROUGHOUT \u2014 residue is a report, never a gate', () => {
    open({
      parsed: withResidue([unknown(), packed()]),
      onAddActivity: vi.fn(),
      onMapToActivity: vi.fn(),
      onSplitPacked: vi.fn(),
      activityNames: CAMP,
    })
    expect(screen.getByText('Solve Assignments')).not.toBeNull()
  })

  it('renders NO action at all when the caller supplies no handlers', () => {
    // The CLI's and the tests' default. An absent handler means absent affordance,
    // which is the rule held at the prop boundary.
    open({ parsed: withResidue([unknown(), packed()]), activityNames: CAMP })
    expect(screen.queryByTestId('residue-add')).toBeNull()
    expect(screen.queryByTestId('residue-map')).toBeNull()
    expect(screen.queryByTestId('residue-split')).toBeNull()
  })
})
