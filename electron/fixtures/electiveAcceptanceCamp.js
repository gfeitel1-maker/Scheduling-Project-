// THE T199 ACCEPTANCE CAMP — built once, here, and read by every T251 test.
//
// docs/work/tickets/T251-t199-acceptance-fixture.md;
// docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md §6
// (the pass conditions); docs/work/tickets/T199-individual-electives-end-to-end.md.
// ADRs: 2026-09-26-per-cell-elective-preferences.md,
// 2026-09-26-ingest-category-exclusivity-and-anchor-identity.md,
// 2026-09-29-linked-elective-bundles.md.
//
// WHY ONE MODULE AND NOT A `beforeEach` PER TEST FILE. §6 is one camp with one
// set of counts, and five test files each building "the same" camp by hand is
// five camps that drift. Worse, it is five chances to build the camp the code
// expects instead of the camp §6 describes — which is the T62 defect shape this
// repository has already paid for twice (see
// src/screens/elective/assignment/buildAttendance.js:16-27: that module read
// `camper.division` while the parser only ever produced `camper.division_label`,
// so attendance scoping never worked in the shipped app, and its own tests
// missed it for months because the fixtures hand-built `{ division: ... }`
// matching the code's wrong assumption).
//
// SO: NOTHING HERE IS HAND-BUILT THAT A PRODUCTION PATH CAN PRODUCE.
//
//   catalogue (tiers, groups, days, time blocks, activities, the recurring
//   event) ....... the real grid file -> parseTextGrid -> extractEntities ->
//                  inferFixedEvents -> derivePinOnlyActivityNames ->
//                  inferActivityRules -> capturePlacements -> the REAL
//                  ingestCommit IPC handler.
//   the manual template and its slots ... that same ingestCommit's
//                  `placements`, materialised by materializeImportedVersion into
//                  a schedule_snapshots row, then restored onto live
//                  template_slots through the real bulkReplace IPC handler —
//                  the same two calls src/screens/schedule/useSnapshots.js's
//                  restoreSnapshot makes.
//   the generated template, the week, locations, the elective set, its
//   offerings and capacities, the bundles, the elective cells ... the real
//                  generic `write` IPC handler, which is what
//                  src/data/scheduleRepository.js (and so every schedule and
//                  elective-set screen) itself calls. There is no
//                  bundle-specific or elective-set-specific handler; the
//                  generic one IS the production path.
//   campers, choices, preferences, the run row ... the real preference-sheet
//                  CLI core (runPreferenceSheetCli) over a real .csv.
//
// THREE DIRECT DATABASE WRITES SURVIVE, and each is unavoidable rather than
// convenient. They are listed in BOOTSTRAP_SQL_ALLOWLIST below and asserted by
// electron/electiveAcceptanceSurfaces.integration.test.js's source scan, which
// also asserts that NOTHING else in this module or in the five test files
// writes SQL at any table §6 says must come from a real path.
//
// WHAT THIS MODULE DOES NOT DO: it does not solve. No production module
// composes solver inputs from a database — the whole orchestration lives inside
// one React callback (`solve()` at
// src/screens/elective/assignment/AssignmentPanel.jsx:611-700), and
// runPreferenceSheetCli commits `assignments: []` deliberately
// (scripts/preferenceSheetCli.js:355-379). Re-implementing that composition
// here would be the T62 shape again. electiveAcceptanceSolve.integration.test.js
// drives the real component instead; see its header.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

import { getOrCreateDeviceId } from '../db/localDb.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import { extractEntities } from '../../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../../src/ingest/activityRules.js'
import { capturePlacements } from '../../src/ingest/capturePlacements.js'
import { runPreferenceSheetCli } from '../../scripts/preferenceSheetCli.js'

export const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/elective-acceptance')
export const GRID_FILE = path.join(FIXTURE_DIR, 'camp-grid.txt')
export const SHEET_BLOCKING = path.join(FIXTURE_DIR, 'preferences.csv')
export const SHEET_RESOLVED = path.join(FIXTURE_DIR, 'preferences-resolved.csv')
export const SHEET_BUNDLE_BY_NAME = path.join(FIXTURE_DIR, 'preferences-bundle-by-name.csv')

