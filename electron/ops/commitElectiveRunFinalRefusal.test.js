// @vitest-environment node
//
// T320 part 2 item 2 (docs/adr/2026-09-30-elective-run-durability.md) — a
// commit onto an already-final run is REFUSED before any write. T244 round 2
// stopped this function re-asserting status/name/source_filename onto an
// existing row; nothing refused the commit itself, so a regenerate silently
// wrote over an immutable run.
//
// The refusal is LOCAL and best-effort by design: it closes the single-device
// window the code comments already identified, not a distributed race.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-finalrefuse-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const PARSED = {
  campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null }],
  choices: [{ label: 'Archery', labelKey: 'archery' }],
  preferences: [{ camper_id: 'cam-1', occurrence_id: 'occ-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
  sameNameCampers: [],
  skippedRows: [],
}
const OCCURRENCES = [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' }]

describe('commitElectiveRun — RUN_IS_FINAL', () => {
  it('refuses a commit onto a final run BEFORE any write', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: [], occurrences: OCCURRENCES,
    })
    expect(first.ok).toBe(true)
    db.prepare("UPDATE elective_assignment_runs SET status = 'final' WHERE id = ?").run(runId)

    const seqBefore = db.prepare('SELECT max(seq) s FROM operations').get().s

    const out = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1 again', runId,
      parsed: PARSED, assignments: [], occurrences: OCCURRENCES,
    })
    expect(out).toEqual({ ok: false, error: 'RUN_IS_FINAL' })

    // The return value alone would pass against an implementation that refuses
    // AFTER writing. Assert nothing reached the op log.
    expect(db.prepare('SELECT max(seq) s FROM operations').get().s).toBe(seqBefore)
    expect(db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId).status).toBe('final')
    db.close()
  })

  it('a draft run still commits', () => {
    const { db, campId } = freshDb()
    const runId = randomUUID()
    expect(commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: [], occurrences: OCCURRENCES,
    }).ok).toBe(true)
    expect(commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Week 1', runId,
      parsed: PARSED, assignments: [], occurrences: OCCURRENCES,
    }).ok).toBe(true)
    db.close()
  })
})
