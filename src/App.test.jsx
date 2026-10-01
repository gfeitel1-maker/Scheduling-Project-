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
import userEvent from '@testing-library/user-event'

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

// The mount-time bootstrap (seedDays + ensureCohort) settles asynchronously
// and, on success, recomposes the notice to null. Tests that assert the
// notice is GONE after an await must flush that first, or the bootstrap's own
// clear would satisfy the assertion instead of the behaviour under test.
const flushBootstrap = () => act(async () => {})

// T204: the notice's dismiss fade is --motion-fast (140ms) before the node is
// removed. Real timers (not fake ones) because the enter transition rides on
// requestAnimationFrame, which vi.useFakeTimers would also have to drive.
const settleDismissFade = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
})

// prefers-reduced-motion is read through window.matchMedia at render time
// (src/styles/shared.js); jsdom's own matchMedia always reports false.
function reduceMotion(on) {
  window.matchMedia = (query) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })
}

beforeEach(() => {
  reduceMotion(false)
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
  // What this test does and does not pin (measured, not assumed):
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
    // T204: dismiss now fades out over --motion-fast before unmounting, so
    // the assertion is the faded-out END state, not immediate removal.
    await settleDismissFade()
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

  // T204 — DESIGN_STANDARD §5c: "On dismiss/resolve, fade out --motion-fast".
  // This test used to assert the alert was gone *immediately* after the
  // click, and that assertion was the stated reason dismiss stayed
  // synchronous. Per GOVERNANCE_INDEX §11.3 the standard governs, so the
  // test moved: it now pins the fade (still mounted, opacity 0) AND the
  // end state (removed). It still fails outright if dismiss stops removing
  // the banner at all.
  it('dismiss fades the banner out and then removes it', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    // Let the mount-time bootstrap settle FIRST. Both writers succeed here,
    // and their final recompose clears the notice — so without this flush a
    // removal assertion taken after any await would pass whether or not the
    // dismiss fade ever completed (measured, not assumed).
    await flushBootstrap()
    act(() => {
      opRejectedCallback({
        type: 'op_rejected',
        reason: 'unique_field',
        existing: { id: 'loc-a', name: 'Pool' },
      })
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))

    const fading = screen.getByRole('alert')
    expect(fading.style.opacity).toBe('0')
    expect(fading.style.transition).toContain('var(--motion-fast)')

    await settleDismissFade()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // T204 §8 — every animation ships a prefers-reduced-motion fallback; for a
  // dismiss that means instant, not a shorter fade.
  it('dismiss is immediate under prefers-reduced-motion', () => {
    reduceMotion(true)
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  // T204 §5c — "outline alert icon (16px, var(--danger)) + message + ...".
  it('renders the 16px danger alert icon alongside the message', () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })
    const icon = screen.getByRole('alert').querySelector('svg')
    expect(icon).toBeTruthy()
    expect(icon.getAttribute('width')).toBe('16')
    expect(icon.getAttribute('stroke')).toBe('var(--danger)')
    expect(icon.getAttribute('fill')).toBe('none')
  })

  // T204 — the window the fade opens: a NEW notice arriving while the old one
  // is still fading must not be swallowed by the outgoing notice's pending
  // unmount. Uses the SAME message twice, which is the case a string-valued
  // notice could not tell apart from "nothing new arrived".
  it('a new notice arriving mid-fade cancels the pending unmount', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await flushBootstrap()
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.getByRole('alert').style.opacity).toBe('0')

    // Same rejection again, mid-fade.
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })

    await settleDismissFade()
    const alert = screen.queryByRole('alert')
    expect(alert).toBeTruthy()
    expect(alert.textContent).toMatch(/could not be saved/i)
    expect(alert.style.opacity).not.toBe('0')
  })
})