// The three tables a direct write is permitted to name, and why each one cannot
// come from a production path in a single-node headless test. Read as a pair
// with the source scan in electiveAcceptanceSurfaces.integration.test.js — this
// constant is the scan's input, so widening it is a visible, reviewable act.
export const BOOTSTRAP_SQL_ALLOWLIST = Object.freeze(['camps', 'devices', 'cohorts'])

/**
 * THE DECLARED SHAPE OF THE CAMP, stated before it is built.
 *
 * Every number here comes from §6's own prose, not from running the code and
 * writing down what came out. `assertManifest` below checks the built camp
 * against it, so a fixture that quietly stops being the camp §6 describes fails
 * loudly instead of making twelve downstream assertions vacuous.
 */
export const ACCEPTANCE_MANIFEST = Object.freeze({
  campName: 'Acceptance Camp',
  tiers: ['Younger', 'Older'],
  groupsPerTier: 2,
  groups: ['Younger 1', 'Younger 2', 'Older 1', 'Older 2'],
  days: ['Monday', 'Tuesday', 'Wednesday'],
  // The elective period. Written as extractEntities emits it (the en-dash in
  // the grid file normalises to a hyphen), because that is the string the
  // preference sheets' Period column has to match.
  electivePeriod: '10:50-11:30',
  // §6: "3 elective occurrences". Three is the count on the GENERATED route,
  // which is the route the run is solved against: Monday and Tuesday carry the
  // set for both tiers, Wednesday for Younger only — five cells... no: the
  // count §6 names is per the route being solved. See `occurrenceCells` below,
  // which states the cells rather than a number, and the two routes' counts
  // separately, so neither can be mistaken for the other.
  occurrenceCells: {
    // day -> the tiers the set is placed for, per route.
    generated: { Monday: ['Younger', 'Older'], Tuesday: ['Younger', 'Older'], Wednesday: ['Younger'] },
    manual: { Monday: ['Younger', 'Older'], Tuesday: ['Younger', 'Older'], Wednesday: ['Younger', 'Older'] },
  },
  generatedOccurrenceCount: 5,
  manualOccurrenceCount: 6,
  // §6: "6 offerings". name -> [capacity_mode, capacity_limit, min_to_run]
  offerings: {
    Swim: ['limited', 6, null],
    Archery: ['limited', 4, null],
    Ceramics: ['limited', 8, null],
    Ropes: ['limited', 3, null],
    // The unlimited one, and the reason it is here: `resolveOfferingCapacity`'s
    // unlimited branch is the one a naive `capacity_limit ?? 0` read gets wrong
    // by CLOSING the offering. Mutation (3) in T251's non-vacuity plan plants
    // exactly that.
    Garden: ['unlimited', null, null],
    Woodshop: ['limited', 10, 4],
  },
  // §6: "one location shared with a non-elective group activity".
  sharedLocation: 'Lakefront',
  sharedLocationElective: 'Swim',
  sharedLocationOuterActivity: 'Boating',
  // §6: ">=24 campers". 26.
  camperCount: 26,
  // §6's named edge cases, by the name the sheet gives them.
  duplicateNameDifferentGroups: 'Ari Feldspar',
  duplicateNameSameGroup: 'Rivka Sandarch',
  wholeRunFallbackCampers: ['Nadav Calcite', 'Ronit Dolomite', 'Netanel Siltstone', 'Zohar Peridot'],
  // §6: "one missing external id" and "one inactive camper". Two DIFFERENT
  // children: folding them onto one camper would let a single wrong row make
  // both assertions pass or both fail together.
  missingExternalIdCamper: 'Zohar Peridot',
  inactiveCamper: 'Dalia Travertine',
  // The recurring event the ingest category leak is exhibited on.
  recurringEvent: 'Menucha',
  // The bundle. NAMED AFTER ITS OWN ACTIVITY, and that is forced rather than
  // chosen — see the note in scripts/fixtures/make-preference-corpus.mjs and
  // the gap held open by electiveAcceptanceImport.integration.test.js.
  bundle: { name: 'Ropes', activity: 'Ropes', tier: 'Older', days: ['Monday', 'Tuesday'] },
  // TWO MORE BUNDLES, authored so that UNSUPPORTED_LINKED_CHOICE is PRODUCED
  // rather than merely absent: case (c) at
  // src/engine/buildElectiveAssignments.js:684-696 fires when two linked
  // choices share a member occurrence.
  //
  // THEY ARE SCOPED TO THE OTHER TIER, and that is forced. Case (c) refuses
  // BOTH sharing choices, not just the later one, so a second bundle overlapping
  // `bundle` above would take `bundle` down with it and condition (8) would have
  // nothing left to assert — measured, not reasoned: the first attempt did
  // exactly that and tier 1 placed nobody. These two overlap EACH OTHER, on
  // Younger cells, which leaves the Older bundle live.
  refusedBundles: [
    { name: 'Ceramics', activity: 'Ceramics', tier: 'Younger', days: ['Tuesday', 'Wednesday'] },
    { name: 'Woodshop', activity: 'Woodshop', tier: 'Younger', days: ['Tuesday', 'Wednesday'] },
  ],
})

