// @vitest-environment jsdom
//
// T199 spec §6, conditions (6) and (7). T251.
//
//   (6) "a child's non-elective cells equal the selected group template"
//   (7) "every assignment appears exactly once in the matching roster, and
//        roster counts equal summary counts"
//
// jsdom, because reaching a committed run at all means driving the real
// AssignmentPanel — see electron/electiveAcceptanceLocalClient.js for why. The
// assertions themselves are about the database and the pure export modules.
//
// CONDITION (6)'s EXPECTATION IS DERIVED FROM THE GRID FILE, not from
// `template_slots`. That is the whole point of the condition: reading both
// sides out of the same table means a join mistake on the way IN is repeated on
// the way OUT and the two agree while both are wrong. The grid is the document
// the camp actually gave us, so it is the only independent statement of what
// belongs in each cell.
//
// CONDITION (7)'s TOTAL IS SOURCED FROM SQL, not from the export. A roster that
// counts itself is consistent by construction.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
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

import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { buildChildScheduleExport } from '../src/screens/elective/export/exportChildSchedule.js'
import { buildActivityRosterExport } from '../src/screens/elective/export/exportActivityRoster.js'
import { buildRunSummaryExport } from '../src/screens/elective/export/exportRunSummary.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { makeLocalClientOverHandlers } from './electiveAcceptanceLocalClient.js'
import { panelPropsFromDatabase, solveWithRoster } from './electiveAcceptancePanelDrive.jsx'
import { ACCEPTANCE_MANIFEST, GRID_FILE } from './fixtures/electiveAcceptanceCamp.js'

const M = ACCEPTANCE_MANIFEST

let camp
let run
let outer
let catalogs

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  ref.impl = makeLocalClientOverHandlers(camp.handlers, camp.token)
  run = await solveWithRoster(camp, panelPropsFromDatabase(camp))

  const list = (entity) => camp.handlers.list(camp.token, entity)
  catalogs = {
    campers: list('campers'),
    groups: list('groups'),
    days: list('days_of_operation'),
    timeBlocks: list('time_blocks'),
  }
  outer = camp.handlers.getElectiveRunOuterSchedule({ token: camp.token, runId: run.id })
}, 120_000)

afterAll(() => { camp?.close() })

// THE GRID FILE'S OWN STATEMENT of what sits in each (group, day, block) cell.
// Read through the real parser, never re-tokenised here.
function gridCells() {
  const parsed = parseTextGrid(fs.readFileSync(GRID_FILE, 'utf8'))
  const { placements } = capturePlacements(parsed, extractEntities(parsed))
  const byCell = new Map()
  for (const p of placements) {
    byCell.set(`${p.groupName}|${p.dayName}|${p.blockLabel}`, p.activityName)
  }
  return byCell
}

// THE SAME STATEMENT, CORRECTED FOR THE ROUTE UNDER TEST. The grid is what the
// camp gave us and stays the independent source; the generated route
// deliberately overwrites exactly one of its cells (§6's outer location
// conflict), and comparing that coordinate against the grid would be comparing
// the route to a document the route is supposed to differ from. The override
// comes from the MANIFEST, not from template_slots — reading it out of the same
// table the export reads is the circularity this whole condition exists to
// avoid.
//
// SAID PLAINLY: this override changes no result TODAY, because that coordinate
// never reaches the inherited set at all — the GAP below measures why and
// asserts it in both directions. It is here so the condition is already correct
// the day the gap closes, rather than going green against the wrong document.
const OUTER_CONFLICT_KEY =
  `${ACCEPTANCE_MANIFEST.outerConflictCell.group}|${ACCEPTANCE_MANIFEST.outerConflictCell.day}|${ACCEPTANCE_MANIFEST.electivePeriod}`
const expectedAt = (grid, key) =>
  (key === OUTER_CONFLICT_KEY ? ACCEPTANCE_MANIFEST.sharedLocationOuterActivity : grid.get(key))

