/**
 * Scenario 37 (libp2p): a device that just JOINED performs an appendOp-path
 * write, and the Host observes it with no restart, no reconnect, and no other
 * exchange that could carry the doc for an unrelated reason.
 *
 * `join()` (harnessAutomerge.js) assigns `this.node = session.node` but never
 * calls `setLocalWriteBroadcaster` the way `start()` and `restart()` do (see
 * those methods' comments, and liveDoc.js's own header comment on the hazard).
 * Joining is the FIRST thing every new device does, so a device that has only
 * ever joined has no broadcaster wired at all: an appendOp-path write
 * (deleteRecord, ingest, restore) updates its own document but never PUSHES
 * it. It only reaches a peer if something else happens to trigger a sync
 * exchange — the admission handshake already ran (that is how the joining
 * device got the domain data in the first place), so nothing will trigger one
 * again until a restart, a reconnect, or another write on the OTHER device.
 *
 * This scenario is deliberately adversarial about that: after `client.join`,
 * it performs exactly one write on the client and then only polls — no
 * `host.write`, no `client.restart`, no `client.reconnect`, nothing that could
 * incidentally re-trigger the Automerge sync exchange. If this scenario ever
 * passes without `join()` wiring the broadcaster, it is proof the scenario
 * itself has an incidental exchange, not proof the defect is fixed.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { deleteRecord } from '../../../electron/ops/deleteRecord.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    // An activity with nothing pointing at it — the easy delete case, because
    // the domain rule is not what this scenario is testing.
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    const joined = await client.join(host)
    await waitFor(() => !!client.domainRow('activities', 'act-1'), 8000)

    // Let the JOIN's own admission-time sync exchange fully quiesce before
    // writing. Measured directly (test/integration/debug37*.mjs, not kept):
    // deleting immediately after the join-data waitFor resolves lets the
    // write ride along on the tail of that still-converging handshake —
    // `getCurrentDoc(db)` is read fresh on every round of an in-flight
    // exchange, so a write made mid-handshake reaches the Host with NO
    // broadcaster wired at all, and the scenario passes for the wrong reason.
    // A flat settle delay closes that race; waiting on a NEGATIVE ("stayed
    // unreplicated for at least this long") has no positive condition to poll
    // for, so a fixed pause is the only tool that fits here.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // The one write. No host.write, no restart, no reconnect follows this —
    // only polling, below.
    deleteRecord(client.db, {
      entity: 'activities',
      entity_id: 'act-1',
      expected_slot_count: 0,
      author_user_id: joined.userId,
      device_id: client.deviceId,
    })
    if (client.domainRow('activities', 'act-1')) {
      throw new Error('the record was not deleted on the device that deleted it')
    }

    await waitFor(() => !host.domainRow('activities', 'act-1'), 8000)
      .catch(() => { throw new Error('a joined device\'s write never reached the Host — join() left the local-write broadcaster unwired') })

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