const nameMap = (rows) => new Map(rows.map((r) => [r.name, r.id]))

/**
 * Bootstrap the three rows no production path can produce headlessly, and
 * ASSERT the shape each one is standing in for.
 *
 * Every assertion here is a precondition, not a test: a fixture built on a camp
 * with no signing key, or an unauthorized device, would exercise a device state
 * the app never reaches, and every §6 assertion downstream would be about that
 * state instead.
 */
export function bootstrapDevice(db, { campName = ACCEPTANCE_MANIFEST.campName } = {}) {
  const deviceId = getOrCreateDeviceId(db)
  const hostKey = ensureHostSigningKey(db)
  const campId = randomUUID()

  // (1) camps. No ingest path creates a camp and CampBootstrapScreen cannot run
  // headless; bootstrapCamp's own write is behind a renderer flow. Precedent for
  // the direct write: electron/electiveRunOuterSchedule.integration.test.js:57-68.
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)')
    .run(campId, campName, 'a'.repeat(64), hostKey.public_key)

  // (2) devices, authorized. Pairing is a libp2p flow and is unavailable on a
  // single node. The row is written in the shape approveDevice writes — a 64-hex
  // device_secret_identifier and pairing_status 'authorized' — not a shape
  // invented here. Same precedent, :52-56.
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  // (3) one cohort. commitIngest needs one to scope tiers and time blocks to,
  // and a camp with none makes the whole ingest clause vacuous — buildSchedule
  // walks cohorts and returns an empty grid. Precedent:
  // electron/ingestPassExclusivity.integration.test.js:88-90.
  const cohortId = randomUUID()
  db.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)')
    .run(cohortId, campId, 'Main')

  const camps = db.prepare('SELECT id, signing_public_key FROM camps').all()
  if (camps.length !== 1) throw new Error(`bootstrapDevice: expected exactly 1 camp, found ${camps.length}`)
  if (!camps[0].signing_public_key) throw new Error('bootstrapDevice: camp has no signing_public_key')
  const device = db.prepare('SELECT pairing_status, device_secret_identifier FROM devices WHERE id = ?').get(deviceId)
  if (device?.pairing_status !== 'authorized') throw new Error('bootstrapDevice: device is not authorized')
  if (!/^[0-9a-f]{64}$/.test(device.device_secret_identifier ?? '')) {
    throw new Error('bootstrapDevice: device_secret_identifier is not the 64-hex shape approveDevice writes')
  }
  const cohorts = db.prepare('SELECT id FROM cohorts WHERE camp_id = ?').all(campId)
  if (cohorts.length !== 1) throw new Error(`bootstrapDevice: expected exactly 1 cohort, found ${cohorts.length}`)

  return { campId, deviceId, cohortId, hostKey }
}

