/**
 * Scenario 11: Pre-merge snapshot restores successfully.
 *
 * Creates a real conflict (same as scenario 04), copies the DB as a pre-resolve
 * snapshot, applies a resolution op, then verifies the snapshot still reflects
 * the pre-resolution state (fewer ops, conflict unresolved).
 */

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'
import { openLocalDb } from '../../../electron/db/localDb.js'

export async function run() {
  const dirs = []
  let host, clientA, clientB, snapDb

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    clientA = new Client(`${tmpDir}/clientA.db`)
    clientA.open()
    await pairAndLogin(host, clientA)

    clientB = new Client(`${tmpDir}/clientB.db`)
    clientB.open()
    await pairAndLogin(host, clientB)

    clientB.registerDevice(clientA.deviceId, 'ClientA')
    clientA.registerDevice(clientB.deviceId, 'ClientB')

    const entityId = randomUUID()

    // Step 1: Client A writes parent op (op0).
    const parentResult = await clientA.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'v0',
      parent_op_id: null,
    })
    if (parentResult.status !== 'applied') throw new Error(`Parent write: ${parentResult.status}`)
    const op0Id = parentResult.op.id

    await waitFor(() => clientB.getOps().some(o => o.id === op0Id), 6000)

    // Client B disconnects.
    const countBeforeB = host.server.wss.clients.size
    clientB.disconnect()
    await waitFor(() => host.server.wss.clients.size < countBeforeB, 500).catch(() => {})

    // Client A writes op_A.
    const resultA = await clientA.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'v1-from-A',
      parent_op_id: op0Id,
    })
    if (resultA.status !== 'applied') throw new Error(`Client A write: ${resultA.status}`)

    // Client A disconnects (releases lock).
    const countBeforeA = host.server.wss.clients.size
    clientA.disconnect()
    await waitFor(() => host.server.wss.clients.size < countBeforeA, 500).catch(() => {})

    // Client B injects conflicting write and reconnects.
    clientB.injectPendingWrite({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'v1-from-B',
      parent_op_id: op0Id,
    })
    await clientB.reconnect()
    await clientB.flushQueue()

    // Wait for conflict to appear in host DB.
    await waitFor(() => host.getConflicts().length > 0, 6000)

    // Step 2: Create pre-resolve snapshot.
    // Checkpoint the WAL before copying so the snapshot file is self-contained
    // (WAL mode keeps recent writes in a separate .wal file until checkpoint).
    host.db.pragma('wal_checkpoint(FULL)')
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshotPath = host.dbPath.replace(/\.sqlite$/, '') + `.pre-resolve-${ts}.sqlite`
    fs.copyFileSync(host.dbPath, snapshotPath)

    if (!fs.existsSync(snapshotPath)) {
      throw new Error('Snapshot file was not created')
    }

    const opsBeforeResolution = host.getOps().length

    // Step 3: Apply resolution — write a new op to the conflicting field.
    const localWriter = createSyncClient(host.db, {
      device_id: host.deviceId,
      author_user_id: host.adminUserId,
    })
    await localWriter.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'Resolved',
    })

    // Verify the resolution op landed.
    await waitFor(() => host.getOps().length > opsBeforeResolution, 4000)
    const opsAfterResolution = host.getOps().length
    if (opsAfterResolution <= opsBeforeResolution) {
      throw new Error('Resolution op was not recorded in host DB')
    }

    // Step 4: Open the snapshot and verify it predates the resolution.
    snapDb = openLocalDb(snapshotPath)

    const snapOps = snapDb.prepare('SELECT COUNT(*) as n FROM operations').get().n
    if (snapOps >= opsAfterResolution) {
      throw new Error(
        `Snapshot should have fewer ops than live DB (snap: ${snapOps}, live: ${opsAfterResolution})`
      )
    }

    // The conflict should still be unresolved in the snapshot.
    const snapConflict = snapDb.prepare(
      "SELECT COUNT(*) as n FROM conflicts WHERE resolved_at IS NULL AND entity = 'activities' AND entity_id = ?"
    ).get(entityId).n
    if (snapConflict === 0) {
      throw new Error('Snapshot should still have unresolved conflict')
    }

    // The resolution value should NOT be in the snapshot.
    const resolvedInSnap = snapDb.prepare(
      "SELECT 1 FROM operations WHERE entity = 'activities' AND entity_id = ? AND value = 'Resolved'"
    ).get(entityId)
    if (resolvedInSnap) {
      throw new Error('Resolution op should not exist in snapshot')
    }

    return 'PASS'
  } finally {
    if (snapDb) { try { snapDb.close() } catch { /* ignore */ } }
    host?.close()
    clientA?.close()
    clientB?.close()
    cleanupDirs(dirs)
  }
}
