// @vitest-environment node
//
// T320 part 2 item 1 (docs/adr/2026-09-30-elective-run-durability.md) — the
// tombstone-aware stub seed. A child's ensureExists may no longer conjure a
// parent whose LAST recorded act was its own deletion.
//
// The defect this pins is the LOCAL appendOp path, not the merge path:
// appendOp calls applyProjection directly and liveDoc.recordLocalWrite runs no
// projectAll, so on a device whose SQLite no longer has the run, a local child
// write re-created the parent as a blank-named row. The merge path is already
// self-healing (projectAll is two-phase) and is pinned here too, so a future
// change to projectAll cannot silently remove that property.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { deriveImportedElectiveRunId } from './electiveDerivedIds.js'
import { createEmptyDoc, applyWrite } from '../automerge/campDocument.js'
import { projectAll, rebuildFromDoc } from '../automerge/projector.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-stubguard-'))
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

const op = (db, entity, entity_id, field, value) =>
  appendOp(db, { entity, entity_id, field, value, device_id: 'dev-1' })

describe('stub seed — tombstone guard on elective_assignment_runs', () => {
  it('a local child write after a local delete does NOT resurrect the run', () => {
    const { db, campId } = freshDb()
    op(db, 'elective_assignment_runs', 'run-1', 'camp_id', campId)
    op(db, 'elective_assignment_runs', 'run-1', 'name', 'Week 1 electives')
    op(db, 'elective_preferences', 'pref-1', 'run_id', 'run-1')
    expect(db.prepare('SELECT name FROM elective_assignment_runs WHERE id = ?').get('run-1').name)
      .toBe('Week 1 electives')

    op(db, 'elective_assignment_runs', 'run-1', DELETE_FIELD, 1)
    expect(db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get('run-1')).toBeUndefined()

    // The reachable trigger: a director on another surface writes a child of
    // the run this device just deleted.
    op(db, 'elective_preferences', 'pref-2', 'run_id', 'run-1')

    // Assert the ROW, not the call. Unguarded, this is [{ id: 'run-1', name: '' }].
    expect(db.prepare('SELECT id, name FROM elective_assignment_runs').all()).toEqual([])
    db.close()
  })

  it('the merge path stays self-healing: a peer child write racing a delete leaves no ghost', () => {
    const { db, campId } = freshDb()
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-1', field: 'camp_id', value: campId })
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-1', field: 'name', value: 'Week 1' })
    doc = applyWrite(doc, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'run_id', value: 'run-1' })
    projectAll(db, doc)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_assignment_runs').get().c).toBe(1)

    // The merged doc a peer's racing child write produces: the parent is gone
    // from the document, an orphan child remains.
    let merged = createEmptyDoc()
    merged = applyWrite(merged, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'run_id', value: 'run-1' })
    merged = applyWrite(merged, { entity: 'elective_preferences', entity_id: 'pref-2', field: 'run_id', value: 'run-1' })
    projectAll(db, merged)

    expect(db.prepare('SELECT id, name FROM elective_assignment_runs').all()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(2)
    db.close()
  })

  it('replay is idempotent: projectAll twice then rebuildFromDoc reaches identical rows', () => {
    const { db, campId } = freshDb()
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-1', field: 'camp_id', value: campId })
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-1', field: 'name', value: 'Week 1' })
    doc = applyWrite(doc, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'run_id', value: 'run-1' })

    projectAll(db, doc)
    const first = db.prepare('SELECT id, name FROM elective_assignment_runs ORDER BY id').all()
    projectAll(db, doc)
    expect(db.prepare('SELECT id, name FROM elective_assignment_runs ORDER BY id').all()).toEqual(first)
    rebuildFromDoc(db, doc, 'elective_assignment_runs')
    expect(db.prepare('SELECT id, name FROM elective_assignment_runs ORDER BY id').all()).toEqual(first)
    expect(first).toEqual([{ id: 'run-1', name: 'Week 1' }])
    db.close()
  })

  it('a legitimate re-create on the SAME derived run id is not stranded by the guard', () => {
    const { db, campId } = freshDb()
    const sha = 'f'.repeat(64)
    const runId = deriveImportedElectiveRunId(campId, sha)
    const parsed = {
      campers: [{ id: 'cam-1', display_name: 'Ari Green', external_id: null }],
      choices: [{ label: 'Archery', labelKey: 'archery' }],
      preferences: [{ camper_id: 'cam-1', occurrence_id: null, label: 'Archery', labelKey: 'archery', rank: 1 }],
      sameNameCampers: [],
      skippedRows: [],
    }
    const first = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'First import', runId, sourceSha256: sha,
      parsed, assignments: [], occurrences: [],
    })
    expect(first.ok).toBe(true)

    op(db, 'elective_assignment_runs', runId, DELETE_FIELD, 1)
    expect(db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)).toBeUndefined()

    // Re-importing the identical sheet derives the SAME id. The recency
    // predicate is self-correcting; a bare "a delete op exists" predicate
    // would strand this forever.
    const again = commitElectiveRun(db, {
      campId, deviceId: 'dev-1', name: 'Second import', runId, sourceSha256: sha,
      parsed, assignments: [], occurrences: [],
    })
    expect(again.ok).toBe(true)
    const row = db.prepare('SELECT id, name FROM elective_assignment_runs WHERE id = ?').get(runId)
    expect(row).toBeDefined()
    expect(row.name).not.toBe('')
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE run_id = ?').get(runId).c).toBeGreaterThan(0)
    db.close()
  })
})

