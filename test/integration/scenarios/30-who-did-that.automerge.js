/**
 * Scenario 30 (libp2p): "who changed that?" has an answer on the other device.
 *
 * CRDT_SECURITY_GAPS item 8's second half. The document used to carry field
 * VALUES only, so a change that arrived from another device had no author on
 * arrival — record history and Trash showed "Unknown" for it, which is the exact
 * symptom T22 was raised to fix, reintroduced by a different route.
 *
 * The deletion half matters most and is the harder one. Every other trace of a
 * deleted record is gone from the document by design — that absence IS the
 * delete — so naming the person who deleted it needs a marker that deliberately
 * OUTLIVES the record. That is what Trash's "deleted by" column reads.
 *
 * Asserted through `listDeleted` and `getEntityHistory` — the functions the
 * screens actually call — rather than by reading the document, because the
 * question is what a director SEES.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { listDeleted, getEntityHistory } from '../../../electron/ops/trash.js'
import { deleteRecord } from '../../../electron/ops/deleteRecord.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { userId } = await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    // The director creates an activity on the office computer, named.
    await host.write({
      entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming',
      source: 'human', author_user_id: userId,
    })
    await waitFor(() => client.domainRow('activities', 'act-1')?.name === 'Swimming', 10000)
      .catch(() => { throw new Error('the activity never reached the second device') })

    // On the OTHER device, record history must name them rather than "Unknown".
    const history = getEntityHistory(client.db, { entity: 'activities', entity_id: 'act-1' })
    const named = history.filter((h) => h.field === 'name')
    if (named.length === 0) {
      throw new Error('the second device has no history for a record it can see')
    }
    if (!named.some((h) => h.author_user_id === userId)) {
      throw new Error(
        `the second device cannot say who made this change (got ` +
        `${JSON.stringify(named.map((h) => h.author_user_id))})`
      )
    }

    // Now the director deletes it, still on the office computer.
    deleteRecord(host.db, {
      entity: 'activities', entity_id: 'act-1', expected_slot_count: 0,
      author_user_id: userId, device_id: host.deviceId,
    })
    await waitFor(() => !client.domainRow('activities', 'act-1'), 10000)
      .catch(() => { throw new Error('the deletion never reached the second device') })

    // THE ASSERTION. Trash on the second device must name who deleted it — the
    // one marker that has to outlive the record it describes.
    const trash = listDeleted(client.db)
    const entry = trash.find((t) => t.entity === 'activities' && t.entity_id === 'act-1')
    if (!entry) {
      throw new Error('the deleted record does not appear in Trash on the second device')
    }
    if (entry.deleted_by_user_id !== userId) {
      throw new Error(
        `Trash cannot say who deleted this on the second device (got ` +
        `${JSON.stringify(entry.deleted_by_user_id)})`
      )
    }
    // And it resolves to a real name, not just an id — the JOIN only works
    // because `users` is a modeled entity that replicates.
    if (!entry.deleted_by_name) {
      throw new Error('Trash has the deleter\'s id but cannot resolve it to a name')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