/** The real ingest pipeline, from the file on disk to committed catalogue rows. */
export async function runRealIngest(db, { handlers, token, cohortId }) {
  const parsed = parseTextGrid(fs.readFileSync(GRID_FILE, 'utf8'))
  const proposal = extractEntities(parsed)
  const { fixedEvents, dualUseNames = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, {})
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)

  const approved = {
    tiers: proposal.entities.tiers,
    groups: proposal.entities.groups,
    days_of_operation: proposal.entities.days_of_operation,
    time_blocks: proposal.entities.time_blocks,
    activities: proposal.entities.activities,
  }
  const activityRules = inferActivityRules(
    proposal.entities.activities,
    proposal.activityPages,
    proposal.seenCounts,
    proposal.entities.days_of_operation.length,
    proposal.entities.groups,
    pinOnly,
  )
  const { placements } = capturePlacements(parsed, proposal)

  const outcome = await handlers.ingestCommit({
    token,
    approved,
    // group -> division, the same shape ImportScreen.jsx:1398 passes.
    links: { groups: proposal.groupUnits },
    cohort_id: cohortId,
    fixedEvents,
    activityRules,
    mode: 'add',
    seenCounts: proposal.seenCounts ?? null,
    pinOnlyActivityNames: [...pinOnly],
    electiveHeaderFindings: proposal.electiveHeaderFindings ?? [],
    activityPeriods: proposal.activityPeriods ?? {},
    placements,
  })

  return { parsed, proposal, fixedEvents, pinOnly, placements, outcome }
}

/**
 * Build the whole §6 camp.
 *
 * @returns everything a test needs to ask a question about it BY ID, so no test
 *   has to re-derive an id and none can look up the wrong one.
 */
