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
  // Stage 6b flipped this, deliberately: automerge is the engine now. The old
  // assertion (unset -> oplog) was correct for Stage 5 and is kept in the
  // history rather than the file — see the plan's 6b row.
  it('defaults to automerge when SHORESH_SYNC_ENGINE is unset', async () => {
    const mod = await loadWithEnv(undefined)
    expect(mod.SYNC_ENGINE).toBe('automerge')
    expect(mod.isAutomergeEngine()).toBe(true)
    expect(mod.isOpLogEngine()).toBe(false)
  })

  it('still lets a device fall back to the op-log, exactly', async () => {
    const mod = await loadWithEnv('oplog')
    expect(mod.SYNC_ENGINE).toBe('oplog')
    expect(mod.isOpLogEngine()).toBe(true)
  })

  it('resolves to automerge when SHORESH_SYNC_ENGINE=automerge', async () => {
    const mod = await loadWithEnv('automerge')
    expect(mod.SYNC_ENGINE).toBe('automerge')
    expect(mod.isAutomergeEngine()).toBe(true)
    expect(mod.isOpLogEngine()).toBe(false)
  })

  // The fail-safe DIRECTION is inverted by 6b, and that is worth an explicit
  // test rather than an implication: a typo no longer silently keeps a device
  // on the old engine. Selecting the op-log must be exact.
  it('resolves a garbage value to automerge, not to the op-log', async () => {
    const mod = await loadWithEnv('garbage')
    expect(mod.SYNC_ENGINE).toBe('automerge')
    expect(mod.isAutomergeEngine()).toBe(true)
  })

  it('does not accept a near-miss like OPLOG or "op-log" as the fallback', async () => {
    for (const near of ['OPLOG', 'op-log', ' oplog']) {
      const mod = await loadWithEnv(near)
      expect(mod.SYNC_ENGINE).toBe('automerge')
    }
  })
})
