// T321 follow-up (Red Hat finding) — attributeElectiveSubject.js's OWN inline
// rekey block (subjectId -> the resolved camperId) is a separate code path
// from camperIdentityResolver.js's rekeyOrphans, and moved only
// elective_preferences/elective_assignments — leaving elective_run_outer_
// snapshots and elective_run_findings behind under the provisional subject's
// id. projector.js's TOMBSTONE_DENYLISTED_ENTITIES comment and
// purgeSupportCommand.js both treat all four as camper-scoped dependents of a
// campers row; naming a provisional subject must move all four or a
// finalized-run snapshot/finding for that child silently survives pointing at
// a camper id the attribution just deleted.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { attributeElectiveSubject } from './attributeElectiveSubject.js'
import { appendOp } from './operations.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t321-attr-'))
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

describe('attributeElectiveSubject — rekeys elective_run_outer_snapshots and elective_run_findings too', () => {
  it('moves both tables from the provisional subject onto the newly-named camper id', () => {
    const { db, campId } = freshDb()

    const subjectId = 'camper1:sub:provisional-subject'
    db.prepare(
      "INSERT INTO campers (id, camp_id, display_name, is_unattributed) VALUES (?, ?, 'planner', 1)"
    ).run(subjectId, campId)
    db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run-1', ?, 'Week 1')").run(campId)

    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-2', 'Device 2')

    appendOp(db, { entity: 'elective_run_outer_snapshots', entity_id: 'snap-1', field: 'run_id', value: 'run-1', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_outer_snapshots', entity_id: 'snap-1', field: 'camper_id', value: subjectId, device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_outer_snapshots', entity_id: 'snap-1', field: 'day_id', value: 'day-mon', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_outer_snapshots', entity_id: 'snap-1', field: 'time_block_id', value: 'block-1', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_outer_snapshots', entity_id: 'snap-1', field: 'activity_name', value: 'Swim', device_id: 'dev-2' })

    // run_id/solver_generation/kind/message first — ensureExists (projections.js)
    // only INSERTs once all four are known, and its INSERT sets only those four
    // columns, so camper_id must come after or its write lands as a no-op UPDATE
    // on a row that doesn't exist yet.
    appendOp(db, { entity: 'elective_run_findings', entity_id: 'find-1', field: 'run_id', value: 'run-1', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_findings', entity_id: 'find-1', field: 'solver_generation', value: 'gen-1', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_findings', entity_id: 'find-1', field: 'kind', value: 'UNSUPPORTED_LINKED_CHOICE', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_findings', entity_id: 'find-1', field: 'message', value: 'linked choice unsupported', device_id: 'dev-2' })
    appendOp(db, { entity: 'elective_run_findings', entity_id: 'find-1', field: 'camper_id', value: subjectId, device_id: 'dev-2' })

    const result = attributeElectiveSubject(db, {
      campId, deviceId: 'dev-1', subjectId, displayName: 'Ari Green',
    })
    expect(result.ok).toBe(true)
    expect(result.camperId).not.toBe(subjectId)

    const movedSnapshot = db.prepare('SELECT camper_id, activity_name FROM elective_run_outer_snapshots WHERE run_id = ?').get('run-1')
    expect(movedSnapshot).toBeTruthy()
    expect(movedSnapshot.camper_id).toBe(result.camperId)
    expect(movedSnapshot.activity_name).toBe('Swim')

    const movedFinding = db.prepare('SELECT camper_id, message FROM elective_run_findings WHERE run_id = ?').get('run-1')
    expect(movedFinding).toBeTruthy()
    expect(movedFinding.camper_id).toBe(result.camperId)
    expect(movedFinding.message).toBe('linked choice unsupported')

    expect(db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE camper_id = ?').get(subjectId).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_run_findings WHERE camper_id = ?').get(subjectId).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM elective_run_findings').get().c).toBe(1)
    expect(db.prepare('SELECT 1 FROM campers WHERE id = ?').get(subjectId)).toBeUndefined()
  })
})
