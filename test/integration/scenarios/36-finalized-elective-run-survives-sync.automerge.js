/**
 * Scenario 36 — T199 spec §6 condition (10): "the finalized run survives sync
 * to a second device and a projection rebuild". T251.
 *
 * WHAT 32 AND 34 ALREADY COVER, so this file does not repeat it. Scenario 32
 * proves the seven participant tables join and rebuild; scenario 34 proves a
 * locked seat survives a regeneration and replicates. NEITHER FINALIZES
 * ANYTHING, so neither touches `elective_run_outer_snapshots` — the one table
 * that exists only after a finalize, the one that holds the immutable record a
 * camp prints from, and therefore the one whose absence from
 * electron/automerge/campDocument.js would be invisible until the day a
 * director's final schedule vanished off a second device.
 *
 * THE SNAPSHOT ROWS ARE PRODUCED BY THE REAL finalizeElectiveRun, not written
 * by hand: hand-writing them would assert that a row this file invented
 * replicates, which says nothing about whether the finalize the app performs
 * produces rows of that shape. Same discipline (and the same
 * `configureDualWrite` wiring) as scenario 34's use of the real
 * commitElectiveRun.
 *
 * WHAT IS ASSERTED AFTER THE REBUILD is the id PLUS a real field value, per
 * scenario 32's own note: `ensureExists` seeds a stub carrying '' in its NOT
 * NULL columns, so "the row is present" passes against a projection that
 * restored nothing at all.
 *
 * WHAT THIS DOES NOT CLAIM, and must not be read as claiming: it says nothing
 * about a LOCK set on a device that has not merged here. commitElectiveRun.js:216-237
 * states that gap itself — `is_locked = 1` is read from the local projection —
 * and a scenario that finalizes on one device cannot exhibit it. T251's
 * condition (5) is single-device only for the same reason.
 *
 * NON-VACUITY, planted and measured: drop 'elective_run_outer_snapshots' from
 * MODELED_ENTITIES in electron/automerge/campDocument.js and this scenario
 * reports "the joining device never received the finalized run". Dropping it
 * from GENESIS_ENTITIES instead is caught earlier, by that module's own
 * import-time parity assertion — which is a different guard, and worth knowing
 * about: only the MODELED_ENTITIES half is this scenario's to catch.
 */
import {
  AmHost, AmClient, makeTmpDir, cleanupDirs, waitFor, configureDualWrite,
} from '../harnessAutomerge.js'
import { applyBulkReplace } from '../../../electron/automerge/campDocument.js'
import { projectAll } from '../../../electron/automerge/projector.js'
import { commitElectiveRun } from '../../../electron/ops/commitElectiveRun.js'
import { finalizeElectiveRun } from '../../../electron/ops/finalizeElectiveRun.js'
import { deriveElectiveOccurrenceId } from '../../../electron/ops/electiveDerivedIds.js'

const RUN = 'run-36'
const SET = 'set-36'
const TIER = 'tier-36'
const GROUP = 'group-36'
const DAY = 'day-36'
const BLOCK = 'tb-36'
const WEEK = 'week-36'
const TEMPLATE = 'tpl-36'
const CAMPER = 'camper-36'
const ACTIVITY = 'act-36-swim'
const OCC = deriveElectiveOccurrenceId(RUN, SET, DAY, BLOCK, TIER)

const PARSED = {
  campers: [{ id: CAMPER, display_name: 'Testcamper Feldspar', external_id: 'SYN-36' }],
  choices: [{ label: 'Swim', labelKey: 'swim' }],
  preferences: [{ camper_id: CAMPER, occurrence_id: OCC, label: 'Swim', labelKey: 'swim', rank: 1 }],
  sameNameCampers: [],
  skippedRows: [],
}
const ASSIGNMENTS = [
  { camper_id: CAMPER, occurrence_id: OCC, labelKey: 'swim', activity_id: ACTIVITY, preference_rank: 1 },
]
const OCCURRENCES = [
  { id: OCC, elective_set_id: SET, day_id: DAY, time_block_id: BLOCK, tier_id: TIER },
]

