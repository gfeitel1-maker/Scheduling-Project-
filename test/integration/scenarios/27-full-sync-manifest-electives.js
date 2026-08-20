/**
 * Scenario 27: T41 slice 1 — the first-pairing full_sync snapshot must ship
 * elective_sets, elective_set_activities, and a template_slots row carrying
 * elective_set_id to a fresh Client.
 *
 * Mirrors scenario 26's regression shape for special_days (T88's manifest-
 * drift bug class): a table registered on the send side (DIRECT_CAMP_ENTITIES
 * / PARENT_SCOPED_ENTITIES) but missed on the apply side
 * (DOMAIN_SNAPSHOT_TABLES / DOMAIN_TABLE_COLUMNS) silently drops rows for
 * every fresh-paired Client. Also proves template_slots' EXTENDED column
 * list (elective_set_id added to an existing entity, not a new one) ships
 * correctly — the different-shaped registration surface this slice adds
 * beyond T40's.
 *
 * docs/work/specs/2026-08-20-group-electives-design.md
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'

export async function run() {
  const dirs = []
  const toClose = []

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    const host = new Host(`${tmpDir}/host.db`)
    toClose.push(host)
    await host.start(await getFreePort())
    await host.bootstrap({ campName: 'Electives Camp' })

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })

    const activityId = randomUUID()
    await localWriter.write({ entity: 'activities', entity_id: activityId, field: 'name', value: 'Swim' })

    const templateId = randomUUID()
    await localWriter.write({ entity: 'schedule_templates', entity_id: templateId, field: 'name', value: 'Week 1' })

    const electiveSetId = randomUUID()
    await localWriter.write({ entity: 'elective_sets', entity_id: electiveSetId, field: 'name', value: 'Afternoon Chugim' })
    await localWriter.write({ entity: 'elective_sets', entity_id: electiveSetId, field: 'sort_order', value: 0 })

    const memberId = randomUUID()
    await localWriter.write({ entity: 'elective_set_activities', entity_id: memberId, field: 'elective_set_id', value: electiveSetId })
    await localWriter.write({ entity: 'elective_set_activities', entity_id: memberId, field: 'activity_id', value: activityId })

    const slotId = randomUUID()
    await localWriter.write({ entity: 'template_slots', entity_id: slotId, field: 'template_id', value: templateId })
    await localWriter.write({ entity: 'template_slots', entity_id: slotId, field: 'elective_set_id', value: electiveSetId })

    const hostSetRow = host.db.prepare('SELECT id, name FROM elective_sets WHERE id = ?').get(electiveSetId)
    if (!hostSetRow) throw new Error('setup: elective_sets row was not created on the Host itself')
    const hostMemberRow = host.db.prepare('SELECT id, elective_set_id, activity_id FROM elective_set_activities WHERE id = ?').get(memberId)
    if (!hostMemberRow) throw new Error('setup: elective_set_activities row was not created on the Host itself')
    const hostSlotRow = host.db.prepare('SELECT id, elective_set_id FROM template_slots WHERE id = ?').get(slotId)
    if (!hostSlotRow || hostSlotRow.elective_set_id !== electiveSetId) {
      throw new Error('setup: template_slots.elective_set_id was not written on the Host itself')
    }

    const client = new Client(`${tmpDir}/client.db`)
    toClose.push(client)
    client.open()
    await pairAndLogin(host, client)
    await waitFor(() => client.hasCompletedInitialSync(), 3000)

    const clientSetRow = client.db.prepare('SELECT id, name, sort_order FROM elective_sets WHERE id = ?').get(electiveSetId)
    if (!clientSetRow) {
      throw new Error('T41: Client dropped the elective_sets row on first-pairing full_sync')
    }
    if (clientSetRow.name !== 'Afternoon Chugim') {
      throw new Error(`T41: Client's elective_sets row has wrong fields: ${JSON.stringify(clientSetRow)}`)
    }

    const clientMemberRow = client.db.prepare(
      'SELECT id, elective_set_id, activity_id FROM elective_set_activities WHERE id = ?'
    ).get(memberId)
    if (!clientMemberRow) {
      throw new Error('T41: Client dropped the elective_set_activities row on first-pairing full_sync')
    }
    if (clientMemberRow.elective_set_id !== electiveSetId || clientMemberRow.activity_id !== activityId) {
      throw new Error(`T41: Client's elective_set_activities row has wrong fields: ${JSON.stringify(clientMemberRow)}`)
    }

    const clientSlotRow = client.db.prepare(
      'SELECT id, template_id, elective_set_id FROM template_slots WHERE id = ?'
    ).get(slotId)
    if (!clientSlotRow) {
      throw new Error('T41: Client dropped the template_slots row on first-pairing full_sync')
    }
    if (clientSlotRow.elective_set_id !== electiveSetId) {
      throw new Error(`T41: Client's template_slots row dropped elective_set_id: ${JSON.stringify(clientSlotRow)}`)
    }

    return 'PASS'
  } finally {
    for (const obj of toClose) {
      try { obj.close() } catch { /* ignore */ }
    }
    cleanupDirs(dirs)
  }
}
