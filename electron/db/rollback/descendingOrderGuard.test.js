// @vitest-environment node
//
// board q-rollback-descending-order-landmine: the developer-only down CLIs
// (vN_down.js) delete `schema_migrations WHERE version >= N`. Run out of
// descending order — e.g. v51_down on a database already migrated to v87 — that
// rewinds the version marker below the live schema, leaving marker and schema
// inconsistent. assertHighestApplied (the footer guard) refuses that; a genuine
// descending chain, or an explicit override, is allowed.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb, CURRENT_SCHEMA_VERSION } from '../localDb.js'
import { assertHighestApplied } from './assertHighestApplied.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
  }
})
function freshDbFile() {
  const file = path.join(os.tmpdir(), `shoresh-rollbackguard-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
function highestApplied(db) {
  return db.prepare('SELECT MAX(version) AS max FROM schema_migrations').get().max
}

describe('assertHighestApplied — the unit guard', () => {
  it('allows rolling back the HIGHEST applied version (in-order)', () => {
    const db = openLocalDb(freshDbFile())
    const highest = highestApplied(db)
    expect(highest).toBe(CURRENT_SCHEMA_VERSION)
    expect(() => assertHighestApplied(db, highest)).not.toThrow()
    db.close()
  })

  it('REFUSES a lower, out-of-descending-order version (the landmine)', () => {
    const db = openLocalDb(freshDbFile())
    // 51 is far below the highest applied — exactly the v51-on-a-v87-db case.
    expect(() => assertHighestApplied(db, 51)).toThrow(/refused/)
    // Message names both the attempted and the actual highest version.
    expect(() => assertHighestApplied(db, 51)).toThrow(new RegExp(`v${CURRENT_SCHEMA_VERSION}`))
    db.close()
  })

  it('allows an out-of-order version when the explicit override is set', () => {
    const db = openLocalDb(freshDbFile())
    expect(() => assertHighestApplied(db, 51, { env: { SHORESH_ROLLBACK_ALLOW_OUT_OF_ORDER: '1' } })).not.toThrow()
    db.close()
  })

  it('refuses when schema_migrations is empty — nothing to roll back', () => {
    const db = openLocalDb(freshDbFile())
    db.prepare('DELETE FROM schema_migrations').run()
    expect(() => assertHighestApplied(db, CURRENT_SCHEMA_VERSION)).toThrow(/nothing to roll back/)
    db.close()
  })

  it('gives a clear message (not an opaque SQLite error) on a db with no schema_migrations table', () => {
    const db = openLocalDb(freshDbFile())
    db.exec('DROP TABLE schema_migrations')
    expect(() => assertHighestApplied(db, 51)).toThrow(/no schema_migrations table/)
    db.close()
  })
})

describe('down CLI — an out-of-order invocation is refused end-to-end', () => {
  function runDownCli(version, file, extraEnv = {}) {
    try {
      const stdout = execFileSync('node', [`electron/db/rollback/v${version}_down.js`, file], {
        cwd: process.cwd(),
        env: { ...process.env, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout, stderr: '' }
    } catch (err) {
      return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
  }

  it('`node v51_down.js <db-at-v87>` exits non-zero and does NOT rewind schema_migrations', () => {
    const file = freshDbFile()
    const db = openLocalDb(file)
    const before = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version >= 51').get().c
    expect(before).toBeGreaterThan(0)
    db.close()

    const res = runDownCli(51, file)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toMatch(/refused/)

    // The refusal actually PREVENTED the rewind — the marker is untouched.
    const db2 = openLocalDb(file)
    expect(db2.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version >= 51').get().c).toBe(before)
    expect(highestApplied(db2)).toBe(CURRENT_SCHEMA_VERSION)
    db2.close()
  })

  it('the override lets the same invocation through (proving the guard is what blocked it)', () => {
    const file = freshDbFile()
    const db = openLocalDb(file)
    db.close()

    const res = runDownCli(51, file, { SHORESH_ROLLBACK_ALLOW_OUT_OF_ORDER: '1' })
    expect(res.status).toBe(0)
    // With the override, rollbackV51 ran: its `DELETE ... WHERE version >= 51` rewound the marker.
    const db2 = openLocalDb(file)
    // openLocalDb re-applies forward migrations on open, so just assert the CLI itself succeeded;
    // the non-override case above is the load-bearing refusal proof.
    db2.close()
  })
})

// CHOKE-POINT GUARD (mirrors bareEqualityRollback.guard.test.js, T220): the fix is
// only durable if a FUTURE vN_down.js cannot silently skip the guard. Wiring 46
// footers by hand is exactly the "forgot the thing in N files" class that shipped
// under a green suite before. This scan makes the invariant — every operable down
// CLI calls assertHighestApplied(db, N) — a property of the directory, not of
// whoever remembers.
describe('descending-order guard coverage — every operable down CLI is wired', () => {
  const files = fs.readdirSync(__dirname).filter((name) => /^v\d+_down\.js$/.test(name))
  // A module is "operable as a CLI" iff it has the `process.argv[1].endsWith('vN_down.js')`
  // footer; that footer is where the landmine (and so the guard) lives.
  const hasCliFooter = (name, src) => src.includes(`.endsWith('${name}')`)

  it('found a non-empty set of rollback modules to scan', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('every down module WITH a CLI footer imports and calls assertHighestApplied(db, N)', () => {
    const offenders = []
    for (const name of files) {
      const n = Number(name.match(/^v(\d+)_down\.js$/)[1])
      const src = fs.readFileSync(path.join(__dirname, name), 'utf8')
      if (!hasCliFooter(name, src)) continue // footer-less modules are exempt (pinned below)
      if (!/import \{ assertHighestApplied \} from '\.\/assertHighestApplied\.js'/.test(src)) {
        offenders.push(`${name}: missing the assertHighestApplied import`)
      }
      if (!new RegExp(`assertHighestApplied\\(db,\\s*${n}\\)`).test(src)) {
        offenders.push(`${name}: missing or wrong-version assertHighestApplied(db, ${n}) call in its CLI footer`)
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([])
  })

  it('pins the EXEMPT set — only the footer-less down(dbPath) modules may lack the guard', () => {
    // If a future module drops its CLI footer (or a new footer-less one lands), this
    // forces a deliberate look rather than silently widening the exemption.
    const exempt = files.filter((name) => !hasCliFooter(name, fs.readFileSync(path.join(__dirname, name), 'utf8')))
    expect(exempt.sort()).toEqual(['v62_down.js', 'v64_down.js'])
  })
})