// id + one real field, for every table the finalize leaves behind. The run row
// is included because `status` and `finalized_at` are what make it FINAL —
// a scenario that only checked the snapshot rows would pass against a camp
// whose run had silently reverted to draft on the second device.
function assertFinalized(label, device) {
  const run = device.domainRow('elective_assignment_runs', RUN)
  if (!run) throw new Error(`${label}: the run row is missing`)
  if (run.status !== 'final') throw new Error(`${label}: run status is ${JSON.stringify(run.status)}, expected 'final'`)
  if (!run.finalized_at) throw new Error(`${label}: finalized_at is empty`)

  const rows = device.db
    .prepare('SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?').all(RUN)
  if (rows.length === 0) throw new Error(`${label}: no elective_run_outer_snapshots rows`)
  const elective = rows.find((r) => r.cell_kind === 'elective')
  if (!elective) throw new Error(`${label}: no snapshot row with cell_kind 'elective'`)
  // A stub from ensureExists carries '' in its NOT NULL columns, so these are
  // the assertions that separate "restored" from "seeded empty".
  for (const [field, expected] of [
    ['camper_id', CAMPER], ['day_id', DAY], ['time_block_id', BLOCK],
    ['activity_id', ACTIVITY], ['activity_name', 'Swim'],
  ]) {
    if (elective[field] !== expected) {
      throw new Error(`${label}: snapshot.${field} is ${JSON.stringify(elective[field])}, expected ${JSON.stringify(expected)}`)
    }
  }
  return rows.length
}

