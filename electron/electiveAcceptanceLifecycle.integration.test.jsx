// @vitest-environment jsdom
//
// T199 spec §6, condition (9) and its second clause. T251.
//
//   (9)  "changing the template marks the run stale and prevents finalization"
//   (9b) "one outer location conflict blocking finalization" (§6's fixture
//        clause, whose only observable consequence is a refused finalize)
//
// jsdom, because reaching a committed run means driving the real
// AssignmentPanel — see electron/electiveAcceptanceLocalClient.js.
//
// ORDER IS LOAD-BEARING IN THIS FILE, and it is the product's order, not a
// convenience. finalizeElectiveRun runs its checks in sequence
// (electron/ops/finalizeElectiveRun.js): staleness FIRST (:73), then the
// resource conflict (:93). This camp carries a real location conflict by
// construction — Boating sits at the Monday elective period for Older 2, and
// Boating and Swim share Lakefront — so a finalize here can never succeed until
// a director resolves it. That is why the three tests below run in this order:
// prove the stale refusal while the template is edited, prove the conflict
// refusal once it is not, and prove the finalize succeeds once the director has
// dealt with the conflict. Each earlier refusal would MASK the next.
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

import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { makeLocalClientOverHandlers } from './electiveAcceptanceLocalClient.js'
import { panelPropsFromDatabase, solveWithRoster } from './electiveAcceptancePanelDrive.jsx'
import { ACCEPTANCE_MANIFEST } from './fixtures/electiveAcceptanceCamp.js'

const M = ACCEPTANCE_MANIFEST

let camp
let run

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  ref.impl = makeLocalClientOverHandlers(camp.handlers, camp.token)
  run = await solveWithRoster(camp, panelPropsFromDatabase(camp))
}, 120_000)

afterAll(() => { camp?.close() })

const finalize = () => camp.handlers.finalizeElectiveRun({ token: camp.token, runId: run.id })
const statusOf = () => camp.db
  .prepare('SELECT status, finalized_at, finalized_by FROM elective_assignment_runs WHERE id = ?').get(run.id)

// Every template edit here goes through the real generic `write` handler — the
// same call src/data/scheduleRepository.js's writeSlotFields makes when a
// director changes a cell on the Schedule screen.
const writeSlot = (slotId, fields) => {
  const results = []
  for (const [field, value] of Object.entries(fields)) {
    results.push(camp.handlers.write({ token: camp.token, entity: 'template_slots', entity_id: slotId, field, value }))
  }
  return Promise.all(results)
}

describe('§6 (9) — changing the template marks the run stale and prevents finalization', () => {
  it('refuses with STALE_OUTER_SCHEDULE and names the occurrence the edit removed', async () => {
    // A REAL TEMPLATE EDIT, not a synthetic row deletion: the director takes
    // the elective set off one cell of the route this run was solved against.
    const victim = camp.fixture.electiveSlotIds.generated[0]
    const before = camp.db.prepare('SELECT elective_set_id, activity_id FROM template_slots WHERE id = ?').get(victim)
    expect(before.elective_set_id).toBe(camp.fixture.electiveSetId)

    // Every group of that tier shares one occurrence, so the occurrence only
    // disappears when the set comes off every group in the cell. Taking it off
    // one group and expecting the occurrence to vanish would be a test that
    // passes for the wrong reason.
    const cell = camp.db
      .prepare('SELECT day_id, time_block_id, group_id FROM template_slots WHERE id = ?').get(victim)
    const tierId = camp.db.prepare('SELECT tier_id FROM groups WHERE id = ?').get(cell.group_id).tier_id
    const sameCell = camp.db.prepare(`
      SELECT s.id FROM template_slots s JOIN groups g ON g.id = s.group_id
      WHERE s.template_id = ? AND s.day_id = ? AND s.time_block_id = ? AND g.tier_id = ? AND s.elective_set_id = ?
    `).all(camp.fixture.generatedTemplateId, cell.day_id, cell.time_block_id, tierId, camp.fixture.electiveSetId)
    expect(sameCell.length).toBeGreaterThan(0)

    for (const s of sameCell) await writeSlot(s.id, { elective_set_id: null })

    const out = await finalize()
    expect(out.ok).toBe(false)
    expect(out.error).toBe('STALE_OUTER_SCHEDULE')
    expect(out.findings.some((f) => f.kind === 'OCCURRENCE_REMOVED')).toBe(true)
    // The run is NOT finalized — asserted against the row, not against the
    // return value, because "prevents finalization" is a claim about the
    // database.
    expect(statusOf()).toMatchObject({ status: 'draft', finalized_at: null, finalized_by: null })

    // Put it back, so the next test measures the conflict and not this.
    for (const s of sameCell) await writeSlot(s.id, { elective_set_id: camp.fixture.electiveSetId })
    const restored = await finalize()
    expect(restored.error).not.toBe('STALE_OUTER_SCHEDULE')
  }, 60_000)
})

