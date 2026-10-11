// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import AboutScreen from './AboutScreen'
import pkg from '../../package.json'

describe('AboutScreen', () => {
  it('shows the About & Legal heading and all four sections', () => {
    render(<AboutScreen />)
    expect(screen.getByRole('heading', { level: 1, name: /About & Legal/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /^About$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /User agreement/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /^License$/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /Third-party software/i })).toBeTruthy()
  })

  it('shows the version from package.json (one source, not a hand-kept literal)', () => {
    render(<AboutScreen />)
    expect(screen.getByText(`Version ${pkg.version}`, { exact: false })).toBeTruthy()
  })

  it('neither the About screen nor the sidebar footer hand-keeps a version literal', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    for (const rel of ['src/screens/AboutScreen.jsx', 'src/components/layout/Sidebar.jsx']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      expect(src, rel).not.toMatch(/\d+\.\d+\.\d+/)
    }
  })

  it('the agreement speaks in the first person singular (T341: voice "I")', () => {
    const { container } = render(<AboutScreen />)
    const text = container.textContent
    expect(text).not.toMatch(/\b(we|We|us|our|Our)\b/)
    expect(text).toMatch(/\bI\b/)
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
