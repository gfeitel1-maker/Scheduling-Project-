/**
 * Scenario 4: Two Clients edit the same field offline — conflict appears in
 *             the Host's conflicts table.
 *
 * The conflict detection in handleSubmitOp compares the incoming op's
 * parent_op_id to the latest op for that entity/field.  To get a genuine
 * conflict rather than lock_contention the sequence is:
 *
 *   1. Client A writes "parent" op (op0) online; Client B receives op0.
 *   2. Client B disconnects (goes offline).
 *   3. Client A writes "op_A" (parent_op_id = op0.id) online → applied.
 *      Client A then disconnects (releases its lock on the field).
 *   4. Client B (still offline) injects a pending write with parent_op_id =
 *      op0.id — same parent as op_A, but B has not seen op_A yet.
 *   5. Client B reconnects and flushes the queue.
 *      detectConflict: latest op is op_A; op_A.id ≠ op0.id → CONFLICT.
 *   6. Host's conflicts table has the row; Client B's DB has it too.
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

    // Client A
    clientA = new Client(`${tmpDir}/clientA.db`)
    clientA.open()
    await pairAndLogin(host, clientA)

    // Client B
    clientB = new Client(`${tmpDir}/clientB.db`)
    clientB.open()
    await pairAndLogin(host, clientB)

    // Each client's operations table has device_id REFERENCES devices(id) with
    // FK enforcement ON.  When client A broadcasts op0, client B's applyRemoteOp
    // will INSERT a row with device_id = clientA.deviceId.  That insert fails
    // silently (caught by the outer try/catch) unless clientA.deviceId is in
    // clientB's devices table.  Register both sides before any writes.
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

    // Wait for Client B to receive op0 via op_applied broadcast.
    await waitFor(() => clientB.getOps().some(o => o.id === op0Id), 6000)

    // Step 2: Client B disconnects (simulates going offline).
    clientB.disconnect()
    await new Promise(r => setTimeout(r, 120))  // let server-side close propagate

    // Step 3: Client A writes op_A with parent_op_id = op0Id.
    const resultA = await clientA.write({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'v1-from-A',
      parent_op_id: op0Id,
    })
    if (resultA.status !== 'applied') throw new Error(`Client A second write: ${resultA.status}`)

    // Client A disconnects so its lock is released.
    clientA.disconnect()
    await new Promise(r => setTimeout(r, 120))  // let lock release propagate

    // Verify the host now has op_A as the latest op for this field.
    const hostOps = host.getOps().filter(o => o.entity === 'activities' && o.entity_id === entityId && o.field === 'name')
    if (hostOps.length !== 2) throw new Error(`Expected 2 host ops, got ${hostOps.length}`)
    const opA = hostOps[hostOps.length - 1]  // latest by seq
    if (opA.id === op0Id) throw new Error('op_A not distinct from op0')

    // Step 4: Client B injects a pending write with parent_op_id = op0Id.
    // B had seen op0 before going offline, so its "latest known op" is op0.
    clientB.injectPendingWrite({
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'v1-from-B',
      parent_op_id: op0Id,
    })

    // Step 5: Client B reconnects and flushes.
    await clientB.reconnect()
    await clientB.flushQueue()

    // detectConflict on host: latest op is op_A (id ≠ op0Id) → conflict.
    await waitFor(() => host.getConflicts().length > 0, 6000)

    const conflicts = host.getConflicts()
    const c = conflicts.find(x =>
      x.entity === 'activities' &&
      x.entity_id === entityId &&
      x.field === 'name'
    )
    if (!c) throw new Error(`Host has ${conflicts.length} conflict(s) but none match entity/field`)

    // Step 6: Client B's DB must also record the conflict (via op_conflict handler).
    await waitFor(() => clientB.getConflicts().length > 0, 4000)
    if (clientB.getConflicts().length === 0) {
      throw new Error('Client B missing local conflict record')
    }

    return 'PASS'
  } finally {
    host?.close()
    clientA?.close()
    clientB?.close()
    cleanupDirs(dirs)
  }
}
