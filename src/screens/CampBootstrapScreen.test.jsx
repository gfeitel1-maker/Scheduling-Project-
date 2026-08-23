// @vitest-environment jsdom
//
// W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §2) — the
// forest-circle badge sits above the role pill, decorative (alt="").
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CampBootstrapScreen from './CampBootstrapScreen'

describe('CampBootstrapScreen brand placement', () => {
  it('shows the forest-circle badge above the role pill', () => {
    render(<CampBootstrapScreen onBack={vi.fn()} onSubmit={vi.fn()} />)
    const badge = screen.getByAltText('')
    expect(badge).toBeTruthy()
    expect(screen.getByText('HOSTING ON THIS DEVICE')).toBeTruthy()
  })
})
