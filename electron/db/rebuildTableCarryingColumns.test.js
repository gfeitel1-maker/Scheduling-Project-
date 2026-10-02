// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { rebuildTableCarryingColumns } from './rebuildTableCarryingColumns.js'

const dbs = []
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close()
    } catch {
      // already closed
    }
  }
})

function makeDb() {
  const db = new Database(':memory:')
  dbs.push(db)
  return db
}

describe('rebuildTableCarryingColumns', () => {
  it('carries a later-added column AND its data forward while relaxing UNIQUE to a plain index', () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE t (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        extra TEXT,
        UNIQUE(name)
      );
    `)
    db.prepare("INSERT INTO t (id, name, extra) VALUES ('r1', 'A', 'kept')").run()

    db.transaction(() => {
      rebuildTableCarryingColumns(db, {
        table: 't',
        baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT NOT NULL'],
        tableConstraints: [],
        postIndexSql: ['CREATE INDEX IF NOT EXISTS idx_t_name ON t(name)'],
      })
    })()

    const row = db.prepare('SELECT * FROM t WHERE id = ?').get('r1')
    expect(row.extra).toBe('kept')
    // UNIQUE relaxed to a plain index: a duplicate name now inserts without error.
    expect(() =>
      db.prepare("INSERT INTO t (id, name, extra) VALUES ('r2', 'A', 'dup')").run()
    ).not.toThrow()
  })

  it('places carried (extra) columns AFTER base columns, in live cid order', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, later_a TEXT, later_b TEXT);')

    db.transaction(() => {
      rebuildTableCarryingColumns(db, {
        table: 't',
        baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
        tableConstraints: [],
        postIndexSql: [],
      })
    })()

    expect(db.pragma('table_info(t)').map((c) => c.name)).toEqual([
      'id',
      'name',
      'later_a',
      'later_b',
    ])
  })

  it('reconstructs a carried column type / NOT NULL / DEFAULT so its shape survives', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, flag INTEGER NOT NULL DEFAULT 0);')
    db.prepare("INSERT INTO t (id, name) VALUES ('r1', 'A')").run()

    db.transaction(() => {
      rebuildTableCarryingColumns(db, {
        table: 't',
        baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
        tableConstraints: [],
        postIndexSql: [],
      })
    })()

    const info = db.pragma('table_info(t)').find((c) => c.name === 'flag')
    expect(info.type).toBe('INTEGER')
    expect(info.notnull).toBe(1)
    expect(info.dflt_value).toBe('0')
    expect(db.prepare('SELECT flag FROM t WHERE id = ?').get('r1').flag).toBe(0)
  })

  it('excludes a generated/virtual column from the rebuild (table_xinfo hidden) without error', () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE t (
        id TEXT PRIMARY KEY,
        name TEXT,
        gen TEXT GENERATED ALWAYS AS (name || '!') VIRTUAL
      );
    `)
    db.prepare("INSERT INTO t (id, name) VALUES ('r1', 'A')").run()

    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
          tableConstraints: [],
          postIndexSql: [],
        })
      })()
    ).not.toThrow()

    expect(db.pragma('table_info(t)').map((c) => c.name)).toEqual(['id', 'name'])
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get('r1').name).toBe('A')
  })

  it('PLANTED DEFECT: throws when the rebuilt table is missing a live column (stale carry / assembly bug)', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, keepme TEXT);')
    db.prepare("INSERT INTO t (id, name, keepme) VALUES ('r1', 'A', 'v')").run()

    // Plant the exact failure the guard exists to catch: the rebuilt table is
    // assembled WITHOUT a live column. If the guard did not re-read the actual
    // rebuilt table, this corruption would reach DROP TABLE and lose the column.
    const realExec = db.exec.bind(db)
    db.exec = (sql) => {
      if (/CREATE TABLE "t__rebuild"/.test(sql)) {
        sql = sql.replace(/,\s*"keepme"[^,\n]*/, '')
      }
      return realExec(sql)
    }

    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
          tableConstraints: [],
          postIndexSql: [],
        })
      })()
    ).toThrow(/would drop column\(s\): keepme/)

    // The transaction rolled back: the original table and its data are intact.
    expect(db.prepare('SELECT keepme FROM t WHERE id = ?').get('r1').keepme).toBe('v')
  })

  it('PLANTED DEFECT: throws when a carried column is reconstructed with the wrong shape (a name-only guard could not see this)', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, flag INTEGER NOT NULL DEFAULT 0);')
    db.prepare("INSERT INTO t (id, name) VALUES ('r1', 'A')").run()

    // Plant a reconstruction bug the NAME check cannot catch: the carried `flag` column keeps its
    // name but loses its type, NOT NULL and DEFAULT. Only the attribute comparison sees it.
    const realExec = db.exec.bind(db)
    db.exec = (sql) => {
      if (/CREATE TABLE "t__rebuild"/.test(sql)) {
        sql = sql.replace(/"flag"[^,\n]*/, '"flag" TEXT')
      }
      return realExec(sql)
    }

    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
          tableConstraints: [],
          postIndexSql: [],
        })
      })()
    ).toThrow(/changed column shape: flag/)

    // The transaction rolled back: the original column shape and data are intact.
    const info = db.pragma('table_info(t)').find((c) => c.name === 'flag')
    expect(info.type).toBe('INTEGER')
    expect(info.notnull).toBe(1)
    expect(db.prepare('SELECT flag FROM t WHERE id = ?').get('r1').flag).toBe(0)
  })

  it('accepts a column recreated with DEFAULT NULL when the source had no default (the mapPair/v50 shape)', () => {
    const db = makeDb()
    // Source `opt` has NO default — table_info reports dflt_value null.
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, opt INTEGER);')
    db.prepare("INSERT INTO t (id, name, opt) VALUES ('r1', 'A', 7)").run()

    // Rebuilt `opt` is declared DEFAULT NULL — table_info reports the literal 'NULL'. Semantically
    // identical to no default, so the guard must NOT flag it as a shape change.
    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT', 'opt INTEGER DEFAULT NULL'],
          tableConstraints: [],
          postIndexSql: [],
        })
      })()
    ).not.toThrow()

    expect(db.prepare('SELECT opt FROM t WHERE id = ?').get('r1').opt).toBe(7)
  })

  it('still rejects a genuine default change (no-default source rebuilt DEFAULT 0)', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, cnt INTEGER);')
    db.prepare("INSERT INTO t (id, name) VALUES ('r1', 'A')").run()

    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT', 'cnt INTEGER DEFAULT 0'],
          tableConstraints: [],
          postIndexSql: [],
        })
      })()
    ).toThrow(/changed column shape: cnt/)
  })

  it('exclude: drops a named live column while carrying forward a different later-added column and its data', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, kind TEXT, later TEXT);')
    db.prepare("INSERT INTO t (id, name, kind, later) VALUES ('r1', 'A', 'fixed', 'kept')").run()

    db.transaction(() => {
      rebuildTableCarryingColumns(db, {
        table: 't',
        baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
        tableConstraints: [],
        postIndexSql: [],
        exclude: ['kind'],
      })
    })()

    const cols = db.pragma('table_info(t)').map((c) => c.name)
    expect(cols).not.toContain('kind')
    expect(cols).toContain('later')
    expect(db.prepare('SELECT later FROM t WHERE id = ?').get('r1').later).toBe('kept')
  })

  it('exclude does not disable the shape guard for a genuine drop of a non-excluded column', () => {
    const db = makeDb()
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT, kind TEXT, keepme TEXT);')
    db.prepare("INSERT INTO t (id, name, kind, keepme) VALUES ('r1', 'A', 'fixed', 'v')").run()

    // Plant the exact failure the guard exists to catch: the rebuilt table is assembled WITHOUT a
    // live, non-excluded column. `exclude: ['kind']` is present, proving it does not blind the
    // guard to a drop of a DIFFERENT column it was never told to drop.
    const realExec = db.exec.bind(db)
    db.exec = (sql) => {
      if (/CREATE TABLE "t__rebuild"/.test(sql)) {
        sql = sql.replace(/,\s*"keepme"[^,\n]*/, '')
      }
      return realExec(sql)
    }

    expect(() =>
      db.transaction(() => {
        rebuildTableCarryingColumns(db, {
          table: 't',
          baseColumns: ['id TEXT PRIMARY KEY', 'name TEXT'],
          tableConstraints: [],
          postIndexSql: [],
          exclude: ['kind'],
        })
      })()
    ).toThrow(/would drop column\(s\): keepme/)

    expect(db.prepare('SELECT keepme FROM t WHERE id = ?').get('r1').keepme).toBe('v')
  })
})
