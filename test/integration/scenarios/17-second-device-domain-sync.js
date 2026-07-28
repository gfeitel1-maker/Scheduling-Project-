/**
 * Scenario 17: A joining device receives the current camp's domain data on
 * first pairing (T7 — "joining device gets empty camp").
 *
 * Covers the four cases required by
 * docs/superpowers/specs/2026-07-28-first-pairing-domain-sync-and-template-identity-design.md's
 * "Required integration scenario" section:
 *
 *   1. Populated-camp join: the Client's local db ends up non-empty for every
 *      camp-scoped domain table, its schedule_templates.id matches the
 *      Host's exactly, hasCompletedInitialSync() becomes true only via the
 *      full_sync_applied ack, and the Host's devices.last_synced_at is set
 *      only after that ack (not merely after the send).
 *   2. Zero-schedule join, then a concurrent first-create on both sides
 *      lands on exactly one schedule_templates row camp-wide, at the
 *      deterministic id.
 *   3. An application-level apply failure on the Client does not permanently
 *      strand the device — no ack, last_synced_at/first_sync_completed_at
 *      stay unset, and a later corrected reconnect succeeds.
 *   4. The signal the (slice-2, renderer-side) write-gate depends on is
 *      false while sync is incomplete, and the Host itself enforces nothing
 *      based on it (proving the gate is a renderer concern, not a server
 *      one) — then flips true once the completion push fires.
 */

import { randomUUID } from 'node:crypto'
import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'
import { appendBulkReplaceOp } from '../../../electron/ops/operations.js'
import { deriveScheduleTemplateId } from '../../../electron/ops/scheduleTemplateId.js'

const COHORTS_TABLE_SQL = `
  CREATE TABLE cohorts (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    name TEXT NOT NULL,
    session_week_start TEXT,
    session_week_end TEXT,
    capacity_source TEXT,
    anchor_model TEXT,
    sort_order INTEGER,
    UNIQUE(camp_id, name)
  );
`

