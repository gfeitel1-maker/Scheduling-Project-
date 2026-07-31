/**
 * Scenario 19: Retiring orphaned schedule slots (migration v26).
 *
 * docs/adr/2026-07-30-retiring-orphaned-schedule-slots.md
 *
 * This is the multi-actor, real-database half of the ADR's evidence — the part
 * the unit tests cannot show honestly. It uses a genuinely bootstrapped Host
 * db, closes it, and reopens it through openLocalDb so v26 runs exactly as it
 * will on a director's machine.
 *
 * Verifies:
 *   a. Orphans are invisible to sync: a paired Client receives the visible week
 *      and never the orphan set, BEFORE v26 runs. (This is why v26 emits no op
 *      and needs none.)
 *   b. After the Host restarts, zero template_slots rows have no owning
 *      schedule_templates row — ADR completion evidence 1.
 *   c. The recovered week is present in Versions, restorable, and belongs to
 *      the generated route — evidence 2.
 *   d. The visible week is untouched, and the Client's view of it is unchanged
 *      by the migration.
 *   e. The T21 PRECONDITION now holds: every place the group is used is
 *      attributable to a route, so every affected route can be snapshotted
 *      before a delete. This is as close to evidence 6 as this branch can get —
 *      the delete flow itself lives on feat/delete-used-records, which must not
 *      be merged or modified here, so the delete cannot be executed. When that
 *      branch lands, extend this scenario to perform the delete.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, waitFor, pairAndLogin } from '../harness.js'
import { openLocalDb } from '../../../electron/db/localDb.js'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId.js'
import { parseSnapshotPayload, isRestorable } from '../../../src/screens/snapshotRestore.js'
import { appendOp } from '../../../electron/ops/operations.js'

const REAL_TEMPLATE_ID = 'random-uuid-generated-template'
const GROUP_ID = 'group-orphan-19'
const ACTIVITY_ID = 'activity-orphan-19'

export async function run() {
  const dirs = []
  let host, client, reopened

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()
    const campId = host.campId

    const write = (entity, entityId, fields) => {
      for (const [field, value] of Object.entries(fields)) {
        appendOp(host.db, {
          entity, entity_id: entityId, field, value,
          author_user_id: host.adminUserId, device_id: host.deviceId,
        })
      }
    }

    write('groups', GROUP_ID, { camp_id: campId, name: 'Bunk 2' })
    write('activities', ACTIVITY_ID, { camp_id: campId, name: 'Swim' })
    // The camp's real generated template carries a RANDOM uuid, as camps built
    // in the v23 window do.
    write('schedule_templates', REAL_TEMPLATE_ID, {
      kind: 'generated', camp_id: campId, name: 'Master Template',
    })
    write('template_slots', 'visible-slot-1', {
      template_id: REAL_TEMPLATE_ID, group_id: GROUP_ID, activity_id: ACTIVITY_ID,
      day_id: 'day-0', time_block_id: 'block-0', flags: '{}',
    })

    // The orphan set: slots written under the DERIVED generated id, which no
    // schedule_templates row holds. Written straight to the table because that
    // is what the v23 renderer effectively produced — template_slots has no
    // declared FK, so SQLite accepted them.
    const orphanId = deriveScheduleTemplateId(campId, 'generated')
    for (let i = 0; i < 4; i++) {
      host.db.prepare(
        `INSERT INTO template_slots
           (id, template_id, group_id, activity_id, day_id, time_block_id, flags, is_span_head, is_anchor)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
      ).run(`orphan-slot-${i}`, orphanId, GROUP_ID, ACTIVITY_ID, `day-${i}`, `block-${i}`, '{}')
    }

    // --- a. orphans do not, and cannot, replicate ---------------------------
    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)

    await waitFor(() =>
      client.db.prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?')
        .get(REAL_TEMPLATE_ID).c === 1
    )
    const clientOrphans = client.db
      .prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(orphanId).c
    if (clientOrphans !== 0) {
      throw new Error(`Expected the orphan set never to reach a peer, found ${clientOrphans} row(s)`)
    }
    client.close(); client = null

    // --- the Host restarts, and v26 runs on a real database -----------------
    const hostDbPath = host.dbPath
    host.close(); host = null

    // Roll the version back so this reopen actually re-runs v26 (the harness
    // bootstrapped an already-current db).
    reopened = openLocalDb(hostDbPath)
    reopened.prepare('DELETE FROM schema_migrations WHERE version >= 26').run()
    reopened.close()
    reopened = openLocalDb(hostDbPath)

    // --- b. no routeless slot remains ---------------------------------------
    const routeless = reopened.prepare(
      `SELECT COUNT(*) c FROM template_slots s
        WHERE NOT EXISTS (SELECT 1 FROM schedule_templates t WHERE t.id = s.template_id)`
    ).get().c
    if (routeless !== 0) {
      throw new Error(`Expected 0 routeless template_slots after v26, got ${routeless}`)
    }

    // --- c. the recovered week is a real, restorable Version ----------------
    const snap = reopened.prepare("SELECT * FROM schedule_snapshots WHERE id LIKE 'v26-recovered:%'").get()
    if (!snap) throw new Error('Expected a recovered Version after v26, found none')
    if (snap.template_id !== REAL_TEMPLATE_ID) {
      throw new Error(
        `The Version must belong to the real generated template or restoreSnapshot refuses it; ` +
        `got ${snap.template_id}`
      )
    }
    if (snap.is_auto !== 0) throw new Error('The recovered Version must be a manual save, not an auto one')
    if (/orphan|template_id|migration/i.test(snap.name || '')) {
      throw new Error(`The Version name is director-facing and must not use jargon: ${snap.name}`)
    }
    if (!isRestorable(snap)) throw new Error('The recovered Version is not restorable')
    const parsed = parseSnapshotPayload(snap)
    if (!parsed.ok) throw new Error(`The recovered Version does not parse: ${parsed.reason}`)
    if (parsed.slots.length !== 4) {
      throw new Error(`Expected all 4 orphan slots preserved, got ${parsed.slots.length}`)
    }

    // --- d. the visible week is untouched -----------------------------------
    const visible = reopened
      .prepare('SELECT COUNT(*) c FROM template_slots WHERE template_id = ?').get(REAL_TEMPLATE_ID).c
    if (visible !== 1) {
      throw new Error(`v26 must not touch the week the director can see; expected 1 slot, got ${visible}`)
    }

    // --- e. the T21 precondition ---------------------------------------------
    // T21 refuses to delete a used record unless every affected route can be
    // snapshotted first. Before v26 four of this group's five placements sat in
    // no route at all, so the delete was refused outright. Now every placement
    // resolves to a route.
    const unattributable = reopened.prepare(
      `SELECT COUNT(*) c FROM template_slots s
        WHERE s.group_id = ?
          AND NOT EXISTS (SELECT 1 FROM schedule_templates t WHERE t.id = s.template_id)`
    ).get(GROUP_ID).c
    if (unattributable !== 0) {
      throw new Error(
        `T21 stays blocked: ${unattributable} of this group's placements are in no route ` +
        `and so cannot be saved before a delete`
      )
    }
    const routes = reopened.prepare(
      `SELECT DISTINCT t.kind FROM template_slots s
         JOIN schedule_templates t ON t.id = s.template_id
        WHERE s.group_id = ?`
    ).all(GROUP_ID).map((r) => r.kind)
    if (routes.length !== 1 || routes[0] !== 'generated') {
      throw new Error(`Expected the group's remaining placements to resolve to the generated route, got ${JSON.stringify(routes)}`)
    }

    reopened.close(); reopened = null
    return 'PASS'
  } finally {
    if (client) client.close()
    if (host) host.close()
    if (reopened) { try { reopened.close() } catch { /* ignore */ } }
    cleanupDirs(dirs)
  }
}
