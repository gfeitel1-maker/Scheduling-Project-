// @vitest-environment node
//
// THE FIXTURE GUARD. T251 / the T199 spec §6
// (docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md).
//
// WHY THIS FILE EXISTS AHEAD OF THE TWELVE CONDITIONS. Every one of §6's pass
// conditions is a statement about a camp with a particular shape — two tiers,
// six offerings with those capacities, a shared location, a bundle spanning two
// periods. If the camp quietly stops having that shape, the conditions do not
// fail; they pass while testing nothing. `buildAttendance` returns
// `{attendance: null}` outright when the occurrences span at most one tier
// (src/screens/elective/assignment/buildAttendance.js:43-46), and
// `runLinkedChoiceTier` returns immediately when no choice has more than one
// member occurrence (src/engine/buildElectiveAssignments.js:643) — two
// conditions that go vacuous with no symptom at all.
//
// So the declared manifest is checked against the built camp here, once, and
// every other T251 file may then assume it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { CURRENT_SCHEMA_VERSION, getSchemaVersion } from './db/localDb.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { ACCEPTANCE_MANIFEST, manifestChecks } from './fixtures/electiveAcceptanceCamp.js'

let camp

beforeAll(async () => { camp = await openAcceptanceCamp() }, 60_000)
afterAll(() => { camp?.close() })

const M = ACCEPTANCE_MANIFEST