export async function buildAcceptanceCamp(db, { handlers, token, campId, deviceId, cohortId, authorUserId }) {
  const M = ACCEPTANCE_MANIFEST
  const write = async (entity, id, fields) => {
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue
      const result = await handlers.write({ token, entity, entity_id: id, field, value })
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`buildAcceptanceCamp: write failed for ${entity}.${field} (status: ${result?.status})`)
      }
    }
  }

  // --- the week. ScheduleScreen creates it on first load with exactly these
  // four fields in this order (src/screens/schedule/useScheduleData.js:220 ->
  // src/data/scheduleRepository.js:254-258).
  const weekId = randomUUID()
  await write('schedule_weeks', weekId, { camp_id: campId, name: 'Week 1', sort_order: '0', is_archived: '0' })

  // --- the catalogue and the manual template's snapshot, from the grid.
  const ingest = await runRealIngest(db, { handlers, token, cohortId })

  const tierIdByName = nameMap(db.prepare('SELECT id, name FROM tiers WHERE camp_id = ?').all(campId))
  const groupIdByName = nameMap(db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId))
  const activityIdByName = nameMap(db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId))
  const dayIdByLabel = new Map(
    db.prepare('SELECT id, label FROM days_of_operation WHERE camp_id = ?').all(campId).map((r) => [r.label, r.id])
  )
  const blockIdByName = nameMap(db.prepare('SELECT id, name FROM time_blocks WHERE camp_id = ?').all(campId))
  const periodId = blockIdByName.get(M.electivePeriod)
  if (!periodId) throw new Error(`buildAcceptanceCamp: the grid produced no "${M.electivePeriod}" time block`)

  // --- the manual template's LIVE slots. ingestCommit materialised a
  // schedule_snapshots row; restoring it onto template_slots is the second half
  // of that production path (src/screens/schedule/useSnapshots.js's
  // restoreSnapshot -> src/data/scheduleRepository.js:313-317's
  // restoreSnapshotRows -> the bulkReplace IPC handler).
  const manualTemplateId = db
    .prepare("SELECT id FROM schedule_templates WHERE week_id = ? AND kind = 'manual'").get(weekId)?.id
  if (!manualTemplateId) throw new Error('buildAcceptanceCamp: ingest did not materialise a manual template')
  const snapshot = db
    .prepare('SELECT slots FROM schedule_snapshots WHERE template_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(manualTemplateId)
  if (!snapshot) throw new Error('buildAcceptanceCamp: ingest materialised no snapshot to restore')
  const snapshotSlots = JSON.parse(snapshot.slots)
  await handlers.bulkReplace({
    token,
    entity: 'template_slots',
    scope_id: manualTemplateId,
    // mapSlotToRow's restore shape (src/data/scheduleRepository.js:30-56):
    // is_span_head is deliberately ABSENT on this path.
    rows: snapshotSlots.map((s) => ({
      id: randomUUID(),
      template_id: manualTemplateId,
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor ? '1' : '0',
      flags: JSON.stringify(s.flags || {}),
    })),
  })

  // --- the generated template. Created lazily on first use in production
  // (ScheduleScreen.jsx:521-533), `kind` written FIRST — the write-ordering
  // contract on schedule_templates in electron/ops/projections.js.
  const generatedTemplateId = deriveScheduleTemplateId(weekId, 'generated')
  await write('schedule_templates', generatedTemplateId, {
    kind: 'generated', camp_id: campId, week_id: weekId, name: 'Generated',
  })

  // The generated route is the manual route's grid with ONE difference that
  // matters to §6 — see `outerConflictSlotId` below — plus the elective cells,
  // which differ by design (Wednesday/Older). Built from the SAME snapshot rows
  // so that condition 6's "a child's non-elective cells equal the selected group
  // template" has two routes that genuinely agree away from the electives.
  const generatedRows = snapshotSlots.map((s) => ({
    id: randomUUID(),
    template_id: generatedTemplateId,
    group_id: s.group_id,
    day_id: s.day_id,
    time_block_id: s.time_block_id,
    activity_id: s.activity_id,
    anchor_id: s.anchor_id,
    is_anchor: s.is_anchor ? '1' : '0',
    flags: JSON.stringify(s.flags || {}),
  }))
  await handlers.bulkReplace({ token, entity: 'template_slots', scope_id: generatedTemplateId, rows: generatedRows })

  // --- locations, and the shared one. LocationsScreen writes these through the
  // same generic `write`; nothing in a plain-text grid carries a room, so this is
  // the production path rather than a shortcut (textGrid.js only captures a
  // parallel location line on the labelled camp families).
  const locationIdByName = new Map()
  for (const name of [M.sharedLocation, 'Field', 'Studio']) {
    const id = randomUUID()
    await write('locations', id, { camp_id: campId, name })
    locationIdByName.set(name, id)
  }
  // §6's "one location shared with a non-elective group activity": Swim (an
  // offering) and Boating (an ordinary group activity) are both at Lakefront.
  for (const activityName of [M.sharedLocationElective, M.sharedLocationOuterActivity]) {
    await write('activities', activityIdByName.get(activityName), {
      location_id: locationIdByName.get(M.sharedLocation),
    })
  }

  // --- the elective set and its six offerings. ElectiveSetDetail.jsx:458/489/514
  // writes exactly these entities through exactly this handler.
  const electiveSetId = randomUUID()
  await write('elective_sets', electiveSetId, { camp_id: campId, name: 'Chugim', is_reusable: '1' })
  const offeringIdByActivity = new Map()
  for (const [activityName, [mode, limit, minToRun]] of Object.entries(M.offerings)) {
    const id = randomUUID()
    await write('elective_set_activities', id, {
      elective_set_id: electiveSetId,
      activity_id: activityIdByName.get(activityName),
      status: 'confirmed',
      capacity_mode: mode,
      capacity_limit: limit == null ? undefined : String(limit),
      min_mode: minToRun == null ? 'none' : 'required',
      min_to_run: minToRun == null ? undefined : String(minToRun),
    })
    offeringIdByActivity.set(activityName, id)
  }

  // --- the elective cells. Placing a set on the grid is a slot edit
  // (src/screens/schedule/useSlotMutations.js -> repo.writeSlotFields ->
  // template_slots), so it is the same `write` again: the cell's activity is
  // cleared and the set takes it.
  const slotAt = (templateId, groupName, dayLabel) => db.prepare(
    'SELECT id FROM template_slots WHERE template_id = ? AND group_id = ? AND day_id = ? AND time_block_id = ?'
  ).get(templateId, groupIdByName.get(groupName), dayIdByLabel.get(dayLabel), periodId)?.id

  const groupsOfTier = { Younger: ['Younger 1', 'Younger 2'], Older: ['Older 1', 'Older 2'] }
  const electiveSlotIds = { manual: [], generated: [] }
  for (const [route, templateId] of [['manual', manualTemplateId], ['generated', generatedTemplateId]]) {
    for (const [dayLabel, tierNames] of Object.entries(M.occurrenceCells[route])) {
      for (const tierName of tierNames) {
        for (const groupName of groupsOfTier[tierName]) {
          const slotId = slotAt(templateId, groupName, dayLabel)
          if (!slotId) throw new Error(`buildAcceptanceCamp: no ${route} slot at ${groupName}/${dayLabel}/${M.electivePeriod}`)
          await write('template_slots', slotId, { activity_id: null, elective_set_id: electiveSetId })
          electiveSlotIds[route].push(slotId)
        }
      }
    }
  }

  // §6's "one outer location conflict blocking finalization", on the GENERATED
  // route only: Older 2 does Boating at the Monday elective period, and Boating
  // is at Lakefront, where Swim is offered. finalizeElectiveRun.js:86-94 refuses
  // with OUTER_RESOURCE_CONFLICT.
  //
  // Written onto a cell the loop above left as an elective cell for Older 2, so
  // the two routes differ in exactly the way §6 asks a Manual and a Generated
  // template to differ.
  const outerConflictSlotId = slotAt(generatedTemplateId, 'Older 2', 'Monday')
  await write('template_slots', outerConflictSlotId, {
    elective_set_id: null, activity_id: activityIdByName.get(M.sharedLocationOuterActivity),
  })
  electiveSlotIds.generated = electiveSlotIds.generated.filter((id) => id !== outerConflictSlotId)

  // --- the bundles. There is NO bundle-specific IPC handler; ElectiveSetDetail
  // authors them through the generic `write`, which is therefore the production
  // path (docs/adr/2026-09-29-linked-elective-bundles.md D1).
  const bundleIds = {}
  const bundleSpecs = [['bundle', M.bundle], ...M.refusedBundles.map((spec, i) => [`refusedBundle${i}`, spec])]
  for (const [key, spec] of bundleSpecs) {
    const bundleId = randomUUID()
    // No camp_id: elective_bundles is scoped by its elective set, and
    // electron/ops/projections.js:605 does not list one as a writable field.
    await write('elective_bundles', bundleId, {
      elective_set_id: electiveSetId,
      activity_id: activityIdByName.get(spec.activity),
      name: spec.name,
      scope_mode: 'only',
    })
    for (const dayLabel of spec.days) {
      await write('elective_bundle_periods', randomUUID(), {
        bundle_id: bundleId, day_id: dayIdByLabel.get(dayLabel), time_block_id: periodId,
      })
    }
    await write('elective_bundle_tiers', randomUUID(), { bundle_id: bundleId, tier_id: tierIdByName.get(spec.tier) })
    bundleIds[key] = bundleId
  }

  return {
    manifest: M,
    campId, deviceId, cohortId, authorUserId, weekId,
    manualTemplateId, generatedTemplateId,
    electiveSetId, electiveSlotIds, outerConflictSlotId,
    periodId, bundleIds,
    tierIdByName, groupIdByName, activityIdByName, dayIdByLabel, blockIdByName,
    locationIdByName, offeringIdByActivity,
    ingest,
  }
}

