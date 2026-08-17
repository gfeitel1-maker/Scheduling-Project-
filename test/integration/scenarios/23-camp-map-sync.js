/**
 * Scenario 23: the optional camp map's background image replicates to a
 * paired device (M6, docs/adr/2026-08-16-locations-optional-map.md D4/D6).
 *
 * Covers:
 *   1. First-pairing snapshot: a camp with an already-uploaded (capped)
 *      camp_maps row ships it to a fresh Client as part of the one-time
 *      full_sync — proving DIRECT_CAMP_ENTITIES + DOMAIN_SNAPSHOT_TABLES/
 *      DOMAIN_TABLE_COLUMNS are wired correctly end to end, not just at the
 *      registry level.
 *   2. Live update: a field written for the FIRST time on this camp_maps row
 *      (parent_op_id omitted, exactly like the real renderer's
 *      localClient.write() always calls it) reaches every OTHER already-
 *      connected device via the ordinary broadcastOps push
 *      (electron/sync/syncServer.js's handleSubmitOp) — no special-cased
 *      path for this "large" field, same mechanism every other camp-scoped
 *      field write already uses. (A REPLACEMENT of an already-snapshot-
 *      received field is deliberately not exercised here: a device that
 *      received a value via the one-time full_sync snapshot has no local
 *      operations-table row for it — by design, a snapshot ships
 *      materialized rows, not op history — so referencing that prior op's id
 *      as parent_op_id would violate operations.parent_op_id's own local FK
 *      on that device. That is a pre-existing characteristic of the
 *      snapshot+op-log split shared by every entity, not something M6
 *      introduces, and out of this slice's scope to change.)
 *   3. Permission boundary (D6): a STAFF-role Client can read the synced
 *      camp_maps row (Q7's requirement) but a staff write is rejected by the
 *      Host — both directions of the D6 carve-out, exercised over the real
 *      WS/authorize() path, not just the permissions.js unit-level registry.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor } from '../harness.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'
import { createUser } from '../../../electron/auth/localAuth.js'

// A tiny, deliberately-not-a-real-JPEG stand-in — appendOp's size guard cares
// only about string length, and the sync path only cares that the value
// round-trips byte-for-byte, so a short marker string is sufficient evidence
// without paying for a real ~500KB fixture in the integration suite.
const IMAGE_A = 'stand-in-jpeg-bytes-A'.repeat(50)

export async function run() {
  const dirs = []
  const toClose = []

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    // -----------------------------------------------------------------
    // Case 1: first-pairing snapshot ships an already-uploaded map image.
    // -----------------------------------------------------------------
    const host = new Host(`${tmpDir}/host.db`)
    toClose.push(host)
    await host.start(await getFreePort())
    await host.bootstrap({ campName: 'Camp With A Map' })

    const localWriter = createSyncClient(host.db, { device_id: host.deviceId, author_user_id: host.adminUserId })
    await localWriter.write({ entity: 'camp_maps', entity_id: host.campId, field: 'image_data', value: IMAGE_A })
    await localWriter.write({ entity: 'camp_maps', entity_id: host.campId, field: 'image_width', value: 800 })
    await localWriter.write({ entity: 'camp_maps', entity_id: host.campId, field: 'image_height', value: 600 })

    const client = new Client(`${tmpDir}/client.db`)
    toClose.push(client)
    client.open()
    await pairAndLogin(host, client)
    await waitFor(() => client.hasCompletedInitialSync(), 3000)

    const clientMapRow = client.db.prepare('SELECT * FROM camp_maps WHERE camp_id = ?').get(host.campId)
    if (!clientMapRow) throw new Error('Case 1: Client received no camp_maps row from first-pairing full_sync')
    if (clientMapRow.image_data !== IMAGE_A) {
      throw new Error('Case 1: Client camp_maps.image_data mismatch — expected the exact uploaded bytes, got a different value')
    }
    if (clientMapRow.image_width !== 800 || clientMapRow.image_height !== 600) {
      throw new Error('Case 1: Client camp_maps row is missing/wrong on image_width/image_height')
    }

    // Sanity per the ADR's "Sync payload impact" check: the snapshot this
    // Client received stayed well under any real transport constraint — the
    // whole point of the D2 cap. Not a tight assertion, just evidence the
    // capped value actually traveled as one bounded row, not something huge.
    if (IMAGE_A.length > 1_400_000) throw new Error('test fixture itself violates the cap — fix the fixture')

    // -----------------------------------------------------------------
    // Case 2: a SECOND admin device (clientB), already connected, receives
    // client's first-ever write of image_mime via the ordinary broadcastOps
    // push — no special-cased path for this field, same mechanism every
    // other camp-scoped field write already uses over the real WS path.
    // -----------------------------------------------------------------
    const clientB = new Client(`${tmpDir}/clientB.db`)
    toClose.push(clientB)
    clientB.open()
    await pairAndLogin(host, clientB)
    await waitFor(() => clientB.hasCompletedInitialSync(), 3000)

    // Each client's operations table has device_id REFERENCES devices(id)
    // with FK enforcement ON — when client broadcasts its op, clientB's
    // applyRemoteOp INSERTs a row with device_id = client.deviceId, which
    // fails the local FK (silently, per applyRemoteOp's own catch) unless
    // clientB already knows about client's device. Same registration this
    // repo's own 04-conflict.js scenario requires for the identical reason.
    clientB.registerDevice(client.deviceId, 'Client')

    const writeResult = await client.write({
      entity: 'camp_maps', entity_id: host.campId, field: 'image_mime', value: 'image/jpeg',
    })
    if (writeResult.status !== 'applied') {
      throw new Error(`Case 2: expected client's camp_maps write to apply, got ${JSON.stringify(writeResult)}`)
    }

    await waitFor(() => {
      const row = clientB.db.prepare('SELECT image_mime FROM camp_maps WHERE camp_id = ?').get(host.campId)
      return row?.image_mime === 'image/jpeg'
    }, 3000)

    // The Host's own row (source of truth) reflects the write too.
    const hostRowAfterLiveWrite = host.db.prepare('SELECT image_mime FROM camp_maps WHERE camp_id = ?').get(host.campId)
    if (hostRowAfterLiveWrite.image_mime !== 'image/jpeg') {
      throw new Error('Case 2: Host row did not reflect the live write')
    }

    // -----------------------------------------------------------------
    // Case 3: D6 permission boundary, both directions, over the real
    // WS/authorize() path (not just the permissions.js registry).
    // -----------------------------------------------------------------
    const staffPin = '4321'
    await createUser(
      host.db,
      { camp_id: host.campId, name: 'Staff Member', pin: staffPin, role: 'staff' },
      (args) => localWriter.write(args)
    )
    const staffClient = new Client(`${tmpDir}/staff-client.db`)
    toClose.push(staffClient)
    staffClient.open()
    const staffLogin = await pairAndLogin(host, staffClient, 'Staff Member', staffPin)
    if (staffLogin.role !== 'staff') throw new Error('Case 3: expected the logged-in role to be staff')
    await waitFor(() => staffClient.hasCompletedInitialSync(), 3000)

    // Direction A: staff CAN read — the full_sync snapshot itself already
    // proves this (a staff device receives the same domain snapshot any
    // device does; there is no read-time filtering by role in this codebase,
    // per CLAUDE.md's camp-isolation-by-device-db model), asserted directly.
    const staffMapRow = staffClient.db.prepare('SELECT image_data FROM camp_maps WHERE camp_id = ?').get(host.campId)
    if (!staffMapRow || staffMapRow.image_data !== IMAGE_A) {
      throw new Error('Case 3 (direction A — read): staff Client did not receive the camp map image (Q7 violated)')
    }

    // Direction B: staff CANNOT write — a staff write attempt must be
    // rejected by the Host's authorize() (camp_maps.write is not in the
    // staff grant), not silently accepted.
    const staffWriteResult = await staffClient.write({
      entity: 'camp_maps', entity_id: host.campId, field: 'image_data', value: 'staff-attempted-overwrite',
    })
    if (staffWriteResult.status === 'applied' || staffWriteResult.status === 'queued') {
      throw new Error(`Case 3 (direction B — write): expected the Host to reject a staff write to camp_maps, got ${JSON.stringify(staffWriteResult)}`)
    }
    // The Host's own row must be untouched by the rejected attempt.
    const hostMapRowAfter = host.db.prepare('SELECT image_data FROM camp_maps WHERE camp_id = ?').get(host.campId)
    if (hostMapRowAfter.image_data !== IMAGE_A) {
      throw new Error('Case 3 (direction B — write): a rejected staff write must not have changed the Host row')
    }

    return 'PASS'
  } finally {
    for (const obj of toClose) {
      try { obj.close() } catch { /* ignore */ }
    }
    cleanupDirs(dirs)
  }
}
