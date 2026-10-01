// Pure, directly-testable MCP tool handlers (W10). Each function takes
// (args, { dbPath, allowWrite, authorUserId }) and returns a plain JS result
// object — pre-JSON-stringify, pre-MCP-envelope. scripts/mcp/server.js wraps
// these in the MCP SDK's stdio transport and content envelope; it contains
// no logic of its own (docs/adr/2026-08-21-mcp-ingestion-server.md, "Test
// seam").
//
// Descriptions surfaced to the MCP client (in server.js's tool
// registration) use canonical W1 vocabulary — Age Division, Program,
// Location, Group — never internal table names. The friendly->DB entity map
// below is a presentation concern that belongs to this MCP layer, not to
// electron/ops/read.js.
import { openLocalDb } from '../../electron/db/localDb.js'
import { makeDocCipher } from '../../electron/db/docCipher.js'
import { runIngestCli } from '../ingestCli.js'
import { runPreferenceSheetCli } from '../preferenceSheetCli.js'
import { resolutionMap, RESOLUTION } from '../../src/ingest/labelResolutions.js'
import { attributeElectiveSubject } from '../../electron/ops/attributeElectiveSubject.js'
import { setElectivePreference, removeElectivePreference } from '../../electron/ops/setElectivePreference.js'
import { isHumanOwned } from '../../electron/ops/fieldProvenance.js'
import { listEntities } from '../../electron/ops/read.js'
import { assembleScheduleEngineInputs } from '../../electron/ops/scheduleEngineInputs.js'
import { normalizeSlots } from '../../src/utils/normalizeSlots.js'
import buildSchedule from '../../src/engine/buildSchedule.js'
import { buildScheduleExport } from '../../src/utils/exportScheduleJson.js'
import { PROJECTIONS } from '../../electron/ops/projections.js'
import { repairProjectionForEntity, checkProjectionHealth } from '../../electron/ops/projectionRepair.js'
import { listDocumentWriteFailures } from '../../electron/ops/documentWriteFailures.js'
import { listDeviceHealthEvents } from '../../electron/ops/deviceHealthEvents.js'
import { buildElectiveRunProjectionInput } from '../../electron/ops/electiveRunProjectionInput.js'
import { buildElectiveRunProjectionExport } from '../../src/screens/elective/export/exportElectiveRunProjection.js'
import path from 'node:path'
import {
  rebuildProjectionFromDocumentAtPath,
  RebuildRefusalError,
} from '../../electron/automerge/rebuildSupportCommand.js'

export const ENTITY_MAP = {
  age_divisions: 'tiers',
  programs: 'cohorts',
  groups: 'groups',
  locations: 'locations',
  activities: 'activities',
  days_of_operation: 'days_of_operation',
  time_blocks: 'time_blocks',
  weeks: 'schedule_weeks',
}

export function ingestPreviewTool(args, { dbPath, dbKey }) {
  return runIngestCli({ file: args.file_path, dbPath, mode: args.mode ?? 'add', action: 'preview', dbKey })
}

export function ingestCommitTool(args, { dbPath, allowWrite, authorUserId, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error: 'commit is disabled — relaunch the server with --allow-write to enable ingest_commit',
      exitCode: 1,
    }
  }
  return runIngestCli({
    file: args.file_path,
    dbPath,
    mode: args.mode ?? 'add',
    action: 'commit',
    authorUserId: authorUserId ?? null,
    dbKey,
  })
}

// T226 — a camper ranked-preference sheet is a DIFFERENT document from a
// schedule grid, with a different commit path, so it gets its own pair of
// tools. Overloading ingest_preview would mean relaxing the T224 schedule-shape
// gate, which exists precisely to refuse this kind of sheet.
//
// Same handler contract as the pair above: (args, { dbPath, allowWrite,
// authorUserId, dbKey }) in, a plain pre-envelope result object out.
// T298 — WHAT AN AGENT MAY SETTLE ABOUT A LABEL, filtered to the two resolutions
// that write nothing. `map_to_existing` and `split_packed` are statements about how
// to read the file; `add_activity` MINTS a camp activity, which is a change to the
// camp's own setup, and a tool whose stated job is "read this sheet" must not make
// one as a side effect. An agent that wants the activity creates it, then re-previews.
const MACHINE_RESOLUTIONS = new Set([RESOLUTION.MAP_TO_EXISTING, RESOLUTION.SPLIT_PACKED])

