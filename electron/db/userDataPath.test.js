import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  APP_NAME,
  DEV_APP_NAME,
  userDataDirName,
  resolveUserDataPath,
  applyUserDataPath,
  resolveSmokeUserDataPath,
} from './userDataPath.js'

// T9 — dev and packaged builds resolved different userData directories by
// accident of argv, and every dev clone collided on Electron's own fallback
// name. See docs/adr/2026-07-28-explicit-userdata-directory.md.

const APP_DATA = '/Users/someone/Library/Application Support'

describe('userDataDirName', () => {
  it('uses the real app name when packaged', () => {
    expect(userDataDirName(true)).toBe('shoresh')
  })

  it('uses a distinct dev directory when not packaged', () => {
    expect(userDataDirName(false)).toBe('shoresh-dev')
  })

  it('never resolves to Electron\'s fallback name', () => {
    // "Electron" is the constant every dev clone previously shared. If either
    // branch ever produces it again, the T9 collision is back.
    expect([userDataDirName(true), userDataDirName(false)]).not.toContain('Electron')
  })

  it('keeps dev and packaged distinct', () => {
    expect(APP_NAME).not.toBe(DEV_APP_NAME)
  })
})

describe('resolveUserDataPath', () => {
  it('places both directories under the app-data root', () => {
    expect(resolveUserDataPath(APP_DATA, true)).toBe(path.join(APP_DATA, 'shoresh'))
    expect(resolveUserDataPath(APP_DATA, false)).toBe(path.join(APP_DATA, 'shoresh-dev'))
  })

  it('does not depend on the app name Electron inferred from argv', () => {
    // The input is appData, which is name-independent — that is the fix.
    expect(resolveUserDataPath(APP_DATA, true)).not.toContain('Electron')
  })
})

describe('applyUserDataPath', () => {
  // A fake Electron `app` that records call order. The ordering is the defect
  // this guards: setName() after a getPath() call silently has no effect, and
  // no comment in main.js would catch that regressing.
  function fakeApp(isPackaged) {
    const calls = []
    return {
      isPackaged,
      name: 'Electron',
      calls,
      setName(n) { calls.push(['setName', n]); this.name = n },
      getPath(k) { calls.push(['getPath', k]); return k === 'appData' ? APP_DATA : `${APP_DATA}/${this.name}` },
      setPath(k, v) { calls.push(['setPath', k, v]) },
    }
  }

  it('redirects to the smoke userData dir when packaged and the env var is set', () => {
    const app = fakeApp(true)
    const smokeDir = '/tmp/shoresh-smoke-xyz'
    const resolved = applyUserDataPath(app, () => {}, { SHORESH_SMOKE_USERDATA: smokeDir })
    expect(resolved).toBe(smokeDir)
    expect(app.calls).toContainEqual(['setPath', 'userData', smokeDir])
  })

  it('ignores the smoke env var in dev', () => {
    const app = fakeApp(false)
    const resolved = applyUserDataPath(app, () => {}, { SHORESH_SMOKE_USERDATA: '/tmp/shoresh-smoke-xyz' })
    expect(resolved).toBe(path.join(APP_DATA, 'shoresh-dev'))
  })

  it('resolves normally when packaged with no smoke env var set', () => {
    const app = fakeApp(true)
    const resolved = applyUserDataPath(app, () => {}, {})
    expect(resolved).toBe(path.join(APP_DATA, 'shoresh'))
  })

  it('sets the app name before reading any path', () => {
    const app = fakeApp(true)
    applyUserDataPath(app, () => {})
    const firstGetPath = app.calls.findIndex(c => c[0] === 'getPath')
    const setName = app.calls.findIndex(c => c[0] === 'setName')
    expect(setName).toBeGreaterThanOrEqual(0)
    expect(setName).toBeLessThan(firstGetPath)
  })

  it('overrides userData explicitly rather than trusting the derived default', () => {
    const app = fakeApp(false)
    const resolved = applyUserDataPath(app, () => {})
    expect(app.calls).toContainEqual(['setPath', 'userData', path.join(APP_DATA, 'shoresh-dev')])
    expect(resolved).toBe(path.join(APP_DATA, 'shoresh-dev'))
  })

  it('creates the directory it points at', () => {
    // Regression: setPath() does NOT create the directory — Electron only
    // auto-creates the one it derived itself. Without this, the first launch
    // after ADR 2026-07-28 died in openLocalDb with "Cannot open database
    // because the directory does not exist". Caught by running the real app,
    // not by any unit test that existed at the time.
    const app = fakeApp(false)
    const made = []
    applyUserDataPath(app, (p) => made.push(p))
    expect(made).toEqual([path.join(APP_DATA, 'shoresh-dev')])
  })

  it('creates the directory after setting the path, not before', () => {
    const app = fakeApp(true)
    const order = []
    const origSetPath = app.setPath.bind(app)
    app.setPath = (k, v) => { order.push('setPath'); origSetPath(k, v) }
    applyUserDataPath(app, () => order.push('mkdir'))
    expect(order).toEqual(['setPath', 'mkdir'])
  })

  it('resolves the packaged app to the same directory it already used', () => {
    // The packaged app must not move. Users of a shipped build see no change
    // and no data migrates — setName only makes the existing behaviour explicit.
    const app = fakeApp(true)
    expect(applyUserDataPath(app, () => {})).toBe(path.join(APP_DATA, 'shoresh'))
  })
})

describe('resolveSmokeUserDataPath', () => {
  it('passes through a non-empty explicit dir', () => {
    expect(resolveSmokeUserDataPath('/tmp/shoresh-smoke-abc')).toBe('/tmp/shoresh-smoke-abc')
  })

  it('rejects an empty or missing dir', () => {
    expect(resolveSmokeUserDataPath('')).toBeNull()
    expect(resolveSmokeUserDataPath(undefined)).toBeNull()
    expect(resolveSmokeUserDataPath(null)).toBeNull()
  })
})
