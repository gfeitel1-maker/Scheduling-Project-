// T198 — buildElectiveRunProjectionInput is the ONE place an elective run's projection input is
// assembled for a machine-access caller (MCP tool, CLI export). It must match, field for field, the
// shape electron/electiveAcceptanceSurfaces.integration.test.jsx's beforeAll already assembles from
// the real handlers (getElectiveRun, getElectiveRunOuterSchedule, list) and has proven correct
// against raw SQL — that integration test is the shape's full-fixture proof. This file only covers
// the two things a heavy acceptance fixture is the wrong tool for: the not-found refusal, and that a
// present-but-empty run returns the right skeleton rather than throwing.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { buildElectiveRunProjectionInput } from './electiveRunProjectionInput.js'
import { buildElectiveRunProjectionExport } from '../../src/screens/elective/export/exportElectiveRunProjection.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-projection-input-'))
}

function bootstrapDb(dir) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  return { db, campId }
}

describe('buildElectiveRunProjectionInput', () => {
  const dirs = []
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true })
  })

  it('returns { ok: false, error: RUN_NOT_FOUND } for a runId that does not exist', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { db } = bootstrapDb(dir)

    const result = buildElectiveRunProjectionInput(db, { runId: 'does-not-exist' })

    expect(result).toEqual({ ok: false, error: 'RUN_NOT_FOUND' })
    db.close()
  })

  it('returns the full input skeleton for a run with no assignments yet', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { db, campId } = bootstrapDb(dir)
    const runId = randomUUID()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name, status, source_sha256, solver_generation) VALUES (?, ?, 'Run 1', 'draft', 'deadbeef', 'gen-1')"
    ).run(runId, campId)

    const result = buildElectiveRunProjectionInput(db, { runId })

    expect(result.ok).toBe(true)
    expect(result.input.run).toEqual({
      id: runId,
      name: 'Run 1',
      status: 'draft',
      solver_generation: 'gen-1',
      source_sha256: 'deadbeef',
      // T320 round 2, F2 — a draft run has nothing to compare a snapshot
      // against yet (computeSnapshotCompleteness's own no-op posture for a
      // non-final run).
      snapshotIncomplete: false,
      expectedSnapshotRows: null,
      heldSnapshotRows: null,
    })
    expect(result.input.campers).toEqual([])
    expect(result.input.groups).toEqual([])
    expect(result.input.days).toEqual([])
    expect(result.input.timeBlocks).toEqual([])
    expect(result.input.outerRows).toEqual([])
    expect(result.input.preferences).toEqual([])
    expect(result.input.assignments).toEqual([])
    expect(result.input.occurrences).toEqual([])
    expect(result.input.staleCount).toBe(0)
    expect(result.input.capacityRows).toEqual([])
    expect(result.input.eligibilityFindings).toEqual([])
    expect(result.input.resourceConflicts).toEqual([])
    db.close()
  })

  it('maps days_of_operation.label onto a `name` field, per the shape the export builders read', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { db, campId } = bootstrapDb(dir)
    const runId = randomUUID()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name, status) VALUES (?, ?, 'Run 1', 'draft')"
    ).run(runId, campId)
    const dayId = randomUUID()
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run(dayId, campId, 'Monday')

    const result = buildElectiveRunProjectionInput(db, { runId })

    expect(result.input.days).toEqual([expect.objectContaining({ id: dayId, label: 'Monday', name: 'Monday' })])
    db.close()
  })

  // T320 round 2, F2 — the whole reason this threading exists: the MCP tools
  // (scripts/mcp/tools.js) and the CLI (scripts/electivesCli.js) both call
  // `buildElectiveRunProjectionExport(result.input)` with no other assembly
  // step, so if `result.input.run.snapshotIncomplete` is not really wired
  // through here, THIS is the one place that can be proven and no export
  // integration harness is needed to prove it.
  it('threads snapshotIncomplete/expectedSnapshotRows/heldSnapshotRows from getElectiveRun onto input.run, and the export builder refuses on it', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { db, campId } = bootstrapDb(dir)
    const runId = randomUUID()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name, status, snapshot_expected_rows, snapshot_digest) VALUES (?, ?, 'Run 1', 'final', 1, 'deadbeef')"
    ).run(runId, campId)
    // Partial sync: a stub-seeded row (identity columns only), same shape
    // projections.js's ensureExists produces before every field has arrived.
    db.prepare(
      'INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?)'
    ).run('snap-1', runId, 'cam-1', 'day-1', 'tb-1')

    const result = buildElectiveRunProjectionInput(db, { runId })

    expect(result.ok).toBe(true)
    expect(result.input.run.snapshotIncomplete).toBe(true)
    expect(result.input.run.expectedSnapshotRows).toBe(1)
    expect(result.input.run.heldSnapshotRows).toBe(1)

    // The MCP/CLI path: buildElectiveRunProjectionExport(result.input), no
    // second assembly. It must refuse rather than export a complete-looking
    // document with holes.
    const exported = buildElectiveRunProjectionExport(result.input)
    expect(exported.ok).toBe(false)
    expect(exported.error).toBe('SNAPSHOT_INCOMPLETE')
    db.close()
  })
})
