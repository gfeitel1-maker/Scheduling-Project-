// @vitest-environment jsdom
//
// T199 spec §6, conditions (11) and (12), plus the ingest category leak. T251.
//
//   (11) "JSON, XLSX, UI, CLI and MCP agree"  — READ GAP-5 BELOW
//   (12) "no manual database edits"
//
// ── GAP-5, AND WHY (11)'s TITLE PROMISES MORE THAN ANY TEST CAN KEEP ──────
//
// THERE IS NO MCP OR CLI READ PATH FOR AN ELECTIVE RUN'S PROJECTION. MCP's
// `export_schedule` calls buildScheduleExport from src/utils/exportScheduleJson.js
// (scripts/mcp/tools.js:434-470) — that is the GROUP schedule, not the
// elective-run projection. `scripts/preferenceSheetCli.js` has no read action
// at all. So (11) cannot mean "five surfaces render the same run"; four of the
// five do not expose one.
//
// What it CAN mean, and what is asserted here, is what those surfaces DO
// expose:
//   JSON  — buildElectiveRunProjectionExport, the one combined document.
//   XLSX  — exportElectiveRunWorkbook, built from that same document.
//   UI    — getElectiveRun, the read the Draft/Final screens make.
//   MCP   — `camper_preferences` over elective_preferences, and
//           `export_schedule`, which must show the elective cells AS elective.
//   CLI   — preferenceSheetCli's preview, the only read it has.
// plus THE ABSENCE, asserted as an enumeration of MCP's tool names: if an
// elective-run export tool is ever added, this goes red and (11) has to grow a
// row rather than quietly continuing to mean less than it says.
//
// ── CONDITION (12), MADE MECHANICAL ──────────────────────────────────────
//
// Three bootstrap inserts are unavoidable (see
// electron/fixtures/electiveAcceptanceCamp.js's BOOTSTRAP_SQL_ALLOWLIST). The
// enforceable form is a SOURCE SCAN: the fixture module and every T251 test
// file are read as text (DISCOVERED by prefix, not listed), and no INSERT,
// REPLACE, UPDATE or DELETE may name a table §6 says must
// come from a real path. Precedent for source-scanning:
// electron/ipcSurfaceParity.test.js.
//
// The scan ASSERTS IT FOUND SOMETHING. A sweep returning zero is a claim about
// the measurement, not about the code — see
// electron/sync/automerge/transportBoundary.guard.test.js and
// electron/authRejectedSender.test.js, which say the same thing about their
// own sweeps. Its BLIND SPOTS, stated rather than solved: SQL built by string
// concatenation, and SQL issued from a helper these files call but this scan
// does not read.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as XLSX from 'xlsx'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

const ref = vi.hoisted(() => ({ impl: null }))
vi.mock('../src/localClient', () => ({
  localClient: new Proxy({}, {
    get: (_t, prop) => (...args) => {
      if (!ref.impl) throw new Error(`localClient.${String(prop)} called before the fixture was built`)
      if (typeof ref.impl[prop] !== 'function') throw new Error(`localClient.${String(prop)} is not forwarded`)
      return ref.impl[prop](...args)
    },
  }),
}))

import { camperPreferencesTool, exportScheduleTool } from '../scripts/mcp/tools.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { filterFreeChoiceActivities } from '../src/engine/freeChoiceActivities.js'
import { buildElectiveRunProjectionExport } from '../src/screens/elective/export/exportElectiveRunProjection.js'
import { buildElectiveRunWorkbook } from '../src/screens/elective/export/exportElectiveRunWorkbook.js'
import { buildOfferings } from '../src/screens/elective/assignment/buildOfferings.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { makeLocalClientOverHandlers } from './electiveAcceptanceLocalClient.js'
import { panelPropsFromDatabase, solveWithRoster } from './electiveAcceptancePanelDrive.jsx'
import { ACCEPTANCE_MANIFEST, BOOTSTRAP_SQL_ALLOWLIST, SHEET_RESOLVED } from './fixtures/electiveAcceptanceCamp.js'

const M = ACCEPTANCE_MANIFEST

