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

// AppShell's default screen is now 'roots', which renders RootsHomeScreen —
// a heavy screen with its own data layer, irrelevant to this notice-only
// test, so it's stubbed out the same way Shell is above.
vi.mock('./screens/RootsHomeScreen', () => ({
  default: (props) => (
    <div data-testid="roots-screen">
      <button onClick={() => props.onNavigate('readiness')}>go-to-readiness</button>
      <button onClick={() => props.onNavigate('import')}>go-to-import</button>
    </div>
  ),
}))

// A stubbed ImportScreen — real ImportScreen no longer takes an `onImported`
// prop (split failures are surfaced locally within it, not carried across
// the screen boundary), so this stub only exercises the navigation it still
// does: routing to Roots once an import finishes.
vi.mock('./screens/ImportScreen', () => ({
  default: (props) => (
    <div data-testid="import-screen">
      <button onClick={() => props.onNavigate('roots')}>finish-import</button>
      <button onClick={() => props.onNavigate('roots')}>cancel-to-roots</button>
    </div>
  ),
}))

import { AppShell } from './App'
import { seedDays } from './utils/seedDays'
import { ensureCohort } from './utils/ensureCohort'

beforeEach(() => {
  opRejectedCallback = undefined
  seedDays.mockReset().mockResolvedValue(undefined)
  ensureCohort.mockReset().mockResolvedValue(undefined)
})