function machineResolutions(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return resolutionMap(
    list
      .filter((r) => MACHINE_RESOLUTIONS.has(r?.action))
      .map((r) => ({ label: r.label, action: r.action, activityName: r.activity_name ?? r.activityName }))
  )
}

export function preferenceSheetPreviewTool(args, { dbPath, dbKey }) {
  return runPreferenceSheetCli({
    file: args.file_path,
    dbPath,
    action: 'preview',
    // T285 — WHOSE sheet this is, when the caller knows. A planner grid carries no
    // name column because the identity comes from the SUBMISSION rather than the
    // page, so this is step 1 of the identity order and the normal case for an
    // agent driving the import on a director's behalf. It existed as a parameter
    // with no argv parser and no tool passing it, which is not a feature.
    camperName: args.camper_name ?? null,
    resolutions: machineResolutions(args.label_resolutions),
    // T303 — WHICH ARRIVAL THIS IS. Accepted on the READ tool as well as the write
    // one, and that is not a T298 violation: an arrival token is a statement about
    // WHICH SUBMISSION this is, it mints nothing, and a preview that ignored it would
    // report a collision the matching commit would not have — the preview and the
    // commit have to be reading the same import.
    arrivalId: args.arrival_id ?? null,
    dbKey,
  })
}

export function preferenceSheetCommitTool(args, { dbPath, allowWrite, authorUserId, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error:
        'commit is disabled — relaunch the server with --allow-write to enable preference_sheet_commit',
      exitCode: 1,
    }
  }
  return runPreferenceSheetCli({
    file: args.file_path,
    dbPath,
    action: 'commit',
    runName: args.run_name ?? null,
    camperName: args.camper_name ?? null,
    resolutions: machineResolutions(args.label_resolutions),
    arrivalId: args.arrival_id ?? null,
    authorUserId: authorUserId ?? null,
    dbKey,
  })
}

// T285 — NAME A SUBJECT WE ALREADY HOLD THE ANSWERS FOR.
//
// The import's own residue promises "name the camper when you know them, and
// nothing needs re-importing". This is the call that makes that true, and the MCP
// surface is its natural home: it is exactly the bridge the owner asked for — an
// agent talking to the software on a director's behalf — and the same act is in the
// director's attention surface ("Needs your attention"), not a separate screen.
//
// Attribution REKEYS rather than renaming: see attributeElectiveSubject for why a
// rename would convert a merge bug into a worse fork bug.
export function attributeSubjectTool(args, { dbPath, allowWrite, authorUserId, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error:
        'this changes data — relaunch the server with --allow-write to enable attribute_camper_subject',
      exitCode: 1,
    }
  }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return { ok: false, error: 'db has no camp bootstrapped yet', exitCode: 1 }
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return { ok: false, error: 'db has no device registered yet', exitCode: 1 }

    const out = attributeElectiveSubject(db, {
      campId: camp.id,
      deviceId: device.id,
      authorUserId: authorUserId ?? null,
      subjectId: args.subject_id,
      displayName: args.camper_name,
      externalId: args.external_id ?? null,
    })
    return out.ok ? { ...out, exitCode: 0 } : { ...out, exitCode: 1 }
  } finally {
    db.close()
  }
}