let camp
let run
let projection
let projectionInput

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  ref.impl = makeLocalClientOverHandlers(camp.handlers, camp.token)
  run = await solveWithRoster(camp, panelPropsFromDatabase(camp))

  const list = (entity) => camp.handlers.list(camp.token, entity)
  const outer = camp.handlers.getElectiveRunOuterSchedule({ token: camp.token, runId: run.id })
  const ui = camp.handlers.getElectiveRun({ token: camp.token, runId: run.id })
  projectionInput = {
    run: { id: run.id, name: run.name, status: run.status, solver_generation: run.solver_generation, source_sha256: run.source_sha256 },
    campers: list('campers'),
    groups: list('groups'),
    days: list('days_of_operation').map((d) => ({ ...d, name: d.label })),
    timeBlocks: list('time_blocks'),
    outerRows: outer.rows,
    preferences: ui.preferences,
    assignments: ui.rows,
    occurrences: ui.occurrences,
    staleCount: ui.staleCount,
    capacityRows: ui.overCapacityOccurrences,
  }
  // The workbook takes the projection's INPUT and builds the document itself
  // (exportElectiveRunWorkbook.js:67-68) — that is the mechanism by which the
  // two artifacts cannot disagree, so both are built from this one object.
  projection = buildElectiveRunProjectionExport(projectionInput)
}, 120_000)

afterAll(() => { camp?.close() })

// ── (11) the surfaces that exist ──────────────────────────────────────────

describe('§6 (11) — JSON and XLSX are built from one document and cannot disagree', () => {
  it('the workbook holds every roster row the JSON holds, under the same headers', () => {
    const workbook = buildElectiveRunWorkbook(projectionInput)
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Activity Roster'], { header: 1, defval: '' })
    const [header, ...body] = sheet
    // THE HEADER IS PINNED. A renamed column is a public-contract change on a
    // file a camp opens in Excel; T251's mutation (11) changes one of these.
    expect(header).toEqual(['Day', 'Time Block', 'Activity', 'Camper', 'Group', 'Count', 'Capacity'])

    const fromJson = projection.activity_rosters
      .flatMap((r) => r.members.map((m) => [r.day, r.time_block, r.activity_name, m.camper_name, m.group_name]))
    expect(body.map((r) => r.slice(0, 5))).toEqual(fromJson)
    expect(body.length).toBeGreaterThan(0)
  })

  it('the workbook and the JSON name the same campers in the child schedules', () => {
    const workbook = buildElectiveRunWorkbook(projectionInput)
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Child Schedules'], { header: 1, defval: '' })
    const namesInSheet = new Set(sheet.slice(1).map((r) => r[0]))
    const namesInJson = new Set(projection.child_schedules.campers.filter((c) => c.schedule.length > 0).map((c) => c.display_name))
    expect(namesInSheet).toEqual(namesInJson)
    // DERIVED, not the camper count: §6 puts two pairs of same-named children
    // in this camp on purpose, so 26 campers are 24 distinct names and a
    // literal 26 here would be asserting the fixture is wrong. Every camper
    // still appears — that is the JSON-side assertion in the projection file.
    const distinctNames = new Set(projectionInput.campers.map((c) => c.display_name))
    expect(namesInSheet.size).toBe(distinctNames.size)
    expect(projectionInput.campers).toHaveLength(M.camperCount)
    expect(distinctNames.size).toBe(M.camperCount - 2)
  })
})

describe('§6 (11) — the UI read and the JSON agree with SQL', () => {
  it('the assignment rows the Draft screen reads are the rows the database holds', () => {
    const ui = camp.handlers.getElectiveRun({ token: camp.token, runId: run.id })
    const fromSql = camp.db
      .prepare('SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ? AND solver_generation = ?')
      .get(run.id, run.solver_generation).c
    expect(ui.rows.length).toBe(fromSql)
    // And the summary counts the same rows.
    const summed = Object.values(projection.summary.counts_by_rank).reduce((a, b) => a + b, 0)
      + ui.rows.filter((r) => r.preference_rank == null).length
    expect(summed).toBe(ui.rows.length)
  })
})

