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
import { render, screen } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../hooks/useGraceWindowUndo', () => ({
  useGraceWindowUndo: () => ({
    status: 'used',
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
})