describe("§6 (6) — a child's non-elective cells equal the group template the grid states", () => {
  it('produced inherited cells at all — without which this condition is vacuous', () => {
    expect(outer.rows.filter((r) => r.cellKind === 'inherited').length).toBeGreaterThan(0)
    expect(catalogs.campers.filter((c) => c.group_id == null)).toEqual([])
  })

  it('every inherited cell holds the activity the grid put in that group/day/period', () => {
    const grid = gridCells()
    expect(grid.size).toBeGreaterThan(0)

    const groupNameById = new Map(catalogs.groups.map((g) => [g.id, g.name]))
    const groupOfCamper = new Map(catalogs.campers.map((c) => [c.id, groupNameById.get(c.group_id)]))

    const export_ = buildChildScheduleExport({
      run: { id: run.id, name: run.name, status: run.status },
      campers: catalogs.campers, groups: catalogs.groups,
      // buildChildScheduleExport reads `days[].name` and `timeBlocks[].name`;
      // days_of_operation rows carry `label`. Passing the rows unmapped would
      // degrade every day to a raw id and the comparison below would be between
      // two ids, which is a comparison that cannot fail.
      days: catalogs.days.map((d) => ({ ...d, name: d.label })),
      timeBlocks: catalogs.timeBlocks,
      outerRows: outer.rows,
    })

    const mismatches = []
    const covered = new Set()
    for (const camper of export_.campers) {
      const groupName = groupOfCamper.get(camper.camper_id)
      for (const entry of camper.schedule) {
        if (entry.kind !== 'span' || entry.cell_kind !== 'inherited') continue
        const key = `${groupName}|${entry.day}|${entry.time_block}`
        covered.add(key)
        const expected = expectedAt(grid, key)
        if (expected !== entry.activity_name) {
          mismatches.push({
            camper: camper.display_name, groupName, day: entry.day,
            block: entry.time_block, expected, got: entry.activity_name,
          })
        }
      }
    }
    expect(covered.size).toBeGreaterThan(0)
    expect(mismatches).toEqual([])

    // COVERAGE, NAMED. Without this the condition is satisfied by whatever
    // subset of cells the export happens to emit, and a future narrowing that
    // stopped emitting the interesting ones would be invisible. The cells that
    // matter are the ones where the two routes DISAGREE: the manual route
    // carries the set on Older/Wednesday, the generated route does not, so on
    // the route under test those cells must arrive as inherited grid cells.
    for (const group of ['Older 1', 'Older 2']) {
      expect([...covered]).toContain(`${group}|Wednesday|${M.electivePeriod}`)
    }
  })

  // GAP — THE ONE CELL THE GENERATED ROUTE OVERWRITES IS NOT REACHABLE AS AN
  // INHERITED CELL AT ALL, and the reason is a production defect, not an
  // export narrowing.
  //
  // An occurrence is (set, day, block, TIER) — never (…, group). The generated
  // route places the set on Older 1 only at Monday/10:50 and gives Older 2
  // `Boating`, but the Older/Monday occurrence that Older 1's cell creates is a
  // TIER-level occurrence, so buildAttendance admits every Older camper to it,
  // including Older 2's. Those campers are then placed in an elective at a
  // period their own group spends at Boating, and F4 in
  // electron/ops/electiveRunOuterSchedule.js correctly suppresses the inherited
  // Boating span underneath it — one placement per block.
  //
  // So condition (6) CANNOT cover this coordinate today. Asserted in both
  // directions rather than left as a silent absence: it is absent from the
  // inherited set, AND the elective placement that displaced it is present. The
  // day tier-level occurrences learn which groups actually carry the set, the
  // second half goes red; the day the export starts emitting it, the first does.
  it('GAP — the overwritten generated cell arrives as an ELECTIVE, not as the group’s Boating', () => {
    const groupIdByName = new Map(catalogs.groups.map((g) => [g.name, g.id]))
    const conflictGroupId = groupIdByName.get(M.outerConflictCell.group)
    const campersThere = catalogs.campers.filter((c) => c.group_id === conflictGroupId)
    expect(campersThere.length).toBeGreaterThan(0)

    const dayId = camp.fixture.dayIdByLabel.get(M.outerConflictCell.day)
    const at = outer.rows.filter(
      (r) => r.dayId === dayId
        && r.timeBlockId === camp.fixture.periodId
        && campersThere.some((c) => c.id === r.camperId)
    )
    expect(at.length).toBeGreaterThan(0)
    expect([...new Set(at.map((r) => r.cellKind))]).toEqual(['elective'])
    expect(at.map((r) => r.activityName)).not.toContain(M.sharedLocationOuterActivity)
  })

  it('the child export names the group the camper is actually in', () => {
    const export_ = buildChildScheduleExport({
      run: { id: run.id, name: run.name, status: run.status },
      campers: catalogs.campers, groups: catalogs.groups,
      days: catalogs.days.map((d) => ({ ...d, name: d.label })),
      timeBlocks: catalogs.timeBlocks,
      outerRows: outer.rows,
    })
    expect(export_.campers).toHaveLength(M.camperCount)
    expect(export_.campers.filter((c) => c.group_name == null)).toEqual([])
  })
})

