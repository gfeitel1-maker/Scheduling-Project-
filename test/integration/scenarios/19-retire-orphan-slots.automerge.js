/**
 * Scenario 19 (libp2p): orphaned schedule slots do not replicate.
 *
 * ADR docs/adr/2026-07-30-retiring-orphaned-schedule-slots.md. An orphan set is
 * `template_slots` rows whose `template_id` matches no `schedule_templates`
 * row — what an older renderer left behind, and what migration v26 retires.
 *
 * The migration itself is local and has its own unit test. What this scenario
 * is for is the half that needs two devices, and the reasoning behind it
 * changed with the transport, which is worth stating because it is the whole
 * point of porting rather than assuming:
 *
 *   Under the op-log, orphans could not replicate because they were written
 *   straight to SQLite by an old renderer and never produced an op. "No op, no
 *   sync" — the guarantee came from the write path.
 *
 *   Under CRDT sync there is no op-log to be absent from. What replicates is
 *   the DOCUMENT, and a row that was never written through the document layer
 *   is simply not in it. The guarantee now comes from the same place the data
 *   does.
 *
 * Same outcome, different reason — and a reason that must be checked rather
 * than inherited, because "it was never in the document" is only true while
 * nothing seeds the document from raw SQLite behind the app's back. `seedAllFromSqlite`
 * does exactly that on first enable, which is precisely why this is worth an
 * end-to-end test: seeding a camp that still carries orphans must not push them
 * to every device.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { applyBulkReplace } from '../../../electron/automerge/campDocument.js'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId.js'

const GROUP_ID = 'group-orphan-19'
const ACTIVITY_ID = 'activity-orphan-19'
const REAL_TEMPLATE_ID = 'tpl-visible-19'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId } = await host.bootstrap()

    await host.write({ entity: 'groups', entity_id: GROUP_ID, field: 'name', value: 'Bunk A' })
    await host.write({ entity: 'activities', entity_id: ACTIVITY_ID, field: 'name', value: 'Swimming' })
    await host.write({ entity: 'schedule_templates', entity_id: REAL_TEMPLATE_ID, field: 'name', value: 'Week 1' })
    await host.node.applyLocal(applyBulkReplace(host.getDoc(), {
      entity: 'template_slots',
      scope_id: REAL_TEMPLATE_ID,
      rows: [{
        id: 'visible-slot', template_id: REAL_TEMPLATE_ID,
        group_id: GROUP_ID, activity_id: ACTIVITY_ID,
      }],
    }))

    // The orphan set, written STRAIGHT TO SQLITE — which is what the old
    // renderer effectively did, and why these rows exist at all. They never
    // pass through the document layer.
    const orphanId = deriveScheduleTemplateId(campId, 'generated')
    for (let i = 0; i < 4; i++) {
      host.db.prepare(
        `INSERT INTO template_slots
           (id, template_id, group_id, activity_id, day_id, time_block_id, flags, is_span_head, is_anchor)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
      ).run(`orphan-slot-${i}`, orphanId, GROUP_ID, ACTIVITY_ID, null, null, '{}')
    }

    const orphansOnHost = host.db
      .prepare('SELECT COUNT(*) AS c FROM template_slots WHERE template_id = ?').get(orphanId).c
    if (orphansOnHost !== 4) {
      throw new Error(`the fixture failed to create orphans: ${orphansOnHost} rows`)
    }

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    // The visible week arrives…
    await waitFor(() => !!client.domainRow('template_slots', 'visible-slot'), 10000)
      .catch(() => { throw new Error('the visible week never reached the device') })

    // …and the orphans do not. Given a moment to be wrong about it: asserting
    // an absence immediately after asserting a presence would pass even if the
    // orphans were merely slower.
    await new Promise((r) => setTimeout(r, 1500))
    const orphansOnClient = client.db
      .prepare('SELECT COUNT(*) AS c FROM template_slots WHERE template_id = ?').get(orphanId).c
    if (orphansOnClient !== 0) {
      throw new Error(`the orphan set reached a paired device: ${orphansOnClient} row(s)`)
    }

    // And the Host still has its own orphans — this scenario is about them not
    // SPREADING, not about them being cleaned up, which is v26's job.
    const orphansStill = host.db
      .prepare('SELECT COUNT(*) AS c FROM template_slots WHERE template_id = ?').get(orphanId).c
    if (orphansStill !== 4) {
      throw new Error('syncing removed the Host\'s orphan rows, which is not this path\'s job')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