// A failed one-time camp seed used to be an unhandled promise rejection: the
// director saw a camp with no weekdays and no reason why. It now surfaces
// through the same notice surface as an offline-rejected write.
describe('AppShell: a failed camp seed is surfaced, not swallowed', () => {
  it('shows a notice when seedDays rejects', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays could not be set up/i)
  })

  it('shows a notice when ensureCohort rejects', async () => {
    ensureCohort.mockRejectedValue(new Error('write failed for field "name"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default cohort could not be set up/i)
  })

  it('shows no notice when the seed succeeds', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // T200 — the two bootstrap writers race by construction (Promise.allSettled
  // over both), so a shared failure cause must not let one .catch clobber the
  // other's notice. Both causes must be legible in the one composed notice.
  it('T200: names BOTH failures when seedDays and ensureCohort both reject', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    ensureCohort.mockRejectedValue(new Error('write failed for field "name"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays/i)
    expect(alert.textContent).toMatch(/default cohort/i)
  })

  // T201 — the notice copy ends in "try again"; a bootstrap failure must
  // offer an explicit retry control that actually re-runs the bootstrap.
  it('T201: a bootstrap failure notice renders a Try again control that re-runs the bootstrap', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    expect(seedDays).toHaveBeenCalledTimes(1)
    const retryBtn = screen.getByRole('button', { name: /try again/i })

    seedDays.mockResolvedValueOnce(undefined)
    await act(async () => {
      fireEvent.click(retryBtn)
    })

    expect(seedDays).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // T201 — an onOpRejected notice is not a bootstrap failure; it must not
  // grow a retry control that has nothing meaningful to re-run.
  it('T201: the offline-queue onOpRejected notice has no Try again control', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    act(() => {
      opRejectedCallback({
        type: 'op_rejected',
        reason: 'unique_field',
        existing: { id: 'loc-a', name: 'Pool' },
      })
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  // T201 — the StrictMode guard is the fix's non-goal: retry must not
  // reopen the double-seed hole. Forcing the bootstrap effect to run twice
  // (StrictMode's dev-mode behaviour) must still call seedDays exactly once.
  // days_of_operation has NO UNIQUE constraint, so a second concurrent
  // seedDays is a real 10-day duplication, not a constraint violation.
  //
  // What this test does and does not pin (T202, measured, not assumed):
  // the invariant is now defended TWICE over — by `seededForCamp` (the
  // original StrictMode ref) and by `bootstrapInFlight` (T201's retry
  // serialiser, which also covers the StrictMode window because both
  // invocations land inside one in-flight run). Removing EITHER guard alone
  // leaves this test green; it only goes red when BOTH are gone. That was
  // verified by planting each removal in turn, so do not read a passing run
  // here as evidence that `seededForCamp` specifically is still doing work.
  // Isolating them is not possible from this seam: with deps [campId]
  // unchanged, React re-runs the effect only under StrictMode, which is the
  // same window the in-flight ref covers. Stated rather than silently
  // tolerated, so the next reader does not have to rediscover it.
  it('T201: StrictMode double-invocation still calls seedDays exactly once (defended by both guards — see comment)', async () => {
    const React = await import('react')
    render(
      <React.StrictMode>
        <AppShell campId="camp-1" role="admin" onLogout={() => {}} />
      </React.StrictMode>
    )
    await act(async () => {})
    expect(seedDays).toHaveBeenCalledTimes(1)
  })

  // T201 — clicking Try again twice while the first attempt is still
  // in-flight must not start two concurrent bootstrap runs.
  it('T201: rapid double-click on Try again does not run concurrent bootstraps', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const retryBtn = screen.getByRole('button', { name: /try again/i })

    let resolveSecond
    seedDays.mockReset()
    seedDays.mockReturnValue(new Promise((resolve) => { resolveSecond = resolve }))
    ensureCohort.mockReset().mockResolvedValue(undefined)

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    expect(seedDays).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSecond()
    })
  })

  // Round-2 review, Red Hat HIGH — allSettled must gate ONLY the in-flight
  // flag, not the notice itself. A hung write must not suppress a failure
  // that is already known.
  it('round2: a hung ensureCohort does not suppress a known seedDays failure', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    ensureCohort.mockReturnValue(new Promise(() => {})) // never settles
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays could not be set up/i)
  })

  // Round-2 review, Tester MEDIUM — a same-cause double failure must not
  // repeat the cause sentence verbatim.
  it('round2: a same-cause double failure names both subjects with the cause only once', async () => {
    seedDays.mockRejectedValue(new Error('disconnected'))
    ensureCohort.mockRejectedValue(new Error('disconnected'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    const cause = 'Your devices could not reach each other — try again when they are both on the network.'
    expect(alert.textContent).toMatch(/default weekdays/i)
    expect(alert.textContent).toMatch(/default cohort/i)
    const occurrences = alert.textContent.split(cause).length - 1
    expect(occurrences).toBe(1)
  })

  // Round-2 review, Tester MEDIUM — a different-cause double failure keeps
  // both full sentences, each with its own cause.
  it('round2: a different-cause double failure keeps both causes distinct', async () => {
    seedDays.mockRejectedValue(new Error('UNIQUE constraint failed'))
    ensureCohort.mockRejectedValue(new Error('NOT NULL constraint failed'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Another record already has that name/i)
    expect(alert.textContent).toMatch(/Something it needs is missing/i)
  })

  // Round-2 review, Tester HIGH — the banner must stay mounted and show a
  // disabled "Retrying…" state while a retry is in flight, not vanish.
  it('round2: retry keeps the banner mounted and shows a disabled Retrying state', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const retryBtn = screen.getByRole('button', { name: /try again/i })

    let resolveRetry
    seedDays.mockReset()
    seedDays.mockReturnValue(new Promise((resolve) => { resolveRetry = resolve }))
    ensureCohort.mockReset().mockResolvedValue(undefined)

    fireEvent.click(retryBtn)

    expect(screen.getByRole('alert')).toBeTruthy()
    const retryingBtn = screen.getByRole('button', { name: /retrying/i })
    expect(retryingBtn.disabled).toBe(true)

    await act(async () => { resolveRetry() })
  })

  // Round-2 review, Tester MEDIUM — DESIGN_STANDARD §5c: a recoverable
  // inline error's retry affordance is a link-button in var(--primary).
  it('round2: the retry control uses the primary link-button color per DESIGN_STANDARD §5c', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const retryBtn = screen.getByRole('button', { name: /try again/i })
    expect(retryBtn.style.color).toBe('var(--primary)')
  })

  // Round-2 review, Red Hat MEDIUM — seededForCamp is set before the
  // in-flight check runs, so a campId change mid-flight must not
  // permanently starve the new camp: an early-returned run must clear the
  // guard so a later attempt for that camp can proceed.
  it('round2: a campId change mid-flight does not permanently starve the new camp', async () => {
    let resolveCamp1
    seedDays.mockImplementationOnce(() => new Promise((resolve) => { resolveCamp1 = resolve }))
    ensureCohort.mockResolvedValue(undefined)

    const { rerender } = render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    seedDays.mockResolvedValue(undefined)
    rerender(<AppShell campId="camp-2" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    await act(async () => { resolveCamp1() })

    rerender(<AppShell campId={null} role="admin" onLogout={() => {}} />)
    rerender(<AppShell campId="camp-2" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    expect(seedDays).toHaveBeenCalledWith('camp-2')
  })

  // Round-3 review, HIGH — bootstrapBusy must mean "a director-initiated
  // retry is in progress", not "the mount bootstrap is still running". A
  // hung mount-time attempt must not render the retry control as a
  // permanently-disabled "Retrying…" that the director never triggered.
  it('round3: a hung ensureCohort on the MOUNT run leaves Try again enabled, not stuck on Retrying', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    ensureCohort.mockReturnValue(new Promise(() => {})) // never settles
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    const retryBtn = screen.getByRole('button', { name: /try again/i })
    expect(retryBtn.disabled).toBe(false)
    expect(retryBtn.textContent).toMatch(/try again/i)
  })

  // Round-3 review, HIGH — clicking Try again while the mount attempt is
  // still hung (bootstrapInFlight) must not silently no-op: the director
  // must see an honest explanation, and it must not fire a second seedDays.
  it('round3: clicking Try again while the mount run is still hung explains why, and does not re-call seedDays', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    ensureCohort.mockReturnValue(new Promise(() => {})) // never settles
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    expect(seedDays).toHaveBeenCalledTimes(1)
    const retryBtn = screen.getByRole('button', { name: /try again/i })

    await act(async () => {
      fireEvent.click(retryBtn)
    })

    expect(seedDays).toHaveBeenCalledTimes(1)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/previous attempt has not finished/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })

  // Round-3 review, MEDIUM — dismiss must stick. A notice the director just
  // closed must not silently reopen when a still-pending write later settles.
  it('round3: dismissing the notice while a write is still pending keeps it closed once that write settles', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    let resolveCohort
    ensureCohort.mockReturnValue(new Promise((resolve) => { resolveCohort = resolve }))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => { resolveCohort() })

    expect(screen.queryByRole('alert')).toBeNull()
  })
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
  it('default-renders the roots screen', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    expect(screen.getByTestId('roots-screen')).toBeTruthy()
  })

  it('redirects a stale readiness nav target to the roots screen', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-readiness'))

    expect(screen.getByTestId('roots-screen')).toBeTruthy()
  })
})

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md §2 — Roots home
// is a distinct screen from ReconciliationScreen's import flow; it no longer
// takes a `mode` prop or a carried `justImported` outcome (deleted, not
// moved, per the ADR's "Shared vs. forked" list). A finished import still
// routes to Roots, it just doesn't carry a receipt there anymore.
describe('AppShell: finished import routes to Roots', () => {
  it('lands a finished import on the roots screen', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    fireEvent.click(screen.getByText('go-to-import'))
    fireEvent.click(screen.getByText('finish-import'))

    expect(screen.getByTestId('roots-screen')).toBeTruthy()
  })
})
