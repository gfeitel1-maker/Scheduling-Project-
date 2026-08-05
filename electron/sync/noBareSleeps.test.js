// @vitest-environment node
//
// Guards the bug class T44 found twice: a bare `setTimeout`-as-sleep in a
// test standing in for "wait until the async thing actually happened" —
// looks harmless on an idle machine, and becomes a flake under real load
// because the fixed duration was a guess, not a measurement. T25 converted
// the arrival-then-assert sites in this file by INSPECTION and missed six of
// them; T44 found those six the same way, by inspection, a second time. This
// test makes the enumeration mechanical so a third pass is unnecessary.
//
// The repo's established opt-out is `sleepBecauseTimeIsUnderTest()`
// (test/helpers/waitFor.js) for the genuine case — proving a timeout fires,
// or that nothing arrives within a window — where elapsed time itself is the
// thing under test. That helper's name is itself the marker: it never
// contains the literal text `setTimeout(` at its call site, so a scanner
// that simply looks for raw `setTimeout(` in test source already leaves it
// alone without needing a second, separate comment convention.
//
// Scope: electron/sync/*.test.js only, not repo-wide. Two reasons: (1) this
// is where T44's pattern actually recurred and where the fix pattern
// (f81013f) was established, so a scoped guard directly protects the thing
// that broke twice; (2) a repo-wide sweep turned up bare sleeps in
// electron/sync/syncServer.test.js, bulkReplace.sync.test.js, and
// restore.sync.test.js that predate this ticket and are out of its scope to
// fix — a repo-wide zero-tolerance rule would fail immediately on files this
// ticket never touched. Those three are grandfathered below at their
// CURRENT count (never allowed to grow) so the guard still stops new bare
// sleeps from landing anywhere in this directory, without silently
// re-authorizing existing ones as "fine" or requiring an unrelated cleanup
// to land this ticket.
//
// ANTI-VACUITY: a text scanner's only failure mode that matters is silently
// matching nothing (a reformatted call site, a renamed helper, a broken
// glob) while staying green. The fixture tests below assert the matcher
// itself, independent of any real file, so a change that breaks detection
// fails loudly here rather than by the guard just going quiet.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A bare sleep is `setTimeout(` appearing outside a `//` comment. Comments
// are stripped naively (substring before the first `//`) — good enough for
// this codebase's style and, per the anti-vacuity note above, an
// under-detection risk (a real call hidden after an unrelated `//` inside a
// string) is preferable to over-detection false-failing the suite.
function findBareSleeps(source) {
  const hits = []
  source.split('\n').forEach((line, i) => {
    const commentIndex = line.indexOf('//')
    const code = commentIndex === -1 ? line : line.slice(0, commentIndex)
    if (code.includes('setTimeout(')) hits.push({ line: i + 1, text: line.trim() })
  })
  return hits
}

// Pre-existing bare sleeps outside this ticket's scope, frozen at their
// current count. Lower this number (or delete the entry) as files are
// cleaned up — never raise it to make a new violation pass.
const GRANDFATHERED_MAX = {
  'bulkReplace.sync.test.js': 7,
  'restore.sync.test.js': 6,
  'syncServer.test.js': 20,
}

const SYNC_DIR = __dirname

describe('findBareSleeps matcher (fixtures, independent of real files)', () => {
  it('flags a raw setTimeout-as-sleep', () => {
    const hits = findBareSleeps("  await new Promise((r) => setTimeout(r, 50))\n")
    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(1)
  })

  it('does not flag sleepBecauseTimeIsUnderTest, the established opt-out', () => {
    const hits = findBareSleeps('  await sleepBecauseTimeIsUnderTest(50)\n')
    expect(hits).toHaveLength(0)
  })

  it('does not flag setTimeout mentioned only in a comment', () => {
    const hits = findBareSleeps(
      "  // T44: this was `await new Promise((r) => setTimeout(r, 150))` — a fixed sleep\n"
    )
    expect(hits).toHaveLength(0)
  })

  it('flags a trailing-comment line only for the code before the comment', () => {
    const hits = findBareSleeps('  await new Promise((r) => setTimeout(r, 50)) // flaky, TODO fix\n')
    expect(hits).toHaveLength(1)
  })

  it('counts multiple hits across multiple lines', () => {
    const hits = findBareSleeps(
      'await new Promise((r) => setTimeout(r, 10))\nawait sleepBecauseTimeIsUnderTest(10)\nawait new Promise((r) => setTimeout(r, 20))\n'
    )
    expect(hits).toHaveLength(2)
  })
})

describe('no new bare setTimeout sleeps in electron/sync/*.test.js', () => {
  const files = fs
    .readdirSync(SYNC_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== 'noBareSleeps.test.js')

  // Floor: catches the glob/readdir silently finding nothing (wrong cwd,
  // directory renamed) rather than the guard quietly passing on zero files.
  it('found the expected sync test files (floor against a silently-empty scan)', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
    expect(files).toContain('syncClient.test.js')
  })

  it.each(files)('%s has no more bare setTimeout sleeps than its grandfathered baseline', (file) => {
    const source = fs.readFileSync(path.join(SYNC_DIR, file), 'utf8')
    const hits = findBareSleeps(source)
    const max = GRANDFATHERED_MAX[file] ?? 0

    if (hits.length > max) {
      const where = hits.map((h) => `  line ${h.line}: ${h.text}`).join('\n')
      throw new Error(
        `${file}: ${hits.length} bare setTimeout sleep(s) found, ${max} allowed (grandfathered).\n` +
        `Use waitFor() for arrival-then-assert, or sleepBecauseTimeIsUnderTest() when elapsed ` +
        `time is genuinely under test:\n${where}`
      )
    }
  })
})
