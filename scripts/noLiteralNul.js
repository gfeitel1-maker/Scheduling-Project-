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

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const NUL_GUARD_GLOBS = ['*.js', '*.jsx', '*.mjs', '*.cjs']

// Below this, a near-empty result almost certainly means a glob typo, not a
// clean repo — the corpus has always had well over 100 matching files.
export const NUL_GUARD_MIN_FILES = 100

const finding = (code, message) => ({ code, message })

// `execFn` is a raw-shell-command string function — `(cmd) => string` — the
// same shape check-governance.js's other checks take (see
// checkPlatformStateFreshness's `execFn`), so checkAll can pass its own
// injected execFn straight through instead of carrying a second convention.
export function listGuardedFiles(root, execFn = (cmd) => execSync(cmd, { encoding: 'utf8' })) {
  const globs = NUL_GUARD_GLOBS.map((g) => `'${g}'`).join(' ')
  return execFn(`git -C '${root}' ls-files ${globs}`).split('\n').filter(Boolean)
}

/**
 * @param root path `git ls-files` and file reads are resolved against
 * @param execFn  (cmd: string) => string — injected so tests never shell out
 * @param readFn  (absPath) => Buffer-like with `.includes(0)` — injected so tests never touch real FS
 */
export function checkNoLiteralNul(root, {
  execFn,
  readFn = (p) => readFileSync(p),
} = {}) {
  let files
  try {
    files = listGuardedFiles(root, execFn)
  } catch (err) {
    // A failed git call is reported, not swallowed — the same reasoning as
    // checkDocFacts' null-derivation finding: "could not check" must never
    // read as "clean".
    return [finding('literal-nul-scan-failed',
      `could not list tracked ${NUL_GUARD_GLOBS.join(' ')} files to scan for NUL bytes ` +
      `(${err?.message ?? err}) — this is NOT a pass; fix the underlying git failure.`)]
  }

  if (files.length <= NUL_GUARD_MIN_FILES) {
    return [finding('literal-nul-floor',
      `git ls-files ${NUL_GUARD_GLOBS.join(' ')} returned only ${files.length} tracked file(s) — the ` +
      `non-vacuity floor (>${NUL_GUARD_MIN_FILES}) did not clear, which usually means a glob typo, not a clean repo.`)]
  }

  const findings = []
  for (const f of files) {
    if (readFn(join(root, f)).includes(0)) {
      findings.push(finding('literal-nul',
        `${f} contains a literal NUL byte (0x00) — plain grep silently treats this file as binary and ` +
        'returns zero matches for it, which has already driven one wrong conclusion about this repo ' +
        '(2026-09-04, electron/db/localDb.js). Spell the byte as the six-character escape at runtime ' +
        'instead of writing a raw byte to disk (see FIELD_DELIM in electron/automerge/campDocument.js).'))
    }
  }
  return findings
}
