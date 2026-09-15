import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// T168. scripts/integration.sh runs at 06:30 and DELETES worktree directories. Two pure
// predicates make up the prune rule: parsing `git worktree list --porcelain` into rows, and
// deciding PROTECTED/READY/PRUNE/ACTIVE for a row's already-computed facts. Both are exercised
// only against fixtures — no real worktree is touched.

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PARSE = join(ROOT, 'scripts', 'parseWorktreePorcelain.sh')
const DECIDE = join(ROOT, 'scripts', 'worktreeDecision.sh')
const fixture = (n) => join(HERE, 'fixtures', 'porcelain', n)

function parse(fixtureName) {
  const r = spawnSync('/bin/zsh', [PARSE, fixture(fixtureName)], { encoding: 'utf8' })
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
}

function decide(protected_, ahead, ephemeral, dirty, idleDays, idleThreshold) {
  const r = spawnSync(
    '/bin/zsh',
    [DECIDE, String(protected_), String(ahead), String(ephemeral), String(dirty), String(idleDays), String(idleThreshold)],
    { encoding: 'utf8' }
  )
  return r.stdout.trim()
}

describe('worktree porcelain parser (scripts/parseWorktreePorcelain.sh)', () => {
  it('parses a branch worktree into wt/branch/head', () => {
    const rows = parse('mixed.txt')
    expect(rows).toContainEqual(['/Users/x/dev/shoresh', 'refs/heads/main', 'abcdef1234567890'])
  })

  it('parses a detached worktree with the DETACHED marker', () => {
    const rows = parse('mixed.txt')
    expect(rows).toContainEqual(['/Users/x/dev/shoresh/.claude/worktrees/detached-1', 'DETACHED', '3333333333333333'])
  })

  // The task brief named this path class as real; awk's default field split ($2) truncates a
  // path at its first space, which would silently defeat the exact-match ledger protection
  // downstream in integration.sh.
  it('preserves a worktree path containing a space', () => {
    const rows = parse('mixed.txt')
    expect(rows).toContainEqual(['/Users/x/dev/Mobile Prototype/.claude/worktrees/b', 'refs/heads/agent-space', '2222222222222222'])
  })

  it('the buggy $2-split form truncates the same path at the first space', () => {
    const buggy = spawnSync(
      '/bin/zsh',
      [
        '-c',
        `awk '/^worktree /{wt=$2} /^HEAD /{h=$2} /^branch /{print wt"\\t"$2"\\t"h; wt=""}' "$1"`,
        '--',
        fixture('mixed.txt'),
      ],
      { encoding: 'utf8' }
    )
    expect(buggy.stdout).toContain('/Users/x/dev/Mobile\t') // the bug: path cut off at the space
    const fixed = parse('mixed.txt').find((r) => r[1] === 'refs/heads/agent-space')
    expect(fixed[0]).toBe('/Users/x/dev/Mobile Prototype/.claude/worktrees/b') // the fix
  })
})

describe('worktree prune decision (scripts/worktreeDecision.sh)', () => {
  const IDLE = 2

  it('ephemeral + clean + 0-ahead + idle >= threshold -> PRUNE', () => {
    expect(decide(0, 0, 1, 0, 3, IDLE)).toBe('PRUNE')
  })

  // The exact shape of a Claude Desktop pooled worktree — this is the case the ledger exists to
  // stop from being deleted.
  it('a path present in the ledger (protected=1) is never pruned, even when it looks abandoned', () => {
    expect(decide(1, 0, 1, 0, 30, IDLE)).toBe('PROTECTED')
  })

  it('ahead > 0 is always surfaced for a human decision, never auto-pruned', () => {
    expect(decide(0, 3, 1, 0, 30, IDLE)).toBe('READY')
  })

  it('a dirty tree is never pruned', () => {
    expect(decide(0, 0, 1, 1, 30, IDLE)).toBe('ACTIVE-DIRTY')
  })

  it('a non-ephemeral worktree (outside .claude/worktrees/) is never pruned, however idle', () => {
    expect(decide(0, 0, 0, 0, 999, IDLE)).toBe('ACTIVE-IDLE')
  })

  it('ephemeral + clean + 0-ahead but NOT yet idle enough is kept, not pruned', () => {
    expect(decide(0, 0, 1, 0, 1, IDLE)).toBe('ACTIVE-IDLE')
  })

  // Protection wins over every other signal, including "ready to merge" — a superset of safety.
  it('protection beats ahead>0 too', () => {
    expect(decide(1, 5, 0, 0, 0, IDLE)).toBe('PROTECTED')
  })
})
