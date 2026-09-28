// @vitest-environment node
//
// T292 round-2 follow-up (Red Hat MEDIUM, "Findings carried forward" in
// docs/work/runs/2026-09-28-t292-camp-data-record-self-maintaining-workbook.md).
//
// Three camp-data-record wirings in electron/main.js had no regression test, so
// a future refactor could silently reintroduce a round-1-class data-loss bug
// with a green gate:
//
//   1. will-quit flush — app.on('will-quit') must flush the still-pending
//      debounced camp-data write, or the last edit is lost on quit.
//   2. writer-listener registration order — in wireOpApplied(), the writer's
//      onOpApplied listener must be registered BEFORE the renderer-push
//      listener, because notifyOpApplied (localWriteClient.js) has no
//      per-listener try/catch: a throwing earlier listener starves later ones.
//   3. reinitialize()/restore dispose — both must dispose the camp-data writer
//      BEFORE db.close(), so the writer's pending timer can't fire against a
//      closed db handle.
//
// Wirings 1 and 3 live in the non-exported Electron entry-point IIFE, which
// never runs under Vitest. They were lifted into two exported helpers
// (flushCampDataRecordOnQuit, disposeCampDataRecordThenCloseDb) so the
// mechanism is behaviorally testable; two structural checks then confirm the
// three call sites route through those helpers (so an inline reorder/drop still
// trips a gate). Wiring 2 is reachable through makeHandlers and gets a genuine
// behavioral test that plants the starvation defect.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

// Same wrap-the-real-thing shape as electron/main.test.js: the real local write
// path (and its real notifyOpApplied fan-out, which has NO per-listener
// try/catch — the property wiring 2 depends on) runs unchanged, while
// lastCreatedSyncClient exposes the client so a test can drive a write.
let lastCreatedSyncClient
vi.mock('./sync/localWriteClient.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    createLocalWriteClient: vi.fn((mockDb, opts) => {
      const real = actual.createLocalWriteClient(mockDb, opts)
      const client = {
        opts,
        write: vi.fn(real.write),
        writeBulkReplace: vi.fn(real.writeBulkReplace),
        onOpApplied: vi.fn(real.onOpApplied),
        onOpConflict: vi.fn(real.onOpConflict),
        onOpRejected: vi.fn(real.onOpRejected),
        onFullSyncApplied: vi.fn(real.onFullSyncApplied),
        getQueuedOps: vi.fn(real.getQueuedOps),
        getPendingRestores: vi.fn(real.getPendingRestores),
        drainPendingRestores: vi.fn(real.drainPendingRestores),
        flushQueue: vi.fn(real.flushQueue),
      }
      lastCreatedSyncClient = client
      return client
    }),
  }
})

// Default engine to Automerge (matches main.test.js) so appendOp's op-log-only
// side effects stay off during the wiring-2 write.
vi.mock('./sync/automerge/syncEngineFlag.js', () => ({
  isAutomergeEngine: vi.fn(() => true),
  isOpLogEngine: vi.fn(() => false),
}))

