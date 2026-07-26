/**
 * Scenario 9: Duplicate and out-of-order messages.
 *
 * 9a: Two pending_writes with the same client_write_id — server deduplicates
 *     and stores exactly one op row.
 *
 * 9b: Two different pending_writes on the same entity both reach the server —
 *     both op rows appear in the host DB.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { insertPendingWrite } from '../../../electron/sync/pendingWrites.js'

// ---------------------------------------------------------------------------
// 9a: Duplicate op (same client_write_id) is deduplicated on the server.
// ---------------------------------------------------------------------------
async function scenario9a(tmpDir) {
  const host = new Host(`${tmpDir}/9a-host.db`)
  let client
  try {
    const port = await getFreePort()
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/9a-client.db`)
    client.open()
    await pairAndLogin(host, client)

    // Disconnect so pending writes are queued and not sent immediately.
    client.disconnect()
    await new Promise(r => setTimeout(r, 100))

    // Insert two pending writes sharing the SAME client_write_id.
    // injectPendingWrite() always generates a fresh client_write_id, so we
    // call insertPendingWrite() directly here to share a single id across both
    // rows — this is the precise invariant the server's dedup check is designed
    // for (same logical write retried after a disconnect).
    const sharedClientWriteId = randomUUID()
    const entityId = randomUUID()
    insertPendingWrite(client.db, {
      pendingId: randomUUID(),
      client_write_id: sharedClientWriteId,
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'DedupTest',
      parent_op_id: null,
    })
    insertPendingWrite(client.db, {
      pendingId: randomUUID(),
      client_write_id: sharedClientWriteId,
      entity: 'activities',
      entity_id: entityId,
      field: 'name',
      value: 'DedupTest',
      parent_op_id: null,
    })

    // Reconnect and flush — server should handle the duplicate gracefully.
    await client.reconnect()
    await client.flushQueue()

    // Wait for at least one op to land on the host.
    await waitFor(() =>
      host.db.prepare(
        'SELECT COUNT(*) as n FROM operations WHERE client_write_id = ?'
      ).get(sharedClientWriteId).n >= 1,
      6000
    )

    // Give a moment for any second write to land (if dedup failed).
    await new Promise(r => setTimeout(r, 200))

    const count = host.db.prepare(
      'SELECT COUNT(*) as n FROM operations WHERE client_write_id = ?'
    ).get(sharedClientWriteId).n

    if (count !== 1) {
      throw new Error(`Expected exactly 1 op for shared client_write_id, got ${count}`)
    }
  } finally {
    client?.close()
    host.close()
  }
}

// ---------------------------------------------------------------------------
// 9b: Two rapid pending writes on the same entity both reach the server.
// ---------------------------------------------------------------------------
async function scenario9b(tmpDir) {
  const host = new Host(`${tmpDir}/9b-host.db`)
  let client
  try {
    const port = await getFreePort()
    await host.start(port)
    await host.bootstrap()

    client = new Client(`${tmpDir}/9b-client.db`)
    client.open()
    await pairAndLogin(host, client)

    client.disconnect()
    await new Promise(r => setTimeout(r, 100))

    const entityId = randomUUID()
    client.injectPendingWrite({ entity: 'activities', entity_id: entityId, field: 'name',     value: 'RapidA',   parent_op_id: null })
    client.injectPendingWrite({ entity: 'activities', entity_id: entityId, field: 'location', value: 'Lakeside', parent_op_id: null })

    await client.reconnect()
    await client.flushQueue()

    // Both ops should arrive at the host.
    await waitFor(() =>
      host.db.prepare(
        "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities' AND entity_id = ?"
      ).get(entityId).n >= 2,
      6000
    )

    const count = host.db.prepare(
      "SELECT COUNT(*) as n FROM operations WHERE entity = 'activities' AND entity_id = ?"
    ).get(entityId).n
    if (count < 2) {
      throw new Error(`Expected >= 2 ops for entityId, got ${count}`)
    }
  } finally {
    client?.close()
    host.close()
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function run() {
  const dirs = []
  let tmpDir

  try {
    tmpDir = makeTmpDir()
    dirs.push(tmpDir)

    await scenario9a(tmpDir)
    await scenario9b(tmpDir)

    return 'PASS'
  } finally {
    cleanupDirs(dirs)
  }
}
