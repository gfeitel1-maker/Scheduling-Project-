/**
 * Scenario 14: Corrupt/incomplete sync payload rejected transactionally.
 *
 * Sends a malformed submit_op (missing 'entity') over the raw WS connection.
 * The server should:
 *   - Not write any partial row to the operations table.
 *   - Respond with { type: 'error' }.
 *   - Leave the DB in a consistent state (integrity_check = 'ok').
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

    const opsBefore = host.getOps().length

    // Set up error listener on the raw WS before sending the bad message.
    let receivedError = false
    const rawWs = client.syncClient.__getWs()
    if (!rawWs) throw new Error('No WS connection after pairAndLogin')

    rawWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') receivedError = true
      } catch { /* ignore parse errors */ }
    })

    // Send a malformed submit_op — missing the required 'entity' field.
    client.sendRawMessage({
      type: 'submit_op',
      op: {
        entity_id: randomUUID(),
        field: 'name',
        value: 'bad',
        parent_op_id: null,
      },
    })

    // Wait for the server to process and respond with an error.
    await waitFor(() => receivedError, 4000)

    const opsAfter = host.getOps().length
    if (opsAfter !== opsBefore) {
      throw new Error(`Expected no new ops after corrupt payload (before: ${opsBefore}, after: ${opsAfter})`)
    }

    if (!receivedError) {
      throw new Error('Expected error response from server, got none')
    }

    const integrity = host.db.pragma('integrity_check')[0].integrity_check
    if (integrity !== 'ok') {
      throw new Error(`Host DB integrity check failed: ${integrity}`)
    }

    return 'PASS'
  } finally {
    host?.close()
    client?.close()
    cleanupDirs(dirs)
  }
}
