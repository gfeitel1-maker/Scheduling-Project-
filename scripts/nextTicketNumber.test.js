import { describe, it, expect } from 'vitest'
import { nextTicketNumber } from './nextTicketNumber.js'

// See docs/adr/2026-09-25-ticket-number-arbitration.md "Test seam (non-vacuity)".
// The crux fixture: a ticket number that exists ONLY as an uncommitted file in
// another local worktree — never on real disk, never in root's own readDocs.

const rootDocs = [
  { path: 'docs/work/tickets/T238-a.md', data: { document_type: 'ticket' }, error: null },
  { path: 'docs/work/tickets/T239-b.md', data: { document_type: 'ticket' }, error: null },
]

const fakeReadDocs = () => rootDocs

const fakeListWorktrees = () => [
  { path: '/fake/root', branch: 'claude/T225-x' },
  { path: '/fake/sibling-worktree', branch: 'worktree-x', locked: true },
]

const fakeReadWorktreeTickets = (worktreePath) => {
  if (worktreePath === '/fake/sibling-worktree') {
    // This file exists ONLY in this fixture — never on real disk — standing in
    // for exactly the case that broke: an uncommitted ticket in another worktree.
    return [{ path: 'docs/work/tickets/T240-uncommitted.md', number: '240' }]
  }
  return []
}

const throwingExecFn = () => { throw new Error('gh: command not found') }

describe('nextTicketNumber — the aggregator closes the T234-239/v73 gap', () => {
  it('sees the sibling worktree\'s uncommitted T240 and allocates T241, not T240', () => {
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: fakeListWorktrees,
      readWorktreeTickets: fakeReadWorktreeTickets,
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(241)
  })

  it('PLANTS the old, single-tree failure: with the sibling-worktree read stubbed out, ' +
     'the identical fixture returns the collision number T240 — proving the assertion above ' +
     'is not vacuous', () => {
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: fakeListWorktrees,
      readWorktreeTickets: () => [], // simulates the old, T225-motivating behavior
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(240)
  })

  it('returns the correct next number when no hidden collision exists', () => {
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: () => [{ path: '/fake/root', branch: 'main' }],
      readWorktreeTickets: () => [],
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(240)
  })

  it('a skipped soft source (gh absent, listWorktrees unavailable) is reported honestly ' +
     'and still yields a correct root-only result', () => {
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: () => { throw new Error('git worktree list unavailable') },
      readWorktreeTickets: fakeReadWorktreeTickets,
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(240)
    expect(result.sources.worktrees).toBe('skipped')
    expect(result.sources.branches).toBe('skipped')
    expect(result.sources.prs).toBe('skipped')
    expect(result.sources.root).toBe('read')
  })

  it('isolates a single worktree\'s read failure — the others are still read', () => {
    const flakyListWorktrees = () => [
      { path: '/fake/root', branch: 'main' },
      { path: '/fake/broken-worktree', branch: 'y' },
      { path: '/fake/sibling-worktree', branch: 'worktree-x' },
    ]
    const flakyReadWorktreeTickets = (worktreePath) => {
      if (worktreePath === '/fake/broken-worktree') throw new Error('EACCES: permission denied')
      return fakeReadWorktreeTickets(worktreePath)
    }
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: flakyListWorktrees,
      readWorktreeTickets: flakyReadWorktreeTickets,
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(241)
    expect(result.sources.worktrees).toBe('read (1 of 2 siblings)')
  })

  it('reports a zero-of-M-siblings scan honestly instead of an unqualified "read"', () => {
    const allFailListWorktrees = () => [
      { path: '/fake/root', branch: 'main' },
      { path: '/fake/sibling-a', branch: 'a' },
      { path: '/fake/sibling-b', branch: 'b' },
      { path: '/fake/sibling-c', branch: 'c' },
    ]
    const allFailReadWorktreeTickets = () => { throw new Error('locked') }
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: throwingExecFn,
      listWorktrees: allFailListWorktrees,
      readWorktreeTickets: allFailReadWorktreeTickets,
      readDocsFn: fakeReadDocs,
    })
    expect(result.sources.worktrees).toBe('read (0 of 3 siblings)')
    expect(result.next).toBe(240)
  })

  it('normalizes root vs worktree paths via realpath so a symlinked root spelling ' +
     'is not double-counted as a sibling', () => {
    const fakeRealpathFn = (p) => ({
      '/tmp/root': '/private/tmp/root',
      '/private/tmp/root': '/private/tmp/root',
      '/fake/sibling': '/fake/sibling',
    }[p] ?? p)
    const symlinkListWorktrees = () => [
      { path: '/private/tmp/root', branch: 'main' }, // same real root, different spelling
      { path: '/fake/sibling', branch: 'x' },
    ]
    const symlinkReadWorktreeTickets = (worktreePath) => {
      if (worktreePath === '/private/tmp/root') return [{ path: 'docs/work/tickets/T239-b.md' }]
      if (worktreePath === '/fake/sibling') return [{ path: 'docs/work/tickets/T240-uncommitted.md' }]
      return []
    }
    const result = nextTicketNumber({
      root: '/tmp/root',
      execFn: throwingExecFn,
      listWorktrees: symlinkListWorktrees,
      readWorktreeTickets: symlinkReadWorktreeTickets,
      readDocsFn: fakeReadDocs,
      realpathFn: fakeRealpathFn,
    })
    expect(result.next).toBe(241)
    expect(result.sources.worktrees).toBe('read (1 of 1 siblings)')
  })

  it('extractNumbers ignores false-positive substrings like SORT250 or PORT2500', () => {
    const result = nextTicketNumber({
      root: '/fake/root',
      execFn: (cmd) => {
        if (cmd.startsWith('git ls-remote')) return 'abc123\trefs/heads/feature/SORT250-fix\n'
        if (cmd.startsWith('gh pr list')) return JSON.stringify([
          { headRefName: 'PORT2500-migrate', title: 'Unrelated PR' },
        ])
        throw new Error('unexpected command')
      },
      listWorktrees: () => [{ path: '/fake/root', branch: 'main' }],
      readWorktreeTickets: () => [],
      readDocsFn: fakeReadDocs,
    })
    expect(result.next).toBe(240)
  })
})
