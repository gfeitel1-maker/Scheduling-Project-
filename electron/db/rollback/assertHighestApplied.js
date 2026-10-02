// Descending-order guard for the developer-only rollback CLIs
// (electron/db/rollback/vN_down.js), board q-rollback-descending-order-landmine.
//
// THE LANDMINE. Every down module deletes its marker with
// `DELETE FROM schema_migrations WHERE version >= N`. Run in descending order
// that is correct — at the highest applied version N, the delete removes only N.
// But nothing enforced the order. An operator (or a script) running, say,
// `node electron/db/rollback/v51_down.js <db>` on a database already migrated to
// v77 deletes schema_migrations rows >= 51 while the v52..v77 schema objects stay
// live: the version marker and the actual schema are now inconsistent, and the
// next app open re-fires forward migrations from a wrong baseline.
//
// THE RULE. A down module may only be run when it is THE HIGHEST applied
// version. Roll newer migrations back first, one at a time, in descending order —
// each v(N)_down, run while N is the highest, leaves N-1 as the new highest, so a
// genuine descending chain never trips this guard. Deliberately running a lower
// module out of order (e.g. to script a bulk rewind another way) requires the
// explicit SHORESH_ROLLBACK_ALLOW_OUT_OF_ORDER=1 override.
//
// This is enforced at the CLI entry (the footer), NOT inside the rollbackVN
// functions: those are also called programmatically — round-trip migration tests,
// chained disaster-recovery rebuilds — where running a specific version's inverse
// while a higher one is applied is legitimate. The landmine is the human/operator
// path, which is exactly the footer.
//
// Throws on refusal (an uncaught throw in the footer exits non-zero — the
// "refuses to run" the board asked for). `env` is injectable for testing.
export function assertHighestApplied(db, version, { env = process.env } = {}) {
  // A sqlite file with no schema_migrations table at all (a brand-new/empty file,
  // a typo'd path better-sqlite3 silently created, or an unrelated db) would
  // otherwise throw an opaque `no such table` from the query below. Fail with the
  // guard's own clear message instead — still a non-zero exit, nothing mutated.
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (!hasTable) {
    throw new Error(
      `rollback v${version} refused: this database has no schema_migrations table — it is not a ` +
        `migrated Shoresh database, so there is nothing to roll back.`
    )
  }
  const row = db.prepare('SELECT MAX(version) AS max FROM schema_migrations').get()
  const highest = row && row.max != null ? row.max : null
  if (highest === null) {
    throw new Error(
      `rollback v${version} refused: schema_migrations is empty — there is nothing to roll back.`
    )
  }
  if (version === highest) return
  if (env.SHORESH_ROLLBACK_ALLOW_OUT_OF_ORDER === '1') return
  throw new Error(
    `rollback v${version} refused: the highest applied migration is v${highest}, not v${version}. ` +
      `Running a down module out of descending order rewinds schema_migrations below the live schema, ` +
      `leaving the version marker and the actual schema inconsistent. Roll newer migrations back first, ` +
      `in descending order (run v${highest}_down, then v${highest - 1}_down, and so on). To override ` +
      `deliberately, set SHORESH_ROLLBACK_ALLOW_OUT_OF_ORDER=1.`
  )
}
