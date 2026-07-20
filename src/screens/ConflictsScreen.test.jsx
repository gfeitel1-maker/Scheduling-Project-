// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConflictsScreen, { noticeForStatus } from './ConflictsScreen'

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

  it('status "queued" (Fix 2b) shows distinct "will sync when connected" copy, NOT the same certainty-implying "Kept" text as "applied"', async () => {
    const user = userEvent.setup()
    const resolveConflict = vi.fn().mockResolvedValue({ status: 'queued' })
    renderScreen({ resolveConflict })

    await user.click(screen.getAllByRole('button', { name: /keep this version/i })[0])
    await waitFor(() => expect(screen.queryByText(/will sync when connected/i)).not.toBeNull())
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
