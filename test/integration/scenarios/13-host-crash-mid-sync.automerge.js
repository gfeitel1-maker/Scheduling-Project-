/**
 * Scenario 13 (libp2p): the Host disappears mid-exchange, and nothing is lost.
 *
 * The WS original was titled "Host disappears during full sync (sendMissedOps)"
 * — a mechanism that no longer exists. The event it modelled very much does:
 * somebody closes the office laptop, or the Wi-Fi drops, while a device is
 * mid-conversation with it.
 *
 * Three things must hold, and the third is the one worth the test:
 *   a. the device survives the Host vanishing — no crash, no wedged state;
 *   b. it can still be used offline, and its own writes stick;
 *   c. when the Host comes back, BOTH sides' work is there. Not the Host's
 *      overwriting the device's, and not the device's overwriting the Host's.
 *
 * (c) is where an op-log and a CRDT genuinely differ. The op-log had to replay
 * a queue in order and could half-apply it; here both sides simply hold their
 * own document and merge. That is a better property, and it should be shown
 * rather than assumed.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    await host.write({ entity: 'activities', entity_id: 'before', field: 'name', value: 'Swimming' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => !!client.domainRow('activities', 'before'), 8000)

    // The Host writes and vanishes in the same breath — the write may or may
    // not have reached the device, which is exactly the ambiguity the original
    // scenario was about. Neither outcome is a failure; losing it in BOTH
    // places would be.
    await host.write({ entity: 'activities', entity_id: 'host-side', field: 'name', value: 'Archery' })
    await host.stop()

    // (a) and (b): the device is still usable, and its own work sticks.
    await client.write({ entity: 'activities', entity_id: 'device-side', field: 'name', value: 'Canoeing' })
    if (client.domainRow('activities', 'device-side')?.name !== 'Canoeing') {
      throw new Error('the device could not write after the Host disappeared')
    }
    if (!client.domainRow('activities', 'before')) {
      throw new Error('the device lost what it already had when the Host disappeared')
    }

    // The Host comes back — a genuinely new node over the same database, which
    // is what restarting the app is.
    const returned = new AmHost(`${tmpDir}/host.db`)
    await returned.start()
    host = returned
    await client.reconnect(returned)

    // (c) Both sides' work, on both sides.
    await waitFor(() => !!returned.domainRow('activities', 'device-side'), 12000)
      .catch(() => { throw new Error('work done while the Host was away never reached it') })
    await waitFor(() => !!client.domainRow('activities', 'host-side'), 12000)
      .catch(() => { throw new Error('the write the Host made as it vanished never reached the device') })

    for (const [label, device] of [['Host', returned], ['device', client]]) {
      for (const id of ['before', 'host-side', 'device-side']) {
        if (!device.domainRow('activities', id)) {
          throw new Error(`${label} is missing '${id}' after the Host came back`)
        }
      }
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
