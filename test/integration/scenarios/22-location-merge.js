/**
 * Scenario 22: Merging two near-duplicate locations (M3c).
 *
 * docs/adr/2026-08-15-locations-merge-and-delete-rehome.md — the integration
 * scenario the ADR names explicitly: Host has "Pool" + "pool" each with bound
 * activities; a merge re-points "pool"'s activities to "Pool", sets the
 * winner's capacity, deletes "pool" — through the real WebSocket, exactly the
 * way a Client-initiated delete/restore already does.
 *
 * Verifies:
 *   a. the re-point + delete replicate to a second real Client.
 *   b. zero activities on either device still point at the deleted "pool".
 *   c. restoring "pool" from Trash brings back an EMPTY place — it does NOT
 *      re-point the activities back (D4), and it does not collide with
 *      "Pool" (case-different names never trigger #68's unique-field guard).
 *   d. the count-drift guard aborts a merge whose bound-activity count
 *      changed between preview and confirm, leaving neither half applied.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, waitFor, pairAndLogin } from '../harness.js'
import { appendOp } from '../../../electron/ops/operations.js'
import { previewDelete } from '../../../electron/ops/deleteRecord.js'
import { restoreEntity } from '../../../electron/ops/restore.js'

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

    // --- setup: two near-duplicate places, two activities on the loser ------
    write('locations', 'loc-Pool', 'camp_id', host.campId)
    write('locations', 'loc-Pool', 'name', 'Pool')
    write('locations', 'loc-Pool', 'capacity', 1)
    write('locations', 'loc-pool', 'camp_id', host.campId)
    write('locations', 'loc-pool', 'name', 'pool')
    write('locations', 'loc-pool', 'capacity', 1)

    write('activities', 'act-swim-lessons', 'camp_id', host.campId)
    write('activities', 'act-swim-lessons', 'name', 'Swim Lessons')
    write('activities', 'act-swim-lessons', 'location_id', 'loc-pool')
    write('activities', 'act-free-swim', 'camp_id', host.campId)
    write('activities', 'act-free-swim', 'name', 'Free Swim')
    write('activities', 'act-free-swim', 'location_id', 'loc-pool')

    // --- pair a second device, AFTER the setup rows exist -------------------
    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)
    client.registerDevice(host.deviceId, 'Host')

    await waitFor(() => client.db.prepare('SELECT COUNT(*) n FROM locations').get().n === 2, 8000)
    if (!client.db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')) {
      throw new Error('Setup failed: the Client never received "pool"')
    }

    // --- d. the count-drift guard, exercised BEFORE the real merge ----------
    let preview = previewDelete(host.db, { entity: 'locations', entity_id: 'loc-pool' })
    if (preview.ref_count !== 2) throw new Error(`Preview counted ${preview.ref_count}, expected 2`)

    // A peer binds a THIRD activity to "pool" after the director's preview.
    write('activities', 'act-water-polo', 'camp_id', host.campId)
    write('activities', 'act-water-polo', 'name', 'Water Polo')
    write('activities', 'act-water-polo', 'location_id', 'loc-pool')

    const stale = await client.requestMerge({
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      winner_capacity: 3,
      expected_ref_count: preview.ref_count, // the now-stale count of 2
    })
    if (stale.error !== 'count-changed') {
      throw new Error(`Expected count-changed on a stale ref_count, got ${JSON.stringify(stale)}`)
    }
    if (host.db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool') === undefined) {
      throw new Error('An aborted merge deleted the loser anyway')
    }
    for (const id of ['act-swim-lessons', 'act-free-swim', 'act-water-polo']) {
      if (host.db.prepare('SELECT location_id FROM activities WHERE id = ?').get(id).location_id !== 'loc-pool') {
        throw new Error(`An aborted merge re-pointed ${id} anyway`)
      }
    }

    // --- a/b. the real merge, driven from the Client over the real socket ---
    preview = previewDelete(host.db, { entity: 'locations', entity_id: 'loc-pool' })
    if (preview.ref_count !== 3) throw new Error(`Preview counted ${preview.ref_count}, expected 3 after the drift`)

    const result = await client.requestMerge({
      loser_id: 'loc-pool',
      winner_id: 'loc-Pool',
      winner_capacity: 3,
      expected_ref_count: preview.ref_count,
    })
    if (!result.ok) throw new Error(`Merge failed: ${JSON.stringify(result)}`)
    if (result.cleared !== 3) throw new Error(`Cleared ${result.cleared}, expected 3`)
    if ([...result.reassigned_activity_ids].sort().join(',') !== 'act-free-swim,act-swim-lessons,act-water-polo') {
      throw new Error(`Unexpected reassigned_activity_ids: ${JSON.stringify(result.reassigned_activity_ids)}`)
    }

    if (host.db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool')) {
      throw new Error('The loser survived the merge on the Host')
    }
    if (host.db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity !== 3) {
      throw new Error('The winner capacity was not set by the merge')
    }
    for (const id of ['act-swim-lessons', 'act-free-swim', 'act-water-polo']) {
      if (host.db.prepare('SELECT location_id FROM activities WHERE id = ?').get(id).location_id !== 'loc-Pool') {
        throw new Error(`${id} was not re-pointed to the winner on the Host`)
      }
    }

    // --- a/b, continued — it replicated to the Client ------------------------
    await waitFor(() => !client.db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-pool'), 8000)
    await waitFor(
      () => client.db.prepare('SELECT location_id FROM activities WHERE id = ?').get('act-water-polo').location_id === 'loc-Pool',
      8000
    )
    for (const id of ['act-swim-lessons', 'act-free-swim', 'act-water-polo']) {
      const row = client.db.prepare('SELECT location_id FROM activities WHERE id = ?').get(id)
      if (row.location_id !== 'loc-Pool') {
        throw new Error(`Client never received ${id}'s re-point to the winner`)
      }
    }
    if (client.db.prepare('SELECT capacity FROM locations WHERE id = ?').get('loc-Pool').capacity !== 3) {
      throw new Error("Client never received the winner's new capacity")
    }

    // --- c. restoring "pool" from Trash comes back empty, no collision ------
    const restored = restoreEntity(host.db, { entity: 'locations', entity_id: 'loc-pool', ...session })
    if (!restored.ok) throw new Error(`Restoring the loser failed: ${JSON.stringify(restored)}`)

    const restoredRow = host.db.prepare('SELECT name FROM locations WHERE id = ?').get('loc-pool')
    if (!restoredRow || restoredRow.name !== 'pool') {
      throw new Error('The restored loser does not have its own name back')
    }
    if (!host.db.prepare('SELECT 1 FROM locations WHERE id = ?').get('loc-Pool')) {
      throw new Error('Restoring the loser destroyed the winner')
    }
    for (const id of ['act-swim-lessons', 'act-free-swim', 'act-water-polo']) {
      if (host.db.prepare('SELECT location_id FROM activities WHERE id = ?').get(id).location_id !== 'loc-Pool') {
        throw new Error(`Restoring the empty "pool" re-pointed ${id} back to it — D4 says restore must not do this`)
      }
    }

    return 'PASS'
  } finally {
    try { client?.close() } catch { /* ignore */ }
    try { host?.close() } catch { /* ignore */ }
    cleanupDirs(dirs)
  }
}
