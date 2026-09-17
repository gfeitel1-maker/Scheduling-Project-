// @vitest-environment node
//
// T189 — whole-database parity of every declared non-table schema object between
// a fresh database's FIRST open and its second.
//
// Why this guard is whole-database rather than per-table. Twelve of the 33
// existing *.migration.test.js files that assert fresh-vs-migrated equivalence do
// check indexes, but each only for the tables it was written about — eleven via a
//   SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
// helper, and exclusionTables.migration.test.js:71 by asserting .toContain() for
// two known names. Both shapes are an opt-in a new table must be enrolled in by
// hand. Nobody enrolled schedule_snapshots, so idx_schedule_snapshots_template_id
// went missing on every fresh database's first open for the life of migrations
// v53 and v59 and no guard noticed (docs/adr/2026-09-16-index-survival-across-table-rebuilds.md).
//
// The mechanism is general, not specific to that index: initSchema() execs
// schema.sql (which holds the CREATE INDEX statements) BEFORE the migration
// blocks run, and a migration that rebuilds a table via
//   DROP TABLE x; ALTER TABLE x_vNN RENAME TO x;
// drops that table's indexes along with it. schema.sql has already run for that
// open, so the index does not come back until the NEXT open. Any future
// rebuild-style migration reintroduces the defect the same way, which is why
// this asserts the whole object set and not one name.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { openLocalDb, initSchema, SCHEDULE_SNAPSHOTS_TEMPLATE_ID_INDEX_DDL } from './localDb.js'
import { rollbackV53 } from './rollback/v53_down.js'
import { rollbackV59 } from './rollback/v59_down.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

// Every separately-declared schema object EXCEPT tables: indexes today, and
// triggers or views if any are ever added. The exclusion is deliberate on both
// sides.
//   - Tables are excluded because the 33 sibling migration tests already compare
//     table DDL text and PRAGMA table_info; duplicating that here would make
//     this guard churn on every ordinary column change.
//   - sqlite_* names are excluded because those are the implicit indexes SQLite
//     generates from a PRIMARY KEY / UNIQUE clause. They are regenerated from
//     the CREATE TABLE statement whenever a table is rebuilt, so they cannot go
//     missing the way a separately-declared object can, and their underlying
//     constraint is already covered by the sibling tests' DDL comparison.
// Widened from indexes-only after a Red Hat review pointed out that a trigger
// dropped by a rebuild would have the identical mechanism and be invisible here.
const declaredObjects = (db) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type != 'table' AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all()

describe('index parity: a fresh database\'s first open vs its second', () => {
  it('has the identical declared-object set on open #1 and open #2', () => {
    const file = tmpFile('index-parity')

    let db = openLocalDb(file)
    const first = declaredObjects(db)
    db.close()

    db = openLocalDb(file)
    const second = declaredObjects(db)
    db.close()

    // Compared by name first: the failure message then names the missing index
    // rather than printing two large DDL arrays.
    expect(first.map((i) => i.name)).toEqual(second.map((i) => i.name))
    expect(first).toEqual(second)

    // Non-vacuity: two empty arrays are also equal. If the sqlite_master query
    // ever stops matching (a renamed column, a changed type string), the
    // assertions above would pass on [] vs [] and this guard would quietly
    // stop guarding. A real database has dozens of declared indexes.
    expect(first.length).toBeGreaterThan(20)
    expect(first.map((i) => i.name)).toContain('idx_schedule_snapshots_template_id')
  })

  it('keeps the migration-side index DDL byte-identical to schema.sql', () => {
    // Both-places DDL, same discipline as LOCATIONS_DDL / SOURCE_ALIASES_DDL:
    // the constant the v53/v59 blocks interpolate must be the same text
    // schema.sql declares, or a fresh database and a migrated one end up with
    // differently-defined indexes of the same name.
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    expect(schemaSql).toContain(SCHEDULE_SNAPSHOTS_TEMPLATE_ID_INDEX_DDL)
  })

  it('serves the schedule_snapshots template_id lookup from an index on the FIRST open', () => {
    // The concrete regression T189 was opened for. A table scan here is a
    // performance defect, not a correctness one, so it is asserted through the
    // query plan — the only place the difference is observable.
    const db = openLocalDb(tmpFile('index-parity-snapshots'))
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM schedule_snapshots WHERE template_id = ?')
      .all('any-template')
      .map((r) => r.detail)
      .join(' ')
    db.close()

    expect(plan).toContain('idx_schedule_snapshots_template_id')
  })

  // The fresh-database path above is the one that regressed, but the path a
  // real camp's data takes is the upgrade. Each rebuild migration is exercised
  // on its own, in a single open, so a future edit that removes one of the two
  // re-creations is caught by the matching case rather than by neither.
  describe.each([
    ['v53', rollbackV53],
    ['v59', rollbackV59],
  ])('migration %s rebuilds schedule_snapshots', (version, rollback) => {
    it('leaves idx_schedule_snapshots_template_id in place in the SAME open', () => {
      const db = new Database(tmpFile(`index-parity-${version}`))
      db.pragma('foreign_keys = ON')
      initSchema(db) // fully migrate forward
      rollback(db) // back to the shape this migration runs against

      initSchema(db) // run the rebuild migration forward again, one open

      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM schedule_snapshots WHERE template_id = ?')
        .all('any-template')
        .map((r) => r.detail)
        .join(' ')
      // Whole-set, not just the one index this ticket was about: a later edit
      // to these blocks that drops a DIFFERENT object would otherwise pass.
      // The reference is a settled database — a fresh file reopened, which is
      // the shape schema.sql alone produces.
      const upgraded = declaredObjects(db)
      db.close()

      const referenceFile = tmpFile(`index-parity-${version}-reference`)
      openLocalDb(referenceFile).close() // open #1 builds it
      const settled = openLocalDb(referenceFile) // open #2 is the settled shape
      const reference = declaredObjects(settled)
      settled.close()

      expect(plan).toContain('idx_schedule_snapshots_template_id')
      expect(upgraded.map((o) => `${o.type} ${o.name}`)).toEqual(
        reference.map((o) => `${o.type} ${o.name}`)
      )
      expect(upgraded).toEqual(reference)
    })
  })
})
