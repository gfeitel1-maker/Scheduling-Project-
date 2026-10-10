// T359 slice 3: the device-local record of the external port the router granted, so a start after a crash
// can delete a mapping the router placed on a port other than the one requested. Never synced. Written
// like punchFileStore (temp file, fsync, rename): a crash leaves the old file or the new one, never a torn one.
import fs from 'node:fs'
import path from 'node:path'

export const GRANT_FILE = 'port-mapping-grant.json'
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536

export function createFileGrantStore(filePath) {
  return {
    load() {
      try {
        const { externalPort } = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        return validPort(externalPort) ? { externalPort } : null
      } catch {
        return null
      }
    },
    save({ externalPort }) {
      if (!validPort(externalPort)) throw new Error('grant store: invalid port')
      const tmp = `${filePath}.tmp`
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, JSON.stringify({ externalPort }))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, filePath)
      try {
        const dirFd = fs.openSync(path.dirname(filePath), 'r')
        try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      } catch { /* best effort: some platforms cannot fsync a directory */ }
    },
    clear() {
      fs.rmSync(filePath, { force: true })
    },
  }
}
