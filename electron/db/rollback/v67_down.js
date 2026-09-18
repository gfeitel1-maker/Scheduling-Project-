// Inverse of migration v67 (electron/db/localDb.js): drops device_identity_key
// (T162, docs/adr/2026-09-14-device-identity-and-token-binding.md §5).
//
//   1. DROP TABLE device_identity_key.
//   2. CANNOT restore the nulled devices.libp2p_peer_id values the v66
//      migration cleared on the way up — they were routing hints from the
//      old "regenerated every restart" regime, already documented as
//      disposable, and the migration's own comment already states they carry
//      no meaning worth restoring. Same posture as v59_down.js's "DATA IS NOT
//      RESTORED, and cannot be" for day_overrides.
//   3. No registry membership is restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js), campScopedEntities.js, or
//      campDocument.js's MODELED_ENTITIES. device_identity_key was never
//      registered there in the first place (§1/§4), so there is nothing to
//      undo on that front.
//
// Usage:  node electron/db/rollback/v66_down.js <path-to-shoresh.sqlite>

export function rollbackV66(db) {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS device_identity_key')

    // >= 66, not just = 66 (v32_down/v46_down/v59_down precedent): a later
    // migration's schema_migrations row surviving this rollback would make
    // getSchemaVersion() report higher than 66, which defeats the v66
    // migration's own `>= 65 && < 66` guard on the next initSchema() — the
    // table would never get re-created and re-dropped correctly.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 67').run()
  })()

  return { dropped: ['device_identity_key'], dataRestored: false }
}

// Direct invocation (node electron/db/rollback/v66_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v66_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v66_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV66(db)
  console.log(JSON.stringify(result))
  db.close()
}
