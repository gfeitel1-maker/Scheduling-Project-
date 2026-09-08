/**
 * A joining device receives the camp's WHOLE domain, not a curated subset.
 *
 * This one scenario replaces four WS scenarios — 17, 25, 26 and 27 — and the
 * reason is worth stating, because collapsing tests is usually a way to lose
 * coverage rather than keep it.
 *
 * Those four existed because the op-log's first-pairing snapshot was a
 * hand-maintained MANIFEST: a list of tables to include. Every time an entity
 * family was added and someone forgot the manifest, a joining device silently
 * came up missing it — which is exactly how 25 (week/location exclusions), 26
 * (special days) and 27 (electives) each came to be written, one per omission.
 * They are four instances of one bug: a list that has to be kept in step by
 * hand.
 *
 * Under the CRDT there is no manifest. A joining device receives the DOCUMENT,
 * and the document holds every modeled entity — so the omission those four
 * tests guarded against is not possible in the same way. What remains worth
 * asserting end-to-end is that the families they named genuinely arrive, which
 * is what this does, in one place, over a real join.
 *
 * The structural half of the old guard has a better home already:
 * campDocument.js's module-load subset guard fails loudly if a modeled entity
 * is missing from the genesis, which is the "somebody forgot the list" failure
 * caught at import time rather than at a camp.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()

    // A camp that has been set up — the state a second device would join into.
    // Parents first: each of these is an FK target for something below.
    await host.write({ entity: 'schedule_weeks', entity_id: 'week-1', field: 'name', value: 'Week 1' })
    await host.write({ entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    await host.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming' })
    await host.write({ entity: 'locations', entity_id: 'loc-1', field: 'name', value: 'Lakefront' })

    // Scenario 25's family: week/location exclusions.
    await host.write({ entity: 'week_location_exclusions', entity_id: 'wle-1', field: 'week_id', value: 'week-1' })
    await host.write({ entity: 'week_location_exclusions', entity_id: 'wle-1', field: 'location_id', value: 'loc-1' })

    // Scenario 26's family: special days.
    await host.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Visiting Day' })

    // Scenario 27's family: electives.
    await host.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })

    // Now a genuinely new device joins — code, director approval, PIN, the lot.
    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    // Scenario 17's own assertion: the camp's ordinary domain data arrives.
    await waitFor(() => !!client.domainRow('activities', 'act-1'), 8000)
    if (client.domainRow('activities', 'act-1').name !== 'Swimming') {
      throw new Error('joining device did not receive the camp\'s activities')
    }
    await waitFor(() => !!client.domainRow('groups', 'g1'), 8000)

    // And each family that used to need its own manifest entry.
    const expected = [
      ['week_location_exclusions', 'wle-1', 'the week/location exclusions of scenario 25'],
      ['special_days', 'sd-1', 'the special days of scenario 26'],
      ['elective_sets', 'es-1', 'the electives of scenario 27'],
    ]
    for (const [table, id, what] of expected) {
      await waitFor(() => !!client.domainRow(table, id), 8000)
        .catch(() => { throw new Error(`joining device never received ${what}`) })
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
