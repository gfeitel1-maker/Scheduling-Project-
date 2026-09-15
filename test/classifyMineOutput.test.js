import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// T168. scripts/consolidation/run.sh runs unattended at 03:00 and writes memory proposals. The
// failure classifier decides SUCCESS / AUTH-FAIL (halt, don't retry) / RETRY (transient, retry)
// for each mining attempt. The finding this test exists for: an unanchored, whole-body grep for
// "Failed to authenticate" discarded a valid 13,088-byte proposal because the proposal itself
// *described* the auth failure it scanned for. The fix anchors the non-retryable match to the
// FIRST LINE, and only after the success check has already run.

const HERE = dirname(fileURLToPath(import.meta.url))
const CLASSIFY = join(HERE, '..', 'scripts', 'consolidation', 'classifyMineOutput.sh')
const fixture = (n) => join(HERE, 'fixtures', 'mineOutput', n)

function classify(rc, fixtureName) {
  const r = spawnSync('/bin/zsh', [CLASSIFY, String(rc), fixture(fixtureName)], { encoding: 'utf8' })
  return { rc: r.status, out: r.stdout.trim() }
}

describe('run.sh mine-output classifier (scripts/consolidation/classifyMineOutput.sh)', () => {
  it('a clean, large, rc=0 proposal classifies as SUCCESS', () => {
    expect(classify(0, 'success-clean.md')).toEqual({ rc: 0, out: 'SUCCESS' })
  })

  // The exact historical defect: a valid proposal whose BODY mentions the auth-failure phrase
  // (because the day's sessions discussed one) must NOT be misclassified as a failure.
  it('a successful proposal whose body merely mentions "Failed to authenticate" is SUCCESS, not AUTH-FAIL', () => {
    expect(classify(0, 'success-mentions-auth.md')).toEqual({ rc: 0, out: 'SUCCESS' })
  })

  it('output whose FIRST LINE is the auth-failure marker classifies as AUTH-FAIL and halts (does not retry)', () => {
    expect(classify(1, 'auth-fail.md')).toEqual({ rc: 2, out: 'AUTH-FAIL' })
  })

  it.each([
    ['API Error: 500', 'transient-500.md'],
    ['Connection closed mid-response', 'transient-connection.md'],
    ['Execution error', 'transient-execution.md'],
    ['API Error: Overloaded', 'transient-overloaded.md'],
    ['a timeout', 'transient-timeout.md'],
    ['a short/incomplete body', 'short-output.md'],
  ])('%s classifies as RETRY, never AUTH-FAIL or SUCCESS', (_label, fixtureName) => {
    expect(classify(1, fixtureName)).toEqual({ rc: 1, out: 'RETRY' })
  })

  // Proves the anchoring/ordering property directly: an unanchored, whole-file grep for the
  // auth phrase (the historical bug) WOULD misclassify the body-mention fixture as a failure.
  it('the unanchored whole-file grep (the historical bug) would wrongly flag the body-mention fixture', () => {
    const buggy = spawnSync(
      '/bin/zsh',
      ['-c', `grep -qaiE '(Failed to authenticate|Invalid API key|Credit balance)' "$1" && print MATCHED || print CLEAN`, '--', fixture('success-mentions-auth.md')],
      { encoding: 'utf8' }
    )
    expect(buggy.stdout.trim()).toBe('MATCHED') // the bug: whole-file grep sees the mid-document phrase
    expect(classify(0, 'success-mentions-auth.md').out).toBe('SUCCESS') // the fix: anchored classifier does not
  })
})
