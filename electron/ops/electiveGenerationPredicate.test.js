// electiveGenerationPredicate.js's own unit tests (T244, docs/adr/2026-09-23-
// elective-run-lifecycle-and-remaining-slices.md decision (a)/MEDIUM-4).
//
// Real in-memory sqlite, not the full app db template — this module is pure
// SQL-fragment text plus the NULL-comparison semantics that make it correct,
// and a tiny fixture table is enough to prove both.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  electiveGenerationVisibleFragment,
  electiveGenerationStaleSolverFragment,
} from './electiveGenerationPredicate.js'

function fixtureDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE elective_assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      source TEXT,
      solver_generation TEXT
    )
  `)
  return db
}

describe('electiveGenerationVisibleFragment', () => {
  it('is source=manual OR solver_generation matching the given generation', () => {
    const db = fixtureDb()
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a1', 'r1', 'solver', 'gen-1')
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a2', 'r1', 'solver', 'gen-2')
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a3', 'r1', 'manual', 'gen-2')

    const rows = db
      .prepare(`SELECT id FROM elective_assignments a WHERE ${electiveGenerationVisibleFragment()} ORDER BY id`)
      .all({ gen: 'gen-1' })

    // a1 matches current generation; a3 is manual so it is exempt regardless
    // of its own marker; a2 (stale solver row) is excluded.
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a3'])
  })

  // The NULL-generation regression: commitElectiveRun never writes
  // solver_generation, so today it is NULL on every row this app has ever
  // written. `= NULL` is never true in SQL — a bare equality predicate would
  // hide every one of those rows. `IS` gives NULL-matches-NULL correctly.
  it('matches NULL solver_generation against a NULL current generation (real-world default state)', () => {
    const db = fixtureDb()
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a1', 'r1', 'solver', null)

    const rows = db
      .prepare(`SELECT id FROM elective_assignments a WHERE ${electiveGenerationVisibleFragment()}`)
      .all({ gen: null })

    expect(rows.map((r) => r.id)).toEqual(['a1'])
  })

  it('supports a table alias parameter for a joined query', () => {
    const db = fixtureDb()
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a1', 'r1', 'solver', 'gen-1')
    const rows = db
      .prepare(
        `SELECT a.id FROM elective_assignments a WHERE ${electiveGenerationVisibleFragment('a')}`
      )
      .all({ gen: 'gen-1' })
    expect(rows.map((r) => r.id)).toEqual(['a1'])
  })
})

describe('electiveGenerationStaleSolverFragment', () => {
  it('is the inverse of the visible fragment, restricted to source=solver rows', () => {
    const db = fixtureDb()
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a1', 'r1', 'solver', 'gen-1') // current, visible
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a2', 'r1', 'solver', 'gen-2') // stale solver
    db.prepare('INSERT INTO elective_assignments VALUES (?,?,?,?)').run('a3', 'r1', 'manual', 'gen-2') // manual, never stale

    const rows = db
      .prepare(`SELECT id FROM elective_assignments a WHERE ${electiveGenerationStaleSolverFragment()}`)
      .all({ gen: 'gen-1' })

    expect(rows.map((r) => r.id)).toEqual(['a2'])
  })
})
