/**
 * Scenario 25: T88 — the first-pairing full_sync snapshot must ship
 * `week_location_exclusions` rows to a fresh Client, not just to
 * already-paired devices via the op log.
 *
 * Regression coverage for the manifest drift found by the 2026-08-16
 * sync/auth audit (C2): electron/sync/syncServer.js's send-side manifest
 * (DOMAIN_PARENT_SCOPED_ENTITIES) included `week_location_exclusions`, but
 * electron/sync/syncClient.js's apply-side manifest (DOMAIN_SNAPSHOT_TABLES)
 * omitted it — so a Host would ship the rows and a fresh Client would
 * silently drop them on first-pairing full_sync. M5 has landed
 * (week_location_exclusions is a real, writable projection entity), so this
 * is a live data-loss bug, not a latent one.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'

export async function run() {
  const dirs = []
  const toClose = []

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    const host = new Host(`${tmpDir}/host.db`)
    toClose.push(host)
    await host.start(await getFreePort())
    await host.bootstrap({ campName: 'Exclusions Camp' })

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })

    const weekId = randomUUID()
    await localWriter.write({ entity: 'schedule_weeks', entity_id: weekId, field: 'name', value: 'Week 1' })

    const locationId = randomUUID()
    await localWriter.write({ entity: 'locations', entity_id: locationId, field: 'name', value: 'The Lake' })

    const exclusionId = randomUUID()
    await localWriter.write({ entity: 'week_location_exclusions', entity_id: exclusionId, field: 'week_id', value: weekId })
    await localWriter.write({ entity: 'week_location_exclusions', entity_id: exclusionId, field: 'location_id', value: locationId })

    const hostRow = host.db.prepare('SELECT id, week_id, location_id FROM week_location_exclusions WHERE id = ?').get(exclusionId)
    if (!hostRow) throw new Error('setup: week_location_exclusions row was not created on the Host itself')

    const client = new Client(`${tmpDir}/client.db`)
    toClose.push(client)
    client.open()
    await pairAndLogin(host, client)
    await waitFor(() => client.hasCompletedInitialSync(), 3000)

    const clientRow = client.db.prepare('SELECT id, week_id, location_id FROM week_location_exclusions WHERE id = ?').get(exclusionId)
    if (!clientRow) {
      throw new Error('T88: Client dropped the week_location_exclusions row on first-pairing full_sync')
    }
    if (clientRow.week_id !== weekId || clientRow.location_id !== locationId) {
      throw new Error(`T88: Client's week_location_exclusions row has wrong fields: ${JSON.stringify(clientRow)}`)
    }

    return 'PASS'
  } finally {
    for (const obj of toClose) {
      try { obj.close() } catch { /* ignore */ }
    }
    cleanupDirs(dirs)
  }
}
