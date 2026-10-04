// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import AboutScreen from './AboutScreen'

describe('AboutScreen', () => {
  it('shows the About & Legal heading and all four sections', () => {
    render(<AboutScreen />)
    expect(screen.getByRole('heading', { level: 1, name: /About & Legal/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /^About$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /User agreement/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /^License$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /Third-party software/i })).toBeTruthy()
  })

  it('shows the app version', () => {
    render(<AboutScreen />)
    expect(screen.getByText(/Version 0\.1\.0/)).toBeTruthy()
  })

  it('states the local-first, no-servers posture and the no-warranty term', () => {
    render(<AboutScreen />)
    expect(screen.getByText(/has no accounts and no servers/i)).toBeTruthy()
    expect(screen.getByText(/without warranty of any kind/i)).toBeTruthy()
    expect(screen.getByText(/Apache License, Version 2\.0/)).toBeTruthy()
  })

  it('is view-only — no accept/acknowledge control', () => {
    render(<AboutScreen />)
    const buttons = screen.queryAllByRole('button')
    expect(buttons).toHaveLength(0)
    expect(screen.queryByText(/I understand|I agree|Accept/i)).toBeNull()
  })
})
