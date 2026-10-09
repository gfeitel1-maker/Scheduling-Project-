import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPackagedDriver, interpretLoadProbe, findPackagedApp } from './verifyPackagedApp.js'

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

describe('interpretLoadProbe', () => {
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
