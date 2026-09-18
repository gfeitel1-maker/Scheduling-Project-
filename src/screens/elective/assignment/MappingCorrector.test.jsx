// @vitest-environment jsdom
//
// T229 round 2, M2 — the mapping corrector was a dead end when a sheet had no
// '#1'-style headers: inferPreferenceMapping returns zero rankColumns, no
// pickers render, and "Confirm Mapping" can never enable. A header like
// "Kid | Grp | Choice A | Choice B" is an ordinary camp export. This pins two
// requirements: the director can add/remove rank columns by hand, and every
// phase has an escape ("Choose a Different File").
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MappingCorrector from './MappingCorrector.jsx'

const HEADER = ['Kid', 'Grp', 'Choice A', 'Choice B']
const SAMPLE_ROWS = [['Ari', 'Juniors', 'Archery', 'Gaga']]

function noRankMapping() {
  return { nameIndex: 0, externalIdIndex: null, divisionIndex: 1, rankColumns: [], unmapped: ['ranks'] }
}

describe('MappingCorrector — M2 manual rank columns', () => {
  it('lets the director add a rank column and pick which sheet column it is', () => {
    const onChange = vi.fn()
    render(
      <MappingCorrector
        header={HEADER} sampleRows={SAMPLE_ROWS} mapping={noRankMapping()}
        onChange={onChange} onConfirm={vi.fn()} onChooseDifferentFile={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText(/Add Rank Column/i))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rankColumns: [{ rank: 1, index: null }] })
    )
  })

  it('lets the director remove a rank column', () => {
    const onChange = vi.fn()
    const mapping = { nameIndex: 0, externalIdIndex: null, divisionIndex: 1, rankColumns: [{ rank: 1, index: 2 }], unmapped: [] }
    render(
      <MappingCorrector
        header={HEADER} sampleRows={SAMPLE_ROWS} mapping={mapping}
        onChange={onChange} onConfirm={vi.fn()} onChooseDifferentFile={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /remove rank #1/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rankColumns: [] }))
  })

  it('cannot confirm until every added rank has a column picked', () => {
    const mapping = { nameIndex: 0, externalIdIndex: null, divisionIndex: 1, rankColumns: [{ rank: 1, index: null }], unmapped: [] }
    render(
      <MappingCorrector
        header={HEADER} sampleRows={SAMPLE_ROWS} mapping={mapping}
        onChange={vi.fn()} onConfirm={vi.fn()} onChooseDifferentFile={vi.fn()}
      />
    )
    expect(screen.getByText(/Confirm Mapping/).disabled).toBe(true)
  })
})

describe('MappingCorrector — M2 no phase is a dead end', () => {
  it('offers Choose a Different File even when no rank columns were inferred', () => {
    const onChooseDifferentFile = vi.fn()
    render(
      <MappingCorrector
        header={HEADER} sampleRows={SAMPLE_ROWS} mapping={noRankMapping()}
        onChange={vi.fn()} onConfirm={vi.fn()} onChooseDifferentFile={onChooseDifferentFile}
      />
    )
    fireEvent.click(screen.getByText(/Choose a Different File/i))
    expect(onChooseDifferentFile).toHaveBeenCalled()
  })
})
