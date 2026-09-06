// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'

const MODULE_PATH = './syncEngineFlag.js'
const ENV_KEY = 'SHORESH_SYNC_ENGINE'

const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
})

async function loadWithEnv(value) {
  if (value === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = value
  vi.resetModules()
  return import(MODULE_PATH)
}

describe('syncEngineFlag', () => {
  it('defaults to oplog when SHORESH_SYNC_ENGINE is unset', async () => {
    const mod = await loadWithEnv(undefined)
    expect(mod.SYNC_ENGINE).toBe('oplog')
    expect(mod.isOpLogEngine()).toBe(true)
    expect(mod.isAutomergeEngine()).toBe(false)
  })

  it('resolves to automerge when SHORESH_SYNC_ENGINE=automerge', async () => {
    const mod = await loadWithEnv('automerge')
    expect(mod.SYNC_ENGINE).toBe('automerge')
    expect(mod.isAutomergeEngine()).toBe(true)
    expect(mod.isOpLogEngine()).toBe(false)
  })

  it('fails safe to oplog on a garbage value', async () => {
    const mod = await loadWithEnv('garbage')
    expect(mod.SYNC_ENGINE).toBe('oplog')
    expect(mod.isOpLogEngine()).toBe(true)
    expect(mod.isAutomergeEngine()).toBe(false)
  })
})
