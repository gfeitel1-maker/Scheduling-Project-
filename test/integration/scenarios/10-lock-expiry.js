/**
 * Scenario 10: Lock holder crashes, lock expires.
 *
 * 10a: WS disconnect triggers releaseLocksForDevice — the lock is gone once
 *      the server processes the close event.
 *
 * 10b: expireLocks() removes a lock whose acquired_at is older than the
 *      configured timeout.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { expireLocks } from '../../../electron/sync/lockManager.js'

// ---------------------------------------------------------------------------
// 10a: WS disconnect releases the lock.
// ---------------------------------------------------------------------------
async function scenario10a(tmpDir) {
  const host = new Host(`${tmpDir}/10a-host.db`)
  let client
  try {
    const port = await getFreePort()
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/10a-client.db`)
    client.open()
    await pairAndLogin(host, client)

    const entityId = randomUUID()
    const clientDeviceId = client.deviceId

    // Insert a lock row directly — simulating a lock the client holds.
    host.db.prepare(
      "INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at) VALUES ('activities', ?, 'name', ?, datetime('now'))"
    ).run(entityId, clientDeviceId)

    // Verify the lock is in the host DB.
    const lockBefore = host.db.prepare(
      'SELECT COUNT(*) as n FROM locks WHERE holder_device_id = ?'
    ).get(clientDeviceId).n
    if (lockBefore === 0) throw new Error('Lock was not inserted into host DB')

    // Disconnect the client — server ws.on('close') calls releaseLocksForDevice.
    const clientCountBefore = host.server.wss.clients.size
    client.disconnect()

    // Wait for the server-side WS close to propagate.
    await waitFor(
      () => host.server.wss.clients.size < clientCountBefore,
      2000,
    ).catch(() => { /* may have already propagated */ })

    // Wait for the lock to be released by the disconnect handler.
    await waitFor(() =>
      host.db.prepare(
        'SELECT COUNT(*) as n FROM locks WHERE holder_device_id = ?'
      ).get(clientDeviceId).n === 0,
      4000
    )

    const lockAfter = host.db.prepare(
      'SELECT COUNT(*) as n FROM locks WHERE holder_device_id = ?'
    ).get(clientDeviceId).n
    if (lockAfter !== 0) {
      throw new Error(`Expected 0 locks after disconnect, got ${lockAfter}`)
    }
  } finally {
    client?.close()
    host.close()
  }
}

// ---------------------------------------------------------------------------
// 10b: expireLocks() removes a stale lock older than the configured timeout.
// ---------------------------------------------------------------------------
async function scenario10b(tmpDir) {
  const host = new Host(`${tmpDir}/10b-host.db`)
  try {
    const port = await getFreePort()
    await host.start(port)
    await host.bootstrap()

    const entityId2 = randomUUID()

    // Insert a lock row with a past acquired_at (120 seconds ago).
    host.db.prepare(
      "INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at) VALUES ('activities', ?, 'name', 'ghost-device', datetime('now', '-120 seconds'))"
    ).run(entityId2)

    // Verify the stale lock exists.
    const before = host.db.prepare(
      "SELECT COUNT(*) as n FROM locks WHERE holder_device_id = 'ghost-device'"
    ).get().n
    if (before === 0) throw new Error('Stale lock was not inserted')

    // Expire locks older than 60 seconds — our lock is 120s old and should go.
    expireLocks(host.db, 60_000)

    const after = host.db.prepare(
      "SELECT COUNT(*) as n FROM locks WHERE holder_device_id = 'ghost-device'"
    ).get().n
    if (after !== 0) {
      throw new Error(`Expected 0 stale locks after expiry, got ${after}`)
    }
  } finally {
    host.close()
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function run() {
  const dirs = []

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    await scenario10a(tmpDir)
    await scenario10b(tmpDir)

    return 'PASS'
  } finally {
    cleanupDirs(dirs)
  }
}
