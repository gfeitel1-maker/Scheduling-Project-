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
})
