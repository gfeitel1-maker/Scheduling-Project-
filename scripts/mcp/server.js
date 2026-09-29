#!/usr/bin/env node
// stdio transport wiring + argv parsing only (W10,
// docs/adr/2026-08-21-mcp-ingestion-server.md, "Files/modules affected").
// All handler logic lives in scripts/mcp/tools.js — this file never touches
// the db directly.
//
// Launch: node scripts/mcp/server.js --db /path/to/shoresh.sqlite
//   [--allow-write] [--author-user-id <uuid>]
//
// Note on the ABI: this runs under Node, not Electron, so it needs the
// Node-built better-sqlite3 binary — run `npm rebuild better-sqlite3` first
// if `electron:dev` ran most recently (see CLAUDE.md's ABI note).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveHeadlessDbKey } from '../../electron/db/headlessDbKey.js'

import {
  ingestPreviewTool,
  ingestCommitTool,
  preferenceSheetPreviewTool,
  preferenceSheetCommitTool,
  attributeSubjectTool,
  listUnattributedSubjectsTool,
  camperPreferencesTool,
  setCamperPreferenceTool,
  removeCamperPreferenceTool,
  listEntitiesTool,
  setupSummaryTool,
  scheduleStateTool,
  exportScheduleTool,
  checkProjectionHealthTool,
  repairProjectionEntityTool,
  rebuildProjectionFromDocumentTool,
} from './tools.js'

function parseArgs(argv) {
  const dbIndex = argv.indexOf('--db')
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : undefined
  const allowWrite = argv.includes('--allow-write')
  const authorIndex = argv.indexOf('--author-user-id')
  const authorUserId = authorIndex >= 0 ? argv[authorIndex + 1] : null
  return { dbPath, allowWrite, authorUserId }
}

const { dbPath, allowWrite, authorUserId } = parseArgs(process.argv.slice(2))
if (!dbPath) {
  console.error('scripts/mcp/server.js: --db <path> is required')
  process.exit(1)
}
// At-rest key for an encrypted DB (ADR 2026-09-16). Read from a protected channel
// (SHORESH_DB_KEY / SHORESH_DB_KEY_FILE), never argv. null → plaintext open, exactly as before, so
// this is inert unless encryption is on and the unlock helper has supplied a key.
let dbKey = null
try {
  dbKey = resolveHeadlessDbKey()
} catch (err) {
  console.error(`scripts/mcp/server.js: ${err.message}`)
  process.exit(1)
}
const ctx = { dbPath, allowWrite, authorUserId, dbKey }

