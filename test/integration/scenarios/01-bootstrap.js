/**
 * Scenario 1: Fresh Host bootstrap + Client pairing and first sync.
 * Client receives ops written by Host after authenticating.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    // --- Host setup ---
    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap({ campName: 'Camp Test', adminName: 'admin', adminPin: '1234' })

    // --- Client setup ---
    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)

    // full_sync arrives asynchronously after authenticate; wait for it.
    await waitFor(() => !!client.db.prepare('SELECT id FROM camps LIMIT 1').get(), 6000)

    // Client should have received a full_sync with the camp row.
    const clientCamp = client.db.prepare('SELECT id, name FROM camps LIMIT 1').get()
    if (!clientCamp) throw new Error('Client missing camp after full_sync')
    if (clientCamp.name !== 'Camp Test') throw new Error(`Camp name mismatch: ${clientCamp.name}`)

    // Client should have the admin user row.
    const clientUser = client.db.prepare('SELECT name, role FROM users LIMIT 1').get()
    if (!clientUser) throw new Error('Client missing user after full_sync')
    if (clientUser.role !== 'admin') throw new Error(`Expected admin, got ${clientUser.role}`)

    // Write an op from the client and verify it lands on the host.
    const entityId = randomUUID()
    const result = await client.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'Archery',
    })
    if (result.status !== 'applied') throw new Error(`Expected applied, got ${result.status}`)

    await waitFor(() => host.countOps('activities', entityId, 'name') === 1)

    const hostOps = host.getOps()
    if (hostOps.length === 0) throw new Error('No ops on host after client write')
    const op = hostOps.find(o => o.entity === 'activities' && o.entity_id === entityId)
    if (!op) throw new Error('Host missing the activities/name op')
    if (op.value !== 'Archery') throw new Error(`Expected Archery, got ${op.value}`)

    // The op should also be in the client's DB (op_applied came back).
    await waitFor(() => client.getOps().some(o => o.entity === 'activities' && o.entity_id === entityId))

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
