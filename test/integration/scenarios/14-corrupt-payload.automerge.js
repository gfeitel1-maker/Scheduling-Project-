/**
 * Scenario 14 (libp2p): malformed input from an admitted peer is rejected
 * without damaging anything.
 *
 * The WS original sent a `submit_op` missing its `entity` field and asserted a
 * partial row never reached the `operations` table. There is no submit_op and
 * no operations table on this path, so the same PROPERTY is asserted against
 * what a peer can actually send here: raw bytes on the document protocol.
 *
 * Three shapes, all from a peer that IS admitted — an unauthenticated peer is
 * already refused by the admission gate and would prove nothing about payload
 * handling:
 *   a. bytes that are not a document at all
 *   b. a truncated document (valid prefix, cut short)
 *   c. a well-formed document built on an unrelated genesis
 *
 * In every case the node must survive, keep its own data intact, and go on
 * syncing afterwards. That last point is the one that matters: a node which
 * rejects bad input and then quietly stops working has failed this test.
 */
import * as A from '@automerge/automerge'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { createEmptyDoc, applyWrite } from '../../../electron/automerge/campDocument.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    await host.write({ entity: 'activities', entity_id: 'keep-1', field: 'name', value: 'Swimming' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => !!client.domainRow('activities', 'keep-1'), 8000)

    const garbage = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253])
    const realDoc = A.save(applyWrite(createEmptyDoc(), {
      entity: 'activities', entity_id: 'x', field: 'name', value: 'x',
    }))
    const truncated = realDoc.slice(0, Math.floor(realDoc.length / 2))
    // A document with an unrelated root — the shape Stage 5 found merges
    // "successfully" while discarding a whole side. It must not be able to
    // arrive this way either.
    const foreignGenesis = A.save(A.change(A.init(), (d) => {
      d.activities = { evil: 'Injected' }
    }))

    for (const [label, bytes] of [
      ['garbage bytes', garbage],
      ['a truncated document', truncated],
      ['a foreign-genesis document', foreignGenesis],
    ]) {
      try {
        await client.node.sendDocTo(host.node.peerId, bytes)
      } catch {
        // A refusal at the transport is a perfectly good outcome.
      }
      await new Promise((r) => setTimeout(r, 250))

      if (!host.domainRow('activities', 'keep-1')) {
        throw new Error(`the Host lost its own data after receiving ${label}`)
      }
      const integrity = host.db.pragma('integrity_check', { simple: true })
      if (integrity !== 'ok') {
        throw new Error(`the Host's database failed integrity_check after ${label}: ${integrity}`)
      }
      if (host.domainRow('activities', 'evil')) {
        throw new Error(`${label} injected a row into the Host`)
      }
    }

    // The node is not merely intact but still WORKING — the assertion that
    // separates "rejected safely" from "rejected and wedged".
    await host.write({ entity: 'activities', entity_id: 'after-1', field: 'name', value: 'Archery' })
    await waitFor(() => !!client.domainRow('activities', 'after-1'), 8000)
      .catch(() => { throw new Error('sync stopped working after the malformed payloads') })

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
