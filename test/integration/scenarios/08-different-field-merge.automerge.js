/**
 * Scenario 8 (Stage 6a libp2p port): two clients edit different fields of the
 * same entity — both land, no conflict.
 *
 * Ported from 08-different-field-merge.js. Under Automerge each field is its
 * own CRDT register (campDocument.js's flat per-field shape), so two
 * concurrent edits to DIFFERENT fields of the same entity_id are not even a
 * candidate for a conflict at the document layer — A.merge always keeps
 * both. This port asserts exactly that: both fields land on the Host
 * (the actual claim the original scenario's name makes), via two
 * independently-dialed peers.
 *
 * The original's `host.getConflicts()`/`operations` table assertions have
 * no equivalent — see 12-schema-migration's sibling retirement note in the
 * Stage 6a report for the general reason (conflicts is a device-local,
 * op-log-only table, not modeled in the CRDT document).
 */

import { randomUUID } from 'node:crypto'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, clientA, clientB

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    clientA = new AmClient(`${tmpDir}/clientA.db`)
    clientA.open()
    await clientA.join(host)

    clientB = new AmClient(`${tmpDir}/clientB.db`)
    clientB.open()
    await clientB.join(host)

    const entityId = randomUUID()

    const resultA = await clientA.write({ entity: 'activities', entity_id: entityId, field: 'name', value: 'Archery' })
    if (resultA.status !== 'applied') throw new Error(`Client A write: ${resultA.status}`)

    const resultB = await clientB.write({ entity: 'activities', entity_id: entityId, field: 'location', value: 'Lakeside' })
    if (resultB.status !== 'applied') throw new Error(`Client B write: ${resultB.status}`)

    await waitFor(() => {
      const row = host.domainRow('activities', entityId)
      return !!row && row.name === 'Archery' && row.location === 'Lakeside'
    }, 6000)

    const hostRow = host.domainRow('activities', entityId)
    if (hostRow.name !== 'Archery') throw new Error(`Host missing name field: ${JSON.stringify(hostRow)}`)
    if (hostRow.location !== 'Lakeside') throw new Error(`Host missing location field: ${JSON.stringify(hostRow)}`)

    return 'PASS'
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}