describe('§6 (9b) — an outer location conflict blocks finalization', () => {
  it('refuses with OUTER_RESOURCE_CONFLICT while the shared location is double-booked', async () => {
    const out = await finalize()
    expect(out.ok).toBe(false)
    expect(out.error).toBe('OUTER_RESOURCE_CONFLICT')
    expect(out.findings.length).toBeGreaterThan(0)
    // THE FINDING IS ABOUT THE RIGHT THING, and this is the check that took a
    // rebuild of the fixture to make honest. findRouteConflicts counts one
    // occupant per GROUP, so a location whose capacity is below the number of
    // elective groups at a cell refuses for a reason that has nothing to do
    // with §6's shared activity at all — measured: the first version refused
    // with four same-named Swim occupants and Boating was irrelevant. So the
    // finding must name the shared location AND list the non-elective activity
    // as one of its occupants.
    const conflict = out.findings.find((f) => f.locationId === camp.fixture.locationIdByName.get(M.sharedLocation))
    expect(conflict).toBeTruthy()
    expect(conflict.occupants.map((o) => o.label).sort())
      .toEqual([M.sharedLocationOuterActivity, M.sharedLocationElective, M.sharedLocationElective, M.sharedLocationElective].sort())
    expect(conflict.occupants.filter((o) => o.sourceKind !== 'elective').map((o) => o.label))
      .toEqual([M.sharedLocationOuterActivity])
    expect(conflict.capacity).toBe(M.sharedLocationCapacity)
    expect(statusOf()).toMatchObject({ status: 'draft', finalized_at: null })
  })

  it('finalizes once the director clears the conflicting cell, and ONLY then', async () => {
    // The conflict is Boating at the Monday elective period for Older 2, in the
    // same location Swim is offered at. A director resolves it by moving
    // Boating off that cell — an ordinary slot edit.
    await writeSlot(camp.fixture.outerConflictSlotId, { activity_id: null })

    const out = await finalize()
    expect(out.error).toBeUndefined()
    expect(out.ok).toBe(true)
    const row = statusOf()
    expect(row.status).toBe('final')
    expect(row.finalized_at).toBeTruthy()
    // finalized_by is the field src/localClient.mock.js never writes — asserted
    // here precisely because a fixture that ran against the mock would pass
    // without it.
    expect(row.finalized_by).toBe(camp.userId)

    // And the snapshot exists, with real values in it — not merely a row count.
    const snapshot = camp.db
      .prepare('SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?').all(run.id)
    expect(snapshot.length).toBeGreaterThan(0)
    expect(snapshot.filter((r) => !r.activity_name)).toEqual([])
    expect(new Set(snapshot.map((r) => r.cell_kind))).toEqual(new Set(['elective', 'inherited']))
  }, 60_000)
})

