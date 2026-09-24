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
import { listEntities } from '../../electron/ops/read.js'
import { assembleScheduleEngineInputs } from '../../electron/ops/scheduleEngineInputs.js'
import { normalizeSlots } from '../../src/utils/normalizeSlots.js'
import buildSchedule from '../../src/engine/buildSchedule.js'
import { buildScheduleExport } from '../../src/utils/exportScheduleJson.js'
import { PROJECTIONS } from '../../electron/ops/projections.js'
import { repairProjectionForEntity, checkProjectionHealth } from '../../electron/ops/projectionRepair.js'
import { listDocumentWriteFailures } from '../../electron/ops/documentWriteFailures.js'
import { listDeviceHealthEvents } from '../../electron/ops/deviceHealthEvents.js'
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
export function preferenceSheetPreviewTool(args, { dbPath, dbKey }) {
  return runPreferenceSheetCli({ file: args.file_path, dbPath, action: 'preview', dbKey })
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
    authorUserId: authorUserId ?? null,
    dbKey,
  })
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
      .filter((s) => s.activity_id && !s.is_anchor)
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
      anchors: listEntities(db, 'anchor_activities'),
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