export async function run() {
  const dirs = []
  const toClose = []

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    // -----------------------------------------------------------------
    // Case 1: populated-camp join
    // -----------------------------------------------------------------
    const host = new Host(`${tmpDir}/host.db`)
    toClose.push(host)
    await host.start(await getFreePort())
    await host.bootstrap({ campName: 'Populated Camp' })

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })
    const groupId = randomUUID()
    await localWriter.write({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bunk A' })
    const dayId = randomUUID()
    await localWriter.write({ entity: 'days_of_operation', entity_id: dayId, field: 'label', value: 'Monday' })
    const blockId = randomUUID()
    await localWriter.write({ entity: 'time_blocks', entity_id: blockId, field: 'name', value: 'Period 1' })
    const activityId = randomUUID()
    await localWriter.write({ entity: 'activities', entity_id: activityId, field: 'name', value: 'Archery' })

    const templateId = deriveScheduleTemplateId(host.campId)
    await localWriter.write({ entity: 'schedule_templates', entity_id: templateId, field: 'name', value: 'Master Template' })

    const slotId = randomUUID()
    appendBulkReplaceOp(host.db, {
      entity: 'template_slots',
      scope_id: templateId,
      rows: [{ id: slotId, template_id: templateId, group_id: groupId, activity_id: activityId, day_id: dayId, time_block_id: blockId }],
      author_user_id: host.adminUserId,
      device_id: host.deviceId,
      client_write_id: randomUUID(),
    })

    const client = new Client(`${tmpDir}/client.db`)
    toClose.push(client)
    client.open()
    await pairAndLogin(host, client)
    // full_sync is fire-and-forget from the Host's authenticate handler —
    // poll for completion rather than racing an event listener against a
    // pairAndLogin() that may already have let it land.
    await waitFor(() => client.hasCompletedInitialSync(), 3000)

    for (const [table, expectedId] of [
      ['groups', groupId],
      ['days_of_operation', dayId],
      ['time_blocks', blockId],
      ['activities', activityId],
    ]) {
      const row = client.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(expectedId)
      if (!row) throw new Error(`Case 1: Client missing ${table} row after full_sync`)
    }

    const clientTemplate = client.db.prepare('SELECT id FROM schedule_templates WHERE camp_id = ?').get(host.campId)
    if (!clientTemplate || clientTemplate.id !== templateId) {
      throw new Error(`Case 1: Client schedule_templates.id mismatch — expected ${templateId}, got ${clientTemplate?.id}`)
    }
    const clientSlot = client.db.prepare('SELECT id FROM template_slots WHERE id = ?').get(slotId)
    if (!clientSlot) throw new Error('Case 1: Client missing template_slots row after full_sync')

    if (!client.hasCompletedInitialSync()) {
      throw new Error('Case 1: Client hasCompletedInitialSync() should be true once full_sync_applied has fired')
    }

    // The Host must have latched last_synced_at — and only via the ack path,
    // not merely because the send succeeded (§2.4's actual fix).
    await waitFor(() => {
      const row = host.db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(client.deviceId)
      return !!row?.last_synced_at
    }, 3000)

    // -----------------------------------------------------------------
    // Case 2: zero-schedule join, then concurrent first-create
    // -----------------------------------------------------------------
    const host2 = new Host(`${tmpDir}/host2.db`)
    toClose.push(host2)
    await host2.start(await getFreePort())
    await host2.bootstrap({ campName: 'Empty Camp' })

    const client2 = new Client(`${tmpDir}/client2.db`)
    toClose.push(client2)
    client2.open()
    await pairAndLogin(host2, client2)
    await waitFor(() => client2.hasCompletedInitialSync(), 3000)

    if (!host2.hasCompletedInitialSync()) {
      throw new Error('Case 2: Host2 hasCompletedInitialSync() should be true trivially, at its own bootstrap')
    }
    if (!client2.hasCompletedInitialSync()) {
      throw new Error('Case 2: Client2 hasCompletedInitialSync() should be true after full_sync_applied, even for a zero-schedule camp')
    }

    const canonicalId2 = deriveScheduleTemplateId(host2.campId)
    // Two people clicking Generate near-simultaneously: Host and Client each
    // independently compute the SAME deterministic id and write to it. The
    // second write is expected to either apply cleanly or land as a
    // trivially-resolvable conflict (same entity_id, same camp_id/name) —
    // per the design doc, a recorded conflict here is an acceptable,
    // expected side effect of this case, not a failure. What actually
    // matters is that both writes targeted the SAME id, so there is never a
    // second, forked schedule_templates row.
    const hostWriter2 = createSyncClient(host2.db, { device_id: host2.deviceId, author_user_id: host2.adminUserId })
    await hostWriter2.write({ entity: 'schedule_templates', entity_id: canonicalId2, field: 'name', value: 'Master Template' })
    const clientWriteResult = await client2.write({ entity: 'schedule_templates', entity_id: canonicalId2, field: 'name', value: 'Master Template' })
    if (clientWriteResult.status !== 'applied' && clientWriteResult.status !== 'conflict') {
      throw new Error(`Case 2: expected the concurrent write to either apply or conflict, got ${JSON.stringify(clientWriteResult)}`)
    }

    const host2Templates = host2.db.prepare('SELECT id FROM schedule_templates WHERE camp_id = ?').all(host2.campId)
    if (host2Templates.length !== 1 || host2Templates[0].id !== canonicalId2) {
      throw new Error(`Case 2: expected exactly one schedule_templates row on Host2 at the canonical id, got ${JSON.stringify(host2Templates)}`)
    }

    // -----------------------------------------------------------------
    // Case 3 + 4: application-level apply failure does not permanently
    // strand a device; the completion signal stays false until it
    // genuinely succeeds; the Host enforces nothing based on it.
    // -----------------------------------------------------------------
    const host3 = new Host(`${tmpDir}/host3.db`)
    toClose.push(host3)
    await host3.start(await getFreePort())
    await host3.bootstrap({ campName: 'Fail Camp' })

    const client3 = new Client(`${tmpDir}/client3.db`)
    toClose.push(client3)
    client3.open()
    // Break the Client's OWN schema before pairing, so its first genuine
    // full_sync — otherwise entirely valid — fails at the DB-insert step
    // inside applyFullSync's transaction (a "genuine DB error", the other
    // failure class §2.3's Consequences names alongside a malformed row).
    client3.db.exec('DROP TABLE cohorts')

    await pairAndLogin(host3, client3)

    // Give the (doomed) full_sync attempt a moment to run and fail.
    await new Promise((r) => setTimeout(r, 300))

    if (client3.hasCompletedInitialSync()) {
      throw new Error('Case 3/4: Client3 hasCompletedInitialSync() should still be false after a failed apply')
    }
    const host3DeviceRow = host3.db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(client3.deviceId)
    if (host3DeviceRow?.last_synced_at) {
      throw new Error('Case 3: Host3 last_synced_at should stay NULL — no full_sync_applied was ever sent')
    }

    // Case 4: prove the write-gate is a renderer concern, not a server one —
    // a bulk_replace from this still-incomplete-sync device is NOT rejected
    // by the Host itself. (The round-trip status can still come back
    // 'error' here — client3's own full_sync never landed its `users` row,
    // by construction of this test's Case 3 setup, so it cannot locally
    // materialize the author_user_id FK on the Host's echoed-back op. That
    // is a client-side replay detail, not the Host refusing the write — what
    // this case actually asserts is that the Host's own operations log
    // recorded it at all.)
    const bulkScopeId = randomUUID()
    await client3.syncClient.writeBulkReplace({
      entity: 'template_slots',
      scope_id: bulkScopeId,
      rows: [],
    })
    const hostRecordedBulkReplace = host3.db
      .prepare("SELECT 1 FROM operations WHERE entity_id = ? AND field = '__bulk_replace__'")
      .get(bulkScopeId)
    if (!hostRecordedBulkReplace) {
      throw new Error("Case 4: expected the Host to accept and record the bulk_replace regardless of the Client's sync-completion state")
    }

    // Fix the Client's schema and reconnect — the next authenticate re-fires
    // sendFullSyncIfFirstPairing (last_synced_at is still NULL on the Host),
    // and this time the identical (still-valid) payload actually applies.
    client3.db.exec(COHORTS_TABLE_SQL)
    await client3.reconnect()
    await waitFor(() => client3.hasCompletedInitialSync(), 3000)

    if (!client3.hasCompletedInitialSync()) {
      throw new Error('Case 3: Client3 hasCompletedInitialSync() should flip true once the corrected reconnect succeeds')
    }
    await waitFor(() => {
      const row = host3.db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(client3.deviceId)
      return !!row?.last_synced_at
    }, 3000)

    return 'PASS'
  } finally {
    for (const obj of toClose) {
      try { obj.close() } catch { /* ignore */ }
    }
    cleanupDirs(dirs)
  }
}
