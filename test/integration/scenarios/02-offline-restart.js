/**
 * Scenario 2: Client offline write survives process restart.
 *
 * Steps:
 *   1. Pair and login client.
 *   2. Inject a pending write directly into pending_writes (simulating a
 *      queued write that existed when the process exited).
 *   3. Close the DB (simulate process exit).
 *   4. Reopen the DB — pending_writes row must still be present.
 *   5. Create a new syncClient (it reloads pending_writes from the DB file).
 *   6. Reconnect to the Host with the stored token.
 *   7. Call flushQueue() — op must be synced to Host.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'

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

    const entityId = randomUUID()

    // Inject a pending write (simulates what syncClient.write() does while
    // offline — the write is durably queued without touching the op-log yet).
    client.injectPendingWrite({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'Canoeing',
    })

    // Verify it's in the DB before "closing the process".
    const beforeClose = client.db.prepare('SELECT * FROM pending_writes').all()
    if (beforeClose.length === 0) throw new Error('Pending write missing before close')

    // Simulate process exit: close DB.
    client.closeDb()

    // Simulate process restart: reopen the DB — pending_write must survive.
    client.open()
    const afterReopen = client.db.prepare('SELECT * FROM pending_writes').all()
    if (afterReopen.length === 0) throw new Error('Pending write did not survive DB close/reopen')
    if (afterReopen[0].entity !== 'activities') throw new Error('Wrong entity in pending write')

    // Reconnect with the stored token (new syncClient loads pending_writes).
    await client.connect(host.serverUrl)

    // Flush — pending write must reach the Host.
    await client.flushQueue()

    // Verify the op appeared on the host.
    await waitFor(() => host.countOps('activities', entityId, 'name') === 1, 6000)

    const op = host.getOps().find(o => o.entity === 'activities' && o.entity_id === entityId)
    if (!op) throw new Error('Host missing the flushed op')
    if (op.value !== 'Canoeing') throw new Error(`Wrong value: ${op.value}`)

    // Pending write must be removed from the queue after successful flush.
    await waitFor(() => client.db.prepare('SELECT COUNT(*) as n FROM pending_writes').get().n === 0, 4000)

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
