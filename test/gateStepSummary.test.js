// @vitest-environment node
//
// T171 item 3 — the gate's SUMMARY column, tested.
//
// scripts/gate.sh extracts a one-line summary per step with a pattern tuned to
// today's vitest/eslint output. When a tool changes its format the pattern stops
// matching, and the old inline version wrote
//   STEP lint | rc=0 |
// a blank column that reads exactly like a clean run with nothing to report.
//
// That is the defect class this whole program exists to remove, in its quietest
// form yet: not a wrong answer, an ABSENT one wearing the clothes of a good one.
// The fix is to give absence a name, so a reader can tell "nothing to report"
// from "I could not read the report" — the same three-valued honesty as
// gateResultCode.sh's `2 = cannot tell`.
//
// These tests exist because the previous two members of this family (the gate's
// exit code, the spec count) each shipped broken through green runs for the same
// reason: nothing executed them.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/gateStepSummary.sh')

function summarise(stepOutput) {
  return execFileSync('/bin/zsh', [SCRIPT], { input: stepOutput, encoding: 'utf8' }).trim()
}

describe('a recognised summary is extracted as before', () => {
  it('pulls the vitest test line', () => {
    expect(summarise('noise\n   Tests  5679 passed | 1 skipped (5680)\nmore noise'))
      .toBe('Tests 5679 passed | 1 skipped (5680)')
  })

  it('pulls an eslint problem count', () => {
    expect(summarise('✖ 3 problems (3 errors, 0 warnings)')).toMatch(/✖ 3 problems/)
  })

  it('pulls a governance no-findings line', () => {
    expect(summarise('check:governance\nno findings')).toBe('no findings')
  })

  it('takes the LAST match, matching the original behaviour', () => {
    // Chunked vitest runs print several; the final one is the run's own total.
    expect(summarise('Tests  1 passed (1)\nTests  9 passed (9)')).toBe('Tests 9 passed (9)')
  })
})

describe('the marker earned itself on its first real run', () => {
  it('summarises agents:check, whose column was blank in every gate run before T171', () => {
    // Found by running the new marker against a real gate: `agents-check` came back
    // UNMATCHED. Its output had NEVER matched the pattern, so that column had been
    // silently blank in every recorded gate run, indistinguishable from "clean".
    // Nobody spotted it for the whole life of the script, because absence looked
    // like success — which is the entire thesis of this program, found once more in
    // the tool built to detect it.
    expect(summarise('match verifier.md\n\nAll generated profiles are byte-identical to the committed .claude/agents/*.md files.'))
      .toMatch(/byte-identical/)
  })

  it('still summarises the security gate, which did already match', () => {
    expect(summarise('✅ security-gate: 0 findings (deps + secrets + dangerous patterns)'))
      .toMatch(/0 findings/)
  })
})

describe('an unsummarisable step says so instead of going blank', () => {
  it('names the case where the format changed out from under the pattern', () => {
    // The actual T171 scenario: the step ran and said plenty, none of it in a
    // shape the pattern knows. Blank here would read as a quiet clean run.
    expect(summarise('RESULTS: 5679 specs OK in 412s')).toBe('UNMATCHED')
  })

  it('names an empty step output rather than printing a blank', () => {
    expect(summarise('')).toBe('UNMATCHED')
  })

  it('names whitespace-only output — a blank is not a summary', () => {
    expect(summarise('   \n\t\n  ')).toBe('UNMATCHED')
  })
})

describe('the column is loud, never fatal', () => {
  it('exits 0 even when it cannot summarise, so rc stays authoritative', () => {
    // A cosmetic format drift must not fail a gate whose steps all passed.
    // Nothing in the DONE/dirty/binding logic reads this column; the exit code
    // of the step itself is the verdict. Loud, not fatal.
    const rc = (() => {
      try { execFileSync('/bin/zsh', [SCRIPT], { input: 'unparseable', stdio: 'pipe' }); return 0 }
      catch (err) { return err.status }
    })()
    expect(rc).toBe(0)
  })
})
