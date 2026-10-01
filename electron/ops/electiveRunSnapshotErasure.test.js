// Board follow-up to T320 item 1 (docs/adr/2026-09-30-elective-run-durability.md): the
// known-defect-now-fixed end-to-end proof that erasing a camper no longer permanently breaks a
// finalized run's export on EVERY device. electiveRunSnapshotCompleteness.test.js covers the
// digest-comparison logic at the unit level; this file proves the real multi-device path:
//
//   device A finalizes a run for real (finalizeElectiveRun.js, real sqlite) -> its state reaches
//   device B exactly the way a peer's would (an Automerge doc, projected with projectAll, the
//   SAME admission gate electron/automerge/tombstoneProjection.test.js exercises) -> device B's
//   own computeSnapshotCompleteness/export builder must treat the result as complete.
//
// Both orders the ADR's erasure propagation can arrive in are covered (device B may see the
// snapshot before or after the tombstone), per tombstoneProjection.test.js's own precedent for
// elective_run_outer_snapshots (its "snapshot before tombstone" / "tombstone first, then a late
// peer" pair).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../automerge/campDocument.js'
import { projectAll } from '../automerge/projector.js'
import { signTombstone } from '../automerge/tombstoneSignature.js'
import { finalizeElectiveRun } from './finalizeElectiveRun.js'
import { deriveElectiveOccurrenceId } from './electiveDerivedIds.js'
import { getElectiveRunOuterSchedule } from './getElectiveRunOuterSchedule.js'
import { computeSnapshotCompleteness, computeExpectedSnapshotDigestByCamper } from './electiveRunSnapshotCompleteness.js'
import { buildChildScheduleExport } from '../../src/screens/elective/export/exportChildSchedule.js'

const dirs = []
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

const CAMP_ID = 'camp-1'

