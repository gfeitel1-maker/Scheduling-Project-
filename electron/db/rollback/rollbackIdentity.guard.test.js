// GUARD (T269): every rollback module electron/db/rollback/vN_down.js must BE the
// rollback it names — its exported function name, its CLI self-guard filename
// literal, its documented usage line, and the schema_migrations version it
// targets must all agree with N in its own filename.
//
// This is deliberately a SEPARATE file from bareEqualityRollback.guard.test.js,
// which scans the same directory for a different, narrower claim (the DELETE
// uses `>=`, never bare `=`). That guard's `expect(files.length).toBe(36)` count
// tripwire is NOT duplicated here: "there are N files" and "every file is
// internally consistent" are different claims, and both are wanted. T267 is
// in flight modifying the sibling file's count; this file has zero overlap with
// it by construction.
//
// v67_down.js shipped exporting rollbackV66 (copy-paste from v66_down.js), with
// its CLI self-guard, Usage comment, and usage error string all naming
// v66_down.js. Its DELETE clause was correct (`>= 67`), so only its identity was
// wrong — `node electron/db/rollback/v67_down.js <db>` was a SILENT NO-OP: the
// `endsWith('v66_down.js')` guard is false for that invocation, so the whole
// direct-invocation block never runs, and the process exits 0 having done
// nothing. No existing guard could see this because none of the four checks
// below existed before this ticket. See docs/work/tickets/T269-rollback-module-identity-guard.md.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Exactly these two filenames use the retired `export function down(dbPath)`
// form (opens/closes its own db handle, so it cannot be driven by a test's
// shared handle or chained with a sibling rollback in one transaction — see the
// ticket's "Testability" / "Composability" arguments). Neither has an importer
// or a test file. Exempted by literal filename, not by a tolerant pattern, so a
// NEW module using this form still fails R1 below.
const LEGACY_PATH_FORM = [
  'v62_down.js', // no importers, no tests, down(dbPath) form (T174)
  'v64_down.js', // no importers, no tests, down(dbPath) form
]

/**
 * Pure, fixture-testable identity check. Takes [{name, source}], returns an
 * array of offender strings (empty = all consistent). Exported so the
 * non-vacuity tests below can plant defects without touching real files.
 */
export function checkRollbackIdentity(files) {
  const offenders = []

  for (const { name, source } of files) {
    const nameMatch = name.match(/^v(\d+)_down\.js$/)
    if (!nameMatch) continue
    const N = nameMatch[1]

    // R1 — export identity.
    if (!LEGACY_PATH_FORM.includes(name)) {
      const exportMatch = source.match(/export function rollbackV(\d+)\s*\(/)
      if (!exportMatch) {
        if (/export function down\s*\(/.test(source)) {
          offenders.push(
            `${name}: exports the retired 'down(dbPath)' convention but is not on the LEGACY_PATH_FORM exemption list`
          )
        } else {
          offenders.push(`${name}: no 'export function rollbackV${N}(' entry point found`)
        }
      } else if (exportMatch[1] !== N) {
        offenders.push(`${name}: exports rollbackV${exportMatch[1]}, expected rollbackV${N}`)
      }
    }

    // R2 — CLI self-guard: every endsWith('vM_down.js') literal must have M === N.
    for (const cliMatch of source.matchAll(/endsWith\('v(\d+)_down\.js'\)/g)) {
      if (cliMatch[1] !== N) {
        offenders.push(`${name}: CLI self-guard checks endsWith('v${cliMatch[1]}_down.js'), expected v${N}_down.js`)
      }
    }

    // R3 — targeted version: DELETE FROM schema_migrations WHERE version [>=|=] M must have M === N.
    for (const delMatch of source.matchAll(/DELETE FROM schema_migrations WHERE version\s*(?:>=|=)\s*(\d+)/g)) {
      if (delMatch[1] !== N) {
        offenders.push(`${name}: schema_migrations DELETE targets version ${delMatch[1]}, expected ${N}`)
      }
    }

    // R4 — documented usage. Scoped precisely to lines that document how to
    // invoke THIS file, not prose citing a sibling rollback as precedent (e.g.
    // "Follows the v74_down.js / v71_down.js convention" is legitimate and must
    // NOT be scanned).
    for (const line of source.split('\n')) {
      const isUsageComment = /^\s*\/\/\s*Usage:/.test(line)
      const isUsageString = /usage:\s*node electron\/db\/rollback\//.test(line)
      if (!isUsageComment && !isUsageString) continue
      // Only the FIRST invoked path on the line — the one after
      // `node electron/db/rollback/` — is this file's identity. A usage line may
      // legitimately carry a trailing sibling citation
      // ("... <path>   (same shape as v74_down.js)"), and scanning every match
      // on the line would make that a spurious offender. Narrow by construction
      // rather than relying on nobody ever writing it: a guard with a
      // false-positive rate trains people to ignore it, which is worse than no
      // guard at all.
      const invoked = line.match(/node\s+electron\/db\/rollback\/v(\d+)_down\.js/)
      if (invoked && invoked[1] !== N) {
        offenders.push(`${name}: documented usage names v${invoked[1]}_down.js, expected v${N}_down.js`)
      }
    }
  }

  // R5 — verbatim body duplication. Strips comments and whitespace; if two
  // DIFFERENT files normalize to identical text, both are named. This catches
  // only a verbatim duplicate, not a paraphrased one — a normalized-but-not-
  // identical body is invisible to this check by design (see the ticket's
  // "Stated limits").
  const normalized = files
    .filter((f) => /^v\d+_down\.js$/.test(f.name))
    .map((f) => ({
      name: f.name,
      body: f.source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/\s+/g, ''),
    }))
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (normalized[i].body === normalized[j].body) {
        offenders.push(`${normalized[i].name} and ${normalized[j].name}: verbatim-identical bodies after stripping comments/whitespace`)
      }
    }
  }

  return offenders
}

