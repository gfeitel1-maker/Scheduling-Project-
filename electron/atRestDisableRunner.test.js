// @vitest-environment node
// T345 runner: the ORDER of the quiesce steps is the safety property (a late document save after the key
// is shredded re-encrypts the document under a dead key). The primitives are tested elsewhere; this pins
// that the runner calls them in the right sequence and recovers when any step fails.
import { describe, it, expect } from 'vitest'
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
    restart: (ms) => order.push(`restart:${ms}`),
    log: () => {},
  })
  return { order, runner }
}

describe('createAtRestDisableRunner', () => {
  it('quiesces in order: flush, stop sync, flush again, block saves, close db, disable, then restart', async () => {
    const { order, runner } = harness()
    expect(await runner()).toEqual({ ok: true, restarting: true, warnings: ['w'] })
    expect(order).toEqual(['flush', 'shutdown', 'flush', 'suspend:true', 'close', 'list', 'disable:/a.sqlite', 'restart:1500'])
  })

  it('a failing first flush does not stop the disable (it is logged, the later flush still runs)', async () => {
    const order = []
    let n = 0
    const runner = createAtRestDisableRunner({
      flushDoc: () => { order.push('flush'); if (++n === 1) throw new Error('disk') },
      shutdownSync: async () => { order.push('shutdown') },
      suspendDocSaves: (on) => order.push(`suspend:${on}`),
      closeDb: () => order.push('close'),
      listDbPaths: () => [],
      disable: () => { order.push('disable'); return { warnings: [] } },
      restart: (ms) => order.push(`restart:${ms}`),
      log: () => {},
    })
    expect((await runner()).ok).toBe(true)
    expect(order).toEqual(['flush', 'shutdown', 'flush', 'suspend:true', 'close', 'disable', 'restart:1500'])
  })

  it('sync shutdown failing never reaches the disable and leaves saves enabled', async () => {
    const { order, runner } = harness({ shutdown: async () => { order.push('shutdown'); throw new Error('stuck') } })
    const res = await runner()
    expect(res).toMatchObject({ ok: false, error: 'disable_failed', restarting: true })
    expect(order).toEqual(['flush', 'shutdown', 'suspend:false', 'restart:5000'])
  })

  it('a failed disable re-enables doc saves, reports the code in plain words and restarts', async () => {
    const { order, runner } = harness({
      disable: () => { throw Object.assign(new Error('Encryption was not changed: x'), { code: 'rekey_failed' }) },
    })
    const res = await runner()
    expect(res).toEqual({ ok: false, error: 'rekey_failed', message: 'Encryption was not changed: x', restarting: true })
    expect(order).toEqual(['flush', 'shutdown', 'flush', 'suspend:true', 'close', 'list', 'suspend:false', 'restart:5000'])
  })

  it('electron/main.js builds its runner from this module, not an inline copy', () => {
    const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js'), 'utf8')
    expect(main).toMatch(/setAtRestDisableRunner\(createAtRestDisableRunner\(/)
  })
})
