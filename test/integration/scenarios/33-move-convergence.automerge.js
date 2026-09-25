/**
 * Scenario 33 — T245 Test seam case 5, for THE MOVE/LOCK WRITE PATH ITSELF.
 *
 * Scenario 31 proves the derived id collapses a duplicate when two devices
 * write an assignment through `client.write()`. It does NOT exercise
 * `setElectiveAssignment`, which is the handler a director's drag actually
 * reaches — that path derives its own id, resolves capacity and eligibility
 * against its LOCAL projection, and appends its fields through `appendOp`.
 * A handler that derived the id differently, or wrote through a path that
 * never reaches the document, would leave 31 green and this red. That is the
 * gap this scenario exists to close, and the reason a comment in the unit
 * tests could not.
 *
 * The fixture: devices A and B both join for real, then PARTITION. Each
 * calls `setElectiveAssignment` for the SAME (run, camper, occurrence) with a
 * DIFFERENT activity. The partition heals and the documents merge.
 *
 * WHAT WOULD MAKE THIS FAIL, which is what makes the assertions non-vacuous:
 * swap `deriveElectiveAssignmentId` in setElectiveAssignment.js for
 * `randomUUID()`. A and B then write two distinct Automerge map keys, the
 * merge is not a conflict at all, both rows survive — assertion (1) reports
 * 2 rows, and (4) never sees a conflict, so one camper is silently assigned
 * to two activities in one period with no human ever asked. Verified in T245
 * round 2 (the red output is in that report): with the derivation swapped, and
 * the pre-merge `out.assignmentId !== SHARED_ID` guard relaxed so the run
 * reaches the merge, assertion (1) reports "got 2".
 */
import {
  setupTwoJoinedDevices, partitionClients, healPartition, cleanupDirs, waitFor, configureDualWrite,
} from '../harnessAutomerge.js'
import { setElectiveAssignment } from '../../../electron/ops/setElectiveAssignment.js'
import { deriveElectiveAssignmentId } from '../../../electron/ops/electiveDerivedIds.js'

const RUN = 'run-1'
const OCC = 'occ-1'
const SET = 'set-1'
const CAMPER = 'camper-1'
const SHARED_ID = deriveElectiveAssignmentId(RUN, CAMPER, OCC)

const rowsFor = (device) =>
  device.db
    .prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ? AND camper_id = ? AND occurrence_id = ?')
    .get(RUN, CAMPER, OCC).c

const pendingConflicts = (device) =>
  device.db
    .prepare("SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL AND id LIKE 'crdt:%'")
    .all()