// T297 — ONE CAMPER'S PREFERENCES, AND WHETHER A HUMAN SET THEM.
//
// WHY THIS BELONGS ON THE MCP SURFACE. T298 drew the line at side effects: a tool
// whose stated job is "read this sheet" must not change camp setup on the way
// past. That line is about a write hiding inside a read, not about writes as
// such — attribute_camper_subject is a targeted, explicitly-named write and sits
// here for exactly the reason this one does: the same act is available to the
// director on screen, and an agent working on their behalf must not be the one
// party who has to re-import a file to change one child's answer.
//
// `edited_by_hand` is carried deliberately. The whole point of T297's provenance
// is that a correction is distinguishable from an import, and a surface that
// could not see the difference would be inviting an agent to overwrite a
// director's decision without knowing it had.
export function camperPreferencesTool(args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    // The filters are BOUND INTO THE SQL rather than applied afterwards: asking
    // for one camper otherwise joins five tables across every preference row in
    // the database and discards almost all of it.
    const camperName = args?.camper_name ?? null
    const runId = args?.run_id ?? null
    const rows = db
      .prepare(
        `SELECT p.id AS preference_id, p.run_id, p.camper_id, p.choice_id, p.occurrence_id,
                p.rank, p.rank_kind, p.coordinate_day_label, p.coordinate_period_label,
                c.display_name AS camper_name, ch.label AS choice_label,
                d.label AS day_label, t.name AS period_label
           FROM elective_preferences p
           LEFT JOIN campers c ON c.id = p.camper_id
           LEFT JOIN elective_choices ch ON ch.id = p.choice_id
           LEFT JOIN elective_occurrences o ON o.id = p.occurrence_id
           LEFT JOIN days_of_operation d ON d.id = o.day_id
           LEFT JOIN time_blocks t ON t.id = o.time_block_id
          WHERE (:camperName IS NULL OR c.display_name = :camperName)
            AND (:runId IS NULL OR p.run_id = :runId)
          ORDER BY c.display_name, p.id`
      )
      .all({ camperName, runId })
      .map((r) => ({
        ...r,
        // The cell as the CAMP names it when a template has bound one, and as the
        // CHILD wrote it otherwise — a coordinate-keyed row is the ordinary shape
        // for a planner sheet imported before any schedule existed.
        day: r.day_label ?? r.coordinate_day_label,
        period: r.period_label ?? r.coordinate_period_label,
        edited_by_hand: isHumanOwned(db, 'elective_preferences', r.preference_id, 'choice_id'),
      }))
    return { ok: true, preferences: rows, exitCode: 0 }
  } finally {
    db.close()
  }
}

// T297 — state one camper's preference for one cell, or correct an existing one.
//
// `replaces_preference_id` is how a CORRECTION is expressed, and passing it
// matters: the new row inherits that row's scope, so a whole-run ranked answer
// stays whole-run instead of being narrowed to one cell. Omitting it states a new
// preference for the named cell. See electron/ops/setElectivePreference.js.
export function setCamperPreferenceTool(args, { dbPath, allowWrite, authorUserId, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error:
        'this changes data — relaunch the server with --allow-write to enable set_camper_preference',
      exitCode: 1,
    }
  }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return { ok: false, error: 'db has no device registered yet', exitCode: 1 }
    const out = setElectivePreference(db, {
      runId: args.run_id,
      camperId: args.camper_id,
      occurrenceId: args.occurrence_id,
      choiceId: args.choice_id,
      rank: args.rank ?? null,
      rankKind: args.rank_kind ?? null,
      replacesPreferenceId: args.replaces_preference_id ?? null,
      authorUserId: authorUserId ?? null,
      deviceId: device.id,
    })
    return out.ok ? { ...out, exitCode: 0 } : { ...out, exitCode: 1 }
  } finally {
    db.close()
  }
}

// T297 — withdraw one preference. A separate verb rather than a null choice on
// set_camper_preference: "remove" and "set to nothing" are different statements
// and collapsing them would make a removal something an agent could do by
// accident.
export function removeCamperPreferenceTool(args, { dbPath, allowWrite, authorUserId, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error:
        'this changes data — relaunch the server with --allow-write to enable remove_camper_preference',
      exitCode: 1,
    }
  }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return { ok: false, error: 'db has no device registered yet', exitCode: 1 }
    const out = removeElectivePreference(db, {
      runId: args.run_id,
      preferenceId: args.preference_id,
      authorUserId: authorUserId ?? null,
      deviceId: device.id,
    })
    return out.ok ? { ...out, exitCode: 0 } : { ...out, exitCode: 1 }
  } finally {
    db.close()
  }
}

// The subjects awaiting a name. Read from the SAME place the director's attention
// surface reads (campers.is_unattributed), so an agent and a human are looking at
// one list rather than two queries that can disagree.
export function listUnattributedSubjectsTool(args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const subjects = db
      .prepare(
        `SELECT c.id AS subject_id, c.display_name AS label,
                COUNT(p.id) AS preference_count
           FROM campers c
           LEFT JOIN elective_preferences p ON p.camper_id = c.id
          WHERE c.is_unattributed = 1
          GROUP BY c.id, c.display_name
          ORDER BY c.display_name`
      )
      .all()
    return { ok: true, subjects, exitCode: 0 }
  } finally {
    db.close()
  }
}

