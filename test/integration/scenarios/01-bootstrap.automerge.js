/**
 * Scenario 1 (Stage 6a libp2p port): fresh Host bootstrap + Client pairing
 * and first sync of DOMAIN data.
 *
 * Ported from 01-bootstrap.js with ONE deliberate scope change: the
 * original asserted the Client received `camps`/`users` rows via the
 * op-log's full_sync. Those tables are device-local infrastructure under
 * the Automerge engine (see harnessAutomerge.js's header comment and
 * electron/automerge/hostOnlyExclusion.test.js) and are never replicated —
 * there is no libp2p equivalent of "seed my local camps/users rows from the
 * Host" today. This port instead asserts what IS synced: a Host-authored
 * domain write reaches the Client, and a Client-authored domain write
 * reaches the Host — the actual bootstrap+first-sync contract for the CRDT
 * document.
 */

import { randomUUID } from 'node:crypto'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap({ campName: 'Camp Test', adminName: 'admin', adminPin: '1234' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()

    const loginResult = await client.join(host)
    if (loginResult.role !== 'admin') throw new Error(`Expected admin, got ${loginResult.role}`)

    // Host writes a domain entity -> Client must receive it via the sync protocol.
    const hostEntityId = randomUUID()
    await host.write({ entity: 'activities', entity_id: hostEntityId, field: 'name', value: 'Swim' })
    await waitFor(() => !!client.domainRow('activities', hostEntityId), 6000)
    const clientRow = client.domainRow('activities', hostEntityId)
    if (clientRow.name !== 'Swim') throw new Error(`Expected Swim, got ${clientRow.name}`)

    // Client writes a domain entity -> Host must receive it.
    const clientEntityId = randomUUID()
    const result = await client.write({ entity: 'activities', entity_id: clientEntityId, field: 'name', value: 'Archery' })
    if (result.status !== 'applied') throw new Error(`Expected applied, got ${result.status}`)
    await waitFor(() => !!host.domainRow('activities', clientEntityId), 6000)
    const hostRow = host.domainRow('activities', clientEntityId)
    if (hostRow.name !== 'Archery') throw new Error(`Expected Archery, got ${hostRow.name}`)

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