// Board note (q-small-sweeps-batch, owner ruling 2026-09-29 "yes to t200"):
// "The offline-queue rejection notice could overwrite a bootstrap-failure
// notice, losing it ... Notices display in order, none lost." These replace
// the single-scalar opRejectedNotice/noticeRetry state with a FIFO queue
// (src/notices/noticeQueue.js).
describe('AppShell: notice FIFO queue (T200 board follow-up)', () => {
  // The board's own scenario, verbatim.
  it('an offline-queue rejection does not overwrite a bootstrap failure notice — both display in order, none lost', async () => {
    seedDays.mockRejectedValue(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    let alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays could not be set up/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()

    // An offline-queue rejection arrives while the bootstrap notice is head.
    act(() => {
      opRejectedCallback({
        type: 'op_rejected',
        reason: 'unique_field',
        existing: { id: 'loc-a', name: 'Pool' },
      })
    })

    // (1) the bootstrap notice is still on screen, with its retry.
    alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays could not be set up/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()

    // (2) after Dismiss, the offline-queue notice shows.
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await settleDismissFade()

    alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Pool')
    expect(alert.textContent).toContain('already exists')
    // (3) nothing was lost, and the offline notice carries no retry control.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('two identical offline rejections in a row produce two separate notices', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await flushBootstrap()

    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })

    expect(screen.getByText('1 more')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Dismiss'))
    await settleDismissFade()

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('a bootstrap recompose does not duplicate its notice when days fails then cohort fails', async () => {
    let rejectDays, rejectCohort
    seedDays.mockReturnValue(new Promise((_, reject) => { rejectDays = reject }))
    ensureCohort.mockReturnValue(new Promise((_, reject) => { rejectCohort = reject }))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)

    await act(async () => { rejectDays(new Error('write failed for field "label"')) })
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    await act(async () => { rejectCohort(new Error('write failed for field "name"')) })
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays/i)
    expect(alert.textContent).toMatch(/default cohort/i)
  })

  it('a bootstrap that resolves clean removes only its own entry, leaving another queued notice intact', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })
    expect(screen.getByText('1 more')).toBeTruthy()

    const retryBtn = screen.getByRole('button', { name: /try again/i })
    seedDays.mockResolvedValueOnce(undefined)
    await act(async () => { fireEvent.click(retryBtn) })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be saved/i)
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('dismissing an offline notice does not mark the bootstrap invocation dismissed', async () => {
    let rejectDays
    seedDays.mockReturnValueOnce(new Promise((_, reject) => { rejectDays = reject }))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)

    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    expect(screen.getByRole('alert').textContent).toMatch(/could not be saved/i)

    fireEvent.click(screen.getByLabelText('Dismiss'))
    await settleDismissFade()
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => { rejectDays(new Error('write failed for field "label"')) })

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays could not be set up/i)
  })

  it('shows no "more" count when only one notice is queued', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await flushBootstrap()
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('shows "N more" marked aria-hidden when notices are queued behind the head', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await flushBootstrap()
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })

    const count = screen.getByText('2 more')
    expect(count.getAttribute('aria-hidden')).toBe('true')
  })

  // Round 2, Red Hat HIGH, CONFIRMED: the dismiss path (unlike every other
  // mutator) removed by POSITION, not by id. The 140ms fade timer is armed
  // at click time but the removal it performs when it fires reads whatever
  // is at index 0 THEN — not what was actually dismissed. If the dismissed
  // entry is independently removed (by id) before that timer fires, the
  // stale positional removal destroys whatever has since become head,
  // which the director never asked to dismiss and may never have read.
  it('Finding 1: a dismiss timer that fires after its own entry was already removed by id must not destroy a different, unrelated queued notice', async () => {
    seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
    ensureCohort.mockRejectedValueOnce(new Error('write failed for field "name"'))
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await act(async () => {})

    let alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/default weekdays/i)

    // An unrelated notice is queued behind the bootstrap notice.
    act(() => {
      opRejectedCallback({ status: 'rejected', reason: 'unique_field' })
    })
    expect(screen.getByText('1 more')).toBeTruthy()

    // Director dismisses the bootstrap notice (the head). This arms the
    // 140ms fade timer closed over the bootstrap notice's id — it has not
    // fired yet.
    fireEvent.click(screen.getByLabelText('Dismiss'))

    // Before that timer fires, the bootstrap notice's own retry resolves
    // cleanly: recompose() removes THAT entry by id (removeById), which
    // correctly leaves the offline notice as the new head.
    seedDays.mockResolvedValueOnce(undefined)
    ensureCohort.mockResolvedValueOnce(undefined)
    const retryBtn = screen.getByRole('button', { name: /try again/i })
    await act(async () => { fireEvent.click(retryBtn) })

    alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/could not be saved/i)

    // The stale dismiss timer now fires.
    await settleDismissFade()

    // The offline notice was never dismissed — it must still be on screen.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/could not be saved/i)
  })

  // Round 2, two reviewers, MEDIUM: handleDismiss arms a new setTimeout into
  // dismissTimeoutRef without clearing one already pending there, and the
  // pre-change stale-timer guard was deleted without an equivalent
  // replacement. Two dismiss activations on the same head (e.g. a focused
  // Dismiss button activated twice via Enter/Space, which jsdom does not
  // block the way pointer-events:none blocks a mouse click) must remove
  // exactly one notice, not two.
  it('Finding 2: two rapid dismiss activations on one head remove exactly one notice, not two', async () => {
    render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
    await flushBootstrap()

    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    act(() => { opRejectedCallback({ status: 'rejected', reason: 'unique_field' }) })
    expect(screen.getByText('1 more')).toBeTruthy()

    const dismissBtn = screen.getByLabelText('Dismiss')
    act(() => {
      fireEvent.click(dismissBtn)
      fireEvent.click(dismissBtn)
    })

    await settleDismissFade()

    // Exactly one notice was removed: the second is now on screen, head,
    // with nothing queued behind it.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/could not be saved/i)
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  // Round 4 board ruling on Red Hat's residual-loss repro (CONFIRMED): a
  // keyboard retry activated inside the 140ms dismiss fade must cancel that
  // notice's own pending dismiss timer before the retry's upsert lands —
  // otherwise the stale timer later removes the fresh failure message the
  // director has never read.
  //
  // Reached via `userEvent.keyboard('{Enter}')` on the already-focused Try
  // again button, NOT `userEvent.click`/`fireEvent.click`. That distinction
  // is the point: `userEvent.click` performs a real pointer interaction and
  // asserts the target's computed `pointer-events` is not `none` first — it
  // would throw here, because `opRejectedNoticeStyles.dismissing` sets
  // `pointerEvents: 'none'` on the wrap while fading, which is exactly what
  // blocks a second *mouse* click in production. `userEvent.keyboard` never
  // performs that pointer-events check (it lives only in the pointer
  // module) — pressing Enter on a focused button fires a synthetic click via
  // the keyboard module's own default-action registry, which is how a real
  // browser honours keyboard activation regardless of pointer-events. That
  // is the reachable path this test exercises.
  it('Round 4 Item 1: a keyboard retry inside the dismiss fade cancels that notice\'s own pending dismiss, so the new failure message is not later removed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      seedDays.mockRejectedValueOnce(new Error('write failed for field "label"'))
      render(<AppShell campId="camp-1" role="admin" onLogout={() => {}} />)
      await act(async () => {})

      let alert = screen.getByRole('alert')
      expect(alert.textContent).toMatch(/default weekdays/i)

      const retryBtn = screen.getByRole('button', { name: /try again/i })
      await act(async () => { retryBtn.focus() })

      // Director dismisses the notice. This arms the 140ms fade timer for
      // THIS notice's id — nothing has been removed yet.
      await act(async () => { fireEvent.click(screen.getByLabelText('Dismiss')) })

      // Within the fade window, the director retries via keyboard. The
      // retry fails again with a brand-new message; bootstrap retries
      // deliberately reuse their entry id, so this upsert writes the new
      // message into the SAME id the stale dismiss timer is about to act on.
      seedDays.mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      await act(async () => {
        await user.keyboard('{Enter}')
      })

      // The original dismiss timer's remaining ~90ms elapses.
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      // The fresh failure must still be on screen — the retry's own notice
      // was never destroyed by a dismiss issued against the message it
      // replaced.
      alert = screen.getByRole('alert')
      expect(alert.textContent).toMatch(/already has that name/i)
    } finally {
      vi.useRealTimers()
    }
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