export function listEntitiesTool(args, { dbPath, dbKey }) {
  const dbEntity = ENTITY_MAP[args.entity]
  if (!dbEntity) {
    return { ok: false, error: `unknown entity: ${args.entity}` }
  }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    return { ok: true, entity: args.entity, rows: listEntities(db, dbEntity) }
  } finally {
    db.close()
  }
}

export function setupSummaryTool(_args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const counts = {}
    for (const [friendly, dbEntity] of Object.entries(ENTITY_MAP)) {
      counts[friendly] = listEntities(db, dbEntity).length
    }
    return { ok: true, counts }
  } finally {
    db.close()
  }
}

function emptyScheduleState(route) {
  return { ok: true, route, week_id: null, template: null, slots: [], overlays: [], findings: [], conflicts: [] }
}

// schedule_templates resolves by (week_id, kind), not kind alone — a camp
// can have many schedule_weeks rows, each with its own template per route.
// Mirrors useScheduleData.js's templateRowFor (docs/adr/2026-08-21-mcp-
// ingestion-server.md, Decision 9).
function templateRowFor(templates, weekId, kind) {
  return templates.find((t) => t.week_id === weekId && (t.kind || 'generated') === kind)
}

// Re-runs the pure engine over this camp's current setup + this route's
// already-placed slots (passed in as preplacedSlots, i.e. locked) so the
// returned findings/conflicts match what the renderer would show for the
// SAME stored placement, without moving any slot (docs/adr/2026-08-21-mcp-
// ingestion-server.md, Decision 8). `slots`/`overlays` in the response are
// the stored DB rows verbatim; `findings`/`conflicts` are freshly computed.
//
// week_id resolution (Decision 9): if given, resolve (week_id, route)
// directly. If omitted and the camp has exactly one schedule_weeks row, use
// it. If omitted and multiple weeks exist, do not guess — return
// { ok: true, needs_week: true, weeks } so the caller can pick.
export function scheduleStateTool(args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return emptyScheduleState(args.route)

    let weekId = args.week_id ?? null
    if (!weekId) {
      const weeks = listEntities(db, 'schedule_weeks')
      if (weeks.length === 0) return emptyScheduleState(args.route)
      if (weeks.length > 1) return { ok: true, route: args.route, needs_week: true, weeks }
      weekId = weeks[0].id
    }

    const template = templateRowFor(listEntities(db, 'schedule_templates'), weekId, args.route)
    if (!template) return { ...emptyScheduleState(args.route), week_id: weekId }

    const slots = normalizeSlots(
      listEntities(db, 'template_slots').filter((s) => s.template_id === template.id)
    )

    const inputs = assembleScheduleEngineInputs(db, camp.id)
    // Reconstructing STORED state (unlike useGeneration.js's lockedPreplaced,
    // which filters to locked activities because it is about to regenerate),
    // so the activity family keeps its original predicate verbatim. Only the
    // two overlay families are ADDED — an elective/event overlay is authored
    // content, never engine output, and dropping it here is exactly T193
    // Defect A: the rows would still exist in `slots`, but the engine would
    // never learn the overlay's location is occupied, and validation would
    // come back falsely clean (docs/work/tickets/T193-overlay-reconstruction-
    // and-route-validator.md).
    const activityPreplaced = slots
      .filter((s) => s.activity_id && !s.is_fixed_event)
      .map((s) => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))
    const electivePreplaced = slots
      .filter((s) => s.elective_set_id)
      .map((s) => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, electiveSetId: s.elective_set_id }))
    const eventPreplaced = slots
      .filter((s) => s.event_id)
      .map((s) => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, eventId: s.event_id }))
    const preplacedSlots = [...activityPreplaced, ...electivePreplaced, ...eventPreplaced]
    const overlays = slots.filter((s) => s.elective_set_id || s.event_id)

    const engineResult = buildSchedule({ ...inputs, campId: camp.id, preplacedSlots, weekId })

    return {
      ok: true,
      route: args.route,
      week_id: weekId,
      template,
      slots,
      overlays,
      findings: engineResult.findings || [],
      conflicts: engineResult.conflicts || [],
    }
  } finally {
    db.close()
  }
}

