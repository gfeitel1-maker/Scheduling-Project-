// GUARD (T220): every rollback in electron/db/rollback/ must delete
// `schema_migrations` rows with `WHERE version >= N`, never `WHERE version = N`.
//
// A bare equality strands any HIGHER version row: rolling back vN on a db that has
// since migrated to vN+1 leaves getSchemaVersion() reporting N+1 while vN's tables
// are gone — a shape no migration path can produce and none will repair. This
// exact defect shipped in 20 rollback files (v24 through v68) under a green suite
// because the paired test (e.g. v68_down.test.js:46, asserting
// `WHERE version = 68` is 0 after rollback) is TRUE regardless of whether the
// production code says `=` or `>=` — it tests an adjacent fact, not this one. See
// docs/work/tickets/T216-gate-semantics-write-up.md for that class of finding, and
// docs/work/tickets/T220-<slug>.md for this ticket.
//
// Scoped to non-test files: *_down.test.js files legitimately assert
// `WHERE version = N` (checking the row for N specifically is gone), which is a
// different, correct claim — see v68_down.test.js:46 and the equivalent in
// v66_down.test.js. Scanning only `*_down.js` (not `*.test.js`) avoids that
// false positive by construction.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('rollback bare-equality schema_migrations guard', () => {
  const files = readdirSync(__dirname)
    .filter((name) => /^v\d+_down\.js$/.test(name))
    .map((name) => join(__dirname, name))

  it('found a non-empty, expected-size set of rollback files to scan', () => {
    // Guards against a disarmed-quiet guard: if the glob broke and matched
    // nothing, the shape assertion below would vacuously pass every file (of
    // which there are zero). Assert the count explicitly so a future rollback
    // file changes this number and forces a look, rather than silently
    // enlarging or shrinking what's covered.
    expect(files.length).toBe(33)
  })

  it('every rollback file uses `>= N`, never bare `= N`, to delete its schema_migrations row', () => {
    const offenders = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const match = src.match(/DELETE FROM schema_migrations WHERE version\s*(=|>=)\s*(\d+)/)
      if (!match) {
        offenders.push(`${file.slice(__dirname.length + 1)}: no schema_migrations DELETE found`)
        continue
      }
      if (match[1] !== '>=') {
        offenders.push(`${file.slice(__dirname.length + 1)}: uses '${match[1]} ${match[2]}', must be '>= ${match[2]}'`)
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([])
  })
})
