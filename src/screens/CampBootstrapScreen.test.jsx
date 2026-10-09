// @vitest-environment jsdom
//
// W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §2) — the
// forest-circle badge sits above the title, decorative (alt=""). The role
// pill it originally sat above was cut in design batch C6.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CampBootstrapScreen from './CampBootstrapScreen'

describe('CampBootstrapScreen brand placement', () => {
  it('shows the forest-circle badge above the title', () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    const badge = screen.getByAltText('')
    expect(badge).toBeTruthy()
    const title = screen.getByText('Set up your camp')
    expect(badge.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("CampBootstrapScreen PIN field", () => {
  it("carries its guidance in the label and placeholder, with no repeating paragraph", () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    const pin = screen.getByLabelText("Create a PIN")
    expect(pin.getAttribute("placeholder")).toBe("6 or more digits")
    expect(screen.queryByText(/at least 6 digits/i)).toBeNull()
  })
})
