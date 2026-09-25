// Allocates the next free ticket number by aggregating in-use numbers from
// every place one can currently live — not just this worktree's own
// docs/work/tickets/.
//
// See docs/adr/2026-09-25-ticket-number-arbitration.md. The load-bearing
// source is (d): every OTHER local worktree, read directly off disk
// (readdirSync/readFileSync — no git operation), including files that are
// not yet committed. That is the source the T234-239/v73 incidents showed
// was authoritative and everything remote-only missed.
//
// Advisory tooling, not a gate: checkTicketNumberUniqueness in
// check-governance.js stays the deterministic, single-tree, post-hoc
// backstop for the residual same-second race (see the ADR). This script
// runs once, by choice, at filing time.
//
// Every source is read individually and wrapped in try/catch. A source that
// cannot be read is SKIPPED and reported as skipped in `sources` — never
// silently dropped. A silent skip is exactly the false-clean shape this
// ticket exists to stop.

import { execSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocs } from './build-work-index.js'

const TICKET_FILENAME = /^T(\d+)[-.]/

function ticketNumber(path) {
  const m = path.split('/').pop().match(TICKET_FILENAME)
  return m ? m[1] : null
}

/** Soft signal: a ticket number embedded anywhere in a branch name or PR title. */
function extractNumbers(text) {
  return [...String(text).matchAll(/\bT(\d+)\b/g)].map((m) => m[1])
}

/** realpath a path for comparison; a path that no longer exists falls back to itself. */
function safeRealpath(path, realpathFn) {
  try {
    return realpathFn(path)
  } catch {
    return path
  }
}

const defaultExecFn = (cmd) => execSync(cmd, { encoding: 'utf8' })

/** Parses `git worktree list --porcelain` into [{ path, branch, locked }]. */
export function defaultListWorktrees(execFn = defaultExecFn) {
  const out = execFn('git worktree list --porcelain')
  return out.split('\n\n').filter((b) => b.trim()).map((block) => {
    const wt = { path: null, branch: null, locked: false }
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) wt.branch = line.slice('branch '.length).replace('refs/heads/', '').trim()
      else if (line === 'detached') wt.branch = null
      else if (line === 'locked' || line.startsWith('locked ')) wt.locked = true
    }
    return wt
  })
}

/** Reads a sibling worktree's docs/work/tickets/*.md directly off disk. */
export function defaultReadWorktreeTickets(worktreePath) {
  const dir = join(worktreePath, 'docs/work/tickets')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ path: `docs/work/tickets/${name}` }))
}

/**
 * @param root                this worktree's absolute path
 * @param execFn              injectable — runs `git ls-remote`, `gh pr list`
 * @param listWorktrees       injectable — () => [{ path, branch, locked }]
 * @param readWorktreeTickets injectable — (worktreePath) => [{ path }]
 * @param readDocsFn          injectable — defaults to build-work-index's readDocs
 * @param realpathFn          injectable — defaults to fs.realpathSync; used to compare `root`
 *                            against each worktree path symlink-robustly (e.g. /tmp vs /private/tmp)
 * @returns {{ next: number, sources: Record<string, string> }} sources.worktrees is 'skipped' when
 *          `listWorktrees` itself failed, otherwise `'read (N of M siblings)'` — N is the number of
 *          sibling worktrees whose tickets dir was actually enumerated without throwing.
 */
export function nextTicketNumber({
  root,
  execFn = defaultExecFn,
  listWorktrees = () => defaultListWorktrees(execFn),
  readWorktreeTickets = defaultReadWorktreeTickets,
  readDocsFn = readDocs,
  realpathFn = realpathSync,
} = {}) {
  const numbers = new Set()
  const sources = {}

  // (a) this worktree's own committed + working tickets
  try {
    for (const doc of readDocsFn(root)) {
      const n = ticketNumber(doc.path)
      if (n) numbers.add(n)
    }
    sources.root = 'read'
  } catch {
    sources.root = 'skipped'
  }

  // (d) every OTHER local worktree — the load-bearing source
  let worktrees = []
  let listWorktreesFailed = false
  try {
    worktrees = listWorktrees()
  } catch {
    listWorktreesFailed = true
  }

  const normRoot = safeRealpath(root, realpathFn)
  let siblingsTotal = 0
  let siblingsRead = 0

  for (const wt of worktrees) {
    if (!wt?.path) continue
    const normPath = safeRealpath(wt.path, realpathFn)
    if (normPath === normRoot) continue
    siblingsTotal++
    try {
      for (const t of readWorktreeTickets(wt.path)) {
        const n = ticketNumber(t.path)
        if (n) numbers.add(n)
      }
      siblingsRead++
    } catch {
      // one sibling worktree's read failing (locked, deleted, permission-denied)
      // must not prevent the others from being read
    }
  }

  sources.worktrees = listWorktreesFailed
    ? 'skipped'
    : `read (${siblingsRead} of ${siblingsTotal} siblings)`

  // (b) remote branch names — soft signal
  try {
    const out = execFn('git ls-remote --heads origin')
    for (const n of extractNumbers(out)) numbers.add(n)
    sources.branches = 'read'
  } catch {
    sources.branches = 'skipped'
  }

  // (c) open PR branches/titles — soft signal, tolerate gh being absent/unauthenticated
  try {
    const out = execFn('gh pr list --state open --json headRefName,title')
    const prs = JSON.parse(out)
    for (const pr of prs) {
      for (const n of extractNumbers(`${pr.headRefName} ${pr.title}`)) numbers.add(n)
    }
    sources.prs = 'read'
  } catch {
    sources.prs = 'skipped'
  }

  const highest = numbers.size ? Math.max(...[...numbers].map(Number)) : 0
  return { next: highest + 1, sources }
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { next, sources } = nextTicketNumber({ root: process.cwd() })
  console.log(`Next free ticket number: T${next}`)
  console.log('')
  console.log('Sources:')
  for (const [name, state] of Object.entries(sources)) {
    console.log(`  ${name}: ${state}`)
  }
  console.log('')
  console.log('This number is advisory, not a guarantee — checkTicketNumberUniqueness ' +
    '(npm run verify) is the backstop that catches a collision.')
}
