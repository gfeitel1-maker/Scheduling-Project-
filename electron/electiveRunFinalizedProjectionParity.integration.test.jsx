// @vitest-environment jsdom
//
// T198 round 2, Fix 1 (Red Hat HIGH). getElectiveRunOuterSchedule.js branches
// on `run?.status === 'final'` to read the immutable elective_run_outer_snapshots
// rows T248 wrote instead of live-deriving — the whole reason that table exists
// is that an export must survive the underlying activity being renamed after
// finalization (D6). electron/electiveAcceptanceSurfaces.integration.test.jsx's
// three-way equality (11) only ever exercised that branch's SIBLING (a draft
// run) through MCP/CLI; nothing exercised the `final` branch through either
// machine-access surface.
//
// A SEPARATE FILE with its OWN isolated camp, not a mutation of that file's
// (electiveAcceptanceSurfaces.integration.test.jsx's) shared `beforeAll` run:
// that file's run stays in `draft` for its whole suite, and finalizing it
// there would poison every other test in that file. This file solves its own
// run on the same 'generated' route electron/electiveAcceptanceLifecycle.
// integration.test.jsx already proves finalizes (§6 (9b)): the fixture
// deliberately gives that route an OUTER_RESOURCE_CONFLICT (Older 2's Boating
// vs Swim at Lakefront — `outerConflictCell`), cleared the same way that file
// clears it — moving Boating off the conflicting cell, an ordinary slot edit
// that does not touch any elective cell and so cannot make the run stale —
// before calling finalizeElectiveRun.js for real. It then proves the same
// three-way equality (11) already proves for a draft run, and goes one step
// further: it renames the underlying activity AFTER finalizing and asserts all
// three surfaces still report the pre-rename (snapshotted) name, which is the
// one observable fact that a live-derive regression would get wrong.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import os from 'node:os'

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

import { exportElectiveAssignmentsTool } from '../scripts/mcp/tools.js'
import { runElectivesCli } from '../scripts/electivesCli.js'
import { buildElectiveRunProjectionExport } from '../src/screens/elective/export/exportElectiveRunProjection.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { makeLocalClientOverHandlers } from './electiveAcceptanceLocalClient.js'
import { panelPropsFromDatabase, solveWithRoster } from './electiveAcceptancePanelDrive.jsx'

let camp
let run

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  ref.impl = makeLocalClientOverHandlers(camp.handlers, camp.token)
  // Default route is 'generated' (solveAndCommit's own default) — the same
  // route electiveAcceptanceLifecycle.integration.test.jsx's §6 (9b) finalizes.
  run = await solveWithRoster(camp, panelPropsFromDatabase(camp))

  // Clear the deliberate Boating/Swim conflict at Lakefront the same way that
  // file's (9b) test does: move the non-elective Boating activity off the one
  // cell that overflows the location's capacity. This slot is NOT one of the
  // run's elective cells, so clearing it cannot make the run stale.
  const clearResult = await camp.handlers.write({
    token: camp.token, entity: 'template_slots', entity_id: camp.fixture.outerConflictSlotId, field: 'activity_id', value: null,
  })
  if (clearResult.status !== 'applied') throw new Error(`beforeAll: clearing the outer conflict slot failed — ${JSON.stringify(clearResult)}`)

  const result = camp.handlers.finalizeElectiveRun({ token: camp.token, runId: run.id })
  if (!result.ok) throw new Error(`beforeAll: finalize refused — ${JSON.stringify(result)}`)
}, 120_000)

afterAll(() => { camp?.close() })

const withoutGeneratedAt = (value) => {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'generated_at') continue
      out[k] = withoutGeneratedAt(v)
    }
    return out
  }
  return value
}

