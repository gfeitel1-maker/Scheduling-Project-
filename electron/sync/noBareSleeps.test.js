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

// T70: sleepBecauseTimeIsUnderTest() exempts a sleep from the bare-setTimeout
// guard above by its NAME alone — the guard above never checks that time is
// genuinely under test at that call site, only that the literal text
// `setTimeout(` is absent. That gap let a real arrival-wait
// (syncClient.test.js:1659, waiting for a full_sync row to land) hide behind
// the marker and fail under load exactly like the bare sleeps T25 set out to
// eliminate.
//
// The fix: every `sleepBecauseTimeIsUnderTest(` call site must carry a
// machine-checkable `// time-under-test: <reason>` tag (same line or the
// line above), where <reason> is one of a closed vocabulary:
//   - elapsed-assertion: the call's own duration is asserted via
//     `expect(<...elapsed...>).toBeLessThan/toBeGreaterThan(...)` somewhere
//     in the enclosing it() block. Enforced mechanically below.
//   - crossing-interval: the sleep exists to cross a known interval (e.g. a
//     throttle window) so a subsequent action is genuinely re-tried rather
//     than silently absorbed by it.
//   - proving-absence: the sleep exists to give a window for something to
//     happen and then assert it did NOT.
// The other two reasons are accepted on the tag's word alone — there's no
// mechanical way to verify "this sleep crosses a real interval" from text —
// but the closed vocabulary means a genuine arrival-wait can no longer pass
// silently: landing one requires an author to consciously write a false
// `crossing-interval`/`proving-absence` tag, not just add a sleep with no
// justification at all, which is what let T70's bug through.
//
// ANTI-VACUITY: same reasoning as findBareSleeps above — the fixture tests
// assert the matcher itself, independent of any real file, so a change that
// breaks detection (e.g. a reformatted call site) fails loudly here instead
// of the guard quietly waving everything through.