// Replace the real camp-data writer with a spy triple so wiring 2 can observe
// schedule() without touching a real filesystem. Behavior of schedule/flush/
// dispose themselves is unit-tested in campDataRecord.test.js; here they are
// only signals.
let lastCampDataWriter
vi.mock('./campDataRecord.js', () => ({
  createCampDataRecordWriter: vi.fn(() => {
    lastCampDataWriter = {
      schedule: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    }
    return lastCampDataWriter
  }),
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import {
  makeHandlers,
  flushCampDataRecordOnQuit,
  disposeCampDataRecordThenCloseDb,
} from './main.js'

let db
let tmpFile
let deviceId

beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  tmpFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(deviceId, os.hostname())
  db.prepare(
    "UPDATE devices SET authorized_at = ?, device_secret_identifier = ?, pairing_status = 'authorized' WHERE id = ?"
  ).run(new Date().toISOString(), randomBytes(32).toString('hex'), deviceId)
  vi.clearAllMocks()
  lastCreatedSyncClient = undefined
  lastCampDataWriter = undefined
})

afterEach(() => {
  try { db.close() } catch { /* may be closed by a test */ }
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

// --------------------------------------------------------------------------
// Wiring 2 — writer-listener registered BEFORE the renderer-push listener.
// --------------------------------------------------------------------------
describe('wiring 2: a throwing renderer-push listener does not starve the writer', () => {
  it('still schedules the camp-data writer when the renderer-push listener throws on the same op', async () => {
    // getMainWindow returns a window whose webContents.send throws — this is
    // exactly what the second (renderer-push) onOpApplied listener does with
    // each op. notifyOpApplied has no per-listener try/catch, so if the writer
    // listener were registered AFTER this one it would never run.
    const handlers = makeHandlers(db, deviceId, {
      getMainWindow: () => ({
        webContents: { send: () => { throw new Error('renderer push blew up') } },
      }),
    })
    // chooseMode wires the op-applied listeners (writer first, push second) via
    // wireOpApplied(), and fires one immediate schedule().
    await handlers.chooseMode({ mode: 'client' })
    expect(lastCampDataWriter).toBeTruthy()

    // Seed the minimal valid parent rows so a real groups.name edit applies to
    // the SQLite projection (the devices row is seeded in beforeEach). Without
    // this the write would throw on a projection FK before ever reaching
    // notifyOpApplied — a throw for the wrong reason.
    const campId = randomUUID()
    const groupId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(groupId, campId, 'Group A')

    const before = lastCampDataWriter.schedule.mock.calls.length

    // Drive a real local write through the real notifyOpApplied fan-out. The
    // push listener throws, which propagates out of write() — caught here — but
    // the writer listener, registered first, has already run.
    let threw = false
    try {
      await lastCreatedSyncClient.write({
        entity: 'groups',
        entity_id: groupId,
        field: 'name',
        value: 'Group B',
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true) // proves the push listener really threw
    expect(lastCampDataWriter.schedule.mock.calls.length).toBeGreaterThan(before)
  })
})

// --------------------------------------------------------------------------
// Wiring 1 — will-quit flushes the pending debounced write.
// --------------------------------------------------------------------------
describe('wiring 1: flushCampDataRecordOnQuit', () => {
  it('invokes flushCampDataRecord on the live handlers', () => {
    const liveHandlers = { flushCampDataRecord: vi.fn() }
    flushCampDataRecordOnQuit(liveHandlers)
    expect(liveHandlers.flushCampDataRecord).toHaveBeenCalledTimes(1)
  })

  it('never throws out of the quit path when the flush itself throws', () => {
    const liveHandlers = {
      flushCampDataRecord: vi.fn(() => { throw new Error('disk full') }),
    }
    expect(() => flushCampDataRecordOnQuit(liveHandlers)).not.toThrow()
    expect(liveHandlers.flushCampDataRecord).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there are no live handlers yet', () => {
    expect(() => flushCampDataRecordOnQuit(null)).not.toThrow()
    expect(() => flushCampDataRecordOnQuit(undefined)).not.toThrow()
    expect(() => flushCampDataRecordOnQuit({})).not.toThrow()
  })
})

// --------------------------------------------------------------------------
// Wiring 3 — dispose the writer BEFORE closing the db.
// --------------------------------------------------------------------------
describe('wiring 3: disposeCampDataRecordThenCloseDb', () => {
  it('disposes the writer BEFORE closing the db', () => {
    const order = []
    const liveHandlers = { disposeCampDataRecord: vi.fn(() => order.push('dispose')) }
    const oldDb = { close: vi.fn(() => order.push('close')) }

    disposeCampDataRecordThenCloseDb(liveHandlers, oldDb)

    expect(order).toEqual(['dispose', 'close'])
    expect(liveHandlers.disposeCampDataRecord).toHaveBeenCalledTimes(1)
    expect(oldDb.close).toHaveBeenCalledTimes(1)
  })

  it('still closes the db even if dispose throws', () => {
    const liveHandlers = {
      disposeCampDataRecord: vi.fn(() => { throw new Error('dispose failed') }),
    }
    const oldDb = { close: vi.fn() }

    expect(() => disposeCampDataRecordThenCloseDb(liveHandlers, oldDb)).not.toThrow()
    expect(oldDb.close).toHaveBeenCalledTimes(1)
  })

  it('closes the db even when there are no live handlers yet', () => {
    const oldDb = { close: vi.fn() }
    expect(() => disposeCampDataRecordThenCloseDb(null, oldDb)).not.toThrow()
    expect(oldDb.close).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the db is already closed', () => {
    const liveHandlers = { disposeCampDataRecord: vi.fn() }
    const oldDb = { close: vi.fn(() => { throw new Error('already closed') }) }
    expect(() => disposeCampDataRecordThenCloseDb(liveHandlers, oldDb)).not.toThrow()
    expect(liveHandlers.disposeCampDataRecord).toHaveBeenCalledTimes(1)
  })
})

// --------------------------------------------------------------------------
// Structural guard — the three call sites route through the helpers, so an
// inline reorder or drop at a call site trips this gate even though the IIFE
// itself never runs under Vitest. This is deliberately a source-level check:
// the wiring lives in the non-exported entry-point IIFE and has no other
// reachable seam. It complements — does not replace — the behavioral helper
// tests above, which pin the ordering/swallowing the helpers must provide.
// --------------------------------------------------------------------------
describe('wiring call sites route through the exported helpers', () => {
  const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')

  function region(startRe, endRe) {
    const start = source.search(startRe)
    expect(start, `start marker ${startRe} not found in main.js`).toBeGreaterThanOrEqual(0)
    const rest = source.slice(start)
    const endRel = rest.slice(1).search(endRe)
    const end = endRel >= 0 ? start + 1 + endRel : source.length
    return source.slice(start, end)
  }

  it('will-quit flushes via flushCampDataRecordOnQuit', () => {
    const willQuit = region(/app\.on\(\s*['"]will-quit['"]/, /app\.on\(|\n\s*\}\)\s*\n\s*\}\s*catch/)
    expect(willQuit).toContain('flushCampDataRecordOnQuit(liveHandlers)')
  })

  it('reinitialize disposes-then-closes via disposeCampDataRecordThenCloseDb', () => {
    const reinit = region(/function reinitialize\s*\(/, /ipcMain\.handle\(\s*['"]shoresh:get-current-project['"]/)
    expect(reinit).toContain('disposeCampDataRecordThenCloseDb(liveHandlers, db)')
  })

  it('restore-project disposes-then-closes via disposeCampDataRecordThenCloseDb', () => {
    const restore = region(
      /ipcMain\.handle\(\s*['"]shoresh:restore-project['"]/,
      /ipcMain\.handle\(\s*['"]shoresh:list-recent-projects['"]/
    )
    expect(restore).toContain('disposeCampDataRecordThenCloseDb(liveHandlers, db)')
  })
})

// Discard the cached template only after every test in this file has run.
afterAll(() => {
  cleanupTemplatedDbs()
})
