/**
 * Scenario 18 (libp2p): a device restores a deleted record while the Host is
 * away, survives a restart, and the restore reaches everyone when it returns.
 *
 * ADR docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md. The
 * original called this "the only place the restart leg can be shown honestly",
 * and that is still true: the device's database is genuinely closed and
 * reopened between pressing Restore and the Host coming back.
 *
 * What the port changes is the mechanism it is honest ABOUT. There is no queue
 * of pending operations any more — the restore is simply a write in that
 * device's own document, which is the whole point of the local-first design.
 * The property is unchanged and is the one a director cares about: work done
 * while the office computer was off does not evaporate.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { deleteRecord } from '../../../electron/ops/deleteRecord.js'
import { restoreEntity, isDeleted } from '../../../electron/ops/restore.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { userId } = await host.bootstrap()
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => !!client.domainRow('activities', 'act-1'), 8000)

    // Deleted on the Host, and the deletion reaches the device.
    deleteRecord(host.db, {
      entity: 'activities', entity_id: 'act-1', expected_slot_count: 0,
      author_user_id: userId, device_id: host.deviceId,
    })
    await waitFor(() => !client.domainRow('activities', 'act-1'), 8000)

    // The Host goes away — the office computer is switched off.
    await host.stop()

    // The director restores it from the device, with nobody to ask.
    if (!isDeleted(client.db, 'activities', 'act-1')) {
      throw new Error('the device does not consider the record deleted, so the restore proves nothing')
    }
    restoreEntity(client.db, {
      entity: 'activities', entity_id: 'act-1',
      author_user_id: userId, device_id: client.deviceId,
    })
    if (!client.domainRow('activities', 'act-1')) {
      throw new Error('the restore did not take effect on the device that made it')
    }

    // And the device restarts before the Host is back — the leg that can only
    // be shown by genuinely closing and reopening the database.
    const docDir = `${tmpDir}/client-userdata`
    await client.restart(docDir, client.campId)

    if (!client.domainRow('activities', 'act-1')) {
      throw new Error('the restore did not survive the device restarting')
    }

    // The Host comes back. Nothing is replayed or flushed — the device simply
    // has a document that says the record exists, and they converge.
    const returned = new AmHost(`${tmpDir}/host.db`)
    await returned.start()
    host = returned
    await client.reconnect(returned)

    await waitFor(() => !!returned.domainRow('activities', 'act-1'), 10000)
      .catch(() => { throw new Error('the restore never reached the Host after it came back') })

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
