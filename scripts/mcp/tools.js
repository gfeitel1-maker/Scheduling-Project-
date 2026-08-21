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
import { runIngestCli } from '../ingestCli.js'
import { listEntities } from '../../electron/ops/read.js'
import { assembleScheduleEngineInputs } from '../../electron/ops/scheduleEngineInputs.js'
import { normalizeSlots } from '../../src/utils/normalizeSlots.js'
import buildSchedule from '../../src/engine/buildSchedule.js'

export const ENTITY_MAP = {
  age_divisions: 'tiers',
  programs: 'cohorts',
  groups: 'groups',
  locations: 'locations',
  activities: 'activities',
  days_of_operation: 'days_of_operation',
  time_blocks: 'time_blocks',
}

export function ingestPreviewTool(args, { dbPath }) {
  return runIngestCli({ file: args.file_path, dbPath, mode: args.mode ?? 'add', action: 'preview' })
}

export function ingestCommitTool(args, { dbPath, allowWrite, authorUserId }) {
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
  })
}

export function listEntitiesTool(args, { dbPath }) {
  const dbEntity = ENTITY_MAP[args.entity]
  if (!dbEntity) {
    return { ok: false, error: `unknown entity: ${args.entity}` }
  }
  const db = openLocalDb(dbPath)
  try {
    return { ok: true, entity: args.entity, rows: listEntities(db, dbEntity) }
  } finally {
    db.close()
  }
}

export function setupSummaryTool(_args, { dbPath }) {
  const db = openLocalDb(dbPath)
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
  return { ok: true, route, template: null, slots: [], overlays: [], findings: [], conflicts: [] }
}

// Re-runs the pure engine over this camp's current setup + this route's
// already-placed slots (passed in as preplacedSlots, i.e. locked) so the
// returned findings/conflicts match what the renderer would show for the
// SAME stored placement, without moving any slot (docs/adr/2026-08-21-mcp-
// ingestion-server.md, Decision 8). `slots`/`overlays` in the response are
// the stored DB rows verbatim; `findings`/`conflicts` are freshly computed.
export function scheduleStateTool(args, { dbPath }) {
  const db = openLocalDb(dbPath)
  try {
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return emptyScheduleState(args.route)

    const template = listEntities(db, 'schedule_templates').find(
      (t) => (t.kind || 'generated') === args.route
    )
    if (!template) return emptyScheduleState(args.route)

    const slots = normalizeSlots(
      listEntities(db, 'template_slots').filter((s) => s.template_id === template.id)
    )
    const overlays = listEntities(db, 'template_overlays').filter((o) => o.template_id === template.id)

    const inputs = assembleScheduleEngineInputs(db, camp.id)
    const preplacedSlots = slots
      .filter((s) => s.activity_id && !s.is_anchor)
      .map((s) => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, activityId: s.activity_id }))

    const engineResult = buildSchedule({ ...inputs, campId: camp.id, preplacedSlots })

    return {
      ok: true,
      route: args.route,
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
