// @vitest-environment node
//
// T376: enrolling a device in the signed roster must touch roster state only. The Host writes the roster entry into the
// live document at login; that write must not re-derive (delete-reconcile) unrelated tables, so a SQLite-only row the
// document does not hold survives a join.
import { describe, it, expect, afterEach } from 'vitest'
import { AmHost, AmClient, makeTmpDir, cleanupDirs } from '../../../test/integration/harnessAutomerge.js'

let host, client, tmpDir
afterEach(async () => {
  await host?.close()
  await client?.close()
  if (tmpDir) cleanupDirs([tmpDir])
  host = client = tmpDir = null
})

describe('roster enrollment scope', () => {
  it('a join (Host enrolls the device) leaves a SQLite-only row on the Host intact', async () => {
    tmpDir = makeTmpDir()
    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    await host.bootstrap()
    host.db.prepare(
      `INSERT INTO template_slots (id, template_id, flags, is_span_head, is_fixed_event) VALUES ('orphan-roster-scope', 'no-such-template', '{}', 1, 0)`
    ).run()

    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    expect(host.db.prepare('SELECT COUNT(*) AS c FROM roster_cache').get().c).toBeGreaterThan(0)
    expect(host.db.prepare("SELECT COUNT(*) AS c FROM template_slots WHERE id = 'orphan-roster-scope'").get().c).toBe(1)
  }, 60000)
})
