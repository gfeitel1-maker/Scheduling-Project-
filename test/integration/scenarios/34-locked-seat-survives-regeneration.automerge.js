/**
 * Scenario 34 — T246's Test seam: a locked seat SURVIVES a regeneration, and
 * the survival replicates.
 *
 * Scenario 33 proves two devices' competing moves converge on one row. It says
 * nothing about what a REGENERATION does to that row, which is the defect T246
 * exists to fix: commitElectiveRun wrote `source:'solver'` over the derived row
 * setElectiveAssignment had written `source:'manual', is_locked:1` to, removing
 * that row's `source='manual'` exemption in electiveGenerationPredicate.js. The
 * lock stayed VISIBLE across a regeneration and did not SURVIVE one — a
 * distinction a visibility-only assertion cannot see, which is why this
 * scenario asserts the row's own fields as well as the predicate.
 *
 * The fixture: clientA imports a run, a director locks cam-1 into Gaga, and the
 * SAME runId is committed again with a solver output that puts cam-1 back in
 * Archery. Then the whole thing must still be true on the other devices.
 *
 * WHAT WOULD MAKE THIS FAIL, which is what makes the assertions non-vacuous:
 * delete the `protectedIds.has(assignmentId)` skip in commitElectiveRun.js.
 * Assertion (1) then reports source 'solver' and activity_id 'act-archery' —
 * verified against this file by planting exactly that.
 */
import {
  setupTwoJoinedDevices, cleanupDirs, waitFor, configureDualWrite,
} from '../harnessAutomerge.js'
import { commitElectiveRun } from '../../../electron/ops/commitElectiveRun.js'
import { setElectiveAssignment } from '../../../electron/ops/setElectiveAssignment.js'
import { deriveElectiveAssignmentId } from '../../../electron/ops/electiveDerivedIds.js'
import { electiveGenerationVisibleFragment } from '../../../electron/ops/electiveGenerationPredicate.js'

const RUN = 'run-1'
const OCC = 'occ-1'
const SET = 'set-1'
const LOCKED_ID = deriveElectiveAssignmentId(RUN, 'cam-1', OCC)

const PARSED = {
  campers: [
    { id: 'cam-1', display_name: 'Ari Green', external_id: null },
    { id: 'cam-2', display_name: 'Noa Katz', external_id: null },
  ],
  choices: [{ label: 'Archery', labelKey: 'archery' }, { label: 'Gaga', labelKey: 'gaga' }],
  preferences: [
    { camper_id: 'cam-1', label: 'Archery', labelKey: 'archery', rank: 1 },
    { camper_id: 'cam-2', label: 'Gaga', labelKey: 'gaga', rank: 1 },
  ],
  sameNameCampers: [],
  skippedRows: [],
}
const ASSIGNMENTS = [
  { camper_id: 'cam-1', occurrence_id: OCC, labelKey: 'archery', activity_id: 'act-archery', preference_rank: 1 },
  { camper_id: 'cam-2', occurrence_id: OCC, labelKey: 'gaga', activity_id: 'act-gaga', preference_rank: 1 },
]
const OCCURRENCES = [{ id: OCC, elective_set_id: SET, day_id: 'day-1', time_block_id: 'tb-1', tier_id: null }]

const visibleLockedRow = (device) => {
  const gen = device.db
    .prepare('SELECT solver_generation FROM elective_assignment_runs WHERE id = ?')
    .get(RUN)?.solver_generation ?? null
  return device.db
    .prepare(
      `SELECT a.source, a.is_locked, a.activity_id FROM elective_assignments a
        WHERE a.id = :id AND ${electiveGenerationVisibleFragment('a')}`
    )
    .get({ id: LOCKED_ID, gen })
}

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
    // commitElectiveRun and setElectiveAssignment both write through appendOp,
    // which only reaches the document once this is wired.
    configureDualWrite(tmpDir)

    // The set and its confirmed offerings are what the move path validates
    // against, and they are seeded as real document records so a device
    // rebuilding from the document has them too.
    const seed = [
      ['elective_sets', SET, { camp_id: campId, name: 'Electives' }],
      ['activities', 'act-archery', { camp_id: campId, name: 'Archery' }],
      ['activities', 'act-gaga', { camp_id: campId, name: 'Gaga' }],
      ['elective_set_activities', 'esa-archery', {
        elective_set_id: SET, activity_id: 'act-archery', status: 'confirmed', capacity_mode: 'unlimited',
      }],
      ['elective_set_activities', 'esa-gaga', {
        elective_set_id: SET, activity_id: 'act-gaga', status: 'confirmed', capacity_mode: 'unlimited',
      }],
    ]
    for (const [entity, id, fields] of seed) {
      for (const [field, value] of Object.entries(fields)) {
        await host.write({ entity, entity_id: id, field, value })
      }
    }
    const ready = (d) =>
      d.domainRow('elective_sets', SET)?.name === 'Electives' &&
      d.domainRow('elective_set_activities', 'esa-gaga')?.capacity_mode === 'unlimited'
    await waitFor(() => ready(clientA), 10000).catch(() => {
      throw new Error('clientA never received the elective set — nothing below would be evidence')
    })

    const commit = () => commitElectiveRun(clientA.db, {
      campId, deviceId: clientA.deviceId, name: 'Week 1 electives', runId: RUN,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
    })

    const first = commit()
    if (!first.ok) throw new Error(`the first commit was refused: ${first.error}`)

    // The director moves cam-1 out of the solver's Archery and locks it.
    const moved = setElectiveAssignment(clientA.db, {
      runId: RUN, camperId: 'cam-1', occurrenceId: OCC, activityId: 'act-gaga',
      locked: true, deviceId: clientA.deviceId,
    })
    if (!moved.ok) throw new Error(`the move was refused: ${moved.error}`)

    // ---- REGENERATE the same run. Its solver output puts cam-1 back in
    // Archery, which is exactly what must NOT happen to the locked row.
    const again = commit()
    if (!again.ok) throw new Error(`the regeneration was refused: ${again.error}`)

    // (1) On the regenerating device: the row is still the director's, with the
    // director's activity, and is still visible under the shared predicate.
    const row = visibleLockedRow(clientA)
    if (!row) throw new Error('clientA: the locked row is not visible after the regeneration')
    if (row.source !== 'manual' || row.is_locked !== 1 || row.activity_id !== 'act-gaga') {
      throw new Error(`clientA: the regeneration overwrote the locked row: ${JSON.stringify(row)}`)
    }

    // (2) And it replicates that way — the other devices see the director's
    // placement, not the solver's. A bounded wait, because this is liveness.
    for (const [label, d] of [['host', host], ['clientB', clientB]]) {
      await waitFor(() => visibleLockedRow(d)?.activity_id === 'act-gaga', 10000).catch(() => {
        throw new Error(
          `${label} never saw the locked placement: ${JSON.stringify(visibleLockedRow(d))}`
        )
      })
      const seen = visibleLockedRow(d)
      if (seen.source !== 'manual' || seen.is_locked !== 1) {
        throw new Error(`${label}: the row arrived without its lock: ${JSON.stringify(seen)}`)
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
