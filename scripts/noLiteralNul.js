// A literal NUL byte (0x00) inside a source file makes plain `grep` treat that
// file as binary and SILENTLY return zero matches — no error, no warning. That
// already produced one wrong conclusion about electron/db/localDb.js on
// 2026-09-04 ("no unique index on operations.client_write_id exists"), which
// drove a migration + test + comment change that had to be fully reverted.
//
// The NUL is load-bearing as a Map/document key delimiter, so the fix is never
// to drop it — it is to spell it as the six-character escape, which produces
// the identical byte at runtime and leaves the file greppable. Every other call
// site in the repo already does this (see FIELD_DELIM in
// electron/automerge/campDocument.js).
//
// Single implementation: no-literal-nul.test.js (repo root) and check:governance
// (via check-governance.js) both call this module rather than each carrying
// their own copy of the glob — two copies is the defect this file exists to
// remove.
//
// Known blind spots — read before trusting a green result here:
// - Only *.js/*.jsx/*.mjs/*.cjs are scanned. *.json/*.md/*.sql/*.sh/*.yml/*.ts
//   are not, and a literal NUL in one of those is invisible to this check.
// - `git ls-files` reads the INDEX, not the working tree — an untracked file
//   is invisible here regardless of its content.
// - The scan reflects whatever is checked out at run time, not a specific
//   commit — it says nothing about history.
// - Round 2 (2026-09-30): the non-vacuity floor below used to be a single
//   aggregate count (`files.length <= 100`) across all four globs summed
//   together. Measured in this repo: *.js alone is 981 files, *.jsx is 180,
//   *.mjs is 18, *.cjs is 0 — so dropping '*.js' from the list (keeping the
//   other three) still cleared that floor at 198, reporting green while blind
//   to ~83% of the corpus. The fix below is three checks, not one:
//     1. total-tracked sanity floor (NUL_GUARD_MIN_TOTAL_TRACKED_FILES): the
//        bare `git ls-files` (no pathspec) must itself look like a real repo.
//        This is a repurposing of the old floor, not a survival of it — it no
//        longer judges the JS-family count, only whether the scan is running
//        against something real at all (wrong root, broken git, a test double
//        that isn't really simulating ls-files). The OLD semantics (floor on
//        the JS-family sum) is gone: it is what let '*.js' drop unnoticed, and
//        the ratio check below does that job correctly now.
//     2. per-pathspec: a glob NOT marked allowEmpty that resolves to 0 files
//        is reported by name. This catches a mistyped or emptied pathspec
//        THAT IS STILL IN THE ARRAY, but not one removed from it outright —
//        there is nothing left to iterate once an entry is gone.
//     3. coverage ratio: scanned-files ÷ all-tracked-files must clear
//        NUL_GUARD_MIN_COVERAGE_RATIO. This is what catches an entry being
//        removed from NUL_GUARD_GLOBS entirely, but only when the removed
//        glob's share of the tree is large enough to move the ratio —
//        measured today, dropping '*.js' or '*.jsx' trips it; dropping
//        '*.mjs' or '*.cjs' (together under 1% of the tracked tree) would
//        not, and neither check would catch that removal. Widening this
//        further would mean asserting the exact pathspec SET somewhere
//        independent of NUL_GUARD_GLOBS, which is the second-copy-of-the-list
//        defect this file exists to avoid — so that residual gap is accepted,
//        not solved.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Single source for BOTH what gets scanned and what "non-vacuous" means for
// it — one object per pathspec, read by both listGuardedFiles and the
// per-pathspec check below. `allowEmpty` distinguishes a glob that is
// legitimately zero in this repo today (*.cjs — no CommonJS file exists yet)
// from one a future edit drops or mistypes, which must NOT read as clean.
export const NUL_GUARD_GLOBS = [
  { pattern: '*.js', allowEmpty: false },
  { pattern: '*.jsx', allowEmpty: false },
  { pattern: '*.mjs', allowEmpty: false },
  { pattern: '*.cjs', allowEmpty: true },
]

// A dropped-or-mistyped pathspec that still leaves a JS-heavy tree behind
// (e.g. losing the small *.mjs share while *.js/*.jsx stay wired) does not
// move this ratio far enough to trip it — see the header's "still can't see"
// note. It catches the case this repo has actually measured: dropping *.js
// (the largest glob by far) collapses coverage from ~52% to under 10%.
export const NUL_GUARD_MIN_COVERAGE_RATIO = 0.2

// Repurposed from the old aggregate floor: this is no longer "are there
// enough JS-family files" (the ratio above answers that, correctly, as a
// share rather than a raw count) — it is "does the bare `git ls-files` call
// even look like it ran against a real repo". A bare `git -C <root> ls-files`
// returning near-nothing means execFn/root is broken (wrong path, a `git`
// that errored without throwing, a test double that isn't really simulating
// `ls-files`), which the ratio check cannot tell apart from a tiny-but-real
// repo since both numerator and denominator would be equally tiny.
export const NUL_GUARD_MIN_TOTAL_TRACKED_FILES = 100

const finding = (code, message) => ({ code, message })

const defaultExecFn = (cmd) => execSync(cmd, { encoding: 'utf8' })

const runGit = (root, pathspec, execFn) => {
  const cmd = pathspec
    ? `git -C '${root}' ls-files '${pathspec}'`
    : `git -C '${root}' ls-files`
  return execFn(cmd).split('\n').filter(Boolean)
}