function freshDb(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shoresh-snap-erasure-${tag}-`))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
}

// Device A: generates a real Host signing key and records its public half locally, exactly as
// installHostKey does in tombstoneProjection.test.js.
function installHostKey(db) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
  const privateKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex')
  db.prepare('INSERT INTO host_signing_key (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
    .run(publicKeyHex, privateKeyHex, new Date().toISOString())
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(publicKeyHex, CAMP_ID)
  return publicKeyHex
}

// Device B never holds the private key — only the trust root (same Host public key device A
// recorded), exactly like a real paired peer.
function trustHostKey(db, publicKeyHex) {
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(publicKeyHex, CAMP_ID)
}

function tombstoneDoc(doc, signingDb, { id, entity, version }) {
  const sig = signTombstone(signingDb, { id, entity, version })
  let d = doc
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'entity', value: entity })
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'version', value: version })
  d = applyWrite(d, { entity: 'tombstones', entity_id: id, field: 'sig', value: sig })
  return d
}

function writeFields(doc, entity, id, fields) {
  let d = doc
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    d = applyWrite(d, { entity, entity_id: id, field, value })
  }
  return d
}

// A minimal, real finalizable run: two campers (camper1 survives, camper2 is erased), each with
// one assignment, built directly against a real sqlite db (same shape as
// finalizeElectiveRun.test.js's own fixture, trimmed to what this file needs).
function buildFinalizableRun(db) {
  const runId = randomUUID()
  const templateId = 'tpl-1'
  const groupId = randomUUID()
  const tierId = randomUUID()
  const setId = randomUUID()
  const camper1 = randomUUID()
  const camper2 = randomUUID()
  const activityId = randomUUID()
  const day1 = 'day-1'
  const day2 = 'day-2'
  const tb = 'tb-1'

  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(tierId, CAMP_ID, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(groupId, CAMP_ID, 'Bunk Alpha', tierId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id) VALUES (?, ?, ?, ?)').run(camper1, CAMP_ID, 'Camper One', groupId)
  db.prepare('INSERT INTO campers (id, camp_id, display_name, group_id) VALUES (?, ?, ?, ?)').run(camper2, CAMP_ID, 'Camper Two', groupId)
  db.prepare('INSERT INTO activities (id, camp_id, name, span_blocks) VALUES (?, ?, ?, ?)').run(activityId, CAMP_ID, 'Pottery', 1)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, CAMP_ID, 'AM Electives')
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, day1, tb)
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), templateId, groupId, setId, day2, tb)
  db.prepare(
    'INSERT INTO elective_assignment_runs (id, camp_id, name, status, schedule_template_id, solver_generation) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(runId, CAMP_ID, 'Week 1', 'draft', templateId, 'gen-1')

  const occ1 = deriveElectiveOccurrenceId(runId, setId, day1, tb, tierId)
  const occ2 = deriveElectiveOccurrenceId(runId, setId, day2, tb, tierId)
  db.prepare(
    'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id, tier_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(occ1, runId, setId, day1, tb, tierId)
  db.prepare(
    'INSERT INTO elective_occurrences (id, run_id, elective_set_id, day_id, time_block_id, tier_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(occ2, runId, setId, day2, tb, tierId)

  db.prepare(
    `INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, source, is_locked)
     VALUES (?, ?, ?, ?, ?, 'manual', 0)`
  ).run(randomUUID(), runId, occ1, camper1, activityId)
  db.prepare(
    `INSERT INTO elective_assignments (id, run_id, occurrence_id, camper_id, activity_id, source, is_locked)
     VALUES (?, ?, ?, ?, ?, 'manual', 0)`
  ).run(randomUUID(), runId, occ2, camper2, activityId)

  return { runId, camper1, camper2 }
}

// Builds the doc fields for the run row and its snapshot rows EXACTLY as device A's real sqlite
// holds them after finalize — the doc is what device B receives, so it must carry the same
// per-camper digest map finalizeElectiveRun.js actually wrote, not a hand-recomputed one.
function docFromFinalizedRun(doc, dbA, runId) {
  const runRow = dbA.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  const snapRows = dbA.prepare('SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)
  let d = writeFields(doc, 'elective_assignment_runs', runId, {
    camp_id: runRow.camp_id,
    name: runRow.name,
    status: runRow.status,
    schedule_template_id: runRow.schedule_template_id,
    solver_generation: runRow.solver_generation,
    finalized_at: runRow.finalized_at,
    finalized_by: runRow.finalized_by,
    snapshot_expected_rows: runRow.snapshot_expected_rows,
    snapshot_digest: runRow.snapshot_digest,
  })
  for (const row of snapRows) {
    d = writeFields(d, 'elective_run_outer_snapshots', row.id, {
      run_id: row.run_id,
      camper_id: row.camper_id,
      day_id: row.day_id,
      time_block_id: row.time_block_id,
      activity_id: row.activity_id,
      activity_name: row.activity_name,
      location_id: row.location_id,
      location_name: row.location_name,
      span_blocks: row.span_blocks,
      solver_generation: row.solver_generation,
      cell_kind: row.cell_kind,
      choice_id: row.choice_id,
      is_linked_choice: row.is_linked_choice,
      choice_label: row.choice_label,
    })
  }
  return { doc: d, runRow, snapRows }
}

function assertExportExcludesErasedCamper(dbB, runId, erasedCamperId, survivingCamperId) {
  const runRow = dbB.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  const completeness = computeSnapshotCompleteness(dbB, runRow)
  expect(completeness.snapshotIncomplete).toBe(false)

  const campers = dbB.prepare('SELECT * FROM campers WHERE camp_id = ?').all(CAMP_ID)
  expect(campers.map((c) => c.id).sort()).toEqual([survivingCamperId])

  const { rows: outerRows } = getElectiveRunOuterSchedule(dbB, { runId })
  const run = { id: runId, name: runRow.name, status: runRow.status, ...completeness }
  const result = buildChildScheduleExport({ run, campers, outerRows })

  expect(result.ok).not.toBe(false)
  const resultCamperIds = result.campers.map((c) => c.camper_id)
  expect(resultCamperIds).toEqual([survivingCamperId])
  expect(resultCamperIds).not.toContain(erasedCamperId)
  expect(result.campers[0].schedule.length).toBeGreaterThan(0)
}

describe('erasure-aware snapshot completeness across devices (board follow-up)', () => {
  it('order A: snapshot already projected on device B, THEN the tombstone arrives — export succeeds and excludes the erased camper', () => {
    const dbA = freshDb('a-orderA')
    const pub = installHostKey(dbA)
    const { runId, camper1, camper2 } = buildFinalizableRun(dbA)

    const finalizeResult = finalizeElectiveRun(dbA, { runId, deviceId: 'device-1' })
    expect(finalizeResult.ok).toBe(true)
    expect(finalizeResult.snapshotRows).toBe(2)

    let doc = createEmptyDoc()
    doc = writeFields(doc, 'campers', camper1, { camp_id: CAMP_ID, display_name: 'Camper One' })
    doc = writeFields(doc, 'campers', camper2, { camp_id: CAMP_ID, display_name: 'Camper Two' })
    const built = docFromFinalizedRun(doc, dbA, runId)
    doc = built.doc

    const dbB = freshDb('b-orderA')
    trustHostKey(dbB, pub)

    // Pass 1: the run and both campers' snapshot rows project normally — nothing erased yet.
    projectAll(dbB, doc)
    expect(dbB.prepare('SELECT camper_id FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId).map((r) => r.camper_id).sort())
      .toEqual([camper1, camper2].sort())

    // Pass 2: the tombstone for camper2 arrives.
    doc = tombstoneDoc(doc, dbA, { id: camper2, entity: 'campers', version: 1 })
    projectAll(dbB, doc)

    // (a) the erased camper's rows are gone from SQLite.
    const remaining = dbB.prepare('SELECT camper_id FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)
    expect(remaining.map((r) => r.camper_id)).toEqual([camper1])

    // (b) + (c)
    assertExportExcludesErasedCamper(dbB, runId, camper2, camper1)
  })

  it('order B: the tombstone is already applied, THEN a late peer writes snapshot ops for the erased camper — export succeeds and excludes the erased camper', () => {
    const dbA = freshDb('a-orderB')
    const pub = installHostKey(dbA)
    const { runId, camper1, camper2 } = buildFinalizableRun(dbA)

    const finalizeResult = finalizeElectiveRun(dbA, { runId, deviceId: 'device-1' })
    expect(finalizeResult.ok).toBe(true)

    const dbB = freshDb('b-orderB')
    trustHostKey(dbB, pub)

    // Pass 1: only camper2 + its tombstone exist on device B so far.
    let doc = createEmptyDoc()
    doc = writeFields(doc, 'campers', camper2, { camp_id: CAMP_ID, display_name: 'Camper Two' })
    doc = tombstoneDoc(doc, dbA, { id: camper2, entity: 'campers', version: 1 })
    projectAll(dbB, doc)
    expect(dbB.prepare('SELECT * FROM tombstones WHERE id = ?').get(camper2)).toBeTruthy()
    expect(dbB.prepare('SELECT * FROM campers WHERE id = ?').get(camper2)).toBeUndefined()

    // Pass 2: the late peer's write arrives — camper1 plus the run and all its snapshot rows,
    // including camper2's (the finalize ran before anyone knew camper2 would be erased).
    doc = writeFields(doc, 'campers', camper1, { camp_id: CAMP_ID, display_name: 'Camper One' })
    const built = docFromFinalizedRun(doc, dbA, runId)
    doc = built.doc
    projectAll(dbB, doc)

    // (a) camper2's snapshot rows never materialize (denylist gate at write time).
    const remaining = dbB.prepare('SELECT camper_id FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)
    expect(remaining.map((r) => r.camper_id)).toEqual([camper1])

    // (b) + (c)
    assertExportExcludesErasedCamper(dbB, runId, camper2, camper1)
  })

  // (d) anti-vacuity, at the cross-device level: a genuinely missing row for the SURVIVING camper
  // (no tombstone involved) must still fire SNAPSHOT_INCOMPLETE and refuse export. Proves the fix
  // did not just relax the comparison.
  it('a non-erased camper missing a row still fails SNAPSHOT_INCOMPLETE and the export builder refuses', () => {
    const dbA = freshDb('a-antivacuity')
    const pub = installHostKey(dbA)
    const { runId, camper1, camper2 } = buildFinalizableRun(dbA)
    expect(finalizeElectiveRun(dbA, { runId, deviceId: 'device-1' }).ok).toBe(true)

    let doc = createEmptyDoc()
    doc = writeFields(doc, 'campers', camper1, { camp_id: CAMP_ID, display_name: 'Camper One' })
    doc = writeFields(doc, 'campers', camper2, { camp_id: CAMP_ID, display_name: 'Camper Two' })
    const built = docFromFinalizedRun(doc, dbA, runId)
    doc = built.doc

    const dbB = freshDb('b-antivacuity')
    trustHostKey(dbB, pub)
    projectAll(dbB, doc)

    // No tombstone anywhere — camper1's row is independently lost (data loss, not erasure).
    const [camper1Row] = dbB.prepare('SELECT id FROM elective_run_outer_snapshots WHERE run_id = ? AND camper_id = ?').all(runId, camper1)
    dbB.prepare('DELETE FROM elective_run_outer_snapshots WHERE id = ?').run(camper1Row.id)

    const runRow = dbB.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
    const completeness = computeSnapshotCompleteness(dbB, runRow)
    expect(completeness.snapshotIncomplete).toBe(true)

    const { rows: outerRows } = getElectiveRunOuterSchedule(dbB, { runId })
    const campers = dbB.prepare('SELECT * FROM campers WHERE camp_id = ?').all(CAMP_ID)
    const run = { id: runId, name: runRow.name, status: runRow.status, ...completeness }
    const result = buildChildScheduleExport({ run, campers, outerRows })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('SNAPSHOT_INCOMPLETE')
  })

  // (g) write side: finalizeElectiveRun's stored snapshot_digest is a per-camper map built from
  // the SAME in-memory snapshots array it already derived — never a second read of
  // elective_run_outer_snapshots. Proven by reconstructing the expected map independently (from
  // the rows finalize itself inserted, the only faithful record of "what it derived") and
  // confirming it is byte-identical to what got stored, in the documented shape.
  it('finalize writes a per-camper digest map matching the rows it derived, not a re-read of the table', () => {
    const db = freshDb('g-writeside')
    const { runId } = buildFinalizableRun(db)
    expect(finalizeElectiveRun(db, { runId, deviceId: 'device-1' }).ok).toBe(true)

    const runRow = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
    const insertedRows = db.prepare('SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)

    expect(runRow.snapshot_digest).not.toMatch(/^[0-9a-f]{64}$/) // not the legacy whole-set shape
    const parsed = JSON.parse(runRow.snapshot_digest)
    const expected = JSON.parse(computeExpectedSnapshotDigestByCamper(insertedRows))
    expect(parsed).toEqual(expected)
    expect(Object.values(parsed).reduce((sum, e) => sum + e.rows, 0)).toBe(runRow.snapshot_expected_rows)
  })
})