describe('§6 (7) — every assignment appears exactly once in the matching roster', () => {
  const rosterOf = () => buildActivityRosterExport({
    campers: catalogs.campers, groups: catalogs.groups,
    days: catalogs.days.map((d) => ({ ...d, name: d.label })),
    timeBlocks: catalogs.timeBlocks,
    outerRows: outer.rows,
    capacityRows: [],
    occurrences: camp.db.prepare('SELECT * FROM elective_occurrences WHERE run_id = ?').all(run.id),
  })

  it("the roster's total count equals the assignment rows SQL returns", () => {
    // SOURCED FROM SQL, not from the export. `count` is the ASSIGNMENT grain
    // (one per elective_assignments row), which is what exportActivityRoster.js's
    // F5 note says it must be so it reconciles with the summary — and a linked
    // choice collapses N rows to ONE member entry, so `members.length` and
    // `count` are deliberately different numbers. Checking the export against
    // itself would not notice them being swapped.
    const roster = rosterOf()
    const total = roster.reduce((n, entry) => n + entry.count, 0)
    const fromSql = camp.db.prepare(`
      SELECT COUNT(*) c FROM elective_assignments a
      JOIN elective_occurrences o ON o.id = a.occurrence_id
      WHERE a.run_id = ? AND o.run_id = ?
    `).get(run.id, run.id).c
    expect(total).toBe(fromSql)
    expect(total).toBeGreaterThan(0)
  })

  // GAP — A LINKED CHOICE NEVER CLUSTERS IN ANY EXPORT.
  //
  // exportActivityRoster.js and exportChildSchedule.js both cluster a bundled
  // placement into one entry via clusterLinkedElectiveRows, keyed on the outer
  // row's `choice_id`/`is_linked_choice`. Those come from
  // `elective_assignments.choice_id` — and commitElectiveRun sets that from
  // `choiceIdByKey.get(a.labelKey)` (:595), a map populated ONLY from the
  // sheet's own choices (:470), which D6 makes it SKIP for exactly the labels a
  // bundle claims (:467). So a bundle's own per-tier choice id is written to
  // elective_choices and to elective_choice_offerings, and never onto the
  // assignment rows it produced. Every linked placement reaches the exports as
  // N ordinary rows.
  //
  // CONSEQUENCE FOR §6: the "appears exactly once" half of condition (7) is
  // asserted on the assignment grain, which is the grain the data actually has.
  // exportActivityRoster.js's F5 note describes `count` (member rows) and
  // `members.length` (campers) as deliberately different numbers — in this camp
  // they cannot differ, so T251's mutation (7) (swapping one for the other) is
  // UNOBSERVABLE here. Recorded rather than worked around.
  it('GAP — no assignment carries a bundle choice id, so nothing clusters', () => {
    const bundleChoiceIds = camp.db
      .prepare('SELECT id FROM elective_choices WHERE run_id = ? AND is_linked = 1').all(run.id)
      .map((r) => r.id)
    expect(bundleChoiceIds.length).toBeGreaterThan(0)

    const placeholders = bundleChoiceIds.map(() => '?').join(',')
    const tagged = camp.db
      .prepare(`SELECT COUNT(*) c FROM elective_assignments WHERE run_id = ? AND choice_id IN (${placeholders})`)
      .get(run.id, ...bundleChoiceIds).c
    expect(tagged).toBe(0)

    // And so no export entry is ever a cluster.
    expect(rosterOf().filter((e) => e.count !== e.members.length)).toEqual([])
    expect(outer.rows.filter((r) => r.isLinkedChoice)).toEqual([])
  })

  // THE "EXACTLY ONCE IN THE MATCHING ROSTER" HALF, which round 1 did not
  // assert at all. Totals reconciling, no duplicate within an entry, and
  // members naming real campers are together satisfied by a PERMUTATION: the
  // Monday/Swim entry holding the camper who was actually assigned
  // Tuesday/Archery passes every one of them. Nothing joined the roster back to
  // the assignment rows on the coordinate, so nothing could notice.
  //
  // Set equality, not multiset: (camper, day, block, activity) is unique per
  // assignment row by construction (deriveElectiveAssignmentId keys on run +
  // camper + occurrence), and the no-duplicate-within-an-entry assertion below
  // covers the roster side. Exact because this camp produces no linked cluster
  // — a cluster's entry is labelled with the CHOICE's name rather than an
  // activity's, and the gap above asserts there are none.
  it('every roster member sits at the coordinate the assignment row gives them', () => {
    const key = (camperId, day, block, activity) => `${camperId}|${day}|${block}|${activity}`
    const fromSql = camp.db.prepare(`
      SELECT a.camper_id, d.label AS day, tb.name AS time_block, act.name AS activity_name
      FROM elective_assignments a
      JOIN elective_occurrences o ON o.id = a.occurrence_id
      JOIN days_of_operation d ON d.id = o.day_id
      JOIN time_blocks tb ON tb.id = o.time_block_id
      JOIN activities act ON act.id = a.activity_id
      WHERE a.run_id = ?
    `).all(run.id).map((r) => key(r.camper_id, r.day, r.time_block, r.activity_name))
    expect(fromSql.length).toBeGreaterThan(0)

    const fromRoster = rosterOf().flatMap(
      (e) => e.members.map((m) => key(m.camper_id, e.day, e.time_block, e.activity_name))
    )
    expect([...new Set(fromRoster)].sort()).toEqual([...new Set(fromSql)].sort())
  })

  it('no camper appears twice in one roster entry', () => {
    for (const entry of rosterOf()) {
      const ids = entry.members.map((m) => m.camper_id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('every roster member names a real camper and their real group', () => {
    const byId = new Map(catalogs.campers.map((c) => [c.id, c]))
    const groupNameById = new Map(catalogs.groups.map((g) => [g.id, g.name]))
    const bad = []
    for (const entry of rosterOf()) {
      for (const m of entry.members) {
        const camper = byId.get(m.camper_id)
        if (!camper) { bad.push({ ...m, why: 'no such camper' }); continue }
        if (m.camper_name !== camper.display_name) bad.push({ ...m, why: 'wrong name' })
        if (m.group_name !== groupNameById.get(camper.group_id)) bad.push({ ...m, why: 'wrong group' })
      }
    }
    expect(bad).toEqual([])
  })

  it('roster counts equal the summary counts', () => {
    const assignments = camp.db
      .prepare('SELECT camper_id, preference_rank FROM elective_assignments WHERE run_id = ?').all(run.id)
    const summary = buildRunSummaryExport({
      run: { id: run.id, name: run.name, status: run.status, solver_generation: run.solver_generation, source_sha256: run.source_sha256 },
      assignments,
      preferences: camp.db.prepare('SELECT camper_id FROM elective_preferences WHERE run_id = ?').all(run.id),
      capacityRows: [],
    })
    // A SECOND FACT, not a restatement of the total. Round 1 summed
    // `counts_by_rank` and the unranked remainder out of the SAME array
    // buildRunSummaryExport was handed, so "roster counts equal summary counts"
    // collapsed into the total equality already asserted above. What is checked
    // here instead is the DISTRIBUTION: the summary's per-rank buckets against
    // a SQL GROUP BY over the assignment rows. A summary that reported the
    // right total split across the wrong ranks passed before and fails now.
    const fromSql = Object.fromEntries(camp.db.prepare(`
      SELECT preference_rank AS rank, COUNT(*) AS c FROM elective_assignments
      WHERE run_id = ? AND preference_rank IS NOT NULL GROUP BY preference_rank
    `).all(run.id).map((r) => [String(r.rank), r.c]))
    expect(Object.keys(fromSql).length).toBeGreaterThan(1)
    expect(Object.fromEntries(
      Object.entries(summary.counts_by_rank).map(([k, v]) => [String(k), v])
    )).toEqual(fromSql)

    const ranked = Object.values(summary.counts_by_rank).reduce((a, b) => a + b, 0)
    const unranked = assignments.filter((a) => a.preference_rank == null).length
    expect(ranked + unranked).toBe(rosterOf().reduce((n, e) => n + e.count, 0))
  })
})
