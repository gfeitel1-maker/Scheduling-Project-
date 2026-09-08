/**
 * Scenario 2 (Stage 6a libp2p port): a domain write survives a process
 * restart.
 *
 * Ported from 02-offline-restart.js. The op-log original tests
 * `pending_writes` — a durable retry queue that exists specifically because
 * a WS write can be lost in flight. Automerge has no equivalent queue
 * because it doesn't need one: `node.applyLocal()` mutates the local
 * document (and projects into SQLite) synchronously, BEFORE any network
 * send is attempted — the write is durable to disk (via docStore.saveDoc,
 * exercised here) independent of whether any peer is even reachable. This
 * port's actual claim is therefore the CRDT-appropriate one: a write made
 * while fully offline is present after the doc is saved, the node is
 * stopped (process exit), and a fresh node is started from the saved
 * bytes — then reaches the Host once reconnected.
 */

import { randomUUID } from 'node:crypto'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const docDir = `${tmpDir}/client-userdata`

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId } = await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    const entityId = randomUUID()
    const result = await client.write({ entity: 'activities', entity_id: entityId, field: 'name', value: 'Canoeing' })
    if (result.status !== 'applied') throw new Error(`Expected applied, got ${result.status}`)

    // Written locally before any restart — proves applyLocal's write is
    // synchronous and durable to the doc, not merely queued for later send.
    if (!client.domainRow('activities', entityId)) throw new Error('Write missing from Client DB before restart')

    // Simulate process exit + restart: persist the doc, stop the node,
    // start a fresh one from the saved bytes.
    await client.restart(docDir, campId)

    // The write survived the restart (it's baked into the doc, not lost
    // with an in-memory-only queue).
    if (!client.domainRow('activities', entityId)) throw new Error('Write did not survive restart')
    if (client.domainRow('activities', entityId).name !== 'Canoeing') {
      throw new Error(`Wrong value after restart: ${client.domainRow('activities', entityId).name}`)
    }

    // Reconnect to the Host — the restarted node re-syncs and the Host
    // ends up with the same write (it never needed a "flush the queue"
    // step; the doc IS the source of truth for what's pending).
    await client.reconnect(host)
    await waitFor(() => !!host.domainRow('activities', entityId), 6000)
    if (host.domainRow('activities', entityId).name !== 'Canoeing') {
      throw new Error(`Wrong value on Host: ${host.domainRow('activities', entityId).name}`)
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
