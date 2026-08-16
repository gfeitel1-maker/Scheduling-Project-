// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConflictsScreen from './ConflictsScreen'
import { noticeForStatus } from './conflictsNotice'

afterEach(() => cleanup())

function makeConflict(overrides = {}) {
  return {
    id: 'users:u1:name:op2',
    entity: 'users',
    entity_id: 'u1',
    field: 'name',
    isPin: false,
    sideA: { op_id: 'op1', value: 'Alice', author_user_id: 'u1', device_id: 'dA', timestamp: '2026-07-20T00:00:00.000Z' },
    sideB: { op_id: 'op2', value: 'Alicia', author_user_id: 'u1', device_id: 'dB', timestamp: '2026-07-20T00:01:00.000Z' },
    ...overrides,
  }
}

// Mirrors the real usePendingConflicts contract closely enough to exercise
// ConflictsScreen/ConflictCard against it: resolveConflict's outcome is
// reflected into `resolvedMeta` (keyed by conflict id, not owned by the
// card), and dismissResolvedConflict clears both `conflicts` and
// `resolvedMeta`. The actual timer-scheduling/unmount-safety behavior of
// the real hook is covered separately in usePendingConflicts.test.js.
function TestHarness({ resolveConflict, conflict }) {
  const [conflicts, setConflicts] = useState([conflict])
  const [resolvedMeta, setResolvedMeta] = useState({})

  async function wrappedResolve(conflictId, side) {
    const result = await resolveConflict(conflictId, side)
    if (result && (result.status === 'applied' || result.status === 'queued')) {
      setResolvedMeta((prev) => ({ ...prev, [conflictId]: { side, queued: result.status === 'queued' } }))
    }
    return result
  }

  function dismissResolvedConflict(conflictId) {
    setConflicts((prev) => prev.filter((c) => c.id !== conflictId))
    setResolvedMeta((prev) => {
      const { [conflictId]: _removed, ...rest } = prev
      return rest
    })
  }

  const pendingConflicts = {
    conflicts,
    loading: false,
    resolveConflict: wrappedResolve,
    dismissResolvedConflict,
    resolveAuthorLabel: () => 'Someone',
    resolvedMeta,
  }
  return <ConflictsScreen pendingConflicts={pendingConflicts} />
}

function renderScreen({ resolveConflict, conflict = makeConflict() } = {}) {
  render(<TestHarness resolveConflict={resolveConflict} conflict={conflict} />)
}