/**
 * §6's roster, landed: the resolved sheet imported through the real CLI core,
 * plus the one deactivation.
 *
 * SEPARATE from buildAcceptanceCamp because
 * electiveAcceptanceImport.integration.test.js has to drive the import itself —
 * condition (1) IS the import refusing and then not refusing. Every other T251
 * file calls this, so there is still exactly one construction.
 *
 * `is_active = 0` goes through the real `write` handler and not an UPDATE: a
 * director deactivating a camper is an ordinary field edit, and the op log is
 * how it reaches the camp's other devices.
 */
/**
 * BUNK MEMBERSHIP, which has to come from somewhere other than the sheet.
 *
 * The sheet's Division column names a TIER, because that is what attendance
 * scoping matches against (src/screens/elective/assignment/buildAttendance.js:86-107
 * looks the label up in `tiers`). A tier label resolves to no group, so
 * `campers.group_id` stays null — and a camper with no group inherits no cells
 * from a group template (electron/ops/electiveRunOuterSchedule.js:194-205),
 * which would make §6's condition 6 vacuous. One Division column cannot carry
 * both facts.
 *
 * In a real camp it does not have to: bunk membership is roster data that
 * exists before any preference sheet, and a director sets it on the camper.
 * That is an ordinary field write, so it goes through the real handler.
 *
 * DETERMINISTIC (sorted id, alternating), never random: two runs of this
 * fixture must produce the same camp, or §6's condition 2 would be measuring
 * the fixture instead of the solver.
 */
