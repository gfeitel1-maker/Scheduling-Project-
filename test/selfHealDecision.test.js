import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// T168. scripts/integration.sh runs at 06:30 and self-heals a missed 03:00 nightly memory pass.
// The historical bug: the predicate checked only for a `=== run <day>` header in run.log, but
// run.sh writes that header as its FIRST action, before doing any work — so "started" read as
// "succeeded" and eight consecutive authentication failures (2026-09-06..13) produced no morning
// signal at all. Four outcomes, tested here against fixture _pending dirs and run.logs; no real
// memory directory is touched.

const HERE = dirname(fileURLToPath(import.meta.url))
const DECIDE = join(HERE, '..', 'scripts', 'selfHealDecision.sh')
const DAY = '2026-09-06'
const pend = (n) => join(HERE, 'fixtures', 'selfHeal', n)

function decide(dirName, day = DAY) {
  // Fixture logs are named run.log.txt, not run.log — *.log is gitignored repo-wide and would
  // silently vanish from version control.
  const r = spawnSync('/bin/zsh', [DECIDE, pend(dirName), join(pend(dirName), 'run.log.txt'), day], { encoding: 'utf8' })
  return r.stdout.trim()
}

describe('self-heal four-outcome decision (scripts/selfHealDecision.sh)', () => {
  it('a proposal exists for the day -> SUCCESS, silent', () => {
    expect(decide('pend-success')).toBe('SUCCESS')
  })

  it('run.log says "no signal for <day>" -> QUIET, silent (not a failure)', () => {
    expect(decide('pend-quiet')).toBe('QUIET')
  })

  it('a NEEDS-AUTH- marker exists -> FAILED-AUTH, report, do not re-run', () => {
    expect(decide('pend-failed-auth')).toBe('FAILED-AUTH')
  })

  it('a FAILED- marker exists -> FAILED-MINE, report, do not re-run', () => {
    expect(decide('pend-failed-mine')).toBe('FAILED-MINE')
  })

  it('no "=== run <day> " header at all -> SELFHEAL (never started; safe to run now)', () => {
    expect(decide('pend-empty')).toBe('SELFHEAL')
  })

  // The exact historical defect: the run STARTED (header present) but produced no proposal and
  // no failure marker. The buggy "header present = succeeded" predicate reads this as healthy;
  // the fix correctly does NOT call it SELFHEAL (it already started, re-running is wrong) and
  // does NOT call it SUCCESS either.
  it('started but produced no proposal and no failure marker -> NONE, never SUCCESS or SELFHEAL', () => {
    const result = decide('pend-started-no-marker')
    expect(result).toBe('NONE')
    expect(result).not.toBe('SUCCESS')
    expect(result).not.toBe('SELFHEAL')
  })

  // Proves the historical bug directly: a header-only check treats "started" as "succeeded".
  it('the historical "header present" check alone would misread a started-but-failed night as healthy', () => {
    const buggyHasHeader = spawnSync(
      '/bin/zsh',
      ['-c', `grep -q "=== run $1 " "$2" && print STARTED || print MISSING`, '--', DAY, join(pend('pend-started-no-marker'), 'run.log.txt')],
      { encoding: 'utf8' }
    ).stdout.trim()
    expect(buggyHasHeader).toBe('STARTED') // the bug: header alone reads as "ran fine"
    expect(decide('pend-started-no-marker')).not.toBe('SUCCESS') // the fix: distinguishes started from succeeded
  })
})
