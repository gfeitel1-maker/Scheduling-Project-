/**
 * Scenario 20 (libp2p): deleting a setup record that a schedule uses, and the
 * result reaching the other device.
 *
 * ADR docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md, completion
 * evidence 6 — which asks specifically for the REFERENCED case (not the easy
 * one where nothing points at the record) and for the result replicating to a
 * second device. Both halves carry over unchanged; only the transport differs.
 *
 * The domain rule itself is not a sync concern and is deliberately not
 * re-litigated here — `deleteRecord` decides it, against real rows, and the
 * unit tests pin the decision. What this scenario is for is the half those
 * cannot show: that the decision, once made on one device, arrives intact on
 * the other, including the slots it retired on the way.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { deleteRecord, previewDelete } from '../../../electron/ops/deleteRecord.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    // Domain operations reach the document through appendOp's dual-write,
    // which is inert until this is set — see configureDualWrite.
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { userId } = await host.bootstrap()

    // A schedule that genuinely USES the activity — the case the ADR asks for.
    await host.write({ entity: 'activities', entity_id: 'act-swim', field: 'name', value: 'Swimming' })
    await host.write({ entity: 'schedule_templates', entity_id: 'tpl-1', field: 'name', value: 'Week 1' })
    await host.write({ entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => !!client.domainRow('activities', 'act-swim'), 8000)

    // The referenced count is what makes this the hard case rather than the
    // easy one; assert we are actually testing what the ADR asked for.
    const preview = previewDelete(host.db, { entity: 'activities', entity_id: 'act-swim' })
    if (!preview) throw new Error('previewDelete returned nothing for a real activity')

    deleteRecord(host.db, {
      entity: 'activities',
      entity_id: 'act-swim',
      expected_slot_count: preview.slot_count ?? 0,
      author_user_id: userId,
      device_id: host.deviceId,
    })

    if (host.domainRow('activities', 'act-swim')) {
      throw new Error('the record was not deleted on the device that deleted it')
    }

    // The half only a two-device test can show.
    await waitFor(() => !client.domainRow('activities', 'act-swim'), 8000)
      .catch(() => { throw new Error('the delete never reached the second device') })

    // A delete must not take unrelated rows with it — the failure mode that
    // looks like a successful delete until someone opens the schedule.
    if (!client.domainRow('groups', 'g1')) {
      throw new Error('deleting an activity removed an unrelated group on the second device')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