// The UI-equivalent projection input, assembled the same way
// electiveAcceptanceSurfaces.integration.test.jsx's `beforeAll` assembles it —
// a FRESH call each time this is invoked, so it exercises whichever branch of
// getElectiveRunOuterSchedule.js the run's current status takes, exactly as
// the MCP tool and the CLI do on their own fresh db opens.
function buildUiProjectionInput() {
  const list = (entity) => camp.handlers.list(camp.token, entity)
  const outer = camp.handlers.getElectiveRunOuterSchedule({ token: camp.token, runId: run.id })
  const ui = camp.handlers.getElectiveRun({ token: camp.token, runId: run.id })
  return {
    run: { id: run.id, name: run.name, status: outer.runStatus, solver_generation: run.solver_generation, source_sha256: run.source_sha256 },
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
}

describe('T198 Fix 1 — the finalized-run branch, exercised through MCP and CLI', () => {
  it('the run actually finalized (status final, finalized_at stamped)', () => {
    const row = camp.db
      .prepare('SELECT status, finalized_at, finalized_by FROM elective_assignment_runs WHERE id = ?')
      .get(run.id)
    expect(row.status).toBe('final')
    expect(row.finalized_at).toBeTruthy()
    // Non-vacuity for the snapshot write itself: a finalize that took the
    // early "no assignments" refusal would also report row.status !== 'final'
    // above, but this pins the snapshot table directly too.
    const snapshotCount = camp.db
      .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(run.id).c
    expect(snapshotCount).toBeGreaterThan(0)
  })

  it('MCP export, CLI export, and the UI-equivalent projection are deep-equal for a FINALIZED run (generated_at excepted)', () => {
    const mcp = exportElectiveAssignmentsTool({ run_id: run.id }, { dbPath: camp.file })
    expect(mcp.ok).toBe(true)
    const cli = runElectivesCli({ action: 'export', runId: run.id, dbPath: camp.file, format: 'json' })
    expect(cli.ok).toBe(true)
    const projection = buildElectiveRunProjectionExport(buildUiProjectionInput())

    expect(withoutGeneratedAt(mcp.export)).toEqual(withoutGeneratedAt(projection))
    expect(withoutGeneratedAt(cli.export)).toEqual(withoutGeneratedAt(projection))

    // Non-vacuity: both sides are non-empty, so the equality above cannot be
    // hiding behind an empty-on-both-sides pass.
    expect(mcp.export.exceptions.unresolved.length + mcp.export.activity_rosters.length).toBeGreaterThan(0)
    expect(cli.export.exceptions.unresolved.length + cli.export.activity_rosters.length).toBeGreaterThan(0)
  })

  it('after the underlying activity is renamed post-finalize, all three surfaces still report the SNAPSHOT name — the exact divergence elective_run_outer_snapshots exists to prevent (T248/D6)', async () => {
    const swimActivityId = camp.fixture.activityIdByName.get('Swim')
    expect(swimActivityId).toBeTruthy()
    const renameResult = await camp.handlers.write({
      token: camp.token, entity: 'activities', entity_id: swimActivityId, field: 'name', value: 'Swim RENAMED',
    })
    expect(renameResult.status).toBe('applied')
    // The rename really landed in the catalogue — the test would be
    // meaningless if the write silently no-opped.
    expect(camp.db.prepare('SELECT name FROM activities WHERE id = ?').get(swimActivityId).name).toBe('Swim RENAMED')

    const mcp = exportElectiveAssignmentsTool({ run_id: run.id }, { dbPath: camp.file })
    const cli = runElectivesCli({ action: 'export', runId: run.id, dbPath: camp.file, format: 'json' })
    const projection = buildElectiveRunProjectionExport(buildUiProjectionInput())

    expect(withoutGeneratedAt(mcp.export)).toEqual(withoutGeneratedAt(projection))
    expect(withoutGeneratedAt(cli.export)).toEqual(withoutGeneratedAt(projection))

    const names = new Set([
      ...mcp.export.activity_rosters.map((r) => r.activity_name),
      ...cli.export.activity_rosters.map((r) => r.activity_name),
      ...projection.activity_rosters.map((r) => r.activity_name),
    ])
    expect(names.has('Swim RENAMED')).toBe(false)
    expect(names.has('Swim')).toBe(true)
  })
})
