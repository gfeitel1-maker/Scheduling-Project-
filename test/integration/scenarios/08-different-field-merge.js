/**
 * Scenario 8: Two clients edit different fields of the same entity — no conflict.
 *
 * Both clients are online.  Client A writes to capacity; Client B writes to
 * name.  Because the fields differ, detectConflict never fires and no conflict
 * row is created.  Both ops end up in the host DB.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'

export async function run() {
  const dirs = []
  let host, clientA, clientB

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

    // Register both devices on each other so FK constraint on device_id passes
    // when op_applied broadcasts arrive.
    clientA.registerDevice(clientB.deviceId, 'ClientB')
    clientB.registerDevice(clientA.deviceId, 'ClientA')

    const entityId = randomUUID()

    // Client A writes to 'name' field.
    const resultA = await clientA.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'Archery',
      parent_op_id: null,
    })
    if (resultA.status !== 'applied') throw new Error(`Client A write: ${resultA.status}`)

    // Client B writes to 'location' field (different field — no conflict possible).
    const resultB = await clientB.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'location',
      value: 'Lakeside',
      parent_op_id: null,
    })
    if (resultB.status !== 'applied') throw new Error(`Client B write: ${resultB.status}`)

    // Wait for both ops to land in the host DB.
    await waitFor(() => {
      const n = host.db.prepare(
        "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities' AND entity_id = ?"
      ).get(entityId).n
      return n >= 2
    }, 6000)

    // No conflicts: different fields can never conflict.
    const conflicts = host.getConflicts()
    if (conflicts.length !== 0) {
      throw new Error(`Expected 0 conflicts, got ${conflicts.length}`)
    }

    // Both ops are present in the host DB.
    const hostOps = host.db.prepare(
      "SELECT * FROM operations WHERE entity = 'activities' AND entity_id = ?"
    ).all(entityId)
    if (hostOps.length < 2) {
      throw new Error(`Expected >= 2 ops for entityId, got ${hostOps.length}`)
    }

    const hasName     = hostOps.some(o => o.field === 'name'     && o.value === 'Archery')
    const hasLocation = hostOps.some(o => o.field === 'location' && o.value === 'Lakeside')
    if (!hasName)     throw new Error('name op not found in host DB')
    if (!hasLocation) throw new Error('location op not found in host DB')

    return 'PASS'
  } finally {
    host?.close()
    clientA?.close()
    clientB?.close()
    cleanupDirs(dirs)
  }
}
