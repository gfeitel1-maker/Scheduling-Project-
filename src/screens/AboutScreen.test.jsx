// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import AboutScreen from './AboutScreen'
import pkg from '../../package.json'

describe('AboutScreen', () => {
  it('shows the About & Legal heading and all four sections', () => {
    render(<AboutScreen />)
    expect(screen.getByRole('heading', { level: 1, name: /About & Legal/i })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /^About Shoresh$/ })).toBeTruthy()
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
    render(<AboutScreen />)
    // The agreement only: the owner's About text above it is his own words, verbatim, and says "we".
    const text = screen.getByRole('heading', { level: 2, name: /User agreement/i }).closest('section').textContent
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

  // T341: the owner's About text, verbatim. Exact strings, so a silent edit, trim or "fix" fails here.
  it("shows the owner's About text verbatim: subtitle, the six headings, first, middle and last lines, and the credit", () => {
    render(<AboutScreen />)
    expect(screen.getByText('An unnecessarily comprehensive explanation of a reasonably straightforward thing, including several observations about the future of software that seemed relevant at the time.')).toBeTruthy()
    for (const h of [
      'A perfectly reasonable thing to build',
      'A brief digression concerning artificial intelligence, which is actually rather central to the whole thing',
      'Concerning ownership, which is a surprisingly complicated word for such a simple idea',
      'Concerning the business model, or the rather peculiar economics of giving something away',
      'The larger question, which has been lurking here for some time and has now become increasingly difficult to ignore',
      'Anyway, about the schedule',
    ]) expect(screen.getByRole('heading', { level: 3, name: h })).toBeTruthy()
    expect(screen.getByText(/^Scheduling a summer camp is, when considered from a sufficiently generous distance, a relatively straightforward exercise/)).toBeTruthy()
    expect(screen.getByText('Your schedule belongs to you.')).toBeTruthy()
    expect(screen.getByText('And somebody, somewhere, is going to ask whether the Blue Group can switch archery with basketball on Thursday.')).toBeTruthy()
    expect(screen.getByText('Now go make a schedule.')).toBeTruthy()
    expect(screen.getByText(/^Written by GPT-6, with considerable philosophical encouragement/)).toBeTruthy()
    expect(screen.getByText(/^The artificial intelligence would also like to acknowledge that it was asked to write an About section/)).toBeTruthy()
  })

  it('renders every line of the text module, in order, with nothing added or dropped', async () => {
    const { ABOUT_TITLE, ABOUT_SUBTITLE, ABOUT_BLOCKS, ABOUT_CREDIT } = await import('./aboutShoreshText.js')
    const { container } = render(<AboutScreen />)
    const about = container.querySelector('[data-testid="about-shoresh"]')
    const shown = [...about.querySelectorAll('h2, h3, p')].map((el) => el.textContent).filter((t) => !t.startsWith('Version '))
    expect(shown).toEqual([ABOUT_TITLE, ABOUT_SUBTITLE, ...ABOUT_BLOCKS.map((b) => b.text), ...ABOUT_CREDIT])
  })
})
