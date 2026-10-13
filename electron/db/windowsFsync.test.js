// Windows: FlushFileBuffers needs a handle opened for writing, so fsync on a file opened 'r' fails with EPERM there.
// That made "Turn off encryption" and Start fresh refuse on Windows (Windows CI audit, run 38459646183). The fs below
// behaves like Windows: fsync on a read-only file handle throws EPERM; a directory fsync may fail and stays best-effort.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite, syncDir, syncFile } from './disableRecovery.js'

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-winfsync-')); dirs.push(d); return d }

function windowsLikeFs() {
  const flagsByFd = new Map()
  const opens = []
  return {
    ...fs,
    opens,
    openSync(p, flags = 'r', ...rest) {
      const fd = fs.openSync(p, flags, ...rest)
      flagsByFd.set(fd, flags)
      opens.push({ p, flags })
      return fd
    },
    fsyncSync(fd) {
      if (flagsByFd.get(fd) === 'r') { const e = new Error('EPERM: operation not permitted, fsync'); e.code = 'EPERM'; throw e }
      return fs.fsyncSync(fd)
    },
    closeSync(fd) { flagsByFd.delete(fd); return fs.closeSync(fd) },
  }
}

describe('fsync on Windows needs a writable handle', () => {
  it('syncFile flushes a file through a writable handle', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'a.bin')
    fs.writeFileSync(f, 'bytes')
    const wfs = windowsLikeFs()
    expect(() => syncFile(f, wfs)).not.toThrow()
    expect(wfs.opens.find((o) => o.p === f).flags).not.toBe('r')
    expect(fs.readFileSync(f, 'utf8')).toBe('bytes')
  })

  it('atomicWrite (the disable and Start-fresh journals) completes', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'journal.json')
    expect(() => atomicWrite(f, '{"v":1}', windowsLikeFs())).not.toThrow()
    expect(fs.readFileSync(f, 'utf8')).toBe('{"v":1}')
  })

  it('a directory fsync that fails stays best-effort', () => {
    expect(() => syncDir(tmpDir(), windowsLikeFs())).not.toThrow()
  })
})