describe('noticeForStatus (Fix 2: covers every non-success syncClient.write status)', () => {
  it('returns the existing conflict copy for status "conflict"', () => {
    expect(noticeForStatus('conflict')).toBe('This changed again — pick again below.')
  })
  it('returns connectivity copy for "timeout"', () => {
    expect(noticeForStatus('timeout')).toMatch(/couldn't reach the network/i)
  })
  it('returns connectivity copy for "disconnected"', () => {
    expect(noticeForStatus('disconnected')).toMatch(/couldn't reach the network/i)
  })
  it('returns a generic message for "error"', () => {
    expect(noticeForStatus('error')).toMatch(/something went wrong/i)
  })
  it('falls back to the generic message for any unrecognized/undefined status', () => {
    expect(noticeForStatus(undefined)).toMatch(/something went wrong/i)
    expect(noticeForStatus('some-future-status')).toMatch(/something went wrong/i)
  })
})

describe('ConflictsScreen keep(): exercises every real write-status path through the wired component', () => {
  it('status "applied" runs the confirm animation and does not show an error notice', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'applied' })
    renderScreen({ resolveConflict })

    const buttons = screen.getAllByRole('button', { name: /keep this version/i })
    await user.click(buttons[0])

    await waitFor(() => expect(screen.queryByText(/kept someone's version/i)).not.toBeNull())
    expect(screen.queryByText(/something went wrong/i)).toBeNull()
  })

  it('status "queued" (Fix 2b) shows distinct not-yet-sent copy, NOT the same certainty-implying "Kept" text as "applied"', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'queued' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    // T18: was /will sync when connected/. "Sync" is developer vocabulary; the
    // copy now says what actually happens to the other computers.
    await waitFor(() => expect(screen.queryByText(/will reach the other computers/i)).not.toBeNull())
    expect(screen.queryByText(/^✓ Kept Someone's version$/)).toBeNull()
  })

  it('status "conflict" shows the re-pick notice and re-enables the buttons', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'conflict' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    await waitFor(() => expect(screen.queryByText(/pick again below/i)).not.toBeNull())
    expect(screen.getAllByRole('button', { name: /keep this version/i })[0].disabled).toBe(false)
  })

  it('status "timeout" shows a connectivity notice instead of silently re-enabling with no explanation', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'timeout' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    await waitFor(() => expect(screen.queryByText(/couldn't reach the network/i)).not.toBeNull())
  })

  it('status "disconnected" shows a connectivity notice', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'disconnected' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    await waitFor(() => expect(screen.queryByText(/couldn't reach the network/i)).not.toBeNull())
  })

  it('status "error" shows a generic failure notice', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'error' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    await waitFor(() => expect(screen.queryByText(/something went wrong/i)).not.toBeNull())
  })
})

describe('ConflictsScreen PIN masking: lock icon shown, raw value never rendered', () => {
  it('shows "PIN was changed" and lock SVG for a pin_hash conflict, not any value string', () => {
    const pinConflict = makeConflict({
      entity: 'users',
      field: 'pin_hash',
      isPin: true,
      // sanitizeSide strips `value` for PIN fields; sideA/sideB carry no value here
      sideA: { op_id: 'op1', author_user_id: 'u1', device_id: 'dA', timestamp: '2026-07-20T00:00:00.000Z' },
      sideB: { op_id: 'op2', author_user_id: 'u1', device_id: 'dB', timestamp: '2026-07-20T00:01:00.000Z' },
    })
    const pendingConflicts = {
      conflicts: [pinConflict],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)

    // Lock copy must be present in both choice boxes
    expect(screen.getAllByText('PIN was changed')).toHaveLength(2)
    // The heading should call it "A PIN was changed on two devices"
    expect(screen.getByText('A PIN was changed on two devices')).toBeTruthy()
    // No raw hash-like string should appear — confirm neither side has a value
    // rendered (values would be empty string / undefined, not a hash string,
    // because sanitizeSide strips them; but we also confirm no String(undefined)
    // leak via the "undefined" text node).
    expect(screen.queryByText('undefined')).toBeNull()
  })

  it('does not render any value for a pin_salt conflict', () => {
    const pinConflict = makeConflict({
      entity: 'users',
      field: 'pin_salt',
      isPin: true,
      sideA: { op_id: 'op1', author_user_id: 'u1', device_id: 'dA', timestamp: '2026-07-20T00:00:00.000Z' },
      sideB: { op_id: 'op2', author_user_id: 'u1', device_id: 'dB', timestamp: '2026-07-20T00:01:00.000Z' },
    })
    const pendingConflicts = {
      conflicts: [pinConflict],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)
    expect(screen.getAllByText('PIN was changed')).toHaveLength(2)
    expect(screen.queryByText('undefined')).toBeNull()
  })
})

// M6 (D3, docs/adr/2026-08-16-locations-optional-map.md): camp_maps.image_data
// must render as two thumbnails, never the raw ~700KB base64 string.
describe('ConflictsScreen camp map image conflict: thumbnails shown, raw base64 never rendered as text', () => {
  function makeImageConflict() {
    return makeConflict({
      entity: 'camp_maps',
      entity_id: 'camp-1',
      field: 'image_data',
      isPin: false,
      sideA: { op_id: 'op1', author_user_id: 'u1', device_id: 'dA', timestamp: '2026-07-20T00:00:00.000Z', value: 'AAAA_base64_stand_in_A' },
      sideB: { op_id: 'op2', author_user_id: 'u2', device_id: 'dB', timestamp: '2026-07-20T00:01:00.000Z', value: 'BBBB_base64_stand_in_B' },
    })
  }

  it('renders the title as "The camp map image", not the generic fallback or PIN copy', () => {
    const pendingConflicts = {
      conflicts: [makeImageConflict()],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)
    expect(screen.getByText('The camp map image')).toBeTruthy()
    expect(screen.queryByText('A PIN was changed on two devices')).toBeNull()
    expect(screen.queryByText('A change to this record')).toBeNull()
  })

  it('renders two <img> thumbnails built from data: URLs, and never dumps the raw base64 as text', () => {
    const conflict = makeImageConflict()
    const pendingConflicts = {
      conflicts: [conflict],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    const { container } = render(<ConflictsScreen pendingConflicts={pendingConflicts} />)

    // Presentational-only: alt="" is deliberate (the thumbnail carries no
    // information a screen reader user needs beyond "an image conflict",
    // already announced by the card's title) — which is exactly why
    // getByRole('img') can't find it (empty alt maps to role="presentation"),
    // so this queries the DOM directly instead.
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(2)
    expect(images[0].getAttribute('src')).toBe(`data:image/jpeg;base64,${conflict.sideA.value}`)
    expect(images[1].getAttribute('src')).toBe(`data:image/jpeg;base64,${conflict.sideB.value}`)

    // The raw base64 stand-ins must never appear as a rendered text node —
    // confirms the generic String(side.value) branch was NOT taken.
    expect(screen.queryByText(conflict.sideA.value)).toBeNull()
    expect(screen.queryByText(conflict.sideB.value)).toBeNull()
  })

  it('still offers "Keep this version" for each side (the resolve action is unchanged by the rendering branch)', () => {
    const pendingConflicts = {
      conflicts: [makeImageConflict()],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)
    expect(screen.getAllByText('Keep this version')).toHaveLength(2)
  })
})

describe('ConflictsScreen empty state: graceful UI when no conflicts', () => {
  it('shows a no-conflicts message and does not crash when conflicts is empty', () => {
    const pendingConflicts = {
      conflicts: [],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)
    expect(screen.getByText(/no conflicts to resolve/i)).toBeTruthy()
    expect(screen.getByText(/everything'?s in sync/i)).toBeTruthy()
    // No error — no buttons, no cards
    expect(screen.queryByRole('button', { name: /keep this version/i })).toBeNull()
  })

  it('shows a loading indicator while conflicts are being fetched', () => {
    const pendingConflicts = {
      conflicts: [],
      loading: true,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: {},
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)
    expect(screen.getByText(/loading/i)).toBeTruthy()
    expect(screen.queryByText(/no conflicts/i)).toBeNull()
  })
})

describe('ConflictCard (Fix 1): renders from resolved-state props, not a self-owned dismiss timer', () => {
  it('a fresh mount for a conflict already present in resolvedMeta shows the confirmed state immediately, never the pristine unresolved buttons', () => {
    const conflict = makeConflict()
    const pendingConflicts = {
      conflicts: [conflict],
      loading: false,
      resolveConflict: vi.fn(),
      dismissResolvedConflict: vi.fn(),
      resolveAuthorLabel: () => 'Someone',
      resolvedMeta: { [conflict.id]: { side: 'A', queued: false } },
    }
    render(<ConflictsScreen pendingConflicts={pendingConflicts} />)

    expect(screen.queryByText(/kept someone's version/i)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /keep this version/i })).toBeNull()
  })
})
