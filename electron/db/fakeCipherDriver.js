// Stand-in for the encrypting SQLite driver, for tests that cannot load the native module under every
// Node (the real-driver proof lives in sqliteCipher.integration.test.js). A file is 'ENC' (or the SQLite
// magic when plaintext) followed by JSON table counts. `beforeRekey(path)` lets a test intercept the
// decrypt, e.g. to simulate the process dying part-way through it.
import fs from 'node:fs'

export const FAKE_MAGIC = 'SQLite format 3\0'

export function fakeDriver({ failRekey = false, corruptAfterRekey = false, beforeRekey = null } = {}) {
  const calls = []
  function Fake(p) { this.p = p; this.keyed = false }
  Fake.prototype.pragma = function (s) {
    calls.push(s)
    if (/^key\s*=/.test(s)) { this.keyed = true; return }
    if (/^rekey\s*=\s*''$/.test(s)) {
      if (beforeRekey) beforeRekey(this.p)
      if (failRekey) throw new Error('disk I/O error')
      const body = fs.readFileSync(this.p, 'latin1')
      if (!body.startsWith('ENC')) throw new Error('not keyed')
      let json = body.slice(3)
      if (corruptAfterRekey) json = JSON.stringify({ camps: 99 })
      fs.writeFileSync(this.p, FAKE_MAGIC + json, 'latin1')
    }
  }
  const readable = (self) => {
    const body = fs.readFileSync(self.p, 'latin1')
    const enc = body.startsWith('ENC')
    if (enc !== self.keyed) throw Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' })
    return JSON.parse(enc ? body.slice(3) : body.slice(FAKE_MAGIC.length))
  }
  Fake.prototype.prepare = function (sql) {
    const self = this
    if (/sqlite_master/.test(sql) && /name/.test(sql)) return { all: () => Object.keys(readable(self)).map((name) => ({ name })) }
    const m = /FROM "(\w+)"/.exec(sql)
    if (m) return { get: () => ({ n: readable(self)[m[1]] }) }
    return { get: () => ({ n: Object.keys(readable(self)).length }) }
  }
  Fake.prototype.close = function () {}
  Fake._calls = calls
  return Fake
}
