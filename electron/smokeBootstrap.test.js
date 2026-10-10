// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { smokeBootstrapRequested, runSmokeBootstrap } from './smokeBootstrap.js'

describe('smokeBootstrapRequested', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pkg-smoke-'))
  const env = { SHORESH_SMOKE_NONCE: 'n', SHORESH_SMOKE_BOOTSTRAP: '1', SHORESH_SMOKE_PIN: '123456', SHORESH_SMOKE_USERDATA: dir }
  const ok = { env, isPackaged: true, userDataPath: dir }

  it('is true only when every condition holds', () => {
    expect(smokeBootstrapRequested(ok)).toBe(true)
  })
  it('needs the nonce, the flag and a pin', () => {
    for (const k of ['SHORESH_SMOKE_NONCE', 'SHORESH_SMOKE_BOOTSTRAP', 'SHORESH_SMOKE_PIN']) {
      expect(smokeBootstrapRequested({ ...ok, env: { ...env, [k]: '' } })).toBe(false)
    }
  })
  it('is false when bootstrap vars are set without SHORESH_SMOKE_USERDATA', () => {
    expect(smokeBootstrapRequested({ ...ok, env: { ...env, SHORESH_SMOKE_USERDATA: undefined } })).toBe(false)
  })
  it('is false when not packaged', () => {
    expect(smokeBootstrapRequested({ ...ok, isPackaged: false })).toBe(false)
  })
  it('is false when userData is not the smoke path', () => {
    expect(smokeBootstrapRequested({ ...ok, userDataPath: path.join(os.homedir(), 'Library', 'Application Support', 'shoresh') })).toBe(false)
  })
  it('is false when the path is not under tmpdir with the smoke prefix', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'))
    expect(smokeBootstrapRequested({ env: { ...env, SHORESH_SMOKE_USERDATA: elsewhere }, isPackaged: true, userDataPath: elsewhere })).toBe(false)
    expect(smokeBootstrapRequested({ ...ok, tmpdir: '/somewhere/else' })).toBe(false)
  })
})

describe('runSmokeBootstrap', () => {
  const make = (node, camps = 0) => {
    const calls = []
    return {
      calls,
      db: { prepare: () => ({ get: () => ({ n: camps }) }) },
      handlers: { chooseMode: vi.fn((a) => calls.push(['chooseMode', a.mode])), bootstrapCamp: vi.fn(async () => { calls.push(['bootstrapCamp']) }) },
      holder: { start: vi.fn(async () => { calls.push(['start']) }), getNode: () => node },
      writeSyncMarker: vi.fn(() => calls.push(['marker'])),
    }
  }
  const run = (m) => runSmokeBootstrap({ db: m.db, pin: '123456', handlers: m.handlers, syncStarterHolder: m.holder, writeSyncMarker: m.writeSyncMarker })

  it('chooses host, bootstraps with the given pin, starts sync, then writes the marker', async () => {
    const m = make({})
    await run(m)
    expect(m.calls.map((c) => c[0])).toEqual(['chooseMode', 'bootstrapCamp', 'start', 'marker'])
    expect(m.handlers.bootstrapCamp).toHaveBeenCalledWith(expect.objectContaining({ adminPin: '123456' }))
  })
  it('refuses an existing camp before chooseMode is called', async () => {
    const m = make({}, 1)
    await expect(run(m)).rejects.toThrow(/camp already exists/)
    expect(m.handlers.chooseMode).not.toHaveBeenCalled()
  })
  it('writes no marker when the node did not start', async () => {
    const m = make(null)
    await expect(run(m)).rejects.toThrow(/did not start/)
    expect(m.writeSyncMarker).not.toHaveBeenCalled()
  })
})
