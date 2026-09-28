import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCampDataRecordWriter } from './campDataRecord.js'

function fakeDb(campRow = { id: 'camp1', name: 'Camp Bear' }) {
  return {
    prepare: () => ({ get: () => campRow }),
  }
}

function fakeListEntities() {
  return []
}

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
