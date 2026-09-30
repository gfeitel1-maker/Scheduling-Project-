import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listGuardedFiles, checkNoLiteralNul } from './scripts/noLiteralNul.js'

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
// Note the authoring trap this test exists to catch: typing the escape into a
// Bash command, a heredoc, or a Write-tool payload converts it to a raw 0x00
// before it reaches disk, so a hand-edit can silently reintroduce the defect it
// meant to fix.
//
// The scan itself lives in scripts/noLiteralNul.js, which `npm run
// check:governance` also runs as a BLOCKING check — one implementation, so the
// glob and the vacuity floor cannot drift between the two callers.

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))

describe('source files contain no literal NUL bytes', () => {
  it('every tracked .js/.jsx/.mjs/.cjs file is greppable', () => {
    const files = listGuardedFiles(ROOT_DIR)
    expect(files.length).toBeGreaterThan(100)

    const findings = checkNoLiteralNul(ROOT_DIR)
    expect(findings).toEqual([])
  })
})
