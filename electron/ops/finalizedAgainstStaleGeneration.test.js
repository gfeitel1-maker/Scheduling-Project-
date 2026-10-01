// @vitest-environment node
//
// T320 part 2 (docs/adr/2026-09-30-elective-run-durability.md, board item
// i-final-run-always-reads-out-of-date-since-v76) — the false positive
// computeFinalizedAgainstStaleGeneration has produced since v76 (T197).
//
// v76 made inherited cells (cell_kind: 'inherited') write their snapshot row
// with solver_generation: NULL BY DESIGN (electron/ops/
// electiveRunOuterSchedule.js's inherited branch) — an inherited cell has no
// solver generation to carry. The comparison this module runs predates that
// change and treats ANY distinct solver_generation value in a run's snapshot
// set as evidence of staleness, so a NULL inherited row sitting next to the
// run's own current generation reads as a mismatch on every finalized run
// that has even one inherited cell. Observed live 2026-09-30: 234 inherited
// NULL rows next to 78 matching elective rows, on a single device, with
// nothing stale about it.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { computeFinalizedAgainstStaleGeneration } from './finalizedAgainstStaleGeneration.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-stalegen-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function insertSnapshot(db, { runId, generation, cellKind = 'elective' }) {
  db.prepare(
    `INSERT INTO elective_run_outer_snapshots
       (id, run_id, camper_id, day_id, time_block_id, solver_generation, cell_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), runId, randomUUID(), 'day-1', 'tb-1', generation, cellKind)
}

describe('computeFinalizedAgainstStaleGeneration', () => {
  it('case 1 (the live defect): inherited NULL rows alongside matching elective rows -> false', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: null, cellKind: 'inherited' })
    insertSnapshot(db, { runId: run.id, generation: null, cellKind: 'inherited' })
    insertSnapshot(db, { runId: run.id, generation: 'g1', cellKind: 'elective' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(false)
    db.close()
  })

  it('case 2: an elective row at a different generation -> true', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: 'g0', cellKind: 'elective' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(true)
    db.close()
  })

  it('case 3: mixed inherited NULLs + matching elective + one stale elective -> true', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: null, cellKind: 'inherited' })
    insertSnapshot(db, { runId: run.id, generation: 'g1', cellKind: 'elective' })
    insertSnapshot(db, { runId: run.id, generation: 'g0', cellKind: 'elective' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(true)
    db.close()
  })

  it('case 4: a final run whose only rows are inherited (all NULL) -> false', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: null, cellKind: 'inherited' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(false)
    db.close()
  })

  it('case 5: a draft run -> false (status guard unchanged)', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'draft', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: 'g0', cellKind: 'elective' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(false)
    db.close()
  })

  it('case 6: a final run with zero snapshot rows -> false (unchanged)', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(false)
    db.close()
  })

  it('case 7: an elective row with NULL generation against a non-null run generation -> true (deliberate: not filtered by IS NOT NULL)', () => {
    const { db } = freshDb()
    const run = { id: randomUUID(), status: 'final', solver_generation: 'g1' }
    insertSnapshot(db, { runId: run.id, generation: null, cellKind: 'elective' })
    expect(computeFinalizedAgainstStaleGeneration(db, run)).toBe(true)
    db.close()
  })
})
