/**
 * Scenario 6 (tier 2): Client hundreds of ops behind — Host catches it up.
 *
 * Sequence:
 *   1. Client pairs and logs in → watermark set to current max seq (0, no ops yet).
 *   2. Client disconnects.
 *   3. Host writes N ops via a local (no-network) sync client.
 *   4. Client reconnects with the stored token.
 *      handleAuthenticate → sendMissedOps sends all N missed ops as op_applied.
 *   5. Client DB must contain all N ops.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'

const N = 50  // use 50 so the test finishes quickly; still exercises the loop

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

    // Disconnect client so it misses the upcoming ops.
    client.disconnect()
    await new Promise(r => setTimeout(r, 100))  // let WS close propagate

    // Write N ops directly on the host via a local (no-network) sync client.
    const localWriter = createSyncClient(host.db, {
      device_id: host.deviceId,
      author_user_id: host.adminUserId,
    })
    const entityIds = []
    for (let i = 0; i < N; i++) {
      const entityId = randomUUID()
      entityIds.push(entityId)
      await localWriter.write({
        entity: 'activities',
        entity_id: entityId,
        field: 'name',
        value: `Activity-${i}`,
      })
    }

    // Verify all N ops are in the host DB.
    const hostOps = host.db.prepare(
      "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities'"
    ).get().n
    if (hostOps < N) throw new Error(`Expected >= ${N} ops on host, found ${hostOps}`)

    // The ops were written by the host device (host.deviceId). Pre-T85 this
    // required manually registering the host's device row on the client
    // (docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md) —
    // applyRemoteOp now stub-seeds the author's devices row itself, in the
    // same transaction as the op-log insert, so catch-up delivery no longer
    // needs a test-only workaround.

    // Reconnect client.
    await client.reconnect()

    // Wait for all N ops to appear in the client DB.
    await waitFor(() => {
      const n = client.db.prepare(
        "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities'"
      ).get().n
      return n >= N
    }, 10000)

    const clientOps = client.db.prepare(
      "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities'"
    ).get().n
    if (clientOps < N) throw new Error(`Client only received ${clientOps} of ${N} ops`)

    // Spot-check: first and last entity ID are present.
    const first = client.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(entityIds[0])
    const last = client.db.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get(entityIds[N - 1])
    if (!first) throw new Error('Client missing first entity op')
    if (!last) throw new Error('Client missing last entity op')

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
