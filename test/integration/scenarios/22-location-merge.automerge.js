/**
 * Scenario 22 (libp2p): merging two near-duplicate locations, and the result
 * reaching the second device.
 *
 * ADR docs/adr/2026-08-15-locations-merge-and-delete-rehome.md names this
 * scenario explicitly: a camp ends up with "Pool" and "pool", each with
 * activities bound to it, and merging them must re-point the loser's activities
 * onto the winner rather than orphaning them.
 *
 * The domain decision is `mergeLocation`'s and is pinned by its own unit tests.
 * What only a two-device scenario can show is that the re-pointing and the
 * deletion arrive TOGETHER on the other device — a merge that replicated the
 * delete but not the re-point would leave the second device with activities
 * pointing at a location that no longer exists, which is worse than either
 * half alone.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { mergeLocation } from '../../../electron/ops/deleteRecord.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId, userId } = await host.bootstrap()

    // The near-duplicate pair a director actually ends up with.
    await host.write({ entity: 'locations', entity_id: 'loc-winner', field: 'camp_id', value: campId })
    await host.write({ entity: 'locations', entity_id: 'loc-winner', field: 'name', value: 'Pool' })
    await host.write({ entity: 'locations', entity_id: 'loc-loser', field: 'camp_id', value: campId })
    await host.write({ entity: 'locations', entity_id: 'loc-loser', field: 'name', value: 'pool' })

    // An activity bound to the LOSER — the case that matters. Merging must
    // re-point it, not orphan it.
    await host.write({ entity: 'activities', entity_id: 'act-swim', field: 'name', value: 'Swimming' })
    await host.write({ entity: 'activities', entity_id: 'act-swim', field: 'location_id', value: 'loc-loser' })

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)
    await waitFor(() => client.domainRow('activities', 'act-swim')?.location_id === 'loc-loser', 8000)

    const bound = host.db
      .prepare('SELECT COUNT(*) AS c FROM activities WHERE location_id = ?')
      .get('loc-loser').c

    mergeLocation(host.db, {
      loser_id: 'loc-loser',
      winner_id: 'loc-winner',
      winner_capacity: null,
      expected_ref_count: bound,
      author_user_id: userId,
      device_id: host.deviceId,
    })

    // Both halves, on the device that did it.
    if (host.domainRow('locations', 'loc-loser')) throw new Error('the loser location survived the merge')
    if (host.domainRow('activities', 'act-swim').location_id !== 'loc-winner') {
      throw new Error('the activity was not re-pointed onto the winner')
    }

    // And both halves on the other device — the assertion this scenario exists
    // for. An activity pointing at a location that no longer exists there would
    // be a worse outcome than not merging at all.
    await waitFor(() => !client.domainRow('locations', 'loc-loser'), 8000)
      .catch(() => { throw new Error('the merge deleted the loser on the Host but not on the device') })
    await waitFor(() => client.domainRow('activities', 'act-swim')?.location_id === 'loc-winner', 8000)
      .catch(() => {
        throw new Error('the device kept an activity pointing at the merged-away location')
      })

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
