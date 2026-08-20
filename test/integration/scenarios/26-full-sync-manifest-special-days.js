/**
 * Scenario 26: T40 slice 1 — the first-pairing full_sync snapshot must ship
 * special_days, its time blocks, and its slots to a fresh Client.
 *
 * Mirrors scenario 25's regression shape for week_location_exclusions
 * (T88's manifest-drift bug class): a table registered on the send side
 * (DOMAIN_PARENT_SCOPED_ENTITIES / DIRECT_CAMP_ENTITIES) but missed on the
 * apply side (DOMAIN_SNAPSHOT_TABLES / DOMAIN_TABLE_COLUMNS) silently drops
 * rows for every fresh-paired Client. Exercises all three new tables in one
 * pass since special_day_time_blocks and special_day_slots are both
 * parent-scoped by special_day_id and would fail identically.
 *
 * docs/work/specs/2026-08-20-special-days-data-shape-design.md
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
    await host.bootstrap({ campName: 'Special Days Camp' })

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })

    const groupId = randomUUID()
    await localWriter.write({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bunk 1' })

    const specialDayId = randomUUID()
    await localWriter.write({ entity: 'special_days', entity_id: specialDayId, field: 'name', value: 'Among Us' })
    await localWriter.write({ entity: 'special_days', entity_id: specialDayId, field: 'sort_order', value: 0 })

    const timeBlockId = randomUUID()
    await localWriter.write({ entity: 'special_day_time_blocks', entity_id: timeBlockId, field: 'special_day_id', value: specialDayId })
    await localWriter.write({ entity: 'special_day_time_blocks', entity_id: timeBlockId, field: 'name', value: 'Opening' })
    await localWriter.write({ entity: 'special_day_time_blocks', entity_id: timeBlockId, field: 'sort_order', value: 0 })

    const slotId = randomUUID()
    await localWriter.write({ entity: 'special_day_slots', entity_id: slotId, field: 'special_day_id', value: specialDayId })
    await localWriter.write({ entity: 'special_day_slots', entity_id: slotId, field: 'group_id', value: groupId })
    await localWriter.write({ entity: 'special_day_slots', entity_id: slotId, field: 'time_block_id', value: timeBlockId })

    const hostDayRow = host.db.prepare('SELECT id, name FROM special_days WHERE id = ?').get(specialDayId)
    if (!hostDayRow) throw new Error('setup: special_days row was not created on the Host itself')
    const hostBlockRow = host.db.prepare('SELECT id, special_day_id, name FROM special_day_time_blocks WHERE id = ?').get(timeBlockId)
    if (!hostBlockRow) throw new Error('setup: special_day_time_blocks row was not created on the Host itself')
    const hostSlotRow = host.db.prepare('SELECT id, special_day_id, group_id, time_block_id FROM special_day_slots WHERE id = ?').get(slotId)
    if (!hostSlotRow) throw new Error('setup: special_day_slots row was not created on the Host itself')

    const client = new Client(`${tmpDir}/client.db`)
    toClose.push(client)
    client.open()
    await pairAndLogin(host, client)
    await waitFor(() => client.hasCompletedInitialSync(), 3000)

    const clientDayRow = client.db.prepare('SELECT id, name, sort_order FROM special_days WHERE id = ?').get(specialDayId)
    if (!clientDayRow) {
      throw new Error('T40: Client dropped the special_days row on first-pairing full_sync')
    }
    if (clientDayRow.name !== 'Among Us') {
      throw new Error(`T40: Client's special_days row has wrong fields: ${JSON.stringify(clientDayRow)}`)
    }

    const clientBlockRow = client.db.prepare(
      'SELECT id, special_day_id, name, sort_order FROM special_day_time_blocks WHERE id = ?'
    ).get(timeBlockId)
    if (!clientBlockRow) {
      throw new Error('T40: Client dropped the special_day_time_blocks row on first-pairing full_sync')
    }
    if (clientBlockRow.special_day_id !== specialDayId || clientBlockRow.name !== 'Opening') {
      throw new Error(`T40: Client's special_day_time_blocks row has wrong fields: ${JSON.stringify(clientBlockRow)}`)
    }

    const clientSlotRow = client.db.prepare(
      'SELECT id, special_day_id, group_id, time_block_id FROM special_day_slots WHERE id = ?'
    ).get(slotId)
    if (!clientSlotRow) {
      throw new Error('T40: Client dropped the special_day_slots row on first-pairing full_sync')
    }
    if (
      clientSlotRow.special_day_id !== specialDayId ||
      clientSlotRow.group_id !== groupId ||
      clientSlotRow.time_block_id !== timeBlockId
    ) {
      throw new Error(`T40: Client's special_day_slots row has wrong fields: ${JSON.stringify(clientSlotRow)}`)
    }

    return 'PASS'
  } finally {
    for (const obj of toClose) {
      try { obj.close() } catch { /* ignore */ }
    }
    cleanupDirs(dirs)
  }
}
