/**
 * Scenario 21 (libp2p): ingesting a prior year's schedule, and everything it
 * created reaching the second device.
 *
 * ADR docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, completion
 * evidence 2/3/5. The original asserted three things: that both file layouts
 * parse, that only the APPROVED subset is written, and that the result
 * replicates.
 *
 * The first two are pure `commitIngest` and are pinned by its own unit tests
 * against the same sample files; re-asserting them here would duplicate that
 * coverage without adding a device. What only this scenario can show is the
 * third — and it is the interesting one, because ingest is the biggest single
 * write this app performs. It creates groups, days, activities and time blocks
 * in one transaction, and a director doing it on the office computer expects to
 * pick up the iPad and see the year already there.
 *
 * The approval half IS kept, in one line: a name the director removed from the
 * proposal must not turn up on the other device either. A sync layer that
 * replicated the whole file rather than what was committed would pass every
 * other assertion here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite } from '../harnessAutomerge.js'
import { commitIngest } from '../../../electron/ops/ingest.js'
import { parseTextGrid } from '../../../src/ingest/textGrid.js'
import { extractEntities } from '../../../src/ingest/extractEntities.js'

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    configureDualWrite(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId, userId } = await host.bootstrap()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    const parsed = extractEntities(
      parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-by-day.txt'), 'utf8'))
    )

    // The director drops one group from the proposal before committing.
    const rejected = parsed.entities.groups[0]
    const approved = {
      groups: parsed.entities.groups.filter((n) => n !== rejected),
      days_of_operation: parsed.entities.days_of_operation,
      activities: parsed.entities.activities,
      time_blocks: parsed.entities.time_blocks,
    }

    const result = commitIngest(host.db, {
      approved, camp_id: campId, author_user_id: userId, device_id: host.deviceId,
    })
    if (!(result.total > 0)) throw new Error('the ingest created nothing, so there is nothing to replicate')

    const countOn = (device, table) =>
      device.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
    const namesOn = (device, table) =>
      device.db.prepare(`SELECT name FROM ${table}`).all().map((r) => r.name)

    // A whole year's setup, arriving on the other device.
    for (const table of ['groups', 'days_of_operation', 'activities', 'time_blocks']) {
      const expected = countOn(host, table)
      if (expected === 0) continue
      await waitFor(() => countOn(client, table) === expected, 20000)
        .catch(() => {
          throw new Error(
            `${table}: the device has ${countOn(client, table)} of the Host's ${expected} after the ingest`
          )
        })
    }

    // And the group the director removed is absent on BOTH — what replicated is
    // what was committed, not what the file offered.
    if (namesOn(host, 'groups').includes(rejected)) {
      throw new Error('a rejected group was written on the Host')
    }
    if (namesOn(client, 'groups').includes(rejected)) {
      throw new Error('a rejected group reached the second device')
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
