import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The bug this file exists for was NOT in selfHealDecision.sh — that predicate correctly
// distinguished "started, no evidence either way" (NONE) from "succeeded" (SUCCESS), and it had
// tests. The bug was one line later, in integration.sh:
//
//     case "$HEALDEC" in
//       SUCCESS|QUIET|NONE)   :   ;;
//
// The caller threw away the distinction the predicate exists to draw, reproducing this program's
// original defect — "started" read as "succeeded" — inside its own fix. The predicate was tested;
// the caller was not. So the reporting DECISION is now its own predicate, and this tests it.
// (Red Hat, 2026-09-15.)

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'healReport.sh')

function report(outcome) {
  const r = spawnSync('/bin/zsh', [SCRIPT, outcome], { encoding: 'utf8' })
  const [severity, ...rest] = r.stdout.trim().split('|')
  return { severity, message: rest.join('|'), status: r.status }
}

describe('what the morning report says about a self-heal outcome', () => {
  it('is silent ONLY for a night that succeeded or was genuinely quiet', () => {
    expect(report('SUCCESS').severity).toBe('silent')
    expect(report('QUIET').severity).toBe('silent')
  })

  // The regression. A night that wrote its run header and then died leaves no proposal and no
  // marker. By 06:30 a 03:00 job that retries 3x over ~60s is not still working — it is dead.
  it('ALERTS on NONE — a run that started and left no evidence either way', () => {
    const { severity, message } = report('NONE')
    expect(severity).toBe('alert')
    expect(message).toMatch(/did not finish|killed/i)
  })

  it('NONE is not silent, which is the exact bucket the bug put it in', () => {
    expect(report('NONE').severity).not.toBe(report('SUCCESS').severity)
  })

  // Nothing else catches a NONE night: the backlog scan globs only NEEDS-AUTH-/FAILED- markers,
  // and a killed run never wrote one. The message has to say so, or a reader will assume the
  // backlog would have caught it.
  it('says why nothing else will report a NONE night', () => {
    expect(report('NONE').message).toMatch(/backlog/i)
  })

  it('alerts on both failure classes, distinguishably', () => {
    expect(report('FAILED-AUTH').severity).toBe('alert')
    expect(report('FAILED-AUTH').message).toMatch(/login/i)
    expect(report('FAILED-MINE').severity).toBe('alert')
    expect(report('FAILED-MINE').message).not.toMatch(/login/i)
  })

  it('routes SELFHEAL to the recovery path rather than to silence or an alert', () => {
    expect(report('SELFHEAL').severity).toBe('heal')
  })

  // An outcome nobody anticipated must fail loud. Defaulting an unknown to silence is how a
  // predicate that grows a sixth return value silently stops being reported at all.
  it('treats an UNRECOGNISED outcome as an alert, never as silence', () => {
    expect(report('SOMETHING_NEW').severity).toBe('alert')
    expect(report('').severity).toBe('alert')
  })

  it('always exits 0 — it classifies, it does not itself fail', () => {
    for (const o of ['SUCCESS', 'NONE', 'FAILED-AUTH', 'SELFHEAL', 'BOGUS']) {
      expect(report(o).status).toBe(0)
    }
  })
})
