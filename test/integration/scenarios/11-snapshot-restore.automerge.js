/**
 * Scenario 11 (libp2p): a named saved version replicates and still shows the
 * state it captured, after the live schedule has moved on.
 *
 * The WS original captured a pre-resolution copy of the DATABASE and asserted
 * it had "fewer ops" than the live one. That framing is gone with the op-log,
 * and it was always a proxy for the property a director actually relies on: a
 * saved version is a point in time that later edits do not rewrite.
 *
 * That property carries extra weight now. The owner released the op-log partly
 * on this basis — *"if they want to redo something they can edit it back to that
 * place or save the version as a named one and get back to it from there"* — so
 * named versions are the undo story, and they must replicate like anything else.
 * This is the end-to-end check behind that sentence.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { applyBulkReplace } from '../../../electron/automerge/campDocument.js'

const SLOTS_AT_SAVE = JSON.stringify([
  { id: 'slot-1', template_id: 'tpl-1', activity_id: 'act-swim' },
])

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    await host.write({ entity: 'schedule_templates', entity_id: 'tpl-1', field: 'name', value: 'Week 1' })
    for (const id of ['act-swim', 'act-archery']) {
      await host.write({ entity: 'activities', entity_id: id, field: 'name', value: id })
    }
    await host.node.applyLocal(applyBulkReplace(host.getDoc(), {
      entity: 'template_slots',
      scope_id: 'tpl-1',
      rows: [{ id: 'slot-1', template_id: 'tpl-1', activity_id: 'act-swim' }],
    }))

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => client.domainRow('template_slots', 'slot-1')?.activity_id === 'act-swim', 8000)

    // The director saves a named version.
    await host.write({ entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'template_id', value: 'tpl-1' })
    await host.write({ entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'name', value: 'Before the swap' })
    await host.write({ entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'is_auto', value: '0' })
    await host.write({ entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'created_at', value: '2026-09-08T12:00:00.000Z' })
    await host.write({ entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'slots', value: SLOTS_AT_SAVE })

    // Wait on the SLOTS — the field this scenario later asserts on — not on the
    // name. Fields of one record arrive across several merges, so waiting on a
    // sibling field and then reading this one is a race, and it fails looking
    // like "the version was rewritten" rather than like a test that measured
    // the wrong thing. (Third time this shape has bitten in this port batch.)
    await waitFor(() => client.domainRow('schedule_snapshots', 'snap-1')?.slots === SLOTS_AT_SAVE, 10000)
      .catch(() => { throw new Error('the saved version never reached the second device intact') })
    if (client.domainRow('schedule_snapshots', 'snap-1').name !== 'Before the swap') {
      throw new Error('the saved version arrived without the name the director gave it')
    }

    // Now the live schedule moves on, from the OTHER device.
    await client.node.applyLocal(applyBulkReplace(client.getDoc(), {
      entity: 'template_slots',
      scope_id: 'tpl-1',
      rows: [{ id: 'slot-1', template_id: 'tpl-1', activity_id: 'act-archery' }],
    }))
    await waitFor(() => host.domainRow('template_slots', 'slot-1')?.activity_id === 'act-archery', 8000)

    // The live schedule changed on both devices…
    if (client.domainRow('template_slots', 'slot-1').activity_id !== 'act-archery') {
      throw new Error('the live edit did not apply on the device that made it')
    }

    // …and the saved version did NOT. This is the whole assertion: an edit
    // after the save must not reach back and rewrite what was saved.
    for (const [label, device] of [['Host', host], ['device', client]]) {
      const snap = device.domainRow('schedule_snapshots', 'snap-1')
      if (snap.slots !== SLOTS_AT_SAVE) {
        throw new Error(`the saved version was rewritten by a later edit on the ${label}`)
      }
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
