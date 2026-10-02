// Rebuild one table from its LIVE column set, carrying forward any later-added
// column AND its data, so a table-rebuild migration (or its inverse) can change
// a table-level constraint WITHOUT silently dropping columns a newer migration
// added after the rebuild's authors enumerated them.
//
// Context: localDb.js's v73 block and rollback/v73_down.js rebuild nine tables
// to relax / restore a name-UNIQUE constraint. Both enumerated an explicit
// column list, which froze at the shapes those tables had when the block was
// written. A later ALTER (e.g. v75's activities.catalog_role) added a column
// that neither list carried, so re-firing the rebuild dropped that column's
// data silently. See docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md.
//
// Contract: the helper runs INSIDE the caller's already-open transaction. The
// caller owns the FK pragma (toggled OFF before BEGIN, ON in a finally) and the
// transaction itself. This helper must NOT touch PRAGMA foreign_keys.
//
// Carried columns keep their type, NOT NULL and constant DEFAULT, but NOT a
// column-level CHECK/FOREIGN KEY/COLLATE or a non-constant DEFAULT — none of the
// nine rebuilt tables carry such a column today. A future constrained column on
// one of them must be promoted into `baseColumns` (or this helper upgraded).
// The backstop below verifies every live column SURVIVES and keeps its
// table_info-visible shape (type / NOT NULL / DEFAULT); column-level
// CHECK/FOREIGN KEY/COLLATE are invisible to table_info and remain the documented
// residual blind spot — not that a carried column's survival is in doubt.
//
// Optional `exclude`: names of live columns to DROP on purpose (e.g. a column
// whose table-level CHECK is the whole reason a rebuild is needed, as in
// rollback/v51_down.js dropping fixed_events.kind). An excluded column is
// removed from the live-column view BEFORE the shape guard runs, so its
// absence from the rebuilt table reads as the intended drop it is — not a
// stale-carry bug. Every OTHER live column, including one added by a later
// migration, is still carried and still guarded exactly as before. Omitted or
// empty, behavior is unchanged.
export function rebuildTableCarryingColumns(db, { table, baseColumns, tableConstraints, postIndexSql, exclude }) {
  const excludeSet = new Set(exclude ?? [])
  const liveInfoAll = db.pragma(`table_info(${table})`) // ordered by cid
  // `exclude` names an EXPECTED drop (e.g. a column whose CHECK forces a rebuild in the first
  // place) — remove it from every live-column view up front so the rest of this function, and its
  // own shape guard, see exactly the column set that is actually supposed to survive.
  const liveInfo = liveInfoAll.filter((c) => !excludeSet.has(c.name))
  const liveNames = liveInfo.map((c) => c.name)

  // Generated/virtual columns (table_xinfo.hidden !== 0) are excluded from the
  // copy: they are not storable via INSERT and are re-derived by their own
  // expression, which the rebuilt table does not restate.
  const hidden = new Set(
    db
      .pragma(`table_xinfo(${table})`)
      .filter((c) => c.hidden !== 0)
      .map((c) => c.name)
  )

  // Name of each base column = first token of its def. UNIQUE(...) and other
  // table-level constraints live in `tableConstraints`, never in `baseColumns`.
  const baseNames = baseColumns.map((d) => d.match(/^\s*"?(\w+)"?/)[1])

  // Later-added columns: live, non-base, non-generated, in live cid order (which
  // is the ALTER-append / migration order, reproducing fresh-install column
  // order — the column-order-trap parity the migration tests pin).
  const extras = liveInfo.filter((c) => !baseNames.includes(c.name) && !hidden.has(c.name))

  const extraDefs = extras.map((c) => {
    let def = `"${c.name}" ${c.type}`
    if (c.notnull) def += ' NOT NULL'
    // c.dflt_value is the raw default SQL text as table_info reports it — already in its SQL form
    // (string defaults carry their quotes, e.g. 'elective'; numbers are bare, e.g. 0), so it is
    // concatenated verbatim rather than re-quoted.
    if (c.dflt_value != null) def += ` DEFAULT ${c.dflt_value}`
    return def
  })

  // Columns MUST precede table-level constraints in a CREATE TABLE body.
  const body = [...baseColumns, ...extraDefs, ...tableConstraints].join(',\n  ')
  db.exec(`CREATE TABLE "${table}__rebuild" (\n  ${body}\n);`)

  // Backstop: re-read the table we just created and prove it holds every live, non-generated column
  // WITH THE SAME per-column shape (type / NOT NULL / DEFAULT). A missing column means a drop; a
  // divergent attribute means a reconstruction bug (wrong type, lost NOT NULL, wrong/absent
  // DEFAULT). Either aborts (propagates out, rolling back the caller's transaction) rather than
  // reach the DROP/RENAME below. Read before the copy so a drop is caught as a stale-carry error,
  // not masked by an INSERT "no such column". UNIQUE (the only constraint these two call sites
  // change) is table-level, so a carried/base column's attributes are identical between the source
  // table and the rebuild on BOTH the relax and the restore path — any attribute divergence here is
  // therefore always a real assembly bug, never an expected difference. Column-level CHECK / FOREIGN
  // KEY / COLLATE are the documented residual: table_info does not report them, so they are not
  // compared (none exist on the nine tables these call sites rebuild).
  const rebuiltInfo = new Map(db.pragma(`table_info("${table}__rebuild")`).map((c) => [c.name, c]))
  const liveKept = liveInfo.filter((c) => !hidden.has(c.name))

  const dropped = liveKept.filter((c) => !rebuiltInfo.has(c.name)).map((c) => c.name)
  if (dropped.length) {
    throw new Error(
      `rebuild of ${table} would drop column(s): ${dropped.join(', ')} — carry list is stale`
    )
  }

  // "no default" and an explicit `DEFAULT NULL` are the same thing, but table_info reports the first
  // as null and the second as the literal string 'NULL'. Collapse only those two to equal; a real
  // default (DEFAULT 0, DEFAULT 'elective', …) still compares by its raw text, so a genuine default
  // change is still flagged.
  const normDflt = (d) => (d == null || String(d).trim().toUpperCase() === 'NULL' ? null : String(d))
  const mismatched = liveKept
    .filter((c) => {
      const r = rebuiltInfo.get(c.name)
      return r.type !== c.type || r.notnull !== c.notnull || normDflt(r.dflt_value) !== normDflt(c.dflt_value)
    })
    .map((c) => {
      const r = rebuiltInfo.get(c.name)
      return `${c.name} (${c.type}/${c.notnull}/${c.dflt_value} -> ${r.type}/${r.notnull}/${r.dflt_value})`
    })
  if (mismatched.length) {
    throw new Error(
      `rebuild of ${table} changed column shape: ${mismatched.join(', ')} — reconstruction is wrong`
    )
  }

  const copyCols = [...baseNames, ...extras.map((c) => c.name)].filter((n) => liveNames.includes(n))
  const colList = copyCols.map((n) => `"${n}"`).join(', ')
  db.exec(`INSERT INTO "${table}__rebuild" (${colList}) SELECT ${colList} FROM "${table}";`)

  db.exec(`DROP TABLE "${table}";`)
  db.exec(`ALTER TABLE "${table}__rebuild" RENAME TO "${table}";`)

  for (const sql of postIndexSql) db.exec(sql)
}