const VALID_TIME_UNDER_TEST_REASONS = ['elapsed-assertion', 'crossing-interval', 'proving-absence']
const TIME_UNDER_TEST_TAG_RE = /\/\/\s*time-under-test:\s*(\S+)/
const ELAPSED_ASSERTION_RE = /expect\(\s*\w*elapsed\w*\s*\)\.(toBeLessThan|toBeGreaterThan)\(/i

// Finds every `sleepBecauseTimeIsUnderTest(` call site and the reason tagged
// for it, if any. The tag is looked for on the call's own line and then
// walking upward through the contiguous `//`-comment block directly above it
// (real usages sometimes wrap the justification across several comment
// lines), stopping at the first non-comment line.
function findMarkerSites(source) {
  const lines = source.split('\n')
  const sites = []
  lines.forEach((line, i) => {
    const commentIndex = line.indexOf('//')
    const code = commentIndex === -1 ? line : line.slice(0, commentIndex)
    if (!code.includes('sleepBecauseTimeIsUnderTest(')) return

    let tag = line.match(TIME_UNDER_TEST_TAG_RE)
    for (let j = i - 1; !tag && j >= 0 && /^\s*\/\//.test(lines[j]); j--) {
      tag = lines[j].match(TIME_UNDER_TEST_TAG_RE)
    }
    sites.push({ line: i + 1, text: line.trim(), reason: tag ? tag[1] : null })
  })
  return sites
}

// Naive brace-counting scan for the it()/it.each() block enclosing a given
// 0-indexed line — good enough for this codebase's style, same tradeoff as
// findBareSleeps' comment-stripping: under-detection (missing the block) is
// preferable to a false failure from a misparsed one, and would surface as
// this test's own fixtures failing, not a silent pass. That holds only at
// this polarity, where the caller (findUnjustifiedMarkers) rejects when the
// assertion is NOT found — flipping the caller to "accept if not found"
// would make the same misparse dangerous, since a missing block would then
// silently pass a genuine violation instead of failing loudly.
function findEnclosingItBlock(lines, callLineIndex) {
  let start = -1
  for (let i = callLineIndex; i >= 0; i--) {
    if (/^\s*it(\.\w+)?\(/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return null

  let depth = 0
  let opened = false
  let end = lines.length - 1
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') {
        depth--
      }
    }
    if (opened && depth <= 0) {
      end = i
      break
    }
  }
  return lines.slice(start, end + 1).join('\n')
}

// Returns one entry per marker call site that fails the guard: untagged, an
// invalid reason, or `elapsed-assertion` with no elapsed-time assertion
// actually present in its enclosing it() block.
function findUnjustifiedMarkers(source) {
  const lines = source.split('\n')
  const violations = []

  for (const site of findMarkerSites(source)) {
    if (!site.reason) {
      violations.push({ ...site, problem: 'no `// time-under-test: <reason>` tag' })
      continue
    }
    if (!VALID_TIME_UNDER_TEST_REASONS.includes(site.reason)) {
      violations.push({ ...site, problem: `invalid reason "${site.reason}" (must be one of ${VALID_TIME_UNDER_TEST_REASONS.join(', ')})` })
      continue
    }
    if (site.reason === 'elapsed-assertion') {
      const block = findEnclosingItBlock(lines, site.line - 1)
      if (!block || !ELAPSED_ASSERTION_RE.test(block)) {
        violations.push({ ...site, problem: 'tagged elapsed-assertion but no elapsed-time assertion found in the enclosing it() block' })
      }
    }
  }

  return violations
}

describe('findUnjustifiedMarkers matcher (fixtures, independent of real files)', () => {
  it('flags a sleepBecauseTimeIsUnderTest call with no tag at all', () => {
    const violations = findUnjustifiedMarkers('it("x", async () => {\n  await sleepBecauseTimeIsUnderTest(50)\n})\n')
    expect(violations).toHaveLength(1)
    expect(violations[0].problem).toMatch(/no `\/\/ time-under-test/)
  })

  it('accepts each valid reason on the line above', () => {
    for (const reason of ['crossing-interval', 'proving-absence']) {
      const source = `it("x", async () => {\n  // time-under-test: ${reason}\n  await sleepBecauseTimeIsUnderTest(50)\n})\n`
      expect(findUnjustifiedMarkers(source)).toHaveLength(0)
    }
  })

  it('accepts a valid reason on the same line as the call', () => {
    const source = 'it("x", async () => {\n  await sleepBecauseTimeIsUnderTest(50) // time-under-test: proving-absence\n})\n'
    expect(findUnjustifiedMarkers(source)).toHaveLength(0)
  })

  it('rejects an invalid reason string', () => {
    const source = 'it("x", async () => {\n  // time-under-test: because-i-said-so\n  await sleepBecauseTimeIsUnderTest(50)\n})\n'
    const violations = findUnjustifiedMarkers(source)
    expect(violations).toHaveLength(1)
    expect(violations[0].problem).toMatch(/invalid reason/)
  })

  it('rejects elapsed-assertion with no elapsed-time assertion in the enclosing it() block', () => {
    const source =
      'it("x", async () => {\n' +
      '  // time-under-test: elapsed-assertion\n' +
      '  await sleepBecauseTimeIsUnderTest(50)\n' +
      '  expect(result.status).toBe("queued")\n' +
      '})\n'
    const violations = findUnjustifiedMarkers(source)
    expect(violations).toHaveLength(1)
    expect(violations[0].problem).toMatch(/no elapsed-time assertion/)
  })

  it('accepts elapsed-assertion when the block asserts on a variable matching /elapsed/i', () => {
    const source =
      'it("x", async () => {\n' +
      '  const start = Date.now()\n' +
      '  // time-under-test: elapsed-assertion\n' +
      '  await sleepBecauseTimeIsUnderTest(50)\n' +
      '  const elapsedMs = Date.now() - start\n' +
      '  expect(elapsedMs).toBeGreaterThan(40)\n' +
      '})\n'
    expect(findUnjustifiedMarkers(source)).toHaveLength(0)
  })

  it('does not flag a file with no sleepBecauseTimeIsUnderTest calls at all', () => {
    expect(findUnjustifiedMarkers('it("x", async () => {\n  expect(1).toBe(1)\n})\n')).toHaveLength(0)
  })
})

describe('every sleepBecauseTimeIsUnderTest site in electron/sync/*.test.js is justified', () => {
  const files = fs
    .readdirSync(SYNC_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== 'noBareSleeps.test.js')

  // Floor: the it.each loop below only asserts "no violations" per file — if
  // findMarkerSites' substring match on `sleepBecauseTimeIsUnderTest(` broke,
  // or the helper were renamed, every file would yield zero sites and zero
  // violations, and this whole guard would pass silently on nothing rather
  // than on genuinely-justified call sites. Same reasoning as the pre-existing
  // "found the expected sync test files" floor above, applied to the marker
  // scan instead of the file scan: 6 real sites exist today.
  it('found real sleepBecauseTimeIsUnderTest call sites (floor against a silently-empty matcher)', () => {
    const totalSites = files.reduce((sum, file) => {
      const source = fs.readFileSync(path.join(SYNC_DIR, file), 'utf8')
      return sum + findMarkerSites(source).length
    }, 0)
    expect(totalSites).toBeGreaterThan(0)
  })

  it.each(files)('%s has no unjustified sleepBecauseTimeIsUnderTest call', (file) => {
    const source = fs.readFileSync(path.join(SYNC_DIR, file), 'utf8')
    const violations = findUnjustifiedMarkers(source)

    if (violations.length > 0) {
      const where = violations.map((v) => `  line ${v.line}: ${v.problem}\n    ${v.text}`).join('\n')
      throw new Error(
        `${file}: ${violations.length} sleepBecauseTimeIsUnderTest call(s) without a valid justification tag.\n` +
        `Tag every call site with // time-under-test: <elapsed-assertion|crossing-interval|proving-absence>:\n${where}`
      )
    }
  })
})