// Assemble one candidate schedule (route × week) into the stable, versioned
// JSON export shape (buildScheduleExport, src/utils/exportScheduleJson.js) —
// the portable "move this schedule anywhere" format (M2c,
// docs/work/plans/2026-09-01-machine-access.md). Read-only. Reuses the same
// week/template resolution as scheduleStateTool (needs_week when >1 week and
// none given). A camp/week/route with no placed template yields a valid export
// with the axes populated and cells: [].
export function exportScheduleTool(args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
    if (!camp) return { ok: true, export: null, empty: true }

    const weeks = listEntities(db, 'schedule_weeks')
    let weekId = args.week_id ?? null
    if (!weekId) {
      if (weeks.length === 0) return { ok: true, export: null, empty: true }
      if (weeks.length > 1) return { ok: true, route: args.route, needs_week: true, weeks }
      weekId = weeks[0].id
    }
    const week = weeks.find((w) => w.id === weekId) ?? { id: weekId }

    const template = templateRowFor(listEntities(db, 'schedule_templates'), weekId, args.route)
    const slots = template
      ? normalizeSlots(listEntities(db, 'template_slots').filter((s) => s.template_id === template.id))
      : []

    const out = buildScheduleExport({
      slots,
      activities: listEntities(db, 'activities'),
      anchors: listEntities(db, 'fixed_events'),
      groups: listEntities(db, 'groups'),
      days: listEntities(db, 'days_of_operation'),
      timeBlocks: listEntities(db, 'time_blocks'),
      electiveSets: listEntities(db, 'elective_sets'),
      // T195 (offering-grid import) load-boundary filter: a 'potential'
      // offering must never reach an export — one of the three consumption
      // boundaries (the other two: scheduleRepository.js,
      // scheduleInputNormalization.js).
      electiveSetActivities: listEntities(db, 'elective_set_activities').filter((row) => row.status !== 'potential'),
      events: listEntities(db, 'events'),
      camp,
      week,
      route: args.route,
    })
    return { ok: true, export: out }
  } finally {
    db.close()
  }
}

// docs/adr/2026-09-04-projection-failure-detection-and-recovery.md, "Product
// decisions" #1/#3: v1 has no director-facing UI or renderer IPC for
// projection_failures — this MCP surface is the only manual entry point,
// for dogfooding/support use. Read-only, so always available like
// list_entities/setup_summary — no --allow-write gate.
// Reports BOTH kinds, separately, because they need opposite remedies and this
// is the only place either is readable (schema v58, see
// electron/ops/documentWriteFailures.js):
//
//   failures          — the op did not reach SQLite. repair_projection_entity
//                       replays the op-log and fixes it.
//   documentFailures  — the op reached SQLite but not the Automerge document.
//                       SQLite is already correct and the DOCUMENT is behind, so
//                       that same replay is the WRONG remedy: it would succeed
//                       and mark the divergence resolved while it is still there.
//                       Recovery is a re-seed of the document, not a replay.
//
// Omitting the second here would have left them recorded where nothing can read
// them — a durable trace is only worth having if something surfaces it.
//   deviceHealthEvents — a merged document that would not project into SQLite, a
//                       a document save that failed on disk. Neither has an op id
//                       (a merge has no op; a failed save loses the window), so
//                       they are recorded in the device's audit log instead. They
//                       mean SQLite is BEHIND the document, or the document file
//                       is behind memory — both invisible without this.
export function checkProjectionHealthTool(_args, { dbPath, dbKey }) {
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    // T174: this used to read audit_events for two actions that could never be
    // written there (its outcome CHECK rejects 'error'), so it always returned []
    // and the tool reported HEALTHY because nothing could be recorded. Reads the
    // table those events actually land in now.
    const deviceHealthEvents = listDeviceHealthEvents(db)
    return {
      ok: true,
      ...checkProjectionHealth(db),
      documentFailures: listDocumentWriteFailures(db),
      deviceHealthEvents,
    }
  } finally {
    db.close()
  }
}

