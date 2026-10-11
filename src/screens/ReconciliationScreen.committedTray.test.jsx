// @vitest-environment jsdom
//
// T253 round 3, Finding B. The spec's post-commit tray layout is:
//   [ hint line ]
//   [ receipt line, with its Show details link ]
//   [ Continue ] [ Undo this import ]
// all inside the same tray card. The implementation rendered tray.receipt
// as a sibling ABOVE styles.tray instead of inside it, so in the running
// app the receipt text floated detached above the card holding the hint
// and the buttons (see docs/work/evidence/t253-03-undo-receipt.png). This
// pins the receipt as a DOM descendant of the tray container.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
  },
}))

const grace = vi.hoisted(() => ({ status: 'used' }))

vi.mock('../hooks/useGraceWindowUndo', () => ({
  useGraceWindowUndo: () => ({
    status: grace.status,
    isPending: false,
    secondsLeft: null,
    undoError: null,
    deleted: [{ entity: 'activities', entity_id: 'a1' }],
    skipped: [],
    kept: [],
    undo: vi.fn(),
    start: vi.fn(),
  }),
}))

import ReconciliationScreen from './ReconciliationScreen.jsx'

describe('CommittedTray receipt placement', () => {
  it('renders the receipt inside the same tray card as the hint and Continue button', () => {
    const { container } = render(
      <ReconciliationScreen
        phase="committed"
        outcome={{ total: 28, invertibleOps: [{}] }}
        notices={[]}
        onNavigate={vi.fn()}
      />
    )

    const receipt = screen.getByText(/Removed 1 record/)
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    const tray = container.querySelector('div[style*="surface-elevated"]')

    expect(tray).toBeTruthy()
    expect(tray.contains(continueButton)).toBe(true)
    expect(tray.contains(receipt)).toBe(true)
  })

  it("says where last year's schedule went and offers to open it in Manual", () => {
    const onNavigate = vi.fn()
    render(
      <ReconciliationScreen
        phase="committed"
        outcome={{ total: 28, version: { created: true, versionName: 'Imported from campB.txt' } }}
        notices={[]}
        onNavigate={onNavigate}
      />
    )
    expect(screen.getByText("Last year's schedule is saved as a version: Imported from campB.txt.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open it in Manual' }))
    expect(onNavigate).toHaveBeenCalledWith('schedule:manual', { openVersionName: 'Imported from campB.txt' })
  })

  it('shows no version line when the import saved no version', () => {
    render(
      <ReconciliationScreen
        phase="committed"
        outcome={{ total: 28, version: { created: false, versionName: null } }}
        notices={[]}
        onNavigate={vi.fn()}
      />
    )
    expect(screen.queryByText(/saved as a version/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open it in Manual' })).toBeNull()
  })

  it('counts what the director recognizes: elective join rows are not records', () => {
    grace.status = 'expired'
    try {
      render(
        <ReconciliationScreen
          phase="committed"
          outcome={{
            invertibleOps: [{}],
            createdEntityIds: [
              { entity: 'elective_sets', entity_id: 's1' },
              { entity: 'activities', entity_id: 'a1' },
              { entity: 'activities', entity_id: 'a2' },
              { entity: 'elective_set_activities', entity_id: 'j1' },
              { entity: 'elective_set_activities', entity_id: 'j2' },
            ],
          }}
          notices={[]}
          onNavigate={vi.fn()}
        />
      )
      expect(screen.getByText(/Imported 3 records from the file\./)).toBeTruthy()
    } finally {
      grace.status = 'used'
    }
  })
})
