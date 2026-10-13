// @vitest-environment node
// "Start fresh on this computer": the move-aside-then-finish-forward wipe of THIS device's data. Real files in temp
// directories; a crash is injected after every filesystem mutation and recovery must always end in an empty userData
// (or, if the journal never became durable, in the untouched original).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLocalReset, recoverInterruptedLocalReset, LOCAL_RESET_JOURNAL, LOCAL_RESET_FILES, resetTargets } from './localReset.js'

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-reset-')); dirs.push(d); return d }

function populate(root) {
  const write = (rel, body = rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body) }
  for (const n of ['shoresh.sqlite', 'shoresh.sqlite-wal', 'shoresh.sqlite-shm', 'db.key.enc', 'tool-authorizations.enc', 'recent-projects.json',
    'current-project.json', 'encryption.disabled', 'encryption.disable-journal', 'tcp-listen-port.json', 'port-mapping-grant.json',
    'punch-gossip-highwater.json', 'punch-signal-replay.json']) write(n)
  write('automerge/camp-1.automerge')
  write('backups/shoresh-1.db')
}
const listAll = (root) => fs.readdirSync(root, { recursive: true }).sort()

// An fs whose Nth mutating call throws, recording every mutating call it saw.
function crashingFs(crashAt, log = []) {
  let n = 0
  const wrap = (name) => (...args) => {
    log.push([name, ...args.filter((a) => typeof a === 'string')])
    if (crashAt !== null && n++ >= crashAt) throw new Error(`injected crash at ${n - 1} (${name})`)
    return fs[name](...args)
  }
  return { ...fs, renameSync: wrap('renameSync'), rmSync: wrap('rmSync'), unlinkSync: wrap('unlinkSync'), writeFileSync: wrap('writeFileSync'), mkdirSync: wrap('mkdirSync') }
}

describe('resetTargets', () => {
  it('lists the key first, only paths inside userData, and the sidecars of in-userData project dbs', () => {
    const root = tmp()
    const outside = tmp()
    const t = resetTargets(root, [path.join(root, 'projects', 'other.sqlite'), path.join(outside, 'evil.sqlite'), path.join(root, '..', 'escape.sqlite')])
    expect(t[0]).toBe('db.key.enc')
    for (const f of LOCAL_RESET_FILES) expect(t).toContain(f)
    expect(t).toContain(path.join('projects', 'other.sqlite'))
    expect(t).toContain(path.join('projects', 'other.sqlite-wal'))
    expect(t.some((x) => x.includes('evil') || x.includes('escape') || path.isAbsolute(x) || x.startsWith('..'))).toBe(false)
  })
})

describe('runLocalReset + recoverInterruptedLocalReset', () => {
  it('moves everything aside, key first, marks the journal moved, and recovery leaves userData empty with the key shredded first', () => {
    const root = tmp()
    populate(root)
    fs.mkdirSync(path.join(root, 'projects'))
    fs.writeFileSync(path.join(root, 'projects', 'other.sqlite'), 'p')
    const log = []
    runLocalReset({ userDataDir: root, extraDbPaths: [path.join(root, 'projects', 'other.sqlite')], fsImpl: crashingFs(null, log), stamp: '1700000000000' })
    expect(JSON.parse(fs.readFileSync(path.join(root, LOCAL_RESET_JOURNAL), 'utf8')).state).toBe('moved')
    const firstMove = log.find((l) => l[0] === 'renameSync' && !l[1].endsWith('.tmp') && !l.includes(path.join(root, LOCAL_RESET_JOURNAL)))
    expect(path.basename(firstMove[1])).toBe('db.key.enc')
    expect(fs.existsSync(path.join(root, 'shoresh.sqlite'))).toBe(false)

    const recLog = []
    expect(recoverInterruptedLocalReset({ userDataDir: root, fsImpl: crashingFs(null, recLog) })).toEqual({ finished: true })
    const firstDelete = recLog.find((l) => l[0] === 'rmSync' || l[0] === 'unlinkSync')
    expect(path.basename(firstDelete[1])).toBe('db.key.enc')
    expect(listAll(root)).toEqual(['projects'])
  })

  it('a crash after ANY step is finished forward by the next launch: userData ends empty, key deleted before the rest', () => {
    const probe = tmp(); populate(probe)
    const total = []
    runLocalReset({ userDataDir: probe, extraDbPaths: [], fsImpl: crashingFs(null, total), stamp: '1700000000001' })
    expect(total.length).toBeGreaterThan(10)
    for (let k = 0; k < total.length; k++) {
      const root = tmp(); populate(root)
      try { runLocalReset({ userDataDir: root, extraDbPaths: [], fsImpl: crashingFs(k), stamp: '1700000000001' }) } catch { /* the injected crash */ }
      const recLog = []
      const res = recoverInterruptedLocalReset({ userDataDir: root, fsImpl: crashingFs(null, recLog) })
      if (!fs.existsSync(path.join(root, LOCAL_RESET_JOURNAL)) && res.finished === false) {
        // The journal never became durable: nothing was moved, the device is exactly as it was.
        expect(fs.existsSync(path.join(root, 'shoresh.sqlite')), `k=${k}`).toBe(true)
        continue
      }
      expect(res.finished, `k=${k}`).toBe(true)
      expect(listAll(root), `k=${k}`).toEqual([])
      const firstDelete = recLog.find((l) => l[0] === 'rmSync' || l[0] === 'unlinkSync')
      expect(path.basename(firstDelete[1]), `k=${k}`).toBe('db.key.enc')
    }
  })

  it('never touches a file outside userData, even when a project path and a symlink point there', () => {
    const root = tmp(); populate(root)
    const sibling = tmp()
    const sibFile = path.join(sibling, 'precious.sqlite')
    fs.writeFileSync(sibFile, 'precious')
    fs.symlinkSync(sibling, path.join(root, 'link-out'))
    runLocalReset({ userDataDir: root, extraDbPaths: [sibFile, path.join(root, 'link-out', 'precious.sqlite')], fsImpl: fs, stamp: '1700000000002' })
    recoverInterruptedLocalReset({ userDataDir: root, fsImpl: fs })
    expect(fs.readFileSync(sibFile, 'utf8')).toBe('precious')
    expect(listAll(sibling)).toEqual(['precious.sqlite'])
  })

  it('ignores a journal that names a path outside userData', () => {
    const root = tmp(); const sibling = tmp()
    fs.writeFileSync(path.join(sibling, 'x'), 'x')
    fs.writeFileSync(path.join(root, LOCAL_RESET_JOURNAL), JSON.stringify({ version: 1, state: 'moving', stamp: '1', targets: ['../' + path.basename(sibling) + '/x'] }))
    expect(recoverInterruptedLocalReset({ userDataDir: root, fsImpl: fs }).finished).toBe(false)
    expect(fs.readFileSync(path.join(sibling, 'x'), 'utf8')).toBe('x')
  })

  it('does nothing when there is no journal', () => {
    const root = tmp(); populate(root)
    const before = listAll(root)
    expect(recoverInterruptedLocalReset({ userDataDir: root, fsImpl: fs })).toEqual({ finished: false })
    expect(listAll(root)).toEqual(before)
  })
})