// T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) CLOSED the
// gap this describe block used to document. _Prior: "GAP — the run
// exceptions export cannot report eligibility or resource findings" pinned
// buildRunExceptionsExport's hardcoded `not_computed: ['eligibility',
// 'resource']` alongside the real exclusion/conflict this camp has, as an
// inverted assertion that would go red once either was wired through._
//
// Both categories are now genuinely computed (not_computed is always []).
// This fixture's OWN eligibility exclusion — three Older campers excluded by
// a TIER mismatch (no Older cell on Wednesday) — is a DIFFERENT finding kind
// than this slice persists: `elective_run_findings` is scoped to
// UNSUPPORTED_LINKED_CHOICE only this slice (ELIGIBILITY_FINDING_KINDS,
// deriveElectiveRunFindingId.js), a deliberate, product-open-question
// narrowing (T320 open question 2), not an oversight — a tier-eligibility
// exclusion is a different kind this ADR does not claim to persist. The
// resource conflict this camp HAD was resolved before finalize (the
// preceding describe block), so a final run's resource bucket is correctly,
// provably [] by construction (finalizeElectiveRun's own gate already
// refused any run that would have had one) — not because nothing was
// computed.
describe('the run exceptions export now genuinely computes eligibility and resource (T320)', () => {
  it('reports not_computed: [] for a finalized run, with both buckets correctly empty for THIS fixture', async () => {
    const { buildRunExceptionsExport } = await import('../src/screens/elective/export/exportRunExceptions.js')
    const out = buildRunExceptionsExport({
      run: { id: run.id, name: run.name, status: 'final' },
      campers: camp.handlers.list(camp.token, 'campers'),
      unassigned: [],
      overCapacity: [],
    })
    expect(out.not_computed).toEqual([])
    // Neither bucket is FED any findings by this call (no eligibilityFindings/
    // resourceConflicts arg), so both are legitimately empty for this specific
    // assertion — the "not_computed" marker being gone is the property under
    // test, not a claim that this camp has zero of either in the database.
    expect(out.eligibility).toEqual([])
    expect(out.resource).toEqual([])

    // THE FIXTURE'S REAL EXCLUSION, STILL TRUE, STILL A DIFFERENT KIND.
    // Older campers wrote a Wednesday choice;
    // the route this run was solved against has no Older cell on Wednesday, so
    // they were excluded from it.
    const wednesday = camp.fixture.dayIdByLabel.get('Wednesday')
    const older = camp.fixture.tierIdByName.get('Older')
    const olderCampers = camp.handlers.list(camp.token, 'campers')
      .filter((c) => c.division_label === 'Older').map((c) => c.id)
    const asked = camp.db.prepare(`
      SELECT DISTINCT camper_id FROM elective_preferences
      WHERE run_id = ? AND coordinate_day_label = 'Wednesday'
    `).all(run.id).filter((r) => olderCampers.includes(r.camper_id))
    expect(asked.length).toBeGreaterThan(0)
    const olderWednesdayOccurrences = camp.db
      .prepare('SELECT id FROM elective_occurrences WHERE run_id = ? AND day_id = ? AND tier_id = ?')
      .all(run.id, wednesday, older)
    expect(olderWednesdayOccurrences).toEqual([])
  })
})

describe('a finalized run is immutable', () => {
  it('refuses a preference edit, rather than silently ignoring it', async () => {
    const pref = camp.db.prepare('SELECT id, camper_id FROM elective_preferences WHERE run_id = ? LIMIT 1').get(run.id)
    const out = await camp.handlers.removeElectivePreference({
      token: camp.token, runId: run.id, preferenceId: pref.id,
    })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('RUN_NOT_DRAFT')
    expect(camp.db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE id = ?').get(pref.id).c).toBe(1)
  })

  it('a second finalize does not re-stamp it', async () => {
    const before = statusOf()
    const out = await finalize()
    expect(out.ok).toBe(false)
    expect(statusOf()).toEqual(before)
    expect(out.error).toBe('ALREADY_FINAL')
  })
})
