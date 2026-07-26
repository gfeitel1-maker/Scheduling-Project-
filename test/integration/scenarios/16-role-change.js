/**
 * Scenario 16: Mid-session role change takes effect without token re-issue.
 *
 * authorize() re-queries the DB on every call (per the ADR and the unit test
 * in electron/main.test.js).  This scenario proves that property survives the
 * full Host-process WS boundary — i.e. it's not merely an in-process guarantee.
 *
 * Steps:
 *   1. Bootstrap: alice (admin) + bob (staff).
 *   2. Bob logs in; submits an activities.write op (staff-permitted) → succeeds.
 *   3. Alice promotes Bob to admin directly in the Host DB (host.dbExec — test-only).
 *   4. Bob (same token) submits a template_slots.bulk_replace op (admin-only) → succeeds.
 *   5. Alice reverts Bob to staff in the Host DB.
 *   6. Bob (same token) retries the admin-only action → rejected with { type: 'error' }.
 *
 * The admin-only action used is submit_bulk_replace_op for template_slots:
 *   - staff has template_slots.write but NOT template_slots.bulk_replace
 *   - admin has ['*'] which covers template_slots.bulk_replace
 *   - template_slots is a valid BULK_REPLACE_ENTITIES entry so the operation
 *     succeeds end-to-end (empty rows on a fresh scope_id yields no conflict)
 */

import { randomUUID } from 'node:crypto'
import {
  Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor,
} from '../harness.js'
import { createUser } from '../../../electron/auth/localAuth.js'
import { createSyncClient } from '../../../electron/sync/syncClient.js'

export async function run() {
  const dirs = []
  let host, clientBob

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)

    // Step 1: Bootstrap with alice as admin, then create bob as staff.
    const { campId } = await host.bootstrap({ adminName: 'alice', adminPin: '1111' })

    const localClient = createSyncClient(host.db, {
      device_id: host.deviceId,
      author_user_id: null,
    })
    const bob = await createUser(
      host.db,
      { camp_id: campId, name: 'bob', pin: '2222', role: 'staff' },
      (args) => localClient.write(args)
    )

    // Step 2: Bob logs in and gets a token.
    clientBob = new Client(`${tmpDir}/bob.db`)
    clientBob.open()
    const loginResult = await pairAndLogin(host, clientBob, 'bob', '2222')
    if (!loginResult.token) throw new Error('Bob did not receive a token')

    // Staff-permitted write: activities.write (survives regardless of later role).
    const opsBefore = host.getOps().length
    clientBob.sendRawMessage({
      type: 'submit_op',
      op: {
        entity: 'activities',
        entity_id: randomUUID(),
        field: 'name',
        value: 'StaffActivity',
        parent_op_id: null,
        client_write_id: randomUUID(),
      },
    })
    await waitFor(() => host.getOps().length > opsBefore, 5000)

    // Verify the staff write landed (activities.write is staff-permitted).
    const staffOp = host.getOps().find(o => o.value === 'StaffActivity')
    if (!staffOp) throw new Error('Step 2: staff write did not land on Host')

    // Step 3: Promote Bob to admin directly in the Host DB (TEST-ONLY via dbExec).
    host.dbExec("UPDATE users SET role = 'admin' WHERE id = ?", [bob.id])

    // Step 4: Bob (same token) attempts template_slots.bulk_replace — admin-only.
    // template_slots is a valid BULK_REPLACE_ENTITIES key; an empty rows array
    // on a fresh scope_id produces no conflict and succeeds cleanly.
    const scopeId1 = randomUUID()
    const cwid4 = randomUUID()
    const opsBeforeStep4 = host.getOps().length
    clientBob.sendRawMessage({
      type: 'submit_bulk_replace_op',
      op: {
        entity: 'template_slots',
        scope_id: scopeId1,
        rows: [],
        based_on_seq: 0,
        client_write_id: cwid4,
      },
    })

    // If Bob is now admin the op lands; if still staff it is rejected (error).
    await waitFor(
      () => host.getOps().length > opsBeforeStep4 || host.getOps().some(o => o.client_write_id === cwid4),
      5000
    )
    const adminOp = host.getOps().find(o => o.client_write_id === cwid4)
    if (!adminOp) {
      throw new Error(
        'Step 4: admin-only bulk_replace was rejected after role promotion — ' +
        'role change did not take effect without token re-issue'
      )
    }

    // Step 5: Revert Bob to staff (TEST-ONLY).
    host.dbExec("UPDATE users SET role = 'staff' WHERE id = ?", [bob.id])

    // Step 6: Same token, same admin-only action → must now be rejected.
    // Use a fresh scope_id and cwid so the idempotency guard doesn't short-circuit.
    const scopeId2 = randomUUID()
    const cwid6 = randomUUID()

    // Listen for the error response on Bob's WS.
    let gotError = false
    const rawWs = clientBob.syncClient.__getWs()
    if (!rawWs) throw new Error('No WS connection for Bob at step 6')
    const messageHandler = (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') gotError = true
      } catch { /* ignore */ }
    }
    rawWs.on('message', messageHandler)

    clientBob.sendRawMessage({
      type: 'submit_bulk_replace_op',
      op: {
        entity: 'template_slots',
        scope_id: scopeId2,
        rows: [],
        based_on_seq: 0,
        client_write_id: cwid6,
      },
    })

    await waitFor(() => gotError, 5000)
    rawWs.off('message', messageHandler)

    if (!gotError) {
      throw new Error(
        'Step 6: expected error response after role demotion, but none arrived'
      )
    }

    // Confirm the step-6 op did NOT land on the Host.
    const step6Op = host.getOps().find(o => o.client_write_id === cwid6)
    if (step6Op) {
      throw new Error('Step 6: demoted-role op landed on Host — demotion had no effect')
    }

    return 'PASS'
  } finally {
    host?.close()
    clientBob?.close()
    cleanupDirs(dirs)
  }
}
