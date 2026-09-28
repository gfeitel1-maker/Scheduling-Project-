import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCampDataRecordWriter } from './campDataRecord.js'
import { listEntities } from './ops/read.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'

function fakeDb(campRow = { id: 'camp1', name: 'Camp Bear' }) {
  return {
    prepare: () => ({ get: () => campRow }),
  }
}

function fakeListEntities(_db, entity) {
  // Round 2 FIX 1 regression guard: the real listEntities(db, 'camps') throws
  // ("Unrecognized entity: camps") — camps is neither in DIRECT_CAMP_ENTITIES
  // nor PARENT_SCOPED_ENTITIES. The writer must never route 'camps' through
  // this function; it builds entities.camps from its own camp-row query
  // instead. This fake reproduces the real throw so a regression here fails
  // loudly instead of silently no-oping like the original bug did.
  if (entity === 'camps') throw new Error(`Unrecognized entity: ${entity}`)
  return []
}

describe('createCampDataRecordWriter — real listEntities seam', () => {
  afterEach(() => {
    cleanupTemplatedDbs()
  })

  it('fireOnce (via a real db + the REAL listEntities) never throws for any entity the writer reads', () => {
    const { db } = openTemplatedDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp Bear', 'sec')").run()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campdata-real-'))
    const writer = createCampDataRecordWriter({
      db, documentsDir: tmpDir, isDev: false, debounceMs: 0,
      listEntitiesFn: listEntities, // the REAL seam, not a mock — this is what round 1 bypassed
    })

    expect(() => writer.flush()).not.toThrow()
    // flush() with nothing scheduled is a no-op (see its own test below), so drive it through
    // schedule()+flush() to force an immediate real fireOnce.
    writer.schedule()
    expect(() => writer.flush()).not.toThrow()

    const target = path.join(tmpDir, 'Shoresh', 'Camp Bear data.xlsx')
    expect(fs.existsSync(target)).toBe(true)

    fs.rmSync(tmpDir, { recursive: true, force: true })
    db.close()
  })
})

describe('createCampDataRecordWriter', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campdata-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('coalesces several rapid schedule() calls into exactly one write after the debounce settles', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    writer.schedule()
    writer.schedule()
    expect(buildFn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(buildFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledTimes(1)

    const target = path.join(tmpDir, 'Shoresh', 'Camp Bear data.xlsx')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('does not drop the last change: a schedule() call after a write starts still results in a follow-up write', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(buildFn).toHaveBeenCalledTimes(1)

    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(buildFn).toHaveBeenCalledTimes(2)
  })

  it('a write failure does not throw out of schedule(), and a subsequent schedule() retries', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    let shouldFail = true
    const writeFn = vi.fn(() => {
      if (shouldFail) {
        const err = new Error('EACCES: permission denied')
        err.code = 'EACCES'
        throw err
      }
      return Buffer.from('fake-xlsx')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    expect(() => writer.schedule()).not.toThrow()
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.not.toThrow()

    const target = path.join(tmpDir, 'Shoresh', 'Camp Bear data.xlsx')
    expect(fs.existsSync(target)).toBe(false)
    expect(errorSpy).toHaveBeenCalled()

    shouldFail = false
    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fs.existsSync(target)).toBe(true)

    errorSpy.mockRestore()
  })

  it('appends a (dev) suffix to the filename when isDev is true', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: true, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)

    const target = path.join(tmpDir, 'Shoresh', 'Camp Bear data (dev).xlsx')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('writes atomically: no partial file is ever left at the final path, and the temp file is cleaned up on failure', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => {
      const err = new Error('EBUSY: resource busy')
      err.code = 'EBUSY'
      throw err
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)

    const shoreshDir = path.join(tmpDir, 'Shoresh')
    const leftoverFiles = fs.existsSync(shoreshDir) ? fs.readdirSync(shoreshDir) : []
    expect(leftoverFiles.filter((f) => f.includes('.tmp'))).toEqual([])
    expect(leftoverFiles.filter((f) => f.endsWith('data.xlsx'))).toEqual([])

    errorSpy.mockRestore()
  })

  it('no-ops when no camp exists yet, without throwing', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(null), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    await vi.advanceTimersByTimeAsync(1000)

    expect(buildFn).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(tmpDir, 'Shoresh'))).toBe(false)
  })

  it('flush() writes immediately with the latest data when a write is pending, bypassing the debounce', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 5000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    expect(buildFn).not.toHaveBeenCalled()

    writer.flush()

    expect(buildFn).toHaveBeenCalledTimes(1)
    const target = path.join(tmpDir, 'Shoresh', 'Camp Bear data.xlsx')
    expect(fs.existsSync(target)).toBe(true)

    // The debounce timer flush() bypassed must not ALSO fire later.
    await vi.advanceTimersByTimeAsync(5000)
    expect(buildFn).toHaveBeenCalledTimes(1)
  })

  it('flush() is a safe no-op when nothing is pending', () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    expect(() => writer.flush()).not.toThrow()
    expect(buildFn).not.toHaveBeenCalled()
  })

  it('dispose() cancels a pending debounced write', async () => {
    const buildFn = vi.fn(() => ({ __wb: true }))
    const writeFn = vi.fn(() => Buffer.from('fake-xlsx'))
    const writer = createCampDataRecordWriter({
      db: fakeDb(), documentsDir: tmpDir, isDev: false, debounceMs: 1000,
      listEntitiesFn: fakeListEntities, buildFn, writeFn,
    })

    writer.schedule()
    writer.dispose()
    await vi.advanceTimersByTimeAsync(2000)

    expect(buildFn).not.toHaveBeenCalled()
  })
})