export async function run() {
  const dirs = []
  let host, client

  try {
    const tmpDir = makeTmpDir()
    dirs.push(tmpDir)

    host = new AmHost(`${tmpDir}/host.db`)
    await host.start()
    const { campId } = await host.bootstrap()

    // commitElectiveRun and finalizeElectiveRun both write through appendOp,
    // which only reaches the document once this is wired.
    //
    // THE FINALIZE HAPPENS ON THE HOST, and that is forced rather than chosen:
    // test/integration/harnessAutomerge.js wires the local-write broadcaster in
    // `start()` and NOT in `join()`, so an appendOp-path write on a joined
    // device updates that device's document and never pushes it — the harness's
    // own comment at :381-388 says exactly that. Measured here: the run and its
    // snapshot rows sat in clientA's document and reached neither peer.
    // Finalizing on the Host is the arrangement this scenario can honestly
    // make; scenario 34 already covers a joined device's commit reaching the
    // others, so the joined-writer case is not what is missing.
    configureDualWrite(tmpDir)

    // The camp the finalize validates against. finalizeElectiveRun re-derives
    // occurrences LIVE from template_slots and refuses if they disagree with
    // what the run recorded, so the slot below is not decoration: without it
    // the finalize refuses STALE_OUTER_SCHEDULE and nothing else here runs.
    const seed = [
      ['tiers', TIER, { camp_id: campId, name: 'Older' }],
      ['groups', GROUP, { camp_id: campId, name: 'Bunk 36', tier_id: TIER }],
      ['days_of_operation', DAY, { camp_id: campId, label: 'Monday' }],
      ['time_blocks', BLOCK, { camp_id: campId, name: 'Period 1' }],
      ['activities', ACTIVITY, { camp_id: campId, name: 'Swim' }],
      ['elective_sets', SET, { camp_id: campId, name: 'Chugim' }],
      ['elective_set_activities', 'esa-36', {
        elective_set_id: SET, activity_id: ACTIVITY, status: 'confirmed', capacity_mode: 'unlimited',
      }],
      // `schedule_templates.week_id` is NOT NULL, so the week has to exist
      // first or the template never materialises and the slot's FK fails.
      ['schedule_weeks', WEEK, { camp_id: campId, name: 'Week 1', sort_order: 0, is_archived: 0 }],
      // `kind` FIRST: electron/ops/projections.js's write-ordering contract.
      ['schedule_templates', TEMPLATE, { kind: 'generated', camp_id: campId, week_id: WEEK, name: 'Generated' }],
      ['campers', CAMPER, { camp_id: campId, display_name: 'Testcamper Feldspar', group_id: GROUP }],
    ]
    for (const [entity, id, fields] of seed) {
      for (const [field, value] of Object.entries(fields)) {
        await host.write({ entity, entity_id: id, field, value })
      }
    }
    // THE SLOT GOES THROUGH bulkReplace, not a per-field write. `template_slots`
    // is scope-replaced in production (src/data/scheduleRepository.js's
    // replaceWeek/restoreSnapshotRows) and its per-field projection only ever
    // UPDATES a row bulkReplace already created — electron/ops/projections.js
    // says so itself. Written field-by-field here the row never materialises at
    // all, and the finalize then refuses STALE_OUTER_SCHEDULE for a reason that
    // has nothing to do with what this scenario is about. Same call scenario 19
    // makes.
    await host.node.applyLocal(applyBulkReplace(host.getDoc(), {
      entity: 'template_slots',
      scope_id: TEMPLATE,
      rows: [{
        id: 'slot-36', template_id: TEMPLATE, group_id: GROUP,
        day_id: DAY, time_block_id: BLOCK, elective_set_id: SET,
      }],
    }))
    if (!host.domainRow('template_slots', 'slot-36')) {
      throw new Error('the elective placement never materialised on the Host — nothing below would be evidence')
    }

    const committed = commitElectiveRun(host.db, {
      campId, deviceId: host.deviceId, name: 'Week 1 electives', runId: RUN,
      parsed: PARSED, assignments: ASSIGNMENTS, occurrences: OCCURRENCES,
      scheduleTemplateId: TEMPLATE,
    })
    if (!committed.ok) throw new Error(`the commit was refused: ${committed.error}`)

    // THE REAL FINALIZE. Its refusal codes are checked by name so a scenario
    // that silently stopped finalizing reports why rather than failing later on
    // an empty table.
    const finalized = finalizeElectiveRun(host.db, {
      runId: RUN, deviceId: host.deviceId, authorUserId: null,
    })
    if (!finalized.ok) throw new Error(`the finalize was refused: ${finalized.error}`)
    if (!(finalized.snapshotRows > 0)) throw new Error('the finalize wrote no snapshot rows')

    const onHost = assertFinalized('finalizing device', host)

    // (1) A second device joins for real and receives the finalized run.
    client = new AmClient(`${tmpDir}/client.db`)
    client.open()
    await client.join(host)

    await waitFor(
      () => client.db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(RUN).c === onHost,
      15000
    ).catch(() => {
      throw new Error('the joining device never received the finalized run')
    })
    assertFinalized('joining device', client)

    // (2) A projection rebuild FROM THE DOCUMENT restores it. Wipe first, so a
    // pass cannot come from the rows simply still being there. Children before
    // parents, foreign_keys = ON.
    for (const t of [
      'elective_run_outer_snapshots',
      'elective_assignments',
      'elective_preferences',
      'elective_choice_offerings',
      'elective_choices',
      'elective_occurrences',
      'elective_assignment_runs',
    ]) {
      client.db.prepare(`DELETE FROM ${t}`).run()
    }
    if (client.domainRow('elective_assignment_runs', RUN)) throw new Error('the wipe did not wipe')

    projectAll(client.db, client.getDoc())
    const rebuilt = assertFinalized('after projection rebuild', client)
    if (rebuilt !== onHost) {
      throw new Error(`after rebuild: ${rebuilt} snapshot rows, expected ${onHost}`)
    }

    return 'PASS'
  } finally {
    await host?.close()
    await client?.close()
    cleanupDirs(dirs)
  }
}
