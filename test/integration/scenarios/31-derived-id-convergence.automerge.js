/**
 * Scenario 31 — ADR D4: an assignment's DERIVED ID is the uniqueness
 * invariant, and the duplicate is unrepresentable rather than guarded.
 *
 * WHY A UNIT TEST DOES NOT DISCHARGE THIS. A unit test of
 * deriveElectiveAssignmentId proves the function is deterministic. It cannot
 * prove the duplicate is impossible, because THE DUPLICATE IS A MERGE
 * PHENOMENON: two devices, each locally correct, producing two rows that only
 * collide when their documents meet. That is what this scenario exercises —
 * real libp2p nodes, real SQLite, a real partition, and the real write path.
 *
 * The fixture: devices A and B both join for real, then PARTITION. Each
 * independently generates an assignment for the SAME (run-1, camper-1, occ-1)
 * — A placing swim, B placing archery — through client.write(), not by
 * hand-constructing a row. The partition heals and the documents merge.
 *
 * WHY IT WOULD FAIL WITHOUT DERIVED IDS, which is the half that makes the
 * assertion non-vacuous: with crypto.randomUUID() ids, A writes id=uuid-A and
 * B writes id=uuid-B. Those are two distinct Automerge map keys, so the merge
 * is not a conflict at all — both survive, the count is 2, no conflicts row is
 * written, and the projection shows one camper assigned to two activities in
 * one period. COUNT = 1 is therefore the exact discriminator between the two
 * designs. A reviewer can verify this test's worth by temporarily swapping the
 * id function for randomUUID and watching it go red.
 *
 * NON-VACUITY, THE OTHER DIRECTION (and this arm matters as much): a
 * convergence test passes for ANY id scheme if it merely merges a document
 * with itself — and for a CONSTANT id it would pass arm 1 while being
 * catastrophically wrong. So arm 2 has device B assign a DIFFERENT camper and
 * asserts the count is 2: distinct keys must stay distinct.
 */
import { AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor } from '../harnessAutomerge.js'
import { readRecord } from '../../../electron/automerge/campDocument.js'
import { deriveElectiveAssignmentId } from '../../../electron/ops/electiveDerivedIds.js'

const RUN = 'run-1'
const OCC = 'occ-1'
const CAMPER_1 = 'camper-1'
const CAMPER_2 = 'camper-2'

// WHAT THIS CONSTANT IS, precisely (round 2, M7). Each device calls the
// derivation for itself at its own write site below, so neither is handed the
// other's string — but both calls run in THIS process, so what the scenario
// proves is convergence GIVEN equal ids: two devices writing the same id merge
// to one record with a conflict, rather than to two records.
//
// It does NOT prove that two devices independently ARRIVE at equal ids. A
// derivation that depended on device-local state — an actor id, Date.now(), a
// locale-sensitive normalization — would still pass here. That class is covered
// by the FROZEN OUTPUT VECTORS in electron/ops/electiveDerivedIds.test.js,
// which pin the exact output string for a fixed input, so any device-local
// input would have to change the pinned string to get in. The two together are
// the D4 argument; this scenario alone is not.
const SHARED_ID = deriveElectiveAssignmentId(RUN, CAMPER_1, OCC)
const OTHER_ID = deriveElectiveAssignmentId(RUN, CAMPER_2, OCC)

const countFor = (device, camperId) =>
  device.db
    .prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ? AND camper_id = ?')
    .get(RUN, camperId).c

const pendingConflicts = (device) =>
  device.db
    .prepare(
      "SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'"
    )
    .all()

