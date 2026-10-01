// @vitest-environment node
//
// Board q-freeze-pr-residuals (2) — the elective acceptance suite never
// exercised the real Automerge dual-write: without `liveDoc.setUserDataDirGetter`
// wired, `applyLocalWriteNow` returns inert at liveDoc.js's "not wired yet"
// guard and the document is never touched. That is why the suite stayed green
// while commit/finalize froze electron:dev for 5-6 minutes on an O(n^2)
// document replay (fixed in #693 via `DOC_CHANGE_CHUNK=250` in
// electron/sync/automerge/liveDoc.js). This file drives the REAL dual-write
// through commitElectiveRun/finalizeElectiveRun at two camper-count sizes and
// asserts the per-op finalize document-flush cost stays sub-quadratic.
//
// Mirrors electron/electiveRunFinalize.integration.test.js's harness
// (electron mock, openTemplatedDb/makeHandlers, real appendOp) and
// scripts/electiveFreezePerf.mjs's fixture shape (one group/tier/elective-set/
// offering/template_slots cell, N campers, `process.cpuUsage()` deltas) —
// reused directly rather than reinvented.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { getOrCreateDeviceId } from './db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'
import { deriveElectiveOccurrenceId } from './ops/electiveDerivedIds.js'
import * as liveDoc from './sync/automerge/liveDoc.js'
import { recordKey } from './automerge/campDocument.js'
import { SYNC_ENGINE } from './sync/automerge/syncEngineFlag.js'

// Cleanup is per-cell (own db + own doc dir), queued here rather than relied
// on at the end of the measurement loop — a thrown assertion mid-loop must
// not leak a tmp dir or a half-open db handle, since this suite runs inside
// `npm run test`, not a throwaway script.
let pendingCleanups = []

afterEach(() => {
  while (pendingCleanups.length > 0) {
    const fn = pendingCleanups.pop()
    try {
      fn()
    } catch {
      // best-effort — a failed cleanup must not mask the real test failure
    }
  }
  cleanupTemplatedDbs()
})

