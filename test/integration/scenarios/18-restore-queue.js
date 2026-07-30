/**
 * Scenario 18: Restoring a deleted record from a Client, including while the
 * Host is away.
 *
 * docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
 *
 * This is the multi-actor half of the ADR's completion evidence, and the only
 * place the restart leg can be shown honestly: the Client's DB is genuinely
 * closed and reopened between pressing Restore and the Host coming back, so
 * nothing but the pending_restores table can carry the intent across.
 *
 * Verifies:
 *   a. Host deletes a group; the Client sees the row go.
 *   b. With the Host killed, the Client's restore request is QUEUED, durably.
 *   c. The Client restarts (DB closed and reopened) — the request is still there.
 *   d. The Host returns; the Client reconnects; the record is rebuilt on the
 *      Host with every field as it was, and the queue row is gone.
 *   e. Draining again restores nothing a second time and writes no new ops.
 *   f. `users` is refused over the wire even for an admin.
 */

import { Host, Client, getFreePort, makeTmpDir, cleanupDirs, waitFor, pairAndLogin } from '../harness.js'
import { appendOp } from '../../../electron/ops/operations.js'

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()
    const host0AdminId = host.adminUserId

    client = new Client(`${tmpDir}/client.db`)
    client.open()
    await pairAndLogin(host, client)
    client.registerDevice(host.deviceId, 'Host')

    // --- a. the Host creates a group, then deletes it -----------------------
    const groupId = 'group-restore-18'
    const hostWrite = (field, value) =>
      appendOp(host.db, {
        entity: 'groups', entity_id: groupId, field, value,
        author_user_id: host.adminUserId, device_id: host.deviceId,
      })
    hostWrite('camp_id', host.campId)
    hostWrite('name', 'Aleph')
    hostWrite('availability', 'morning')
    const before = host.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)
    if (!before) throw new Error('Setup failed: the group was never created on the Host')

    hostWrite('__deleted__', 1)
    if (host.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) {
      throw new Error('Setup failed: the group is still present on the Host after the delete')
    }

    // --- f. users is refused over the wire ---------------------------------
    const opsBeforeRefusal = host.db.prepare('SELECT COUNT(*) n FROM operations').get().n
    const refused = await client.requestRestore({
      entity: 'users', entity_id: host.adminUserId, requested_by: host.adminUserId,
    })
    if (refused.error !== 'not-restorable') {
      throw new Error(`Expected users to be refused as not-restorable, got ${JSON.stringify(refused)}`)
    }
    const opsAfterRefusal = host.db.prepare('SELECT COUNT(*) n FROM operations').get().n
    if (opsAfterRefusal !== opsBeforeRefusal) {
      throw new Error('A refused restore wrote ops to the log')
    }

    // --- b. the Host goes away; the request is queued durably ---------------
    host.kill(); host = null
    await new Promise(r => setTimeout(r, 150))

    const queued = await client.requestRestore({
      entity: 'groups', entity_id: groupId, requested_by: host0AdminId,
    })
    if (!queued.queued) {
      throw new Error(`Expected the request to be queued with no Host, got ${JSON.stringify(queued)}`)
    }
    if (client.getPendingRestores().length !== 1) {
      throw new Error('Expected exactly one queued restore request')
    }

    // --- c. the app is quit and reopened ------------------------------------
    client.closeDb()
    client.open()
    const survived = client.getPendingRestores()
    if (survived.length !== 1 || survived[0].entity_id !== groupId) {
      throw new Error('The queued restore did not survive the restart')
    }

    // --- d. the Host returns --------------------------------------------------
    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await client.connect(host.serverUrl)

    await waitFor(() => !!host.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId), 8000)

    const after = host.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)
    for (const key of Object.keys(before)) {
      if (after[key] !== before[key]) {
        throw new Error(`Restored ${key} is ${JSON.stringify(after[key])}, was ${JSON.stringify(before[key])}`)
      }
    }

    await waitFor(() => client.getPendingRestores().length === 0, 8000)

    // --- e. draining again changes nothing -----------------------------------
    const opsAfterRestore = host.db.prepare('SELECT COUNT(*) n FROM operations').get().n
    await client.syncClient.drainPendingRestores()
    const opsAfterSecondDrain = host.db.prepare('SELECT COUNT(*) n FROM operations').get().n
    if (opsAfterSecondDrain !== opsAfterRestore) {
      throw new Error(
        `A second drain emitted ${opsAfterSecondDrain - opsAfterRestore} extra op(s)`
      )
    }
    const groupCount = host.db.prepare('SELECT COUNT(*) n FROM groups WHERE id = ?').get(groupId).n
    if (groupCount !== 1) {
      throw new Error(`Expected exactly one restored group, found ${groupCount}`)
    }

    return 'PASS'
  } finally {
    try { client?.close() } catch { /* ignore */ }
    try { host?.close() } catch { /* ignore */ }
    cleanupDirs(dirs)
  }
}
