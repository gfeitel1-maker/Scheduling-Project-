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
    <div
      data-testid="roots-screen"
      data-mode={props.mode}
      data-just-imported={props.justImported ? String(props.justImported.total) : ''}
    >
      <button onClick={() => props.onNavigate('readiness')}>go-to-readiness</button>
      <button onClick={() => props.onNavigate('import')}>go-to-import</button>
    </div>
  ),
}))

// Task 4 — a stubbed ImportScreen that exercises the carrier: finishing an
// import hands an outcome up via onImported and routes to Roots.
vi.mock('./screens/ImportScreen', () => ({
  default: (props) => (
    <div data-testid="import-screen">
      <button
        onClick={() => {
          props.onImported({ total: 7, invertibleOps: [] })
          props.onNavigate('roots')
        }}
      >finish-import</button>
      <button onClick={() => props.onNavigate('roots')}>cancel-to-roots</button>
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

// Roots-as-dashboard plan, Task 4: a finished import routes to Roots carrying
// the commit outcome, which App holds and clears when the director leaves.
describe('AppShell: finished import carries to Roots (plan T4)', () => {
  it('lands a finished import on Roots carrying the outcome', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-import'))
    fireEvent.click(screen.getByText('finish-import'))

    const roots = screen.getByTestId('roots-screen')
    expect(roots.dataset.mode).toBe('inspect')
    expect(roots.dataset.justImported).toBe('7')
  })

  it('clears the carried outcome once the director leaves Roots', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-import'))
    fireEvent.click(screen.getByText('finish-import'))
    expect(screen.getByTestId('roots-screen').dataset.justImported).toBe('7')

    // Leave Roots (to Import) and come back — the outcome must not persist.
    fireEvent.click(screen.getByText('go-to-import'))
    fireEvent.click(screen.getByText('cancel-to-roots'))
    expect(screen.getByTestId('roots-screen').dataset.justImported).toBe('')
  })

  // Whole-branch review fix: 'readiness' redirects to 'roots' at render, so a
  // nav to 'readiness' must not clear justImported — that would silently drop
  // the post-import banner while the director visually stays on Roots.
  it('does not clear the carried outcome when navigating to the stale readiness target', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-import'))
    fireEvent.click(screen.getByText('finish-import'))
    expect(screen.getByTestId('roots-screen').dataset.justImported).toBe('7')

    fireEvent.click(screen.getByText('go-to-readiness'))
    expect(screen.getByTestId('roots-screen').dataset.justImported).toBe('7')
  })
})
