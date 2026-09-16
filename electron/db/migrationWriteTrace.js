// WHAT A MIGRATION ACTUALLY WROTE, measured by running it.
//
// migrationDomainState.js classifies every migration as domain-state or
// schema-only, and migrationDomainState.test.js checks that classification
// against the source. The source scan has a blind spot it states honestly: it
// reads localDb.js as TEXT, split at each migration's own stamp, so it can only
// see SQL written INLINE in a migration's block. A backfill routed through a
// helper — `backfillLocations(db)`, which is what v32 is — is a call, and the
// UPDATE/INSERT statements it runs live 900 lines away. A future migration that
// genuinely changes what a camp MEANS, written as a helper call rather than as
// inline SQL, would read as schema-only and the guard would say nothing.
//
// A blind spot in a guard is a silent one, so this closes it by changing what is
// measured. Instead of reading the file, run the migration chain against a real
// database with the handle instrumented, and record every statement SQLite was
// actually asked to execute. Indirection cannot hide a statement from this: a
// helper's `db.prepare(...).run()` goes through the same handle the migration
// block used, and the trace sees the string SQLite ran.
//
// WHAT THIS STILL CANNOT SEE, stated for the same reason the text scanner
// stated its own limit:
//   - A statement that is never executed is never traced, so COVERAGE IS ONLY
//     AS GOOD AS THE FIXTURES' DATA. Read that as the sharper claim it is: this
//     does not see everything, it sees everything that RUNS. The worked example
//     is v32 itself. `backfillLocations` returns before preparing a single
//     statement when no activity carries a location, and no era fixture sets
//     one — so the first version of this guard executed none of v32 while
//     reporting green, which is the same defect class one level up: a check
//     that reads clean because it never reached the code. A seeded run was
//     added for exactly that reason. The next backfill will need the same care.
//   - A write reaching SQLite through a handle other than the one passed to
//     `initSchema` (a second `new Database(...)` opened inside a migration) is
//     outside the trace. Nothing does that today.
//   - Which TABLE a statement writes is still read from the statement's text.
//     That is not the blind spot being closed: a statement's text is the
//     statement. What indirection moved was where the text LIVES, and the trace
//     no longer cares.

/**
 * Wrap a better-sqlite3 handle so every executed statement is recorded, in
 * order, with the number of rows it changed.
 *
 * Returns `{ db, trace }`. Pass `db` wherever the real handle would have gone —
 * it forwards everything. `trace` fills as statements run: `{ sql, changes }`.
 *
 * `changes` is evidence, not the flag. A statement that matched no rows still
 * gets traced, because whether a migration is a domain write is a question
 * about what it does, not about whether this particular fixture happened to
 * have a row for it to hit.
 */
