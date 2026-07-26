/**
 * Scenario 13: Host disappears during full sync (sendMissedOps).
 *
 * Sequence:
 *   1. Client pairs and logs in.
 *   2. Client disconnects.
 *   3. Host writes 20 ops locally.
 *   4. Client reconnects — host begins sendMissedOps.
 *   5. Host is killed mid-stream after 30ms.
 *   6. Client DB integrity is verified.
 *   7. Host is restarted on the same port.
 *   8. Client reconnects — receives all remaining ops.
 *   9. Final integrity check.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'
import { openLocalDb } from '../../../electron/db/localDb.js'
import { startSyncServer } from '../../../electron/sync/syncServer.js'

const N = 20

async function restartHost(host, port) {
  host.db = openLocalDb(host.dbPath)
  host.server = startSyncServer(host.db, {
    port,
    onPairingRequest: (dId, dName) => {
      const waiter = host._pairingWaiters.shift()
      if (waiter) waiter({ deviceId: dId, deviceName: dName })
      else host._pairingQueue.push({ deviceId: dId, deviceName: dName })
    },
  })
}

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)

    // Step 2: Client disconnects.
    client.disconnect()
    await new Promise(r => setTimeout(r, 100))

    // Step 3: Host writes N ops via a local (no-network) sync client.
    const localWriter = createSyncClient(host.db, {
      device_id: host.deviceId,
      author_user_id: host.adminUserId,
    })
    for (let i = 0; i < N; i++) {
      await localWriter.write({
        entity: 'activities',
        entity_id: randomUUID(),
        field: 'name',
        value: `Activity-${i}`,
      })
    }

    // The ops were written by the host device — register it on the client so
    // applyRemoteOp can insert them (FK on device_id).
    client.registerDevice(host.deviceId, 'Host')

    // Step 4: Client reconnects — host starts sendMissedOps.
    await client.reconnect()

    // Step 5: Kill the host after 30ms (mid-stream).
    await new Promise(r => setTimeout(r, 30))
    host.kill()

    // Step 6: Wait for in-flight messages to settle, then check client integrity.
    await new Promise(r => setTimeout(r, 100))

    const integrityBefore = client.db.pragma('integrity_check')[0].integrity_check
    if (integrityBefore !== 'ok') {
      throw new Error(`Client DB integrity check failed after host kill: ${integrityBefore}`)
    }

    // Step 7: Restart the host on the same port.
    await restartHost(host, port)

    // Step 8: Client reconnects to the restarted host.
    await client.reconnect()

    // Step 9: Wait for all N ops to appear in the client DB.
    await waitFor(() =>
      client.db.prepare(
        "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities'"
      ).get().n >= N,
      10000
    )

    const finalCount = client.db.prepare(
      "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities'"
    ).get().n
    if (finalCount < N) {
      throw new Error(`Client only received ${finalCount} of ${N} ops after restart`)
    }

    const integrityAfter = client.db.pragma('integrity_check')[0].integrity_check
    if (integrityAfter !== 'ok') {
      throw new Error(`Client DB integrity check failed after full sync: ${integrityAfter}`)
    }

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