// Mutating (replays op-log history back into the projected table), so it is
// gated the same way ingest_commit already is — the ADR's stated posture for
// this call ("Repair trigger and authority" #3). entity is validated against
// PROJECTIONS (the same registry applyProjection itself checks) before any
// query runs, so an invalid entity name is rejected rather than executing an
// unbounded scan (ADR §3, "Trust boundary").
export function repairProjectionEntityTool(args, { dbPath, allowWrite, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error: 'repair is disabled — relaunch the server with --allow-write to enable repair_projection_entity',
    }
  }
  if (!PROJECTIONS[args.entity]) {
    return { ok: false, error: `unknown entity: ${args.entity}` }
  }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    return { ...repairProjectionForEntity(db, args.entity, args.entity_id), entity: args.entity, entity_id: args.entity_id }
  } finally {
    db.close()
  }
}

// T161: the support-command entry point for "delete this computer's SQLite
// and rebuild it from the Automerge document" (T151 proved the property; this
// is the first thing that actually runs it). Deliberately mutating and gated
// like repair_projection_entity — this is a recovery procedure a person runs
// on purpose (docs/current/WHERE_DATA_LIVES.md's rebuild-precondition
// section), never a director-facing action. `user_data_dir` defaults to the
// db file's own directory (the normal case — dbPath is
// `<userDataDir>/shoresh.sqlite`, see electron/main.js); pass it explicitly
// only for a non-default layout (a custom --project path).
export function rebuildProjectionFromDocumentTool(args, { dbPath, allowWrite, dbKey }) {
  if (!allowWrite) {
    return {
      ok: false,
      error: 'rebuild is disabled — relaunch the server with --allow-write to enable rebuild_projection_from_document',
    }
  }
  const userDataDir = args.user_data_dir ?? path.dirname(dbPath)
  // Under encryption: the rebuild opens the SQLite db (needs the key) AND reads the .automerge
  // document (needs the cipher). Both derive from the one device key; null when unencrypted.
  const cipher = dbKey ? makeDocCipher(dbKey) : null
  try {
    return rebuildProjectionFromDocumentAtPath({ dbPath, userDataDir, key: dbKey ?? null, cipher })
  } catch (err) {
    if (err instanceof RebuildRefusalError) {
      return { ok: false, error: err.message }
    }
    throw err
  }
}

// T198 — the run's identity, assignments, preferences and findings, over
// buildElectiveRunProjectionInput (electron/ops/electiveRunProjectionInput.js) — the ONE assembly
// this and exportElectiveAssignmentsTool below both call, so the two can never disagree about a run's
// data the way a second hand-rolled query would risk. Read-only, camp-scoped: no --allow-write gate,
// matching the schedule_state/export_schedule/camper_preferences precedent.
export function getElectiveAssignmentRunTool(args, { dbPath, dbKey }) {
  if (!args?.run_id) return { ok: false, error: 'run_id is required', exitCode: 1 }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const result = buildElectiveRunProjectionInput(db, { runId: args.run_id })
    if (!result.ok) return { ok: false, error: result.error, exitCode: 1 }
    return { ok: true, ...result.input, exitCode: 0 }
  } finally {
    db.close()
  }
}

// T198 — the versioned combined projection document (format_version 1: child schedules, activity
// roster, exceptions, summary — src/screens/elective/export/exportElectiveRunProjection.js) for one
// run. Built from the SAME buildElectiveRunProjectionInput this file's getElectiveAssignmentRunTool
// calls, so the MCP export, the CLI's `electives export`, and the UI's own export can never assemble
// three different documents for one run — see the parity assertion in
// electron/electiveAcceptanceSurfaces.integration.test.jsx. JSON only: MCP's stdio transport returns
// one JSON envelope, so an XLSX workbook (a binary file on disk) is a CLI-only format — see
// scripts/electivesCli.js's export action for `format: 'xlsx'`.
export function exportElectiveAssignmentsTool(args, { dbPath, dbKey }) {
  if (!args?.run_id) return { ok: false, error: 'run_id is required', exitCode: 1 }
  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const result = buildElectiveRunProjectionInput(db, { runId: args.run_id })
    if (!result.ok) return { ok: false, error: result.error, exitCode: 1 }
    return { ok: true, export: buildElectiveRunProjectionExport(result.input), exitCode: 0 }
  } finally {
    db.close()
  }
}