// One (camp, device, elective run) cell at a given camper count, driven
// through the REAL production handlers with the Automerge dual-write wired
// live (liveDoc.resetForTests + setUserDataDirGetter BEFORE any write — the
// one line that makes applyLocalWriteNow stop being inert). Returns the
// finalize-phase cpuUsage delta plus the snapshot row count (== ops applied),
// having already asserted correctness and dual-write coverage for this cell.
async function runCell(size) {
  if (SYNC_ENGINE !== 'automerge') {
    throw new Error(`expected the default automerge engine, got ${SYNC_ENGINE} — unset SHORESH_SYNC_ENGINE`)
  }

  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-dualwrite-'))
  liveDoc.resetForTests()
  liveDoc.setUserDataDirGetter(() => docDir)

  const templated = openTemplatedDb()
  const db = templated.db
  pendingCleanups.push(() => {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(templated.file + suffix)) fs.unlinkSync(templated.file + suffix)
    }
    fs.rmSync(docDir, { recursive: true, force: true })
  })

  const deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)

  const hostKey = ensureHostSigningKey(db)
  // Same interpolation-is-unavoidable shape as electiveFreezePerf.mjs: a
  // trigger body cannot bind a parameter, and the value is locally generated
  // hex, never caller-supplied.
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS trg_dualwrite_set_signing_public_key
    AFTER INSERT ON camps WHEN NEW.signing_public_key IS NULL
    BEGIN UPDATE camps SET signing_public_key = '${hostKey.public_key}' WHERE id = NEW.id; END;
  `)

  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Fixture', 'a'.repeat(64))
  await createUser(
    db,
    { camp_id: campId, name: 'Director', pin: '123400', role: 'admin' },
    async ({ entity, entity_id, field, value }) => ({
      status: 'applied',
      op: appendOp(db, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null }),
    })
  )
  const handlers = makeHandlers(db, deviceId, {})
  const { token } = await handlers.login({ name: 'Director', pin: '123400' })

  const fx = {
    groupId: randomUUID(), tierId: randomUUID(), setId: randomUUID(),
    activityId: randomUUID(), locationId: randomUUID(),
    dayId: 'day-1', timeBlockId: 'tb-1', templateId: 'tpl-1',
  }
  db.prepare('INSERT INTO tiers (id, camp_id, name) VALUES (?, ?, ?)').run(fx.tierId, campId, 'Bogrim')
  db.prepare('INSERT INTO groups (id, camp_id, name, tier_id) VALUES (?, ?, ?, ?)').run(fx.groupId, campId, 'Bogrim A', fx.tierId)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, ?)').run(fx.locationId, campId, 'Field', 10000)
  db.prepare('INSERT INTO activities (id, camp_id, name, location_id, span_blocks) VALUES (?, ?, ?, ?, 1)').run(fx.activityId, campId, 'Archery', fx.locationId)
  db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(fx.setId, campId, 'AM Electives')
  db.prepare('INSERT INTO elective_set_activities (id, elective_set_id, activity_id, capacity_mode, capacity_limit) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), fx.setId, fx.activityId, 'unlimited', null)
  db.prepare('INSERT INTO template_slots (id, template_id, group_id, elective_set_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), fx.templateId, fx.groupId, fx.setId, fx.dayId, fx.timeBlockId)

  const runId = randomUUID()
  const occurrenceId = deriveElectiveOccurrenceId(runId, fx.setId, fx.dayId, fx.timeBlockId, fx.tierId)
  const campers = Array.from({ length: size }, (_, i) => ({ id: randomUUID(), name: `Camper ${i}` }))
  const parsed = {
    campers: campers.map((c) => ({ id: c.id, display_name: c.name, external_id: null })),
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: campers.map((c) => ({ camper_id: c.id, occurrence_id: occurrenceId, label: 'Archery', labelKey: 'archery', rank: 1 })),
    sameNameCampers: [], skippedRows: [],
  }
  const assignments = campers.map((c) => ({
    camper_id: c.id, occurrence_id: occurrenceId, labelKey: 'archery',
    activity_id: fx.activityId, preference_rank: 1, flags: [],
  }))
  const occurrences = [{ id: occurrenceId, elective_set_id: fx.setId, day_id: fx.dayId, time_block_id: fx.timeBlockId, tier_id: fx.tierId }]

  const commit = await handlers.commitElectiveRun({
    token, name: 'Week 1 electives', parsed, assignments, occurrences,
    scheduleTemplateId: fx.templateId, runId,
  })
  expect(commit.ok).toBe(true)

  const cpu0 = process.cpuUsage()
  const finalize = await handlers.finalizeElectiveRun({ token, runId })
  const cpu = process.cpuUsage(cpu0)
  expect(finalize.ok).toBe(true)

  const snapshotRows = finalize.snapshotRows
  expect(snapshotRows).toBe(size)

  // Correctness at this size — mirrors electiveRunFinalize.integration.test.js
  // case 1: the run flips to 'final' and SQLite holds exactly the snapshot
  // rows finalize reports.
  const runRow = db.prepare('SELECT status FROM elective_assignment_runs WHERE id = ?').get(runId)
  expect(runRow.status).toBe('final')
  const sqliteSnapshotCount = db.prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?').get(runId).c
  expect(sqliteSnapshotCount).toBe(snapshotRows)

  // Dual-write coverage — the gap this file exists to close. A "fast because
  // it did nothing" regression (e.g. userDataDirGetter silently unset again)
  // must fail HERE, not just look fast on the cpu/op ratio below.
  const doc = liveDoc.getCurrentDoc(db)
  expect(doc).toBeTruthy()
  const firstSnapshotId = db.prepare('SELECT id FROM elective_run_outer_snapshots WHERE run_id = ? LIMIT 1').get(runId).id
  const docCamperId = doc.elective_run_outer_snapshots?.[recordKey(firstSnapshotId, 'camper_id')]
  expect(docCamperId).toBeTruthy()

  return { user: cpu.user, system: cpu.system, cpu: cpu.user + cpu.system, ops: snapshotRows }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

describe('elective acceptance: real Automerge dual-write through commit+finalize', () => {
  // N=120 / M=480 (4x) per the board brief, measured and confirmed below (see
  // docs/work/runs/2026-10-01-dual-write-acceptance-cpu-bound.md for the
  // actual interleaved numbers this K was chosen against): on current main
  // (DOC_CHANGE_CHUNK=250, flat cost per #693) the measured per-op ratio sits
  // close to 1x; an unbounded-chunk quadratic regression reproduces #693's
  // own measured ~4-8x at this size ratio. K=2.5 passes the former with real
  // margin and fails the latter clearly.
  const N = 120
  const M = 480
  const K = 2.5
  const REPS = 3

  it('finalize cpu/op does not grow superlinearly from N to M campers (sub-quadratic document flush)', async () => {
    const bySize = { [N]: [], [M]: [] }

    // Interleave which size runs first across reps — same reasoning as
    // scripts/electiveFreezePerf.mjs's engine interleave, applied to size
    // instead of engine since there is only one engine live here: a block of
    // same-size runs measures this machine's mood, not the code.
    for (let rep = 0; rep < REPS; rep += 1) {
      const order = rep % 2 === 0 ? [N, M] : [M, N]
      for (const size of order) {
        const result = await runCell(size)
        bySize[size].push(result)
      }
    }

    const perOp = (rows) => rows.map((r) => r.cpu / r.ops)
    const perOpN = median(perOp(bySize[N]))
    const perOpM = median(perOp(bySize[M]))
    const ratio = perOpM / perOpN

    console.log(
      `[dual-write cpu/op] N=${N} median=${perOpN.toFixed(1)}µs/op ` +
      `(${perOp(bySize[N]).map((v) => v.toFixed(1)).join(', ')}); ` +
      `M=${M} median=${perOpM.toFixed(1)}µs/op ` +
      `(${perOp(bySize[M]).map((v) => v.toFixed(1)).join(', ')}); ratio=${ratio.toFixed(2)}x (K=${K})`
    )

    expect(ratio).toBeLessThanOrEqual(K)
  }, 600000)
})