const TOOLS = [
  {
    name: 'ingest_preview',
    description:
      "Preview what importing a schedule file (Excel or text grid) would create or change in this camp's setup — Age Divisions, Programs, Groups, Locations, Activities, Days, Time Blocks. Makes no changes.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to import.' },
        mode: { type: 'string', enum: ['add', 'replace'], default: 'add' },
      },
      required: ['file_path'],
    },
    handler: ingestPreviewTool,
  },
  {
    name: 'ingest_commit',
    description:
      "Commit a schedule-file import into this camp's setup. Requires the server to have been launched with --allow-write; otherwise refuses.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        mode: { type: 'string', enum: ['add', 'replace'], default: 'add' },
      },
      required: ['file_path'],
    },
    handler: ingestCommitTool,
  },
  {
    name: 'preference_sheet_preview',
    description:
      "Preview what importing a camper elective preference sheet (Excel or CSV) would create: the campers on it, the distinct elective choices they named, and their ranked preferences. Makes no changes. Reports which column it read as the camper name, camper id, division and each ranking, any campers whose name appears on more than one row with no camper id to tell them apart, any rows it skipped, and — in `blocked` — the reason a commit would be refused, if it would be. This is NOT the schedule importer: use ingest_preview for a schedule grid.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the preference sheet to read.' },
        run_name: { type: 'string', description: 'Optional name for the run this sheet would create.' },
        camper_name: {
          type: 'string',
          description:
            "Optional. WHOSE sheet this is. A filled-in planner grid has no camper-name column — it is one camper's own sheet and the identity comes from the submission, not the page — so pass the camper's name here when you know it. Without it the sheet is still imported in full, against a provisional subject you can name later with attribute_camper_subject.",
        },
        label_resolutions: {
          type: 'array',
          description:
            "Optional. How to read labels this camp's activity list cannot resolve, which the residue in a preview names. Each entry is {label, action, activity_name}. action 'map_to_existing' reads that label as an activity the camp already has (activity_name required) — use it when the sheet spells an existing activity differently, e.g. 'Arts and Crafts' against 'Arts & Crafts'. action 'split_packed' reads a cell naming several activities at once ('Swim, Archery, Ceramics') as those separate choices. Both only change how the FILE is read and write nothing extra; neither creates an activity, so a label naming an activity the camp genuinely lacks stays residue until someone adds it.",
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The label exactly as the sheet wrote it.' },
              action: { type: 'string', enum: ['map_to_existing', 'split_packed'] },
              activity_name: { type: 'string', description: "Required for map_to_existing: the camp's own name for the activity." },
            },
            required: ['label', 'action'],
          },
        },
      },
      required: ['file_path'],
    },
    handler: preferenceSheetPreviewTool,
  },
  {
    name: 'preference_sheet_commit',
    description:
      "Commit a camper elective preference sheet: records each camper, each distinct elective choice named on the sheet, and every camper's ranked preferences as one draft run. Requires the server to have been launched with --allow-write; otherwise refuses. Refuses the whole sheet, writing nothing, when two rows name the same camper with no camper id to tell them apart, or when a camper holds the same rank twice.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        run_name: { type: 'string', description: 'Optional. Defaults to the file name.' },
        camper_name: {
          type: 'string',
          description:
            "Optional. WHOSE sheet this is, for a planner grid that names no camper. Without it the choices are still stored in full against a provisional subject, which list_unattributed_subjects will show and attribute_camper_subject can name later without re-importing.",
        },
        label_resolutions: {
          type: 'array',
          description:
            "Optional. How to read labels this camp's activity list cannot resolve, which the residue in a preview names. Each entry is {label, action, activity_name}. action 'map_to_existing' reads that label as an activity the camp already has (activity_name required) — use it when the sheet spells an existing activity differently, e.g. 'Arts and Crafts' against 'Arts & Crafts'. action 'split_packed' reads a cell naming several activities at once ('Swim, Archery, Ceramics') as those separate choices. Both only change how the FILE is read and write nothing extra; neither creates an activity, so a label naming an activity the camp genuinely lacks stays residue until someone adds it.",
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The label exactly as the sheet wrote it.' },
              action: { type: 'string', enum: ['map_to_existing', 'split_packed'] },
              activity_name: { type: 'string', description: "Required for map_to_existing: the camp's own name for the activity." },
            },
            required: ['label', 'action'],
          },
        },
      },
      required: ['file_path'],
    },
    handler: preferenceSheetCommitTool,
  },
  {
    name: 'list_unattributed_subjects',
    description:
      "List the imported sheets whose camper is not yet identified. A filled-in planner grid is one camper's own sheet and carries no name column, so when nothing said whose it was, the choices were stored in full against a provisional subject labelled with the file name. Each entry gives the subject_id to pass to attribute_camper_subject and how many preferences it holds. This is the same list the director sees under \"Needs your attention\".",
    inputSchema: { type: 'object', properties: {} },
    handler: listUnattributedSubjectsTool,
  },
  {
    name: 'attribute_camper_subject',
    description:
      "Name the camper whose sheet was imported without an identity. Moves that subject's choices onto the camper's real identity, so a later import of the same name lands on the SAME record rather than creating a second one, and nothing needs re-importing. Requires --allow-write. Refuses if the camper is already identified, since renaming an identified camper would give them a new identity and disconnect them from their other records.",
    inputSchema: {
      type: 'object',
      properties: {
        subject_id: {
          type: 'string',
          description: 'The subject to name, from list_unattributed_subjects.',
        },
        camper_name: { type: 'string', description: "The camper's name as the camp writes it." },
        external_id: {
          type: 'string',
          description: "Optional. The camp's own roster id for this camper, if there is one.",
        },
      },
      required: ['subject_id', 'camper_name'],
    },
    handler: attributeSubjectTool,
  },
  {
    name: 'camper_preferences',
    description:
      "One camper's elective choices as this camp holds them, or every camper's. Each row carries the preference_id to pass to set_camper_preference or remove_camper_preference, the day and period it applies to (or none, for a whole-run ranked answer), and edited_by_hand — whether a person here set it rather than the imported sheet. Check edited_by_hand before changing anything: overwriting a director's own correction is the one thing this surface must not do quietly.",
    inputSchema: {
      type: 'object',
      properties: {
        camper_name: { type: 'string', description: "Optional. Limit to one camper, by the name the camp writes." },
        run_id: { type: 'string', description: 'Optional. Limit to one assignment run.' },
      },
    },
    handler: camperPreferencesTool,
  },
  {
    name: 'set_camper_preference',
    description:
      "State what one camper asked for in one period, without re-importing a file. To CORRECT an existing answer pass its replaces_preference_id from camper_preferences — the correction then keeps that answer's scope, so a whole-run ranked list stays whole-run instead of being narrowed to a single period. Omit it to state a new preference for the named period. Solve the run again afterwards for the change to reach the placements. Requires --allow-write.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The assignment run, from camper_preferences.' },
        camper_id: { type: 'string', description: 'The camper, from camper_preferences.' },
        occurrence_id: { type: 'string', description: 'The period this is about, from camper_preferences.' },
        choice_id: { type: 'string', description: 'What they asked for. Must be a choice this run already knows — see camper_preferences.' },
        rank: { type: 'integer', description: 'Where this sits in their ordering. Pass the replaced row\u2019s rank when correcting one; 1 for a period they have chosen.' },
        rank_kind: { type: 'string', description: "How to read that rank: 'cell-choice', 'ordered-fallback' or 'unordered-set'." },
        replaces_preference_id: { type: 'string', description: 'Optional. The answer being corrected, from camper_preferences.' },
      },
      required: ['run_id', 'camper_id', 'occurrence_id', 'choice_id'],
    },
    handler: setCamperPreferenceTool,
  },
  {
    name: 'remove_camper_preference',
    description:
      'Withdraw one preference a camper no longer wants. The removal is recorded as a person\u2019s decision, so importing the same sheet again will not put it back. Requires --allow-write.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The assignment run, from camper_preferences.' },
        preference_id: { type: 'string', description: 'The preference to withdraw, from camper_preferences.' },
      },
      required: ['run_id', 'preference_id'],
    },
    handler: removeCamperPreferenceTool,
  },
  {
    name: 'list_entities',
    description:
      'List the rows of one setup entity for this camp: Age Divisions, Programs, Groups, Locations, Activities, Days of Operation, Time Blocks, or Weeks.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          enum: [
            'age_divisions',
            'programs',
            'groups',
            'locations',
            'activities',
            'days_of_operation',
            'time_blocks',
            'weeks',
          ],
        },
      },
      required: ['entity'],
    },
    handler: listEntitiesTool,
  },
  {
    name: 'setup_summary',
    description: "Row counts for every setup entity in this camp — a quick health check of what's been ingested so far.",
    inputSchema: { type: 'object', properties: {} },
    handler: setupSummaryTool,
  },
  {
    name: 'schedule_state',
    description:
      "Read AND VALIDATE one candidate schedule (Manual or Generated route) for one week of this camp: its template, placed slots, and computed findings/conflicts. This is how you validate a schedule — it re-runs the schedule engine over the stored placement (moving nothing). `findings` are what the app's Schedule screen shows for that same placement. `conflicts` are route-wide resource conflicts (e.g. two overlapping bookings over-filling one location at the same day/block) computed by the engine's routeConflicts validator — currently reported here but not yet surfaced in any screen, so this tool is presently the only place a caller sees them. A camp can have several weeks, each with its own template per route — pass week_id to pick one; if omitted and the camp has more than one week, this tool returns needs_week: true plus the list of weeks (list_entities with entity 'weeks' also lists them) so the caller can choose.",
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', enum: ['manual', 'generated'] },
        week_id: { type: 'string', description: 'Optional. Required only when the camp has more than one week.' },
      },
      required: ['route'],
    },
    handler: scheduleStateTool,
  },
  {
    name: 'export_schedule',
    description:
      "Export one candidate schedule (Manual or Generated route) for one week of this camp as a stable, versioned JSON document (format_version 1) — the portable representation for moving a schedule into any other tool. Read-only. Contains the camp/week/route, the groups/days/time-blocks axes, and one record per occupied cell (activity, anchor, event, or elective with its member activities). Multi-week camps: pass week_id, or omit it to get needs_week plus the week list.",
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', enum: ['manual', 'generated'] },
        week_id: { type: 'string', description: 'Optional. Required only when the camp has more than one week.' },
      },
      required: ['route'],
    },
    handler: exportScheduleTool,
  },
  {
    name: 'check_projection_health',
    description:
      "Read-only diagnostic: lists this device's unresolved projection failures (an op-log entry that logged durably but whose effect never materialized into this device's local tables — docs/adr/2026-09-04-projection-failure-detection-and-recovery.md). Support/debugging use; always available, no --allow-write required.",
    inputSchema: { type: 'object', properties: {} },
    handler: checkProjectionHealthTool,
  },
  {
    name: 'repair_projection_entity',
    description:
      "Re-derive one entity's row from its full op-log history, clearing any unresolved projection failure for it once the blocking condition (e.g. a since-resolved foreign-key dependency) is gone. Requires the server to have been launched with --allow-write; otherwise refuses. Support/debugging use — this is not a director-facing action.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'The op-log entity name, e.g. groups, locations, activities.' },
        entity_id: { type: 'string' },
      },
      required: ['entity', 'entity_id'],
    },
    handler: repairProjectionEntityTool,
  },
  {
    name: 'rebuild_projection_from_document',
    description:
      "Delete this device's SQLite projection and rebuild it from the synced Automerge document — the recovery procedure for a corrupted or suspect local database. Requires the server to have been launched with --allow-write; otherwise refuses. Support/debugging use, run on purpose by a person (never automatic, never a director-facing action). Refuses loudly rather than half-working: no camps row on this device, no document file for this camp, a document that does not share this camp's genesis, or a camps row whose id does not match the document's camp. Takes a pre-rebuild backup of the SQLite file first. Does NOT restore the operations history ledger (Trash, Restore's prior values, ingest-undo) or this device's signing_secret/signing_public_key/host_signing_key — those are host-only and never left this device's old database.",
    inputSchema: {
      type: 'object',
      properties: {
        user_data_dir: {
          type: 'string',
          description:
            'Optional. The userData directory the Automerge document lives under (automerge/<campId>.automerge). Defaults to the directory containing the db file — override only for a non-default project path.',
        },
      },
    },
    handler: rebuildProjectionFromDocumentTool,
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

const server = new Server({ name: 'shoresh-ingestion', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS_BY_NAME.get(request.params.name)
  if (!tool) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `unknown tool: ${request.params.name}` }) }] }
  }
  const result = tool.handler(request.params.arguments ?? {}, ctx)
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
