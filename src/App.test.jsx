// @vitest-environment jsdom
//
// Item 7 (docs/adr/2026-08-15-locations-concurrent-create-collision.md
// addendum, owner decision): an offline-rejected write must be VISIBLE to
// the director, not console-only. Drives AppShell directly (exported from
// App.jsx alongside the default App) with fixed props, bypassing
// useDeviceMode's async init — the same seam every screen test already uses
// for its own component.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

let opRejectedCallback

vi.mock('./localClient', () => ({
  localClient: {
    list: vi.fn(() => Promise.resolve([])),
    onOpRejected: vi.fn((cb) => {
      opRejectedCallback = cb
      return () => {}
    }),
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

// AppShell's default screen is now 'roots', which renders ReconciliationScreen —
// a heavy screen with its own data layer, irrelevant to this notice-only
// test, so it's stubbed out the same way Shell is above.
vi.mock('./screens/ReconciliationScreen', () => ({
  default: (props) => (
    <div data-testid="roots-screen" data-mode={props.mode}>
      <button onClick={() => props.onNavigate('readiness')}>go-to-readiness</button>
    </div>
  ),
}))

import { AppShell } from './App'

beforeEach(() => {
  opRejectedCallback = undefined
})

describe('AppShell: offline op-rejected notice (item 7, owner decision)', () => {
  it('renders no notice before any rejection arrives', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a dismissible banner naming the existing location when onOpRejected fires', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    expect(opRejectedCallback).toBeTypeOf('function')

    act(() => {
      opRejectedCallback({
        type: 'op_rejected',
        reason: 'unique_field',
        existing: { id: 'loc-a', name: 'Pool', capacity: 2, notes: null },
      })
    })

    const notice = screen.getByRole('alert')
    expect(notice.textContent).toContain('Pool')
    expect(notice.textContent).toContain('already exists')
  })

  it('falls back to a generic message when the rejection carries no existing.name', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })

    const notice = screen.getByRole('alert')
    expect(notice.textContent).toMatch(/could not be saved/i)
  })

  it('dismiss removes the banner', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    act(() => {
      opRejectedCallback({
        type: 'op_rejected',
        reason: 'unique_field',
        existing: { id: 'loc-a', name: 'Pool' },
      })
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// Roots-as-dashboard plan, Task 3: Roots (not the retired Setup Readiness
// hub) is the in-session landing screen, and any stale 'readiness' deep-link
// or nav target redirects to it rather than rendering nothing.
describe('AppShell: Roots as landing screen (plan T3)', () => {
  it('default-renders the roots screen in inspect mode', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    const roots = screen.getByTestId('roots-screen')
    expect(roots.dataset.mode).toBe('inspect')
  })

  it('redirects a stale readiness nav target to the roots screen, still in inspect mode', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-readiness'))

    const roots = screen.getByTestId('roots-screen')
    expect(roots.dataset.mode).toBe('inspect')
  })
})