describe('T251 — the acceptance camp is the camp §6 describes', () => {
  // Asserted against CURRENT_SCHEMA_VERSION itself, never a hand-maintained
  // literal: every literal form of this tripwire in this repository has gone
  // stale (see electron/ingestPassExclusivity.integration.test.js's own note).
  it('is written against the current schema version', () => {
    expect(getSchemaVersion(camp.db)).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('has two tiers in the shape the grid states them', () => {
    expect(manifestChecks(camp.db, camp.fixture).tiers).toEqual([...M.tiers].sort())
  })

  it('has four groups, two per tier', () => {
    const c = manifestChecks(camp.db, camp.fixture)
    expect(c.groups).toEqual([...M.groups].sort())
    for (const tier of M.tiers) {
      const n = camp.db
        .prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ? AND tier_id = ?')
        .get(camp.fixture.campId, camp.fixture.tierIdByName.get(tier)).c
      expect(n).toBe(M.groupsPerTier)
    }
  })

  it('has the three operating days the grid states', () => {
    expect(manifestChecks(camp.db, camp.fixture).days).toEqual(M.days)
  })

  it('has six offerings, at the capacities §6 names', () => {
    expect(manifestChecks(camp.db, camp.fixture).offeringCount).toBe(Object.keys(M.offerings).length)
    for (const [name, [mode, limit, minToRun]] of Object.entries(M.offerings)) {
      const row = camp.db
        .prepare('SELECT capacity_mode, capacity_limit, min_mode, min_to_run FROM elective_set_activities WHERE id = ?')
        .get(camp.fixture.offeringIdByActivity.get(name))
      expect({ name, ...row }).toEqual({
        name,
        capacity_mode: mode,
        capacity_limit: limit,
        min_mode: minToRun == null ? 'none' : 'required',
        min_to_run: minToRun,
      })
    }
  })

  // The unlimited offering is load-bearing twice over: it is the branch a naive
  // `capacity_limit ?? 0` read CLOSES (buildOfferings.js:1-5's own trap note),
  // and its presence is why NO_CAPACITY can never fire in this camp — see the
  // asserted gap in electiveAcceptanceSolve.integration.test.jsx.
  it('offers exactly one unlimited activity', () => {
    const rows = camp.db
      .prepare("SELECT activity_id FROM elective_set_activities WHERE elective_set_id = ? AND capacity_mode = 'unlimited'")
      .all(camp.fixture.electiveSetId)
    expect(rows).toHaveLength(1)
    expect(rows[0].activity_id).toBe(camp.fixture.activityIdByName.get('Garden'))
  })

  it('places the set on cells that span BOTH tiers — without which condition 4 is vacuous', () => {
    const tierIds = camp.db.prepare(`
      SELECT DISTINCT g.tier_id AS tier_id FROM template_slots s
      JOIN groups g ON g.id = s.group_id
      WHERE s.template_id = ? AND s.elective_set_id = ?
    `).all(camp.fixture.generatedTemplateId, camp.fixture.electiveSetId).map((r) => r.tier_id)
    expect(new Set(tierIds).size).toBe(2)
  })

  it('the two routes differ, and differ in the two ways §6 needs', () => {
    const c = manifestChecks(camp.db, camp.fixture)
    // (a) the manual route carries the Wednesday cell for BOTH tiers, the
    //     generated route for Younger only — which is what makes the
    //     eligibility rejection a property of a real route rather than a staged
    //     row, and what makes condition 9's staleness test a real template edit.
    expect(c.manualElectiveCells).toBeGreaterThan(c.generatedElectiveCells)
    // (b) the generated route carries Boating at the Monday elective period for
    //     Older 2 — §6's outer location conflict.
    const conflictSlot = camp.db
      .prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?')
      .get(camp.fixture.outerConflictSlotId)
    expect(conflictSlot.elective_set_id).toBeNull()
    expect(conflictSlot.activity_id).toBe(camp.fixture.activityIdByName.get(M.sharedLocationOuterActivity))
  })

  it('shares one location between an offering and a non-elective group activity', () => {
    const locationId = camp.fixture.locationIdByName.get(M.sharedLocation)
    const users = camp.db
      .prepare('SELECT name FROM activities WHERE camp_id = ? AND location_id = ? ORDER BY name')
      .all(camp.fixture.campId, locationId).map((r) => r.name)
    expect(users).toEqual([M.sharedLocationElective, M.sharedLocationOuterActivity].sort())
  })

  it('has a bundle spanning exactly two periods — without which condition 8 is vacuous', () => {
    const periods = camp.db
      .prepare('SELECT day_id, time_block_id FROM elective_bundle_periods WHERE bundle_id = ?')
      .all(camp.fixture.bundleIds.bundle)
    expect(periods).toHaveLength(2)
    expect(new Set(periods.map((p) => p.day_id)).size).toBe(2)
    expect(manifestChecks(camp.db, camp.fixture).bundleCount).toBe(1 + M.refusedBundles.length)
  })

  it('has two MORE bundles that overlap each other, so UNSUPPORTED_LINKED_CHOICE is produced not merely absent', () => {
    const cellsOf = (id) => camp.db
      .prepare('SELECT day_id, time_block_id FROM elective_bundle_periods WHERE bundle_id = ?')
      .all(id).map((p) => `${p.day_id}|${p.time_block_id}`).sort()
    const tierOf = (id) => camp.db
      .prepare('SELECT tier_id FROM elective_bundle_tiers WHERE bundle_id = ?').get(id).tier_id

    const a = cellsOf(camp.fixture.bundleIds.refusedBundle0)
    const b = cellsOf(camp.fixture.bundleIds.refusedBundle1)
    expect(b.some((k) => a.includes(k))).toBe(true)
    expect(tierOf(camp.fixture.bundleIds.refusedBundle0)).toBe(tierOf(camp.fixture.bundleIds.refusedBundle1))

    // And they must NOT collide with the LIVE bundle, because case (c) refuses
    // EVERY choice sharing the period, not only the newcomer — a second bundle
    // overlapping the live one takes the live one down with it and leaves
    // condition (8) nothing to assert (measured: the first attempt did exactly
    // that). An occurrence is (set, day, block, TIER), so putting these two on
    // the other tier is what keeps them apart.
    expect(tierOf(camp.fixture.bundleIds.refusedBundle0))
      .not.toBe(tierOf(camp.fixture.bundleIds.bundle))
  })
  // The three bootstrap rows, asserted as the PRECONDITION each one stands in
  // for rather than merely as "a row exists". bootstrapDevice throws on each of
  // these too; they are repeated here because a throw in setup reads as an
  // infrastructure failure, and these are claims about the fixture.
  it('bootstraps exactly one camp, with a signing key', () => {
    const camps = camp.db.prepare('SELECT id, signing_public_key FROM camps').all()
    expect(camps).toHaveLength(1)
    expect(camps[0].signing_public_key).toBeTruthy()
  })

  it('bootstraps this device in the shape approveDevice writes', () => {
    const row = camp.db
      .prepare('SELECT pairing_status, device_secret_identifier FROM devices WHERE id = ?')
      .get(camp.deviceId)
    expect(row.pairing_status).toBe('authorized')
    expect(row.device_secret_identifier).toMatch(/^[0-9a-f]{64}$/)
  })

  it('bootstraps exactly one cohort', () => {
    expect(camp.db.prepare('SELECT COUNT(*) c FROM cohorts WHERE camp_id = ?').get(camp.fixture.campId).c).toBe(1)
  })
})
