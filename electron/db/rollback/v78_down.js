// Inverse of migration v78 (electron/db/localDb.js): drops
// idx_elective_preferences_run_camper_occurrence and rebuilds
// elective_preferences without occurrence_id (T265,
// docs/adr/2026-09-26-per-cell-elective-preferences.md).
//
// UNLIKE v66's rollback (empty-of-meaning shape plus PII rows, no widening-
// vs-narrowing question): rolling BACK a key WIDENING is never automatically
// safe. Forward, v78 widened the key from (run_id, camper_id, choice_id) to
// (run_id, camper_id, occurrence_id, choice_id) — going backward means
// DROPPING occurrence_id from the key, and if two rows that are DISTINCT
// under the 4-tuple would become the SAME row under the old 3-tuple (the
// exact collision T265 exists to eliminate — a linked choice's per-occurrence
// ranks), collapsing them silently is precisely the silent-loss defect this
// ticket fixes. So this rollback REFUSES whenever any (run_id, camper_id,
// choice_id) spans more than one occurrence_id, and NAMES the blocking rows
// rather than collapsing them. A director who wants to roll back anyway must
// resolve or remove those rows first.
//
// Usage:  node electron/db/rollback/v78_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

const countIfPresent = (db, table) =>
  hasTable(db, table) ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : 0

/**
 * @returns {{ok:true, discarded:{preferences:number}} | {ok:false, error:string, blocking:Array}}
 */
export function rollbackV78(db) {
  if (!hasTable(db, 'elective_preferences')) {
    db.prepare('DELETE FROM schema_migrations WHERE version >= 78').run()
    return { ok: true, discarded: { preferences: 0 } }
  }

  // REFUSE, don't collapse. A (run_id, camper_id, choice_id) triple naming
  // more than one occurrence_id would silently lose the per-cell rank
  // distinction if the key narrows back to the 3-tuple.
  const blocking = db
    .prepare(
      `SELECT run_id, camper_id, choice_id, COUNT(DISTINCT occurrence_id) AS occ_count,
              GROUP_CONCAT(DISTINCT occurrence_id) AS occurrence_ids
         FROM elective_preferences
        WHERE camper_id IS NOT NULL AND choice_id IS NOT NULL
        GROUP BY run_id, camper_id, choice_id
       HAVING COUNT(DISTINCT occurrence_id) > 1`
    )
    .all()

  if (blocking.length > 0) {
    return {
      ok: false,
      error:
        `refused: ${blocking.length} (run_id, camper_id, choice_id) row-group(s) span more than ` +
        'one occurrence_id — rolling back would silently collapse distinct per-cell preference ' +
        'ranks onto one row. Resolve or remove these rows before rolling back v78.',
      blocking,
    }
  }

  // Count BEFORE destroying, so the report is honest about what went — every
  // group above is already singleton-occurrence, so the column is dropped
  // with no distinct-rank information lost.
  const discarded = { preferences: countIfPresent(db, 'elective_preferences') }

  db.transaction(() => {
    db.exec(`
      DROP TABLE elective_preferences;
      CREATE TABLE elective_preferences (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        camper_id TEXT,
        choice_id TEXT,
        rank INTEGER
      );
    `)
    // `>= 78`, not `= 78` — this repo's convention since v46_down (T220): a bare equality
    // strands any HIGHER version in the table.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 78').run()
  })()

  return { ok: true, discarded }
}

// Direct invocation (node electron/db/rollback/v78_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v78_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v78_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV78(db)
  if (!result.ok) {
    console.error(result.error)
    for (const b of result.blocking) {
      console.error(`  run_id=${b.run_id} camper_id=${b.camper_id} choice_id=${b.choice_id} occurrence_ids=${b.occurrence_ids}`)
    }
    db.close()
    process.exit(1)
  }
  db.close()
  console.log(`v78 rolled back: discarded the occurrence_id column from ${result.discarded.preferences} preference row(s)`)
}