export function instrumentDb(realDb) {
  const trace = []
  const totalChanges = () => realDb.prepare('SELECT total_changes() AS n').get().n

  const wrapStatement = (stmt, sql) =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'run' && typeof value === 'function') {
          return (...args) => {
            const info = value.apply(target, args)
            trace.push({ sql, changes: info && typeof info.changes === 'number' ? info.changes : 0 })
            return info
          }
        }
        // Reads are traced too, and one read in particular: every migration
        // block opens with `getSchemaVersion(db) < N`, which is the only place
        // this SELECT is issued. It marks where one block ends and the next
        // begins — see attributeByMigration, which needs that boundary and not
        // just the stamps.
        if (prop === 'get' && typeof value === 'function') {
          return (...args) => {
            const row = value.apply(target, args)
            if (GUARD_READ.test(sql)) trace.push({ sql, changes: 0, guardRead: true })
            return row
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

  return {
    trace,
    db: new Proxy(realDb, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'prepare') {
          return (sql, ...rest) => wrapStatement(value.call(target, sql, ...rest), sql)
        }
        if (prop === 'exec') {
          // A multi-statement script reports no per-statement count, so the
          // whole script is one trace entry and `changes` is measured across it.
          return (sql) => {
            const before = totalChanges()
            const result = value.call(target, sql)
            trace.push({ sql, changes: totalChanges() - before })
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
}

const GUARD_READ = /SELECT MAX\(version\) as version FROM schema_migrations/i

/**
 * Where the guard reads fell relative to each stamp, as `Array<{ version,
 * guardReadsBefore }>`: how many boundaries were observed between the previous
 * stamp and this one. Zero means the block ran without a guard read of its own
 * and was therefore merged into its predecessor's window — a silent
 * mis-attribution, which is why it is asserted rather than assumed.
 */
export function blockBoundaries(trace) {
  const out = []
  let guardReadsBefore = 0
  for (const entry of trace) {
    if (entry.guardRead) {
      guardReadsBefore += 1
      continue
    }
    const stamp = entry.sql.match(STAMP)
    if (!stamp) continue
    out.push({ version: Number(stamp[1]), guardReadsBefore })
    guardReadsBefore = 0
  }
  return out
}

const STAMP = /INSERT OR IGNORE INTO schema_migrations \(version, applied_at\) VALUES \((\d+),/

/**
 * Attribute each traced statement to the migration that ran it.
 *
 * NOT by "the version stamped next". That rule reads plausibly and is wrong in
 * the one direction that matters: a block which stamps its version and THEN
 * writes would have those writes credited to the following migration, and if
 * that one is classified domain-state the real offender is excused silently.
 *
 * Instead the trace is cut at each guard READ — `getSchemaVersion(db)`, whose
 * single SELECT is the boundary. Note what is being keyed on: the read, not the
 * comparison. localDb.js has two guard forms — a bare `< N` (23 blocks) and a
 * paired `>= N-1 && < N` (38 blocks) — and keying on the SQL rather than on the
 * `< N` term makes both, and any third form, open a window the same way.
 *
 * Everything between two guard reads is one block, and the block's version is
 * whichever it stamped — before, after, or in the middle of its own writes. A
 * window that stamps nothing (the first read of a paired guard, or a guard that
 * ran without its block) carries its statements forward into the next window
 * rather than dropping them.
 *
 * The assumption left standing is that every block performs a guard read before
 * its first statement. A block that did not — a guard hoisted into a helper, or
 * cached — would merge into the previous window and be attributed to the wrong
 * version. That is pinned by a test rather than trusted; see
 * `blockBoundaries` below and its use in migrationWriteTrace.test.js.
 *
 * Returns `Map<version, Array<{ sql, changes }>>`.
 */
export function attributeByMigration(trace) {
  const windows = [[]]
  for (const entry of trace) {
    if (entry.guardRead) windows.push([])
    else windows[windows.length - 1].push(entry)
  }

  const byVersion = new Map()
  let carried = []
  for (const window of windows) {
    const stamps = window.filter((e) => STAMP.test(e.sql)).map((e) => Number(e.sql.match(STAMP)[1]))
    const writes = carried.concat(window.filter((e) => !STAMP.test(e.sql)))
    if (stamps.length === 0) {
      carried = writes
      continue
    }
    carried = []
    // A window with more than one stamp is initSchema's opening v1/v2 pair,
    // which has no block of its own; credit the statements to the last.
    const version = stamps[stamps.length - 1]
    byVersion.set(version, (byVersion.get(version) ?? []).concat(writes))
    for (const v of stamps) if (!byVersion.has(v)) byVersion.set(v, [])
  }
  return byVersion
}

/**
 * The statements in `entries` that write rows of one of `tables`.
 *
 * A table RECREATE legitimately INSERTs into its own `_vNN` shadow table and
 * then renames, which is shape work. The trailing `\b` excludes those without
 * needing to name them: `anchor_activities\b` does not match
 * `anchor_activities_v65`, because `_` is a word character and there is no
 * boundary between `s` and `_`. The same boundary excludes `users_new`.
 */
export function domainWritesIn(entries, tables) {
  const found = []
  for (const entry of entries) {
    for (const table of tables) {
      const write = new RegExp(`(UPDATE|INSERT INTO|INSERT OR \\w+ INTO|DELETE FROM)\\s+${table}\\b`, 'i')
      if (write.test(entry.sql)) found.push({ table, sql: entry.sql, changes: entry.changes })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// THE MEASUREMENT THAT DOES NOT READ SQL AT ALL.
//
// Everything above still reasons about statements. That is enough for the
// helper-routed shape it was built for, and not enough in general —
// camp-schedule-ingestion and gracious-thompson found the hole while checking
// v65 against it. A table RECREATE (create shadow, INSERT INTO shadow SELECT
// ... FROM real, DROP real, RENAME) destroys and rebuilds every row without
// SQLite ever being asked to UPDATE or DELETE the modeled table, and the
// statement that carries the data targets the shadow table, which both guards
// deliberately ignore. For a verbatim copy that reading is correct. But if the
// SELECT ever TRANSFORMS an existing column — `SELECT upper(name)`, a
// recomputed field — that is a domain change wearing shape-work clothing, and
// no statement-level guard can see it.
//
// So compare the ROWS. Snapshot every modeled table at each block boundary and
// diff consecutive snapshots: a changed value is a changed value however it was
// spelled, and a row that vanished is gone whether it was DELETEd or dropped
// with its table.
//
// Two things make the diff quiet enough to be useful:
//   - Only columns present in BOTH snapshots are compared, so ALTER TABLE ADD
//     COLUMN — and a recreate that adds one, which is what v65 is — reads as no
//     change. A NEW column cannot alter a value that did not exist.
//   - Rows are keyed by `id`, not by rowid, which a recreate reassigns.

/** `{ table: Map<id, row> }` for every modeled table that exists right now. */
function snapshotModeled(db, tables) {
  const snapshot = new Map()
  for (const table of tables) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
    if (!exists) continue
    const columns = db.pragma(`table_info(${table})`).map((c) => c.name)
    if (!columns.includes('id')) continue
    const rows = new Map()
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) rows.set(row.id, row)
    // Columns are recorded from the SCHEMA, not inferred from a row, so a
    // vanished column is detected on an empty table too. Inferring them from
    // rows would make the finding appear only when a fixture happened to hold
    // data — the same coverage trap that hid v32.
    snapshot.set(table, { columns, rows })
  }
  return snapshot
}

/**
 * Take a snapshot at every block boundary while `run(db)` migrates.
 *
 * Returns `{ trace, snapshots }`, where `snapshots[i]` is the state just before
 * the i-th block ran. Pass both to `diffByMigration`.
 */
export function traceWithSnapshots(realDb, tables, run) {
  const { db, trace } = instrumentDb(realDb)
  const snapshots = []
  const boundaries = []
  const observed = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop === 'prepare') {
        return (sql, ...rest) => {
          const stmt = value.call(target, sql, ...rest)
          if (!GUARD_READ.test(sql)) return stmt
          return new Proxy(stmt, {
            get(s, p) {
              const v = Reflect.get(s, p, s)
              if (p !== 'get' || typeof v !== 'function') {
                return typeof v === 'function' ? v.bind(s) : v
              }
              return (...args) => {
                boundaries.push(trace.length)
                snapshots.push(snapshotModeled(realDb, tables))
                return v.apply(s, args)
              }
            },
          })
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  run(observed)
  boundaries.push(trace.length)
  snapshots.push(snapshotModeled(realDb, tables))
  return { trace, snapshots }
}

/**
 * Row-level changes between consecutive snapshots, attributed to the migration
 * that ran between them.
 *
 * Returns `Map<version, Array<{ table, id, kind, column?, before?, after?,
 * reason? }>>` where `kind` is 'changed' | 'removed' | 'added' | 'unknown'.
 *
 * 'unknown' is a finding, not a pass. It means the rows could not be compared —
 * a table or column present before and absent after — which is a different fact
 * from the rows being unchanged. Treating the two alike is this repository's
 * recurring defect, so they are kept apart here and both are reported.
 */
export function diffByMigration(trace, snapshots) {
  // Same windowing as attributeByMigration: snapshot i precedes window i.
  const versions = []
  let window = []
  for (const entry of trace) {
    if (entry.guardRead) {
      versions.push(window)
      window = []
    } else window.push(entry)
  }
  versions.push(window)

  const stampOf = (entries) => {
    const stamped = entries.filter((e) => STAMP.test(e.sql)).map((e) => Number(e.sql.match(STAMP)[1]))
    return stamped.length ? stamped[stamped.length - 1] : null
  }

  const byVersion = new Map()
  for (let i = 0; i + 1 < snapshots.length; i += 1) {
    const version = stampOf(versions[i + 1] ?? [])
    if (version == null) continue
    const changes = diffSnapshots(snapshots[i], snapshots[i + 1])
    if (changes.length === 0) continue
    byVersion.set(version, (byVersion.get(version) ?? []).concat(changes))
  }
  return byVersion
}

function diffSnapshots(before, after) {
  const changes = []
  for (const [table, beforeState] of before) {
    const afterState = after.get(table)
    const beforeRows = beforeState.rows
    if (!afterState) {
      // The table is gone — dropped, or renamed out from under its rows. Do NOT
      // read that as no-change. The rows cannot be compared, which is a
      // different fact from the rows being unchanged, and reporting it as
      // 'unknown' is the whole difference between a guard and a guard that
      // reads clean because it never looked. Raised by app-icon-audit-a9a598,
      // who found the live instance: v64's ALTER TABLE ... RENAME TO.
      changes.push({ table, kind: 'unknown', reason: 'table absent after this migration' })
      continue
    }
    const afterRows = afterState.rows

    // Column-level, computed once per table rather than per row, so it is
    // reported whether or not this fixture holds data.
    for (const column of beforeState.columns) {
      if (!afterState.columns.includes(column)) {
        changes.push({ table, column, kind: 'unknown', reason: 'column absent after this migration' })
      }
    }
    for (const [id, beforeRow] of beforeRows) {
      const afterRow = afterRows.get(id)
      if (!afterRow) {
        changes.push({ table, id, kind: 'removed' })
        continue
      }
      for (const column of Object.keys(beforeRow)) {
        // A column that existed before and does not now was dropped or renamed.
        // Its values cannot be compared — which is NOT the same as its values
        // being unchanged, and a migration that drops or renames a column while
        // transforming it is precisely the shape that would otherwise pass in
        // silence. There is no instance in the history today; that is why it is
        // pinned as a rule rather than against an example.
        // Reported once per table above, not per row.
        if (!(column in afterRow)) continue
        // A column that did not exist BEFORE is skipped, and that asymmetry is
        // deliberate: a new column cannot have altered a value that did not
        // exist, which is what makes ADD COLUMN — and a recreate that adds one —
        // read as no change.
        if (beforeRow[column] !== afterRow[column]) {
          changes.push({ table, id, kind: 'changed', column, before: beforeRow[column], after: afterRow[column] })
        }
      }
    }
    for (const id of afterRows.keys()) {
      if (!beforeRows.has(id)) changes.push({ table, id, kind: 'added' })
    }
  }
  return changes
}
