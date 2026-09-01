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

import {
  ingestPreviewTool,
  ingestCommitTool,
  listEntitiesTool,
  setupSummaryTool,
  scheduleStateTool,
  exportScheduleTool,
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
const ctx = { dbPath, allowWrite, authorUserId }

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
      "Read AND VALIDATE one candidate schedule (Manual or Generated route) for one week of this camp: its template, placed slots, and computed findings/conflicts. This is how you validate a schedule — it re-runs the schedule engine over the stored placement (moving nothing) and returns exactly the findings and conflicts the app's Schedule screen shows for that same placement. A camp can have several weeks, each with its own template per route — pass week_id to pick one; if omitted and the camp has more than one week, this tool returns needs_week: true plus the list of weeks (list_entities with entity 'weeks' also lists them) so the caller can choose.",
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