describe('rollback module identity guard (real files)', () => {
  const files = readdirSync(__dirname)
    .filter((name) => /^v\d+_down\.js$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(__dirname, name), 'utf8') }))

  it('every rollback module\'s export name, CLI self-guard, documented usage, and targeted version agree with its own filename', () => {
    const offenders = checkRollbackIdentity(files)
    expect(offenders, offenders.join('; ')).toEqual([])
  })
})

describe('rollback module identity guard (non-vacuity: planted defects)', () => {
  it('positive control: the real directory, unmodified, produces zero offenders', () => {
    const files = readdirSync(__dirname)
      .filter((name) => /^v\d+_down\.js$/.test(name))
      .map((name) => ({ name, source: readFileSync(join(__dirname, name), 'utf8') }))
    expect(checkRollbackIdentity(files)).toEqual([])
  })

  it('catches a wrong export name (R1)', () => {
    const files = [
      {
        name: 'v98_down.js',
        source: `
export function rollbackV99(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()
}
`,
      },
    ]
    const offenders = checkRollbackIdentity(files)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatch(/v98_down\.js: exports rollbackV99, expected rollbackV98/)
  })

  it('catches a CLI self-guard naming a different file, with a correct export name (R2 — the shape live on main today)', () => {
    const files = [
      {
        name: 'v98_down.js',
        source: `
export function rollbackV98(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()
}

if (process.argv[1] && process.argv[1].endsWith('v97_down.js')) {
  const result = rollbackV98(db)
}
`,
      },
    ]
    const offenders = checkRollbackIdentity(files)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatch(/v98_down\.js: CLI self-guard checks endsWith\('v97_down\.js'\), expected v98_down\.js/)
  })

  it('catches a correct export name whose DELETE targets a different version (R3)', () => {
    const files = [
      {
        name: 'v98_down.js',
        source: `
export function rollbackV98(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 97').run()
}
`,
      },
    ]
    const offenders = checkRollbackIdentity(files)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatch(/v98_down\.js: schema_migrations DELETE targets version 97, expected 98/)
  })

  it('catches a new module using the retired down(dbPath) convention, not on the exemption list (R1 retired-convention branch)', () => {
    const files = [
      {
        name: 'v98_down.js',
        source: `
import Database from 'better-sqlite3'

export function down(dbPath) {
  const db = new Database(dbPath)
  try {
    db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()
  } finally {
    db.close()
  }
}
`,
      },
    ]
    const offenders = checkRollbackIdentity(files)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatch(
      /v98_down\.js: exports the retired 'down\(dbPath\)' convention but is not on the LEGACY_PATH_FORM exemption list/
    )
  })

  it('does not flag a legacy-exempted module using down(dbPath)', () => {
    const files = [
      {
        name: 'v62_down.js',
        source: `
import Database from 'better-sqlite3'

export function down(dbPath) {
  const db = new Database(dbPath)
  try {
    db.prepare('DELETE FROM schema_migrations WHERE version >= 62').run()
  } finally {
    db.close()
  }
}
`,
      },
    ]
    expect(checkRollbackIdentity(files)).toEqual([])
  })

  it('catches a documented Usage line naming a different file, while ignoring a legitimate sibling-precedent citation', () => {
    const files = [
      {
        name: 'v98_down.js',
        source: `
// Follows the v74_down.js / v97_down.js convention: this citation is fine.
//
// Usage:  node electron/db/rollback/v97_down.js <path-to-shoresh.sqlite>
export function rollbackV98(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()
}
`,
      },
    ]
    const offenders = checkRollbackIdentity(files)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toMatch(/v98_down\.js: documented usage names v97_down\.js, expected v98_down\.js/)
  })

  it('does NOT flag a Usage line that carries a trailing sibling citation after the invoked path', () => {
    // False-positive regression (T269 code review). A guard that fires on a
    // legitimate line trains people to ignore it, which is worse than no guard.
    const files = [
      {
        name: 'v98_down.js',
        source: `
// Usage:  node electron/db/rollback/v98_down.js <path>   (same shape as v74_down.js)
export function rollbackV98(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= 98').run()
}
`,
      },
    ]
    expect(checkRollbackIdentity(files)).toEqual([])
  })

  it('catches two verbatim-identical bodies under different, otherwise-correct names (R5)', () => {
    const body = `
export function rollbackV%N%(db) {
  db.prepare('DELETE FROM schema_migrations WHERE version >= %N%').run()
}
`
    const files = [
      { name: 'v98_down.js', source: body.replace(/%N%/g, '98') },
      { name: 'v99_down.js', source: body.replace(/%N%/g, '98') },
    ]
    const offenders = checkRollbackIdentity(files)
    // Each file individually is R1/R3-consistent (v99_down.js's export/DELETE
    // both say 98, so it also fails R1/R3 — that's expected and correct: the
    // fixture plants a copy-paste, which is simultaneously a wrong-identity
    // file AND a verbatim duplicate). Assert the R5 offender specifically.
    expect(offenders.some((o) => /verbatim-identical bodies/.test(o) && o.includes('v98_down.js') && o.includes('v99_down.js'))).toBe(true)
  })
})
