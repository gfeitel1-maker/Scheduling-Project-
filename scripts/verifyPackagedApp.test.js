import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPackagedDriver, checkPackagedDatachannel, interpretLoadProbe, findPackagedApp, checkLockfilePlatforms, waitForExit } from './verifyPackagedApp.js'
import { EventEmitter } from 'node:events'

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgapp-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function fixture(files) {
  const app = path.join(tmp, 'Shoresh.app/Contents/Resources/app')
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true })
    fs.writeFileSync(path.join(app, f), 'x')
  }
  return app
}

describe('checkPackagedDriver', () => {
  it('fails when the driver package is not in the bundle at all (the shipped defect)', () => {
    const app = fixture(['node_modules/better-sqlite3/build/Release/better_sqlite3.node'])
    const r = checkPackagedDriver(app)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('driver-missing')
  })

  it('fails when the package is present but carries no compiled .node', () => {
    const app = fixture(['node_modules/better-sqlite3-multiple-ciphers/package.json'])
    const r = checkPackagedDriver(app)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-native-binary')
  })

  it('passes and names the binary when a .node is in the bundle', () => {
    const rel = 'node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node'
    const app = fixture([rel])
    const r = checkPackagedDriver(app)
    expect(r.ok).toBe(true)
    expect(r.binaries).toEqual([path.join(app, rel)])
  })
})

describe('checkPackagedDatachannel', () => {
  it('fails when node-datachannel is not in the bundle', () => {
    const r = checkPackagedDatachannel(fixture(['node_modules/better-sqlite3-multiple-ciphers/build/Release/x.node']))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('datachannel-missing')
  })

  it('fails when node-datachannel is present but no @node-datachannel platform binary shipped', () => {
    const r = checkPackagedDatachannel(fixture(['node_modules/node-datachannel/package.json']))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-native-binary')
  })

  it('passes and names the prebuilt platform binary', () => {
    const rel = 'node_modules/@node-datachannel/darwin-x64/node_datachannel.node'
    const app = fixture(['node_modules/node-datachannel/package.json', rel])
    const r = checkPackagedDatachannel(app)
    expect(r.ok).toBe(true)
    expect(r.binaries).toEqual([path.join(app, rel)])
  })
})

describe('checkLockfilePlatforms', () => {
  const lock = (names) => ({ packages: Object.fromEntries(names.map((n) => [`node_modules/@node-datachannel/${n}`, { version: '0.33.4' }])) })

  it('passes when the lockfile pins prebuilts for every shipped platform', () => {
    expect(checkLockfilePlatforms(lock(['darwin-arm64', 'darwin-x64', 'win32-x64-msvc'])).ok).toBe(true)
  })

  it('fails and names the platform whose prebuilt is missing', () => {
    const r = checkLockfilePlatforms(lock(['darwin-arm64', 'darwin-x64']))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('win32-x64-msvc')
  })
})

describe('interpretLoadProbe', () => {
  it('names the module that failed to load', () => {
    expect(interpretLoadProbe({ status: 1, stdout: '', stderr: 'boom' }, 'node-datachannel').message).toContain('node-datachannel')
  })

  it('passes only when the packaged Electron opened an in-memory database', () => {
    expect(interpretLoadProbe({ status: 0, stdout: 'DRIVER_OK\n', stderr: '' }).ok).toBe(true)
  })

  it('fails on a nonzero exit and carries the stderr', () => {
    const r = interpretLoadProbe({ status: 1, stdout: '', stderr: 'NODE_MODULE_VERSION 141' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('NODE_MODULE_VERSION 141')
  })

  it('fails on exit 0 without the sentinel (a probe that ran nothing is not a pass)', () => {
    expect(interpretLoadProbe({ status: 0, stdout: '', stderr: '' }).ok).toBe(false)
  })
})

describe('findPackagedApp', () => {
  it('returns null when no release/mac*/Shoresh.app exists', () => {
    expect(findPackagedApp(tmp)).toBeNull()
  })

  it('finds release/mac-arm64/Shoresh.app', () => {
    const app = path.join(tmp, 'release/mac-arm64/Shoresh.app')
    fs.mkdirSync(app, { recursive: true })
    expect(findPackagedApp(tmp)).toBe(app)
  })
})

describe('waitForExit', () => {
  it('resolves true when the child exits inside the bound', async () => {
    const child = new EventEmitter()
    child.exitCode = null
    setTimeout(() => child.emit('exit', 0), 5)
    expect(await waitForExit(child, 1000)).toBe(true)
  })

  it('resolves false (never hangs) when the child does not exit inside the bound', async () => {
    const child = new EventEmitter()
    child.exitCode = null
    expect(await waitForExit(child, 20)).toBe(false)
  })

  it('a child that already exited counts as exited', async () => {
    const child = new EventEmitter()
    child.exitCode = 0
    expect(await waitForExit(child, 20)).toBe(true)
  })
})
