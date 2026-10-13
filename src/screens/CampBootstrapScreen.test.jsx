// @vitest-environment jsdom
//
// W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §2) — the
// app's sprout mark (navy disc, gold sprout; the app icon's design) sits above the
// title, decorative (alt=""). The role pill it originally sat above was cut in design batch C6.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CampBootstrapScreen from './CampBootstrapScreen'

describe('CampBootstrapScreen brand placement', () => {
  it('shows the sprout mark badge above the title', () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    const badge = screen.getByAltText('')
    expect(badge.getAttribute('src')).toMatch(/173B63/i) // the sprout mark's navy (Vite inlines the SVG as a data URI)
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

// Director test 2026-10-12: the "6 or more digits" guidance disappeared once typing began, and Create
// stayed disabled with no reason given.
describe('CampBootstrapScreen guidance', () => {
  it('keeps "6 or more digits" visible under the PIN, tied to the field', () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    const pin = screen.getByLabelText('Create a PIN')
    const hint = document.getElementById(pin.getAttribute('aria-describedby'))
    expect(hint?.textContent).toBe('6 or more digits')
  })

  it('says why Create is disabled, and stops once everything is filled in', () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    expect(screen.getByText('Create camp').closest('button').disabled).toBe(true)
    expect(screen.getByText(/^To create the camp, add a camp name, your name and a PIN of 6 or more digits\.$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Camp name'), { target: { value: 'Pines' } })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } })
    fireEvent.change(screen.getByLabelText('Create a PIN'), { target: { value: '123' } })
    expect(screen.getByText(/^To create the camp, make the PIN 6 or more digits\.$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Create a PIN'), { target: { value: '123456' } })
    expect(screen.getByText('Create camp').closest('button').disabled).toBe(false)
    expect(screen.queryByText(/^To create the camp/)).toBeNull()
  })
})
