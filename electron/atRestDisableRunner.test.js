// @vitest-environment node
// T345 runner: the ORDER of the quiesce steps is the safety property (a late document save after the key
// is shredded re-encrypts the document under a dead key). The primitives are tested elsewhere; this pins
// that the runner calls them in the right sequence and recovers when any step fails.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAtRestDisableRunner } from './atRestDisableRunner.js'

function harness({ shutdown, disable } = {}) {
  const order = []
  const runner = createAtRestDisableRunner({
    flushDoc: () => order.push('flush'),
    shutdownSync: shutdown ?? (async () => { order.push('shutdown') }),
    suspendDocSaves: (on) => order.push(`suspend:${on}`),
    closeDb: () => order.push('close'),
    listDbPaths: () => { order.push('list'); return ['/a.sqlite'] },
    disable: disable ?? ((args) => { order.push(`disable:${args.dbPaths.join(',')}`); return { disabled: true, warnings: ['w'] } }),
    endSessions: () => order.push('end-sessions'),
    restart: (ms) => order.push(`restart:${ms}`),
    log: () => {},
  })
  return { order, runner }
}

describe('createAtRestDisableRunner', () => {
  it('quiesces in order: flush, stop sync, flush again, block saves, close db, disable, then restart', async () => {
    const { order, runner } = harness()
    expect(await runner()).toEqual({ ok: true, restarting: true, warnings: ['w'] })
    expect(order).toEqual(['flush', 'shutdown', 'flush', 'suspend:true', 'close', 'list', 'disable:/a.sqlite', 'end-sessions', 'restart:1500'])
  })

  it('sync shutdown failing never reaches the disable and never suspended saves', async () => {
    const { order, runner } = harness({ shutdown: async () => { order.push('shutdown'); throw new Error('stuck') } })
    const res = await runner()
    expect(res).toMatchObject({ ok: false, error: 'disable_failed', restarting: true })
    expect(order).toEqual(['flush', 'shutdown', 'restart:5000'])
  })

  it('a failed disable keeps doc saves blocked until the restart, reports the code in plain words and restarts', async () => {
    const { order, runner } = harness({
      disable: () => { throw Object.assign(new Error('Encryption was not changed: x'), { code: 'rekey_failed' }) },
    })
    const res = await runner()
    expect(res).toEqual({ ok: false, error: 'rekey_failed', message: 'Encryption was not changed: x', restarting: true })
    expect(order).toEqual(['flush', 'shutdown', 'flush', 'suspend:true', 'close', 'list', 'restart:5000'])
  })

  it('electron/main.js builds its runner from this module, not an inline copy', () => {
    const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js'), 'utf8')
    expect(main).toMatch(/setAtRestDisableRunner\(createAtRestDisableRunner\(/)
  })
})

describe('createAtRestDisableRunner: a flush that failed refuses the disable', () => {
  for (const failing of [1, 2]) {
    it(`flush #${failing} failing leaves encryption on and never closes the db`, async () => {
      const order = []
      let n = 0
      const runner = createAtRestDisableRunner({
        flushDoc: () => { if (++n === failing) throw new Error('disk') },
        shutdownSync: async () => { order.push('shutdown') },
        suspendDocSaves: (on) => order.push(`suspend:${on}`),
        closeDb: () => order.push('close'),
        listDbPaths: () => [],
        disable: () => { order.push('disable'); return { warnings: [] } },
        restart: (ms) => order.push(`restart:${ms}`),
        log: () => {},
      })
      const res = await runner()
      expect(res.ok).toBe(false)
      expect(order).not.toContain('disable')
      expect(order).not.toContain('close')
    })
  }
})

describe('boundedSyncStop (the runner\'s sync stop: close() raced against 10s)', () => {
  it('resolves when close() settles in time', async () => {
    const { boundedSyncStop } = await import('./atRestDisableRunner.js')
    await expect(boundedSyncStop(async () => 'stopped', 10000)).resolves.toBe('stopped')
  })

  it('rejects with sync_stop_timeout when close() never settles, so the screen cannot stick on working', async () => {
    const { boundedSyncStop } = await import('./atRestDisableRunner.js')
    vi.useFakeTimers()
    try {
      const p = boundedSyncStop(() => new Promise(() => {}), 10000)
      const caught = p.catch((e) => e)
      await vi.advanceTimersByTimeAsync(9999)
      let settled = false
      caught.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await caught).toMatchObject({ code: 'sync_stop_timeout', message: expect.stringMatching(/sync did not stop in time/) })
    } finally { vi.useRealTimers() }
  })

  it('the timeout rejection fails the runner before the db is closed or anything is decrypted', async () => {
    const { boundedSyncStop } = await import('./atRestDisableRunner.js')
    vi.useFakeTimers()
    try {
      const order = []
      const runner = createAtRestDisableRunner({
        flushDoc: () => order.push('flush'),
        shutdownSync: () => boundedSyncStop(() => new Promise(() => {}), 10000),
        suspendDocSaves: () => order.push('suspend'),
        closeDb: () => order.push('close'),
        listDbPaths: () => [],
        disable: () => order.push('disable'),
        restart: (ms) => order.push(`restart:${ms}`),
        log: () => {},
      })
      const p = runner()
      await vi.advanceTimersByTimeAsync(10000)
      expect(await p).toMatchObject({ ok: false, error: 'sync_stop_timeout', restarting: true })
      expect(order).toEqual(['flush', 'restart:5000'])
    } finally { vi.useRealTimers() }
  })

  it('main.js uses it with the holder close()', () => {
    const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js'), 'utf8')
    expect(main).toMatch(/shutdownSync: \(\) => boundedSyncStop\(\(\) => syncStarterHolder\.close\(\), 10000\)/)
  })
})
