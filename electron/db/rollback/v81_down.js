// Inverse of migration v81 (electron/db/localDb.js) -- T301, linked elective
// bundles.
//
//   1. DROP the three new tables outright (not ALTER DROP COLUMN -- these are
//      whole tables this migration introduced, nothing pre-existing to
//      preserve).
//   2. Order: children before parent (elective_bundle_periods,
//      elective_bundle_tiers, then elective_bundles) -- no FK enforces this
//      (bundle_id is a soft reference, D1), but it keeps the rollback
//      legible as "undo the leaves, then the root" and costs nothing.
//   3. No registry membership restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js) or any other registry.
//      Those are separate, deliberate code changes a schema-only rollback
//      does not undo -- same ruling as v77_down/v79_down/v80_down.
//   4. Data loss: every authored bundle, its periods, and its tier scope are
//      discarded outright. There is no prior state to restore -- none of
//      these tables existed before v81. A director who had authored bundles
//      must author them again. Unlike v80's rollback, this is not a lost
//      CONSTRAINT on otherwise-live data -- it is the removal of rows whose
//      only consumer (deriveChoices.js, tier 1) also stops being reachable
//      the moment this rollback runs, so nothing downstream is left
//      half-referencing a dropped table.
//
// Usage: node electron/db/rollback/v81_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

export function rollbackV81(db) {
  const discarded = {
    bundles: hasTable(db, 'elective_bundles')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c
      : 0,
    periods: hasTable(db, 'elective_bundle_periods')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods').get().c
      : 0,
    tierExceptions: hasTable(db, 'elective_bundle_tiers')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundle_tiers').get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS elective_bundle_periods')
    db.exec('DROP TABLE IF EXISTS elective_bundle_tiers')
    db.exec('DROP TABLE IF EXISTS elective_bundles')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 81').run()
  })()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v81_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v81_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV81(db)
  db.close()
  console.log(
    `v81 rolled back: discarded ${result.discarded.bundles} bundle(s), ${result.discarded.periods} ` +
    `period row(s), ${result.discarded.tierExceptions} tier-scope row(s). There is no prior state to ` +
    'restore -- none of these tables existed before v81. A director who had authored bundles must ' +
    'author them again. This app build still declares schema version 81 -- reopening it re-creates ' +
    'all three tables, empty.'
  )
}