describe('§6 (11) — MCP agrees with the database, on the surfaces MCP has', () => {
  it("camper_preferences returns exactly this run's stored preferences", () => {
    const out = camperPreferencesTool({ run_id: run.id }, { dbPath: camp.file })
    expect(out.ok).toBe(true)
    const fromSql = camp.db
      .prepare('SELECT id FROM elective_preferences WHERE run_id = ? ORDER BY id').all(run.id).map((r) => r.id)
    expect([...out.preferences.map((p) => p.preference_id)].sort()).toEqual([...fromSql].sort())
    expect(fromSql.length).toBeGreaterThan(0)
  })

  it('camper_preferences names the same campers the JSON export does', () => {
    const out = camperPreferencesTool({ run_id: run.id }, { dbPath: camp.file })
    const fromMcp = new Set(out.preferences.map((p) => p.camper_name))
    // GUARDED IN PLACE. `for (const x of empty) expect(...)` is green over an
    // empty set, and the non-emptiness guard lived in a different `it`, over a
    // separately-computed `out` — a pass there is not a pass here.
    expect(fromMcp.size).toBeGreaterThan(0)
    const fromJson = new Set(projection.child_schedules.campers.map((c) => c.display_name))
    for (const name of fromMcp) expect(fromJson.has(name)).toBe(true)
  })

  it('export_schedule shows the elective cells AS elective, not as blanks', () => {
    const out = exportScheduleTool({ route: 'generated' }, { dbPath: camp.file })
    expect(out.ok).toBe(true)
    // NOT a substring search of the whole payload for the set's name, which
    // passes on the name appearing anywhere at all — including in a list of
    // elective sets beside a grid of blanks. exportScheduleJson.js:30-39 emits
    // a per-cell `kind`, so the claim in this test's title is checkable
    // directly: cells that ARE elective, counted.
    const elective = out.export.cells.filter((c) => c.kind === 'elective')
    expect(elective.length).toBeGreaterThan(0)
    expect(new Set(elective.map((c) => c.name))).toEqual(new Set(['Chugim']))
  })

  it("the CLI's only read agrees with the database about who was imported", () => {
    const preview = runPreferenceSheetCli({
      file: SHEET_RESOLVED, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    expect(preview.ok).toBe(true)
    expect(preview.counts.campers).toBe(
      camp.db.prepare('SELECT COUNT(*) c FROM campers WHERE camp_id = ?').get(camp.fixture.campId).c
    )
  })

  // GAP-5, ASSERTED AS AN ENUMERATION. Do not stretch "agree" to cover a
  // surface that does not exist: pin the tool list instead, so adding an
  // elective-run export tool forces this condition to grow a row.
  it('GAP-5 — MCP exposes no elective-run projection tool', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/mcp/server.js'), 'utf8')
    const names = [...source.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(10)
    expect(names).toEqual([
      'ingest_preview', 'ingest_commit',
      'preference_sheet_preview', 'preference_sheet_commit',
      'list_unattributed_subjects', 'attribute_camper_subject',
      'camper_preferences', 'set_camper_preference', 'remove_camper_preference',
      'list_entities', 'setup_summary', 'schedule_state', 'export_schedule',
      'check_projection_health', 'repair_projection_entity', 'rebuild_projection_from_document',
    ])
    // And `export_schedule` is the GROUP schedule, not the run's projection —
    // the fact that makes the list above the honest answer.
    const toolsSource = fs.readFileSync(path.join(process.cwd(), 'scripts/mcp/tools.js'), 'utf8')
    expect(toolsSource).toContain('buildScheduleExport')
    expect(toolsSource).not.toContain('buildElectiveRunProjectionExport')
  })
})

// ── the ingest category leak, exhibited rather than routed around ────────

describe('the ingest category leak — exhibited in its exact current shape', () => {
  // docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md is
  // `implementation_state: partial`. The catalog_role half shipped (T266); the
  // activity_id identity half has since shipped too (T267,
  // electron/db/localDb.js:3503-3535 adds and backfills fixed_events.activity_id),
  // so the ADR is STALE on that point.
  //
  // THE RESIDUAL LEAK is that the recurring event's name still EXISTS as a
  // catalogue `activities` row, marked rather than removed. All four clauses
  // below are asserted, including (i) — so that if a future fix deletes the
  // catalogue row, (i) goes red and forces the question, instead of a
  // `not.toContain` quietly continuing to pass.
  const activityRow = () => camp.db
    .prepare('SELECT id, name, catalog_role FROM activities WHERE camp_id = ? AND name = ?')
    .get(camp.fixture.campId, M.recurringEvent)

  it('(i) the catalogue row for the recurring event EXISTS, marked pinned_event', () => {
    expect(activityRow()).toMatchObject({ name: M.recurringEvent, catalog_role: 'pinned_event' })
  })

  it('(ii) filterFreeChoiceActivities excludes it', () => {
    const activities = camp.handlers.list(camp.token, 'activities')
    expect(activities.some((a) => a.name === M.recurringEvent)).toBe(true)
    const free = filterFreeChoiceActivities(activities)
    expect(free.some((a) => a.name === M.recurringEvent)).toBe(false)
    // Non-vacuity for the filter itself: it keeps the ordinary activities.
    expect(free.some((a) => a.name === 'Swim')).toBe(true)
  })

  it('(iii) it is absent from the solver’s offerings — it can never become an elective', () => {
    const offerings = buildOfferings({
      occurrences: camp.db.prepare('SELECT * FROM elective_occurrences WHERE run_id = ?').all(run.id),
      setActivities: camp.handlers.list(camp.token, 'elective_set_activities'),
      activities: camp.handlers.list(camp.token, 'activities'),
    })
    expect(offerings.length).toBeGreaterThan(0)
    expect(offerings.some((o) => o.activity_id === activityRow().id)).toBe(false)
  })

  it('(iv) the fixed_events row resolves to that same activities row', () => {
    const event = camp.db
      .prepare('SELECT id, name, activity_id FROM fixed_events WHERE camp_id = ? AND name = ?')
      .get(camp.fixture.campId, M.recurringEvent)
    expect(event).toBeTruthy()
    expect(event.activity_id).toBe(activityRow().id)
  })
})

// ── (12) no manual database edits ─────────────────────────────────────────

describe('§6 (12) — no manual database edits', () => {
  // DISCOVERED, not listed. A hand-maintained list is a list that an eleventh
  // T251 file is silently absent from, and absent from a scan reads exactly
  // like clean. Everything named `electron/electiveAcceptance*` plus the
  // fixture module is in scope by construction.
  const FILES = [
    ...fs.readdirSync(path.join(process.cwd(), 'electron'))
      .filter((f) => f.startsWith('electiveAcceptance'))
      .map((f) => `electron/${f}`),
    'electron/fixtures/electiveAcceptanceCamp.js',
  ].sort()

  // EVERY WRITE VERB SQLite HAS, not just two. Round 1 matched INSERT and
  // UPDATE only, so a DELETE FROM campers or a REPLACE INTO template_slots
  // passed the scan that exists to forbid exactly that.
  const WRITE_VERB_SOURCE = '\\b(INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)'
  const WRITE_VERB_GLOBAL = new RegExp(`${WRITE_VERB_SOURCE}\\s+([a-z_]+)`, 'gi')

  // Tables §6 says must come from a real path. An INSERT or UPDATE naming one
  // of these anywhere in the T251 surface is a manual database edit.
  const FORBIDDEN = [
    'activities', 'locations', 'groups', 'tiers', 'days_of_operation', 'time_blocks',
    'template_slots', 'fixed_events', 'schedule_templates', 'schedule_weeks', 'schedule_snapshots',
    'campers', 'elective_sets', 'elective_set_activities', 'elective_bundles',
    'elective_bundle_periods', 'elective_bundle_tiers', 'elective_assignment_runs',
    'elective_occurrences', 'elective_choices', 'elective_choice_offerings',
    'elective_preferences', 'elective_assignments', 'elective_run_outer_snapshots',
  ]

  // COMMENTS STRIPPED FIRST. Every file in this list explains at length what it
  // does and does not write, and the word "UPDATE" in a sentence is not a
  // statement — scanning the raw text flags the prose that documents the rule.
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  const sources = FILES.map((f) => ({
    file: f,
    text: stripComments(fs.readFileSync(path.join(process.cwd(), f), 'utf8')),
  }))

  it('reads every T251 source file — a sweep over nothing is a claim about the measurement', () => {
    expect(sources.length).toBe(FILES.length)
    expect(sources.length).toBeGreaterThan(8)
    for (const s of sources) expect(s.text.length).toBeGreaterThan(200)
  })

  it('writes SQL only at the three bootstrap tables, and nowhere else', () => {
    const statements = []
    for (const { file, text } of sources) {
      for (const m of text.matchAll(WRITE_VERB_GLOBAL)) {
        statements.push({ file, verb: m[1].toUpperCase().replace(/\s+/g, ' '), table: m[2] })
      }
    }
    // NON-VACUITY: the three bootstrap writes ARE there, so a scan that matched
    // nothing (a broken regex, a renamed file) cannot read as a pass.
    expect(statements.length).toBeGreaterThan(2)
    const offenders = statements.filter((s) => !BOOTSTRAP_SQL_ALLOWLIST.includes(s.table))
    expect(offenders).toEqual([])
    expect(new Set(statements.map((s) => s.table))).toEqual(new Set(BOOTSTRAP_SQL_ALLOWLIST))
  })

  it('never writes SQL at any table §6 requires a real path for', () => {
    const hits = []
    for (const { file, text } of sources) {
      for (const table of FORBIDDEN) {
        const re = new RegExp(`${WRITE_VERB_SOURCE}\\s+${table}\\b`, 'i')
        if (re.test(text)) hits.push({ file, table })
      }
    }
    expect(hits).toEqual([])
  })
})
