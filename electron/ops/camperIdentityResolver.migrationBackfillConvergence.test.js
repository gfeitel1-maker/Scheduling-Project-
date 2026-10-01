// T321 follow-up (Red Hat finding) — the v85 migration back-fill
// (electron/db/localDb.js) writes camper_identity_keys rows with raw SQLite,
// never appendOp, so they never replicate to a device that joins the camp
// AFTER the migration ran elsewhere (see the ADR's "Migration back-fill does
// not replicate" section for the full reasoning on why this is accepted
// rather than fixed at migration time).
//
// THIS TEST proves the accepted mitigation actually holds: a pre-existing
// (pre-migration, un-backfilled) camper is not silently orphaned forever — a
// new device's independent resolution for the same name eventually converges
// onto it via the SAME rekeyOrphans mechanism acceptance criterion 4 already
// covers, once that new mapping syncs back and the original device touches
// the name again. Nothing is silently dropped.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { resolveOrMintCamperId } from './camperIdentityResolver.js'
import { appendOp } from './operations.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t321-migration-'))
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

describe('a pre-migration camper with no camper_identity_keys row self-heals on next touch', () => {
  it('rekeys the un-backfilled camper onto a new device\'s synced-in mapping, preserving its preferences', () => {
    const { db, campId } = freshDb()

    // Simulates the PRE-MIGRATION state: a real camper this device has always had, written
    // directly (as the old, pre-ADR commitElectiveRun.js path did) with NO camper_identity_keys
    // row — exactly what the v85 back-fill was supposed to create but, per the accepted
    // limitation, never replicated to any other device.
    const preExistingCamperId = 'camper1:36.pre-migration-camper-id-old-format'
    db.prepare("INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, 'Ari Green')").run(preExistingCamperId, campId)
    db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run-1', ?, 'Week 1')").run(campId)
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'run_id', value: 'run-1', device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'camper_id', value: preExistingCamperId, device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'choice_id', value: 'choice-swim', device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'rank', value: 1, device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'rank_kind', value: 'ranked', device_id: 'dev-1' })

    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-2', 'New Device')

    // THE NEW DEVICE: joins the camp after the migration ran elsewhere, re-imports the same
    // camper's sheet, and genuinely cache-misses (this device has no camper_identity_keys row for
    // 'Ari Green' at all). resolveOrMintCamperId mints a fresh id and writes the mapping through
    // the live, replicating appendOp path.
    const newDeviceResult = resolveOrMintCamperId(db, { campId, deviceId: 'dev-2', displayName: 'Ari Green' })
    expect(newDeviceResult.minted).toBe(true)
    expect(newDeviceResult.camperId).not.toBe(preExistingCamperId)

    // SYNC SIMULATION: this device now receives dev-2's camper row (its own campers row, separate
    // from the lookup mapping) — same as the orphan-rekey acceptance-criterion-4 test's merge
    // simulation.
    db.prepare("INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, 'Ari Green')").run(newDeviceResult.camperId, campId)

    // NEXT TOUCH on the ORIGINAL device: re-importing (or otherwise resolving) 'Ari Green' again
    // now hits the mapping dev-2 wrote, detects the pre-existing camper as the orphan, and rekeys.
    const nextTouch = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })
    expect(nextTouch.minted).toBe(false)
    expect(nextTouch.camperId).toBe(newDeviceResult.camperId)

    // THE ASSERTION THIS TEST EXISTS FOR: the pre-migration camper's preference is not lost — it
    // moved onto the new device's id.
    const movedPref = db.prepare('SELECT camper_id FROM elective_preferences WHERE run_id = ? AND choice_id = ?').get('run-1', 'choice-swim')
    expect(movedPref).toBeTruthy()
    expect(movedPref.camper_id).toBe(newDeviceResult.camperId)

    expect(db.prepare('SELECT 1 FROM campers WHERE id = ?').get(preExistingCamperId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(1)
  })
})