describe('stub seed — tombstone guard on elective_sets', () => {
  // elective_set_activities.elective_set_id is a REAL FK (schema.sql), unlike
  // every elective_assignment_runs child, whose run_id is a soft reference. So
  // a refused parent seed cannot leave an orphan child here the way it does
  // for a run — INSERT OR IGNORE does not suppress an FK violation (this
  // file's own elective_choice_offerings comment says so). The refusal is
  // therefore a silent skip of the WHOLE child insert, which is the error
  // shape the ADR's interface-contract table specifies for this guard.
  it('a local elective_set_activities write after a local delete does NOT resurrect the set', () => {
    const { db, campId } = freshDb()
    op(db, 'elective_sets', 'set-1', 'camp_id', campId)
    op(db, 'elective_sets', 'set-1', 'name', 'Afternoon electives')
    op(db, 'elective_sets', 'set-1', DELETE_FIELD, 1)
    expect(db.prepare('SELECT * FROM elective_sets WHERE id = ?').get('set-1')).toBeUndefined()

    op(db, 'elective_set_activities', 'esa-1', 'elective_set_id', 'set-1')
    op(db, 'elective_set_activities', 'esa-1', 'activity_id', 'act-1')

    expect(db.prepare('SELECT id, name FROM elective_sets').all()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(0)
    db.close()
  })

  it('a legitimate re-create of an elective_set id after its delete still seeds', () => {
    const { db, campId } = freshDb()
    op(db, 'elective_sets', 'set-1', 'camp_id', campId)
    op(db, 'elective_sets', 'set-1', DELETE_FIELD, 1)
    // The set itself is written again (its own ensureExists, unguarded), so
    // the last recorded act is no longer the delete.
    op(db, 'elective_sets', 'set-1', 'name', 'Rebuilt set')
    op(db, 'elective_set_activities', 'esa-1', 'elective_set_id', 'set-1')
    op(db, 'elective_set_activities', 'esa-1', 'activity_id', 'act-1')

    expect(db.prepare('SELECT name FROM elective_sets WHERE id = ?').get('set-1').name).toBe('Rebuilt set')
    expect(db.prepare('SELECT COUNT(*) c FROM elective_set_activities').get().c).toBe(1)
    db.close()
  })
})
