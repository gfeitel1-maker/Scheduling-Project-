// T321 acceptance criterion 4 — the cross-device orphan case (ADR decision 3).
//
// SCENARIO: two devices, each offline, independently resolve the SAME logical
// camper (same name) to DIFFERENT random camper ids (the expected, named cost
// of Option B — see the ADR's "Convergence, worked through explicitly"). Each
// writes a preference under its own camper id. After the camper_identity_keys
// row converges (simulated here by directly setting it to one winner, the way
// an Automerge per-field LWW merge would), the LOSING device's next touch
// (another resolveOrMintCamperId call for the same name) must detect that its
// local camper id no longer matches what camper_identity_keys resolves to,
// and REKEY: move the losing camper's preference onto the winner, delete the
// losing camper row. Nothing may be silently dropped.
//
// This does not use the real libp2p merge (that is scenario 38, the
// convergence integration test) — it simulates the POST-merge state directly,
// which is the correct boundary for a unit test of the rekey DETECTION logic
// specifically, same split as 31-derived-id-convergence.automerge.js (real
// merge) vs electiveDerivedIds.test.js (pure function, frozen vectors).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t321-orphan-'))
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

describe('resolveOrMintCamperId — cross-device orphan rekey (acceptance criterion 4)', () => {
  it('rekeys the losing device camper preference onto the winning camper id, on next touch', () => {
    const { db, campId } = freshDb()

    // Device B (this db, simulating the LOSING device) resolves 'Ari Green' while
    // offline and mints its own random camper id.
    const losing = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })
    expect(losing.minted).toBe(true)

    // The resolver itself only mints the id and the lookup row — every real call
    // site (commitElectiveRun.js, preferenceSheet.js) creates the `campers` row
    // separately once it has the resolved id, so the test does the same here.
    db.prepare("INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, 'Ari Green')").run(losing.camperId, campId)

    // Device B writes a preference under its own (losing) camper id, through the
    // real write path, before any merge.
    db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run-1', ?, 'Week 1')").run(campId)
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'run_id', value: 'run-1', device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'camper_id', value: losing.camperId, device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'choice_id', value: 'choice-swim', device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'rank', value: 1, device_id: 'dev-1' })
    appendOp(db, { entity: 'elective_preferences', entity_id: 'pref-1', field: 'rank_kind', value: 'ranked', device_id: 'dev-1' })

    // SIMULATE THE MERGE: camper_identity_keys for this lookup key now resolves to
    // device A's camper id instead (A won last-write-wins) — exactly what a real
    // Automerge merge would do to this device's local projection.
    const winningCamperId = 'camper2:winner-from-device-a'
    db.prepare("INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, 'Ari Green')").run(winningCamperId, campId)
    db.prepare('UPDATE camper_identity_keys SET camper_id = ? WHERE id = ?').run(winningCamperId, losing.lookupId)

    // NEXT TOUCH: device B imports the same sheet again (or commits another run)
    // and resolves 'Ari Green' again. This must detect the mismatch and rekey.
    const result = resolveOrMintCamperId(db, { campId, deviceId: 'dev-1', displayName: 'Ari Green' })

    expect(result.minted).toBe(false)
    expect(result.camperId).toBe(winningCamperId)

    // THE ASSERTION THIS CRITERION EXISTS FOR: the preference is NOT dropped — it
    // is moved onto the winning camper id.
    const movedPref = db.prepare('SELECT camper_id FROM elective_preferences WHERE run_id = ? AND choice_id = ?').get('run-1', 'choice-swim')
    expect(movedPref).toBeTruthy()
    expect(movedPref.camper_id).toBe(winningCamperId)

    // The losing camper row and its orphaned preference row are both gone — no
    // duplicate, no dangling reference to a camper id nothing resolves to.
    expect(db.prepare('SELECT 1 FROM campers WHERE id = ?').get(losing.camperId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences WHERE camper_id = ?').get(losing.camperId).c).toBe(0)

    // Exactly one preference total — not duplicated across both ids.
    expect(db.prepare('SELECT COUNT(*) c FROM elective_preferences').get().c).toBe(1)
  })
})