export async function run() {
  const dirs = []
  let host, clientA, clientB

  try {
    const tmpDir = makeTmpDir()
    dirs.push(tmpDir)
    const dirA = `${tmpDir}/clientA-userdata`
    const dirB = `${tmpDir}/clientB-userdata`

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId } = await host.bootstrap()

    clientA = new AmClient(`${tmpDir}/clientA.db`)
    clientA.open()
    await clientA.join(host)

    clientB = new AmClient(`${tmpDir}/clientB.db`)
    clientB.open()
    await clientB.join(host)

    // The run and its occurrence exist on every device BEFORE the partition —
    // a director creates the run, then two people work on it. The parent must
    // be shared, or this would be testing a contested run rather than a
    // contested assignment.
    await host.write({ entity: 'elective_assignment_runs', entity_id: RUN, field: 'name', value: 'Week 1' })
    await host.write({ entity: 'elective_occurrences', entity_id: OCC, field: 'run_id', value: RUN })

    const hasRun = (d) => readRecord(d.getDoc(), 'elective_assignment_runs', RUN)?.name === 'Week 1'
    await waitFor(() => hasRun(clientA), 8000).catch(() => {
      throw new Error('clientA never received the run')
    })
    await waitFor(() => hasRun(clientB), 8000).catch(() => {
      throw new Error('clientB never received the run')
    })

    // ---- PARTITION. Each device restarts onto a fresh node that is not dialed
    // to the Host, so the writes below genuinely cannot reach the other side.
    await clientA.restart(dirA, campId)
    await clientB.restart(dirB, campId)

    // ---- Both independently generate an assignment for the SAME triple,
    // through the real write path. Neither knows the other is doing it.
    for (const [client, activity] of [
      [clientA, 'activity-swim'],
      [clientB, 'activity-archery'],
    ]) {
      // Derived HERE, per device, from the triple alone — not the module-scope
      // constant reused. See SHARED_ID's comment for what that does and does
      // not establish.
      const id = deriveElectiveAssignmentId(RUN, CAMPER_1, OCC)
      if (id !== SHARED_ID) throw new Error(`derivation is not a pure function of its key: ${id}`)
      await client.write({ entity: 'elective_assignments', entity_id: id, field: 'run_id', value: RUN })
      await client.write({ entity: 'elective_assignments', entity_id: id, field: 'camper_id', value: CAMPER_1 })
      await client.write({ entity: 'elective_assignments', entity_id: id, field: 'occurrence_id', value: OCC })
      await client.write({ entity: 'elective_assignments', entity_id: id, field: 'activity_id', value: activity })
    }

    // Arm 2, written while still partitioned: device B ALSO assigns a
    // DIFFERENT camper in the same occurrence. This must survive as its own
    // row — without it, a constant id would pass arm 1.
    await clientB.write({ entity: 'elective_assignments', entity_id: OTHER_ID, field: 'run_id', value: RUN })
    await clientB.write({ entity: 'elective_assignments', entity_id: OTHER_ID, field: 'camper_id', value: CAMPER_2 })
    await clientB.write({ entity: 'elective_assignments', entity_id: OTHER_ID, field: 'occurrence_id', value: OCC })
    await clientB.write({ entity: 'elective_assignments', entity_id: OTHER_ID, field: 'activity_id', value: 'activity-ropes' })

    // Each device has exactly one row locally, before any merge. If this is
    // already 2 on one device, the rest of the scenario would be measuring the
    // wrong thing.
    for (const [label, d] of [['clientA', clientA], ['clientB', clientB]]) {
      if (countFor(d, CAMPER_1) !== 1) {
        throw new Error(`${label}: expected 1 local row pre-merge, got ${countFor(d, CAMPER_1)}`)
      }
    }

    // ---- HEAL.
    await clientA.reconnect(host)
    await clientB.reconnect(host)

    // Wait until both devices have actually seen the other's write, so the
    // assertions below are made on a MERGED document rather than on a device
    // that simply has not heard yet — the false green this scenario would
    // otherwise be most likely to produce.
    const sawPeer = (d) =>
      !!readRecord(d.getDoc(), 'elective_assignments', OTHER_ID) &&
      countFor(d, CAMPER_2) === 1
    await waitFor(() => sawPeer(clientA), 10000).catch(() => {
      throw new Error('clientA never received clientB rows — the merge did not happen, so nothing below is evidence')
    })
    await waitFor(() => sawPeer(host), 10000).catch(() => {
      throw new Error('host never received clientB rows')
    })

    // (1) THE INVARIANT. Exactly ONE row for the contested triple, on every
    // device. This is the assertion the whole slice exists for.
    for (const [label, d] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      const c = countFor(d, CAMPER_1)
      if (c !== 1) {
        throw new Error(
          `${label}: expected exactly 1 elective_assignments row for the contested ` +
            `(run, camper, occurrence), got ${c}. The derived id did not collapse the duplicate.`
        )
      }
    }

    // (2) That one row is the DERIVED id — not one device's row that happened
    // to win a race under some other key.
    for (const [label, d] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      const row = d.domainRow('elective_assignments', SHARED_ID)
      if (!row) throw new Error(`${label}: the surviving row is not keyed by the derived id`)
      if (row.activity_id !== 'activity-swim' && row.activity_id !== 'activity-archery') {
        throw new Error(`${label}: invented a third answer: ${row.activity_id}`)
      }
    }

    // (3) Every device agrees on the SAME survivor. Convergence, not merely
    // "one row each".
    const survivors = new Set(
      [host, clientA, clientB].map((d) => d.domainRow('elective_assignments', SHARED_ID)?.activity_id)
    )
    if (survivors.size !== 1) {
      throw new Error(`devices disagree about the survivor: ${[...survivors].join(', ')}`)
    }

    // (4) The disagreement was SURFACED, not silently resolved. This is what
    // the derived id buys beyond deduplication: because both writes land on one
    // record, the existing per-field conflict machinery can see them. Under two
    // random ids there is nothing to compare and no conflict is ever raised.
    for (const [label, d] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      await waitFor(
        () =>
          pendingConflicts(d).some(
            (r) =>
              r.entity === 'elective_assignments' &&
              r.entity_id === SHARED_ID &&
              r.field === 'activity_id'
          ),
        10000
      ).catch(() => {
        throw new Error(
          `${label} never surfaced the assignment disagreement — ` +
            `the row converged but a human was never asked to choose. ` +
            `Conflicts seen: ${JSON.stringify(pendingConflicts(d))}`
        )
      })
    }

    // (5) ARM 2 — distinct keys stay distinct. Two campers in the same
    // occurrence are TWO rows. Without this, a constant id passes everything
    // above while assigning the whole camp to one record.
    for (const [label, d] of [['host', host], ['clientA', clientA], ['clientB', clientB]]) {
      const total = d.db
        .prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ?')
        .get(RUN).c
      if (total !== 2) {
        throw new Error(`${label}: expected 2 rows for two different campers, got ${total}`)
      }
      if (countFor(d, CAMPER_2) !== 1) {
        throw new Error(`${label}: the second camper's own assignment did not survive`)
      }
      if (SHARED_ID === OTHER_ID) {
        throw new Error('the derivation is constant in camper_id — arm 1 proved nothing')
      }
    }

    return 'PASS'
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}
