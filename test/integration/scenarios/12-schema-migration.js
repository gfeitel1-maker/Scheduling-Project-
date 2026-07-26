/**
 * Scenario 12: Schema migration with pending writes.
 *
 * Bootstraps a DB to v20, closes it, deletes the v20 migration row to simulate
 * a downgrade, then reopens via openLocalDb.  Verifies:
 *   a. A .pre-migration-*.bak backup file is written alongside the DB.
 *   b. The schema is migrated back to v20.
 *   c. The pending_writes table still exists (data survived).
 */

import fs from 'node:fs'
import Database from 'better-sqlite3'
import { Host, getFreePort, makeTmpDir, cleanupDirs } from '../harness.js'
import { openLocalDb, getSchemaVersion } from '../../../electron/db/localDb.js'

export async function run() {
  const dirs = []
  let host, migratedDb

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    // Bootstrap to get a fully migrated DB.
    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    // Record op count before migration — bootstrap creates ops (admin user creation).
    const opsBefore = host.db.prepare('SELECT COUNT(*) as n FROM operations').get().n

    const hostDbPath = host.dbPath

    // Close everything before messing with the DB file.
    host.close();   host = null

    // Delete the v20 migration row to simulate "rolled back" schema version.
    const rawDb = new Database(hostDbPath)
    rawDb.prepare('DELETE FROM schema_migrations WHERE version = 20').run()
    rawDb.close()

    // Reopen via openLocalDb — should detect v19 < 20 and migrate.
    migratedDb = openLocalDb(hostDbPath)

    // a. A .bak backup file should exist alongside the DB.
    const bakExists = fs.readdirSync(tmpDir).some(
      f => f.includes('.pre-migration') && f.endsWith('.bak')
    )
    if (!bakExists) {
      throw new Error('Expected a .pre-migration-*.bak backup file, none found')
    }

    // b. Schema version is back to 20.
    const version = getSchemaVersion(migratedDb)
    if (version !== 20) {
      throw new Error(`Expected schema version 20 after re-migration, got ${version}`)
    }

    // c. Ops written before migration survived (data-survival check).
    const opsAfter = migratedDb.prepare('SELECT COUNT(*) as n FROM operations').get().n
    if (opsAfter < opsBefore) {
      throw new Error(`Ops lost during migration: before=${opsBefore}, after=${opsAfter}`)
    }

    // d. pending_writes table is still accessible (structural check).
    const pwCount = migratedDb.prepare('SELECT COUNT(*) as n FROM pending_writes').get()
    if (pwCount === undefined) {
      throw new Error('pending_writes table missing after migration')
    }

    return 'PASS'
  } finally {
    if (migratedDb) { try { migratedDb.close() } catch { /* ignore */ } }
    host?.close()
    cleanupDirs(dirs)
  }
}