export async function assignBunks(db, { handlers, token, campId, groupIdByName }) {
  const byTier = { Younger: ['Younger 1', 'Younger 2'], Older: ['Older 1', 'Older 2'] }
  const campers = db
    .prepare('SELECT id, division_label FROM campers WHERE camp_id = ? ORDER BY id')
    .all(campId)
  if (campers.length === 0) throw new Error('assignBunks: no campers to place in bunks')
  const seen = { Younger: 0, Older: 0 }
  for (const camper of campers) {
    const groupNames = byTier[camper.division_label]
    if (!groupNames) throw new Error(`assignBunks: camper division ${camper.division_label} names no tier`)
    const groupName = groupNames[seen[camper.division_label] % groupNames.length]
    seen[camper.division_label] += 1
    const r = await handlers.write({
      token, entity: 'campers', entity_id: camper.id, field: 'group_id', value: groupIdByName.get(groupName),
    })
    if (r?.status !== 'applied') throw new Error(`assignBunks: group write failed (${r?.status})`)
  }
  return campers.length
}

export async function importResolvedSheet(db, { dbPath, handlers, token, authorUserId, campId, groupIdByName }) {
  const out = runPreferenceSheetCli({ file: SHEET_RESOLVED, dbPath, action: 'commit', authorUserId })
  if (!out.ok) throw new Error(`importResolvedSheet: the resolved sheet did not commit — ${out.error ?? out.blocked}`)

  if (campId && groupIdByName) await assignBunks(db, { handlers, token, campId, groupIdByName })

  // §6's "one inactive camper". Chosen by NAME, not by position, so a roster
  // change cannot silently move it onto a different child.
  const name = ACCEPTANCE_MANIFEST.inactiveCamper
  const row = db.prepare('SELECT id FROM campers WHERE display_name = ? AND is_active = 1').get(name)
  if (!row) throw new Error(`importResolvedSheet: no active camper named ${name} to deactivate`)
  const result = await handlers.write({ token, entity: 'campers', entity_id: row.id, field: 'is_active', value: '0' })
  if (result?.status !== 'applied') throw new Error(`importResolvedSheet: deactivating ${name} failed (${result?.status})`)

  return { runId: out.runId, inactiveCamperId: row.id, cli: out }
}

/**
 * The built camp IS the camp §6 describes.
 *
 * Separate from the builder so the assertion is a TEST's (it reports through
 * expect, with a diff) rather than a throw buried in setup — and so a test that
 * forgets to call it is visibly missing a line.
 */
export function manifestChecks(db, fx) {
  const M = ACCEPTANCE_MANIFEST
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const countElectiveCells = (templateId) => all(
    'SELECT DISTINCT day_id, time_block_id, group_id FROM template_slots WHERE template_id = ? AND elective_set_id = ?',
    templateId, fx.electiveSetId
  ).length

  return {
    tiers: all('SELECT name FROM tiers WHERE camp_id = ? ORDER BY name', fx.campId).map((r) => r.name),
    groups: all('SELECT name FROM groups WHERE camp_id = ? ORDER BY name', fx.campId).map((r) => r.name),
    days: all('SELECT label FROM days_of_operation WHERE camp_id = ? ORDER BY sort_order', fx.campId).map((r) => r.label),
    offeringCount: one('SELECT COUNT(*) c FROM elective_set_activities WHERE elective_set_id = ?', fx.electiveSetId).c,
    manualElectiveCells: countElectiveCells(fx.manualTemplateId),
    generatedElectiveCells: countElectiveCells(fx.generatedTemplateId),
    bundleCount: one('SELECT COUNT(*) c FROM elective_bundles WHERE elective_set_id = ?', fx.electiveSetId).c,
    recurringEventRow: one('SELECT id, name, catalog_role FROM activities WHERE camp_id = ? AND name = ?', fx.campId, M.recurringEvent),
    fixedEventRow: one('SELECT id, name, activity_id FROM fixed_events WHERE camp_id = ? AND name = ?', fx.campId, M.recurringEvent),
  }
}