export async function run() {
  const dirs = []
  let host, clientA, clientB

  try {
    const setup = await setupTwoJoinedDevices()
    host = setup.host
    clientA = setup.clientA
    clientB = setup.clientB
    const { tmpDir, campId } = setup
    dirs.push(tmpDir)
    // setElectiveAssignment writes through appendOp, which only reaches the
    // document once this is wired — see configureDualWrite.
    configureDualWrite(tmpDir)

    // Everything the handler validates against must exist on BOTH devices
    // before the partition: a director sets the run up, then two people move
    // campers inside it. Capacity is 'unlimited' so this scenario measures
    // convergence rather than a capacity race.
    const seed = [
      // The elective set is seeded as a REAL document record, not left to the
      // projection stub: a device rebuilding from the document applies
      // elective_set_activities against a set that must already be there.
      ['elective_sets', SET, { camp_id: campId, name: 'Electives' }],
      ['elective_assignment_runs', RUN, { camp_id: campId, name: 'Week 1 electives', status: 'draft' }],
      ['elective_occurrences', OCC, { run_id: RUN, elective_set_id: SET }],
      ['elective_preferences', 'pref-1', { run_id: RUN, camper_id: CAMPER }],
      ['elective_set_activities', 'esa-swim', {
        elective_set_id: SET, activity_id: 'activity-swim', status: 'confirmed', capacity_mode: 'unlimited',
      }],
      ['elective_set_activities', 'esa-archery', {
        elective_set_id: SET, activity_id: 'activity-archery', status: 'confirmed', capacity_mode: 'unlimited',
      }],
    ]
    for (const [entity, id, fields] of seed) {
      for (const [field, value] of Object.entries(fields)) {
        await host.write({ entity, entity_id: id, field, value })
      }
    }

    const ready = (d) =>
      d.domainRow('elective_assignment_runs', RUN)?.status === 'draft' &&
      d.domainRow('elective_occurrences', OCC)?.elective_set_id === SET &&
      d.domainRow('elective_preferences', 'pref-1')?.camper_id === CAMPER &&
      d.domainRow('elective_set_activities', 'esa-archery')?.capacity_mode === 'unlimited'
    for (const [label, d] of [['clientA', clientA], ['clientB', clientB]]) {
      await waitFor(() => ready(d), 10000).catch(() => {
        throw new Error(`${label} never received the run setup — nothing below would be evidence`)
      })
    }

    // ---- PARTITION.
    await partitionClients({ tmpDir, clientA, clientB, campId })

    // ---- Both move the SAME camper, through the real handler, to different
    // activities. Neither knows the other is doing it.
    for (const [label, client, activityId] of [
      ['clientA', clientA, 'activity-swim'],
      ['clientB', clientB, 'activity-archery'],
    ]) {
      const out = setElectiveAssignment(client.db, {
        runId: RUN, camperId: CAMPER, occurrenceId: OCC, activityId,
        locked: true, deviceId: client.deviceId,
      })
      if (!out.ok) throw new Error(`${label}: the move was refused: ${out.error}`)
      if (out.assignmentId !== SHARED_ID) {
        throw new Error(`${label}: the handler did not write the derived id (got ${out.assignmentId})`)
      }
      if (rowsFor(client) !== 1) {
        throw new Error(`${label}: expected 1 local row pre-merge, got ${rowsFor(client)}`)
      }
    }

    // ---- HEAL.
    await healPartition({ host, clientA, clientB })

    const devices = [['host', host], ['clientA', clientA], ['clientB', clientB]]

    // THE GATE, and why it is this and not a sentinel. A round-2 draft gated on
    // a `solver_version='merged'` field the host wrote after healing. That
    // proves a client drained the host's document AS OF the moment the host
    // wrote it — it does NOT prove the host had already received clientB's op
    // by then, so a client could hold the sentinel and still be missing one of
    // the two competing activity_id writes. Under the full runner that is what
    // happened: (1) and (2) passed on each device's local row and (3) saw two
    // survivors. That is a premature gate, not a convergence failure —
    // Automerge's per-field resolution is deterministic once both ops are
    // merged, so three devices holding two values means one is missing an op.
    //
    // What replaces it is deliberately the WEAKEST gate that makes (1) and (2)
    // meaningful: every device holds AT LEAST ONE row for the triple. A broken
    // id scheme satisfies this immediately (it produces two rows, not none),
    // so (1) still fails with "got 2" — the message that names the real
    // defect — rather than timing out here. Convergence itself is asserted as
    // the liveness property it is, at (3).
    for (const [label, d] of devices) {
      await waitFor(() => rowsFor(d) > 0, 10000).catch(() => {
        throw new Error(`${label} never received any move for the contested triple — nothing below is evidence`)
      })
    }

    // (1) Exactly ONE row for the contested triple, on every device.
    for (const [label, d] of devices) {
      const c = rowsFor(d)
      if (c !== 1) {
        throw new Error(
          `${label}: expected exactly 1 elective_assignments row for the contested ` +
            `(run, camper, occurrence), got ${c}. The move path did not collapse the duplicate.`
        )
      }
    }

    // (2) That row is keyed by the DERIVED id, not by something the handler
    // minted for itself. This does not race behind the gate above: the gate
    // establishes a row for the triple exists, and (1) has established there is
    // exactly one — under a correct derivation that row IS this id, and under a
    // broken one (1) already threw.
    for (const [label, d] of devices) {
      const row = d.domainRow('elective_assignments', SHARED_ID)
      if (!row) throw new Error(`${label}: the surviving row is not keyed by the derived id`)
      if (row.activity_id !== 'activity-swim' && row.activity_id !== 'activity-archery') {
        throw new Error(`${label}: invented a third answer: ${row.activity_id}`)
      }
    }

    // (3) Every device agrees on the SAME survivor — convergence, not merely
    // "one row each". This is a LIVENESS property, so it is asserted as a
    // bounded wait rather than a single read: a device may hold its own write
    // and not yet the peer's, and that is a moment in time, not a disagreement.
    // The bound is what keeps it a real assertion — a system that genuinely
    // never converges still fails here, by timeout, naming both values.
    const survivorSet = () =>
      new Set(devices.map(([, d]) => d.domainRow('elective_assignments', SHARED_ID)?.activity_id))
    await waitFor(() => survivorSet().size === 1, 10000).catch(() => {
      throw new Error(
        `devices never converged on one survivor within 10s: ${[...survivorSet()].join(', ')}`
      )
    })

    // (4) The disagreement was SURFACED, not silently resolved. Two directors
    // moved one child to two places; a human has to choose.
    for (const [label, d] of devices) {
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
          `${label} never surfaced the disagreement — the row converged but nobody was asked. ` +
            `Conflicts seen: ${JSON.stringify(pendingConflicts(d))}`
        )
      })
    }

    return 'PASS'
  } finally {
    await host?.close()
    await clientA?.close()
    await clientB?.close()
    cleanupDirs(dirs)
  }
}
