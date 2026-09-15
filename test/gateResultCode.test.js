// @vitest-environment node
//
// THE GATE'S OWN VERDICT, TESTED — the coverage T171 said was owed (item 2).
//
// scripts/gateResultCode.sh decides whether a gate run passed. Every downstream
// claim — the GateReport chain, a Grader score, "13/13 green" in a handoff —
// rests on that one exit code, and until now nothing executed it. The gate never
// ran itself, which is exactly how it shipped a version whose last line was
//   grep -c ... >/dev/null 2>&1 && exit 0 || exit 0
// exiting 0 on BOTH branches, reporting success no matter what the results file
// said, through a 13/13 green run.
//
// Writing this test found the same defect twice more in different clothes: a
// MISSING results file and an EMPTY one both exited 0. Absence read as success —
// "started" taken for "succeeded" — which is the one thing this program exists to
// remove, still sitting in the tool built to detect it.
//
// So the contract is three-valued, and these are the cases that keep it that way.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/gateResultCode.sh')

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-rc-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// Runs the real script and returns its exit code. Never throws on non-zero —
// the exit code IS the thing under test.
function run(argOrNull) {
  try {
    execFileSync('/bin/zsh', [SCRIPT, ...(argOrNull === null ? [] : [argOrNull])], { stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status
  }
}

function resultsFile(name, contents) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, contents)
  return p
}

describe('gateResultCode.sh — passed, failed, and cannot tell', () => {
  it('exits 0 when every step passed', () => {
    expect(run(resultsFile('pass.txt', 'STEP lint rc=0\nSTEP test rc=0\nDONE\n'))).toBe(0)
  })

  it('exits 1 when any step failed', () => {
    expect(run(resultsFile('fail.txt', 'STEP lint rc=0\nSTEP test rc=1\nDONE\n'))).toBe(1)
  })

  it('THE HISTORICAL DEFECT: a failing step can never read as a pass', () => {
    // The regression that shipped through a green run. Kept as its own case,
    // named, so a future "simplification" of the exit logic has to break a test
    // that says what it is protecting.
    expect(run(resultsFile('regression.txt', 'STEP test rc=1\nDONE\n'))).not.toBe(0)
  })

  it('catches a multi-digit failure code (rc=127), not just rc=1..9', () => {
    // A command-not-found is rc=127; an OOM kill is 137. Matching only a single
    // digit would call both of those a pass.
    expect(run(resultsFile('rc127.txt', 'STEP security rc=127\nDONE\n'))).toBe(1)
    expect(run(resultsFile('rc137.txt', 'STEP test rc=137\nDONE\n'))).toBe(1)
  })

  it('a MISSING results file is inconclusive (2), never a pass', () => {
    // Measured 2026-09-15: this returned 0. `grep -q` on a nonexistent path
    // returns 2, the `if` read false, and "I could not find the results" became
    // "everything passed".
    expect(run(path.join(dir, 'nope.txt'))).toBe(2)
  })

  it('an EMPTY results file is inconclusive (2), never a pass', () => {
    // Measured 2026-09-15: this returned 0 too. No STEP lines means no FAILING
    // step lines, so a gate that died before writing anything reported success.
    expect(run(resultsFile('empty.txt', ''))).toBe(2)
  })

  it('a results file with output but no STEP lines is inconclusive, never a pass', () => {
    // The realistic shape of the above: the runner crashed partway and left
    // whatever it had already printed.
    expect(run(resultsFile('noisy.txt', 'starting gate\nnpm error ENOENT\n'))).toBe(2)
  })

  it('no argument at all is inconclusive, never a pass', () => {
    expect(run(null)).toBe(2)
  })

  it('distinguishes FAILED from CANNOT TELL, because a human responds differently', () => {
    // A failed gate means read the failures. An inconclusive one means the gate
    // itself is broken. Collapsing them to "non-zero" would lose the difference
    // at the exact moment it matters.
    const failed = run(resultsFile('f.txt', 'STEP test rc=1\nDONE\n'))
    const inconclusive = run(path.join(dir, 'absent.txt'))
    expect(failed).toBe(1)
    expect(inconclusive).toBe(2)
    expect(failed).not.toBe(inconclusive)
  })
})
