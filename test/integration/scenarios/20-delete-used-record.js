/**
 * Scenario 19: Deleting a setup record that a schedule uses.
 *
 * docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md — completion
 * evidence 6, which asks for the referenced case (not the easy one) AND the
 * resulting ops replicating to a second device.
 *
 * This is the multi-actor half. It uses the real appendOp/projection path, real
 * devices and users rows (a fabricated device_id makes EVERY delete fail on the
 * operations table's OWN foreign keys with a byte-identical error string — a
 * reproduction that "confirms" the bug while proving nothing), and a real WS
 * broadcast to a paired Client.
 *
 * Verifies:
 *   a. before this change, deleting a used group is refused by the FK — the
 *      defect T21 describes, reproduced here rather than assumed.
 *   b. deleteRecord saves a version of EACH affected route, holding a real
 *      payload, BEFORE a single slot row is gone.
 *   c. the group and its 50 slots are gone; the OTHER group's week is untouched.
 *   d. restoring the saved version brings the week back.
 *   e. every child removal replicates to the Client as its own op, and the
 *      Client's `groups` row is genuinely gone — applyRemoteOp would swallow a
 *      failure to remove it.
 *   f. the parent delete is the LAST op, so a peer applying in seq order never
 *      violates its own foreign_keys = ON.
 *   g. deleting an activity empties its cells and leaves the grid intact.
 *   h. deleting a day takes its anchors and the orphan slots no FK
 *      protects.
 *   i. a failed save aborts the delete and destroys nothing.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, waitFor, pairAndLogin } from '../harness.js'
import { appendOp, DELETE_FIELD } from '../../../electron/ops/operations.js'
import { previewDelete, deleteRecord } from '../../../electron/ops/deleteRecord.js'

const DAYS = 5
const BLOCKS = 5

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    const session = { author_user_id: host.adminUserId, device_id: host.deviceId }
    const write = (entity, entity_id, field, value) =>
      appendOp(host.db, { entity, entity_id, field, value, ...session })

    // --- setup: two real routes, two groups, a full week each ---------------
    const templates = {}
    for (const kind of ['generated', 'manual']) {
      const id = `template-${kind}`
      host.db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
        .run(id, host.campId, kind, kind)
      templates[kind] = id
    }

    const groupIds = ['group-bunk-1', 'group-bunk-2']
    for (const [i, id] of groupIds.entries()) {
      write('groups', id, 'camp_id', host.campId)
      write('groups', id, 'name', `Bunk ${i + 1}`)
    }
    const dayIds = []
    for (let d = 0; d < DAYS; d++) {
      const id = `day-${d}`
      write('days_of_operation', id, 'camp_id', host.campId)
      write('days_of_operation', id, 'label', `Day ${d}`)
      dayIds.push(id)
    }
    const blockIds = []
    for (let b = 0; b < BLOCKS; b++) {
      const id = `block-${b}`
      write('time_blocks', id, 'camp_id', host.campId)
      write('time_blocks', id, 'name', `Block ${b}`)
      blockIds.push(id)
    }
    write('activities', 'activity-archery', 'camp_id', host.campId)
    write('activities', 'activity-archery', 'name', 'Archery')

    const insertSlot = host.db.prepare(
      'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const tid of Object.values(templates)) {
      for (const gid of groupIds) {
        for (const dayId of dayIds) {
          for (const blockId of blockIds) {
            insertSlot.run(`slot-${tid}-${gid}-${dayId}-${blockId}`, tid, gid, 'activity-archery', dayId, blockId)
          }
        }
      }
    }

    const slotsFor = (gid) =>
      host.db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(gid).n
    if (slotsFor(groupIds[0]) !== 50) {
      throw new Error(`Setup failed: expected 50 slots for Bunk 1, found ${slotsFor(groupIds[0])}`)
    }

    // --- a. the defect, reproduced ------------------------------------------
    let refused = false
    try {
      write('groups', groupIds[0], DELETE_FIELD, 1)
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err
      refused = true
    }
    if (!refused) {
      throw new Error('Expected the ordinary delete path to be refused by the foreign key')
    }
    if (host.db.prepare('SELECT COUNT(*) n FROM operations WHERE entity = ? AND field = ?')
      .get('groups', DELETE_FIELD).n !== 0) {
      throw new Error('A refused delete left an op in the log')
    }

    // --- pair a second device, AFTER the setup rows exist -------------------
    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)
    // Pre-T85 this required manually registering the host's device row on
    // the client (docs/adr/2026-08-16-device-fk-seeding-and-delivery-
    // watermark.md) — applyRemoteOp now stub-seeds the author's devices row
    // itself.

    await waitFor(() => client.db.prepare('SELECT COUNT(*) n FROM template_slots').get().n === 100, 8000)
    if (!client.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupIds[0])) {
      throw new Error('Setup failed: the Client never received Bunk 1')
    }

    // --- i. a failed save aborts, and destroys nothing ----------------------
    const realPrepare = host.db.prepare.bind(host.db)
    host.db.prepare = (sql) =>
      sql.includes('SELECT template_id, slots FROM schedule_snapshots')
        ? { get: () => ({ template_id: 'x', slots: null }) }
        : realPrepare(sql)
    let aborted
    try {
      aborted = deleteRecord(host.db, { entity: 'groups', entity_id: groupIds[0], expected_slot_count: 50, ...session })
    } finally {
      host.db.prepare = realPrepare
    }
    if (aborted.error !== 'snapshot-failed') {
      throw new Error(`Expected snapshot-failed, got ${JSON.stringify(aborted)}`)
    }
    if (slotsFor(groupIds[0]) !== 50 || !host.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupIds[0])) {
      throw new Error('A delete that could not save a version destroyed something anyway')
    }
    if (host.db.prepare('SELECT COUNT(*) n FROM schedule_snapshots').get().n !== 0) {
      throw new Error('A failed save left a half-done version behind')
    }

    // --- b/c. the 75-slot case, not the easy one ----------------------------
    const preview = previewDelete(host.db, { entity: 'groups', entity_id: groupIds[0] })
    if (preview.slot_count !== 50) {
      throw new Error(`Preview counted ${preview.slot_count}, expected 50`)
    }
    if (preview.routes.length !== 2) {
      throw new Error(`Expected 2 affected routes, got ${preview.routes.length} — "each affected route" is not rhetorical`)
    }

    // Driven from the CLIENT, over the real WebSocket, so the Host executes it
    // and broadcasts the resulting ops — the replication leg below is only
    // honest if the ops actually crossed the wire.
    const result = await client.requestDelete({
      entity: 'groups',
      entity_id: groupIds[0],
      expected_slot_count: preview.slot_count,
    })
    if (!result.ok) throw new Error(`Delete failed: ${JSON.stringify(result)}`)
    if (result.cleared !== 50) throw new Error(`Cleared ${result.cleared}, expected 50`)

    const snapshots = host.db.prepare('SELECT * FROM schedule_snapshots').all()
    if (snapshots.length !== 2) {
      throw new Error(`Expected one saved version per route, found ${snapshots.length}`)
    }
    for (const snap of snapshots) {
      const slots = JSON.parse(snap.slots)
      if (slots.length !== 50) {
        throw new Error(`A saved version holds ${slots.length} slots — it must hold the WHOLE route, or restoring it deletes the other group's week`)
      }
      if (!slots.some((s) => s.group_id === groupIds[0])) {
        throw new Error('A saved version was written AFTER the rows were removed — it does not contain the deleted week')
      }
    }

    if (slotsFor(groupIds[0]) !== 0) throw new Error("Bunk 1's slots survived the delete")
    if (slotsFor(groupIds[1]) !== 50) throw new Error("Bunk 2's week was destroyed along with Bunk 1's")
    if (host.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupIds[0])) {
      throw new Error('The group itself survived the delete')
    }

    // --- f. ordering: the parent delete is last -----------------------------
    // Load-bearing, not incidental: a peer applies in seq order with its own
    // foreign_keys = ON, so a parent delete appended before its children would
    // be silently correct on the Host and silently broken on every peer.
    const deleteOps = host.db
      .prepare('SELECT entity, seq FROM operations WHERE field = ? ORDER BY seq ASC')
      .all(DELETE_FIELD)
    const parentIndex = deleteOps.findIndex((o) => o.entity === 'groups')
    if (parentIndex !== deleteOps.length - 1) {
      throw new Error('The parent delete is not the last delete op — a peer applying in order would violate its own FK')
    }

    // --- e. it all replicated, and the peer's group row is genuinely gone ----
    await waitFor(
      () => !client.db.prepare('SELECT 1 FROM template_slots WHERE group_id = ? AND template_id = ?')
        .get(groupIds[0], templates.manual),
      8000
    )
    // The one applyRemoteOp swallows by design. If the peer failed to remove
    // the row it would keep a bunk the Host deleted, forever, silently.
    await waitFor(() => !client.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupIds[0]), 8000)

    const clientSlotDeletes = client.db
      .prepare('SELECT COUNT(*) n FROM operations WHERE entity = ? AND field = ?')
      .get('template_slots', DELETE_FIELD).n
    if (clientSlotDeletes !== 50) {
      throw new Error(
        `The peer received ${clientSlotDeletes} slot-delete ops, expected 50 — child effects must be RECORDED, never re-derived on each device`
      )
    }
    if (client.db.prepare('SELECT COUNT(*) n FROM template_slots WHERE group_id = ?').get(groupIds[1]).n !== 50) {
      throw new Error("The peer lost Bunk 2's week")
    }

    // --- d. restoring the version brings the week back ----------------------
    const snapshot = snapshots[0]
    const restored = JSON.parse(snapshot.slots)
    const restoreRows = restored.map((s, i) => ({
      id: `restored-${i}`,
      template_id: snapshot.template_id,
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
    }))
    const { appendBulkReplaceOp } = await import('../../../electron/ops/operations.js')
    // The group row has to come back first — template_slots.group_id is a real
    // FK, which is exactly what makes Trash and Versions two separate steps.
    const { restoreEntity } = await import('../../../electron/ops/restore.js')
    const back = restoreEntity(host.db, { entity: 'groups', entity_id: groupIds[0], ...session })
    if (!back.ok) throw new Error(`Restoring the group failed: ${JSON.stringify(back)}`)
    appendBulkReplaceOp(host.db, {
      entity: 'template_slots',
      scope_id: snapshot.template_id,
      rows: restoreRows,
      ...session,
    })
    if (slotsFor(groupIds[0]) !== 25) {
      throw new Error(`Restoring the version brought back ${slotsFor(groupIds[0])} of Bunk 1's 25 slots in that route`)
    }

    // --- g. an activity: cells emptied, grid intact -------------------------
    const gridBefore = host.db.prepare('SELECT COUNT(*) n FROM template_slots').get().n
    const actPreview = previewDelete(host.db, { entity: 'activities', entity_id: 'activity-archery' })
    if (actPreview.destructive) throw new Error('Deleting an activity must not be treated as destructive')
    const actResult = deleteRecord(host.db, {
      entity: 'activities',
      entity_id: 'activity-archery',
      expected_slot_count: actPreview.slot_count,
      ...session,
    })
    if (!actResult.ok) throw new Error(`Deleting the activity failed: ${JSON.stringify(actResult)}`)
    if (host.db.prepare('SELECT COUNT(*) n FROM template_slots').get().n !== gridBefore) {
      throw new Error('Deleting an activity removed grid cells — it must only empty them')
    }
    if (host.db.prepare('SELECT COUNT(*) n FROM template_slots WHERE activity_id IS NOT NULL').get().n !== 0) {
      throw new Error('Deleting the activity left it placed somewhere')
    }

    // --- h. a day: anchors and the orphans no FK protects -------------------
    write('anchor_activities', 'anchor-1', 'camp_id', host.campId)
    write('anchor_activities', 'anchor-1', 'day_id', dayIds[0])

    const dayPreview = previewDelete(host.db, { entity: 'days_of_operation', entity_id: dayIds[0] })
    if (dayPreview.anchor_count !== 1) {
      throw new Error(`Day preview reported ${dayPreview.anchor_count} anchors, expected 1`)
    }
    const dayResult = deleteRecord(host.db, {
      entity: 'days_of_operation',
      entity_id: dayIds[0],
      expected_slot_count: dayPreview.slot_count,
      ...session,
    })
    if (!dayResult.ok) throw new Error(`Deleting the day failed: ${JSON.stringify(dayResult)}`)
    for (const [table, column] of [['anchor_activities', 'day_id'], ['template_slots', 'day_id']]) {
      const left = host.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`).get(dayIds[0]).n
      if (left !== 0) {
        throw new Error(`Deleting the day left ${left} orphaned ${table} row(s) pointing at a day that no longer exists`)
      }
    }

    return 'PASS'
  } finally {
    try { client?.close() } catch { /* ignore */ }
    try { host?.close() } catch { /* ignore */ }
    cleanupDirs(dirs)
  }
}
