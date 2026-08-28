// @vitest-environment jsdom
//
// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 1 — the landing
// predicate: campIsEmpty ? 'seed' : 'roots', read synchronously by
// AppShell's `screen` useState initializer. Drives AppShell directly (same
// seam App.test.jsx already uses) with a fixed campIsEmpty prop, bypassing
// useDeviceMode's async init.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./localClient', () => ({
  localClient: {
    list: vi.fn(() => Promise.resolve([])),
    onOpRejected: vi.fn(() => () => {}),
  },
}))

vi.mock('./hooks/usePendingConflicts', () => ({
  usePendingConflicts: () => ({ conflicts: [] }),
}))

vi.mock('./utils/ensureCohort', () => ({
  ensureCohort: vi.fn(() => Promise.resolve()),
}))

vi.mock('./utils/seedDays', () => ({
  seedDays: vi.fn(() => Promise.resolve()),
}))

vi.mock('./components/layout/Shell', () => ({
  default: ({ children }) => <div data-testid="shell">{children}</div>,
}))

vi.mock('./screens/ReconciliationScreen', () => ({
  default: () => <div data-testid="roots-screen" />,
}))

vi.mock('./screens/SeedScreen', () => ({
  default: () => <div data-testid="seed-screen" />,
}))

import { AppShell } from './App'

describe('AppShell: stage-aware landing (campIsEmpty ? seed : roots)', () => {
  it('lands on the Seed screen when campIsEmpty is true', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} campIsEmpty />)
    expect(screen.getByTestId('seed-screen')).toBeTruthy()
    expect(screen.queryByTestId('roots-screen')).toBeNull()
  })

  it('lands on Roots when campIsEmpty is false', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} campIsEmpty={false} />)
    expect(screen.getByTestId('roots-screen')).toBeTruthy()
    expect(screen.queryByTestId('seed-screen')).toBeNull()
  })

  it('lands on Roots when campIsEmpty is undefined (unresolved/omitted, matching pre-ADR behavior)', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    expect(screen.getByTestId('roots-screen')).toBeTruthy()
  })
})