// `execFn` is a raw-shell-command string function — `(cmd) => string` — the
// same shape check-governance.js's other checks take (see
// checkPlatformStateFreshness's `execFn`), so checkAll can pass its own
// injected execFn straight through instead of carrying a second convention.
//
// Each pathspec is its own `git ls-files` call (rather than one call with all
// four globs) precisely so a single dropped or mistyped one is individually
// visible — see checkNoLiteralNul's per-pathspec check below.
export function listGuardedFiles(root, execFn = defaultExecFn) {
  return NUL_GUARD_GLOBS.flatMap((g) => runGit(root, g.pattern, execFn))
}

/**
 * @param root path `git ls-files` and file reads are resolved against
 * @param execFn  (cmd: string) => string — injected so tests never shell out
 * @param readFn  (absPath) => Buffer-like with `.includes(0)` — injected so tests never touch real FS
 */
export function checkNoLiteralNul(root, {
  execFn = defaultExecFn,
  readFn = (p) => readFileSync(p),
} = {}) {
  let perGlob
  let totalTrackedCount
  try {
    perGlob = NUL_GUARD_GLOBS.map((g) => ({ ...g, files: runGit(root, g.pattern, execFn) }))
    totalTrackedCount = runGit(root, null, execFn).length
  } catch (err) {
    // A failed git call is reported, not swallowed — the same reasoning as
    // checkDocFacts' null-derivation finding: "could not check" must never
    // read as "clean".
    return [finding('literal-nul-scan-failed',
      `could not list tracked ${NUL_GUARD_GLOBS.map((g) => g.pattern).join(' ')} files to scan for NUL bytes ` +
      `(${err?.message ?? err}) — this is NOT a pass; fix the underlying git failure.`)]
  }

  const findings = []

  // Sanity floor on the DENOMINATOR, not the JS-family count: if the bare
  // `git ls-files` call itself returns an implausibly small repo, the ratio
  // check below cannot be trusted (see NUL_GUARD_MIN_TOTAL_TRACKED_FILES).
  if (totalTrackedCount < NUL_GUARD_MIN_TOTAL_TRACKED_FILES) {
    return [finding('literal-nul-floor',
      `git ls-files returned only ${totalTrackedCount} tracked file(s) total — below the ` +
      `non-vacuity floor (>${NUL_GUARD_MIN_TOTAL_TRACKED_FILES}), which usually means the scan did not ` +
      'run against a real repo (wrong root, or a broken git call), not a clean one.')]
  }

  // Per-pathspec non-vacuity: a glob that is NOT marked allowEmpty but
  // resolves to zero tracked files has been dropped or mistyped, not
  // "cleanly empty". This is blind to an entry being removed from
  // NUL_GUARD_GLOBS entirely (there is then nothing left to iterate and
  // check) — that failure mode is what the coverage-ratio floor below is for.
  for (const g of perGlob) {
    if (g.files.length === 0 && !g.allowEmpty) {
      findings.push(finding('literal-nul-pathspec-empty',
        `git ls-files '${g.pattern}' returned 0 tracked files — this pathspec is expected to match real ` +
        'files in this repo, so 0 usually means it was dropped or mistyped in NUL_GUARD_GLOBS rather than ' +
        'the extension genuinely disappearing. (*.cjs is the one glob in this list allowed to be 0 today.)'))
    }
  }

  // Coverage floor: the scanned globs' share of ALL tracked files, not an
  // absolute count. This is what catches a pathspec being removed from
  // NUL_GUARD_GLOBS outright (per-pathspec above cannot, since there is
  // nothing left in the array to check) — removing a glob with a large
  // enough share of the tree (measured here: *.js, *.jsx) collapses the
  // ratio; see the module header for the share this does NOT catch.
  const scannedCount = perGlob.reduce((sum, g) => sum + g.files.length, 0)
  const ratio = totalTrackedCount > 0 ? scannedCount / totalTrackedCount : 0
  if (ratio < NUL_GUARD_MIN_COVERAGE_RATIO) {
    findings.push(finding('literal-nul-coverage-floor',
      `the configured NUL-guard globs (${NUL_GUARD_GLOBS.map((g) => g.pattern).join(' ')}) matched only ` +
      `${scannedCount} of ${totalTrackedCount} tracked files (${(ratio * 100).toFixed(1)}%) — below the ` +
      `${(NUL_GUARD_MIN_COVERAGE_RATIO * 100).toFixed(0)}% floor, which usually means a pathspec was dropped ` +
      'or mistyped in NUL_GUARD_GLOBS rather than the repo\'s JS-family share actually shrinking this much.'))
  }

  // A vacuity/coverage problem means the file list itself is not trustworthy
  // (e.g. `git ls-files` returning something that is not really a file list
  // at all) — same early-return reasoning the old single aggregate floor
  // used, now just after two checks instead of one.
  if (findings.length > 0) return findings

  for (const g of perGlob) {
    for (const f of g.files) {
      if (readFn(join(root, f)).includes(0)) {
        findings.push(finding('literal-nul',
          `${f} contains a literal NUL byte (0x00) — plain grep silently treats this file as binary and ` +
          'returns zero matches for it, which has already driven one wrong conclusion about this repo ' +
          '(2026-09-04, electron/db/localDb.js). Spell the byte as the six-character escape at runtime ' +
          'instead of writing a raw byte to disk (see FIELD_DELIM in electron/automerge/campDocument.js).'))
      }
    }
  }
  return findings
}
