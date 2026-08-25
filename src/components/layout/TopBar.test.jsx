// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import TopBar from './TopBar'
import { SCREEN_KEYS } from '../../screenKeys'

// Plan T5 / audit finding G4 — a setup screen reached via Roots' "Manage
// {Area} →" deep link (Task 1) had no way back into Roots. This return
// affordance closes the inspect→edit→re-inspect loop.

describe('TopBar — Roots return affordance', () => {
  it('shows "Roots" control on a setup screen and navigates to roots on click', () => {
    const onNavigate = vi.fn()
    render(<TopBar screen="groups" onNavigate={onNavigate} />)

    const control = screen.getByRole('button', { name: /roots/i })
    fireEvent.click(control)

    expect(onNavigate).toHaveBeenCalledWith('roots')
  })

  it('does not show the control when already on roots', () => {
    render(<TopBar screen="roots" onNavigate={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /roots/i })).toBeNull()
  })

  it('does not show the control on a non-setup screen (schedule route)', () => {
    render(<TopBar screen="schedule:manual" onNavigate={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /roots/i })).toBeNull()
  })

  it('does not show the control on a non-setup screen (conflicts)', () => {
    render(<TopBar screen="conflicts" onNavigate={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /roots/i })).toBeNull()
  })
})

// Every routable screen must resolve to its own header title. A screen key
// with no TITLES entry falls back to the literal "Shoresh", which tells the
// director nothing about where they are — the exact regression that left
// roots/locations/events/specialdays and the special/electives/map schedule
// routes all showing "Shoresh".
describe('TopBar — every screen key has a non-fallback title', () => {
  for (const key of SCREEN_KEYS) {
    it(`renders a real title for "${key}", not the "Shoresh" fallback`, () => {
      const { container } = render(<TopBar screen={key} onNavigate={vi.fn()} />)
      const heading = container.querySelector('h1')
      expect(heading).not.toBeNull()
      expect(heading.textContent).not.toBe('Shoresh')
    })
  }
})
