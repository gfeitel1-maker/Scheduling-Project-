/**
 * Scenario 15: Clock-skew on op created_at is ignored by the Host.
 *
 * The op-log uses Host seq numbers as the authoritative ordering.  Device
 * clocks are recorded for display context only (per the ADR).  A skewed
 * created_at timestamp in the submitted op payload must NOT cause the Host to
 * reject the op, and host_seq ordering must remain monotonic regardless of the
 * skew.
 *
 * Steps:
 *   1. Client A submits an op with a far-future created_at (+1 day).  The
 *      server ignores extra op payload fields so this must NOT cause rejection.
 *   2. Verify the Host accepted op1 (op lands in operations table).
 *   3. Client A submits a second op with a normal (absent) created_at.
 *   4. Verify op2 lands on the Host.
 *   5. Verify op1.seq < op2.seq (Host assigns monotonically increasing seq
 *      regardless of the submitted created_at value).
 *   6. Verify both ops land in Client A's local DB (via the op_applied
 *      broadcast the server sends to all authenticated clients) with
 *      host_seq preserving the same ordering.
 *
 * Note: clientB is NOT used because sendMissedOps does not replay historical
 * ops to a brand-new device on its very first connection (it only baselines
 * the watermark).  Ordering verification is done directly against the Host DB
 * and via clientA's local DB (which receives ops via the live broadcast).
 */

import { randomUUID } from 'node:crypto'
import {
  Host, Client, getFreePort, makeTmpDir, cleanupDirs, pairAndLogin, waitFor,
} from '../harness.js'

export async function run() {
  const dirs = []
  let host, clientA

  try {
    const tmpDir = makeTmpDir(); dirs.push(tmpDir)
    const port = await getFreePort()

    host = new Host(`${tmpDir}/host.db`)
    await host.start(port)
    await host.bootstrap()

    // --- Client A: pair and login as admin ---
    clientA = new Client(`${tmpDir}/clientA.db`)
    clientA.open()
    await pairAndLogin(host, clientA)

    const opsBefore = host.getOps().length
    const entityId = randomUUID()
    const cwid1 = randomUUID()
    const cwid2 = randomUUID()

    // Step 1: Submit an op whose payload includes a far-future created_at.
    // The server ignores unknown op payload fields; this must NOT cause rejection.
    clientA.sendRawMessage({
      type: 'submit_op',
      op: {
        entity: 'activities',
        entity_id: entityId,
        field: 'name',
        value: 'FutureActivity',
        parent_op_id: null,
        client_write_id: cwid1,
        created_at: new Date(Date.now() + 86400000).toISOString(), // +1 day
      },
    })

    // Step 2: Verify the Host accepted op1 — poll the Host DB directly.
    await waitFor(() => host.getOps().length > opsBefore, 5000)

    const op1 = host.getOps().find(o => o.client_write_id === cwid1)
    if (!op1) {
      throw new Error('Op1 (skewed created_at) not found in Host DB — op was rejected')
    }

    // Step 3: Submit a second op on the same entity/field.
    // Use op1.id as parent_op_id so detectConflict sees it as a linear update,
    // not a concurrent-write conflict.
    clientA.sendRawMessage({
      type: 'submit_op',
      op: {
        entity: 'activities',
        entity_id: entityId,
        field: 'name',
        value: 'NormalActivity',
        parent_op_id: op1.id, // chain to op1 — no conflict
        client_write_id: cwid2,
      },
    })

    // Step 4: Wait for the second op to land on the Host.
    await waitFor(
      () => host.getOps().some(o => o.client_write_id === cwid2),
      5000
    )

    // Step 5: Verify host_seq ordering on the Host.
    // On the Host, seq IS the canonical ordering (host_seq is NULL on Host rows).
    const op2 = host.getOps().find(o => o.client_write_id === cwid2)
    if (!op2) throw new Error('Op2 not found on Host after waitFor succeeded')

    if (op1.seq >= op2.seq) {
      throw new Error(
        `Host seq ordering wrong: op1.seq=${op1.seq} should be < op2.seq=${op2.seq} ` +
        `regardless of the skewed created_at on op1`
      )
    }

    // Step 6: Verify Client A received both ops via the live op_applied broadcast
    // and stores them with correct host_seq ordering in its local DB.
    await waitFor(
      () => {
        const ops = clientA.getOps()
        return ops.some(o => o.client_write_id === cwid1) &&
               ops.some(o => o.client_write_id === cwid2)
      },
      5000
    )

    const a1 = clientA.getOps().find(o => o.client_write_id === cwid1)
    const a2 = clientA.getOps().find(o => o.client_write_id === cwid2)
    if (!a1 || !a2) throw new Error('ClientA missing one or both ops')

    // On the client DB, host_seq stores the Host's canonical seq.
    // Assert it was actually written — a null here means op_applied broadcast
    // did not populate host_seq, which would make the ordering comparison below
    // meaningless (it would fall back to local insert order, always monotonic).
    if (a1.host_seq == null) {
      throw new Error(
        `ClientA op1 host_seq is null — op_applied broadcast may not have populated it ` +
        `(client_write_id=${cwid1})`
      )
    }
    if (a2.host_seq == null) {
      throw new Error(
        `ClientA op2 host_seq is null — op_applied broadcast may not have populated it ` +
        `(client_write_id=${cwid2})`
      )
    }
    if (a1.host_seq >= a2.host_seq) {
      throw new Error(
        `ClientA host_seq ordering wrong: a1.host_seq=${a1.host_seq} should be < a2.host_seq=${a2.host_seq}`
      )
    }

    return 'PASS'
  } finally {
    host?.close()
    clientA?.close()
    cleanupDirs(dirs)
  }
}
