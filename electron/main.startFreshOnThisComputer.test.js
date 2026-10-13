// @vitest-environment node
// "Start fresh on this computer" through the REAL handler, the REAL runner and the REAL file moves, in temp directories.
// The gate is this device's own signed authority state: the revoke fixtures go through the real verified derivation
// (projectAll -> upsertCampAuthorityLogEntity), the same way authorityProjection.test.js builds them.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId, initSchema } from './db/localDb.js'
import { ensureDeviceIdentity } from './auth/deviceIdentity.js'
import { makeHandlers, setLocalResetRunner } from './main.js'
import { createLocalResetRunner } from './localResetRunner.js'
import { runLocalReset, recoverInterruptedLocalReset, LOCAL_RESET_JOURNAL } from './db/localReset.js'
import { createEmptyDoc, applyWrite } from './automerge/campDocument.js'
import { signAuthorityEntry } from './automerge/authorityLogSignature.js'
import { projectAll } from './automerge/projector.js'
import { markRemovedFromCamp, isLocallyRemoved, isRemovedFromCamp } from './sync/automerge/selfRemoval.js'
import { resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

const tmpFiles = []
const tmpDirs = []
let db, deviceId, userData, events, restart, runner, handlers, founder, doc, shutdownHook

async function makeDevice() {
  const file = path.join(os.tmpdir(), `shoresh-startfresh-key-${crypto.randomUUID()}.sqlite`)
  tmpFiles.push(file)
  const kdb = new Database(file)
  initSchema(kdb)
  const { peerId } = await ensureDeviceIdentity(kdb)
  return { db: kdb, peerId }
}
const put = (d, id, fields) => Object.entries(fields).reduce((acc, [field, value]) => applyWrite(acc, { entity: 'camp_authority_log', entity_id: id, field, value }), d)
let seq = 0
const entryId = () => `sf-entry-${seq++}`
function genesis(d, deviceIdOf, peerId) { return put(d, entryId(), { kind: 'genesis', target_device_id: deviceIdOf, target_peer_id: peerId }) }
function signedEntry(d, kind, signerDb, signerId, targetId, extra = {}, { sign = true } = {}) {
  const id = entryId()
  const fields = { kind, target_device_id: targetId, signer_device_id: signerId, ...extra }
  if (sign) fields.signature = signAuthorityEntry(signerDb, { id, kind, target_device_id: targetId, signer_device_id: signerId })
  return put(d, id, fields)
}

const populate = () => {
  for (const n of ['shoresh.sqlite', 'db.key.enc', 'tool-authorizations.enc', 'recent-projects.json', 'current-project.json']) fs.writeFileSync(path.join(userData, n), `bytes of ${n}`)
  fs.mkdirSync(path.join(userData, 'automerge'))
  fs.writeFileSync(path.join(userData, 'automerge', 'camp-1.automerge'), 'doc')
  fs.mkdirSync(path.join(userData, 'backups'))
  fs.writeFileSync(path.join(userData, 'backups', 'b.db'), 'backup')
}
const snapshot = (root) => Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort().map((r) => {
  const p = path.join(root, r)
  return [r, fs.statSync(p).isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'dir']
}))

// Mutating calls are recorded in the same timeline as the runner's own steps, so ORDER is assertable.
const recordingFs = () => {
  const wrap = (name) => (...a) => { events.push(`fs:${name}:${path.basename(String(a[0]))}`); return fs[name](...a) }
  return { ...fs, renameSync: wrap('renameSync'), writeFileSync: wrap('writeFileSync') }
}

function buildRunner() {
  return createLocalResetRunner({
    flushDoc: () => events.push('flush'),
    shutdownSync: async () => { events.push('shutdown'); await shutdownHook?.() },
    suspendDocSaves: () => events.push('suspend'),
    stillRemoved: () => isLocallyRemoved(db, deviceId),
    closeDb: () => { events.push('close'); db.close() },
    listProjectDbPaths: () => [],
    reset: ({ extraDbPaths }) => runLocalReset({ userDataDir: userData, extraDbPaths, fsImpl: recordingFs(), stamp: 'test' }),
    restart: (ms) => { events.push(`restart:${ms}`); restart(ms) },
    log: () => {},
  })
}

beforeEach(async () => {
  seq = 0
  ;({ db } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-startfresh-ud-'))
  tmpDirs.push(userData)
  populate()
  events = []
  restart = vi.fn()
  shutdownHook = null
  founder = await makeDevice()
  doc = genesis(createEmptyDoc(), 'founder', founder.peerId)
  doc = signedEntry(doc, 'grant', founder.db, 'founder', deviceId, { target_peer_id: founder.peerId })
  runner = buildRunner()
  setLocalResetRunner(runner)
  handlers = makeHandlers(db, deviceId, { userDataPath: userData, dbPath: path.join(userData, 'shoresh.sqlite') })
})
afterEach(() => {
  setLocalResetRunner(null)
  resetLiveDocForTests()
  try { db.close() } catch { /* the runner closed it */ }
  for (const f of tmpFiles.splice(0)) for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true })
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
afterAll(() => cleanupTemplatedDbs())

const revokeThisDevice = () => {
  doc = signedEntry(doc, 'revoke', founder.db, 'founder', deviceId)
  projectAll(db, doc)
  markRemovedFromCamp(db, { peerId: 'peer-x', reason: 'device_revoked' })
}

describe('startFreshOnThisComputer: a signed revoke', () => {
  it('journals, moves the key first, marks moved, restarts; a fresh launch on that userData is empty', async () => {
    revokeThisDevice()
    expect(isLocallyRemoved(db, deviceId)).toBe(true)
    const res = await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })
    expect(res).toEqual({ ok: true, restarting: true })
    expect(events.slice(0, 5)).toEqual(['flush', 'shutdown', 'flush', 'suspend', 'close'])
    const fsEvents = events.filter((e) => e.startsWith('fs:'))
    expect(fsEvents[0]).toBe(`fs:writeFileSync:${LOCAL_RESET_JOURNAL}.tmp`)
    const firstMove = fsEvents.find((e) => e.startsWith('fs:renameSync') && !e.endsWith('.tmp'))
    expect(firstMove).toBe('fs:renameSync:db.key.enc')
    expect(events[events.length - 1]).toBe('restart:500')
    expect(events.indexOf('restart:500')).toBe(events.length - 1)
    expect(events.findLastIndex((e) => e.startsWith('fs:'))).toBeLessThan(events.indexOf('restart:500'))
    expect(JSON.parse(fs.readFileSync(path.join(userData, LOCAL_RESET_JOURNAL), 'utf8')).state).toBe('moved')
    expect(fs.existsSync(path.join(userData, 'shoresh.sqlite'))).toBe(false)

    expect(recoverInterruptedLocalReset({ userDataDir: userData }).finished).toBe(true)
    expect(fs.readdirSync(userData)).toEqual([])
  })
})

describe('startFreshOnThisComputer: refusals touch nothing', () => {
  const expectUntouched = async (before, res, error = 'not_removed') => {
    expect(res).toEqual({ ok: false, error })
    expect(snapshot(userData)).toEqual(before)
    expect(restart).not.toHaveBeenCalled()
    expect(events).toEqual([])
  }

  it('a healthy device is refused', async () => {
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
  })

  it('the removed mark alone, with no authority revoke, is refused', async () => {
    markRemovedFromCamp(db, { peerId: 'peer-x', reason: 'device_revoked' })
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
  })

  it('an authority revoke with no removed mark is refused', async () => {
    doc = signedEntry(doc, 'revoke', founder.db, 'founder', deviceId)
    projectAll(db, doc)
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
  })

  it('a forged revoke (signed with another key) is refused even with the mark set', async () => {
    const attacker = await makeDevice()
    doc = signedEntry(doc, 'revoke', attacker.db, 'founder', deviceId)
    projectAll(db, doc)
    markRemovedFromCamp(db, { peerId: 'peer-x', reason: 'device_revoked' })
    expect(db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId).status).toBe('admin')
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
  })

  it('an unsigned revoke is refused even with the mark set', async () => {
    doc = signedEntry(doc, 'revoke', founder.db, 'founder', deviceId, {}, { sign: false })
    projectAll(db, doc)
    markRemovedFromCamp(db, { peerId: 'peer-x', reason: 'device_revoked' })
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
  })

  it('PLANT: an unsigned entry targeting this device plus a bare refusal, even with both old halves forced true, does not open the gate', async () => {
    const lone = genesis(createEmptyDoc(), 'founder', founder.peerId)
    doc = signedEntry(lone, 'revoke', founder.db, 'founder', deviceId, {}, { sign: false })
    projectAll(db, doc)
    // Since #1019 the projector no longer marks an unsigned entry's target revoked at all.
    expect(db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId)?.status).not.toBe('revoked')
    // The gate must not rest on that fix: force the two old halves true (what the pre-#1019 projector plus a bare
    // refusal produced). With no VERIFIED revoke in applied_authority_log, it still refuses and touches nothing.
    db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES (?, 'revoked', ?) ON CONFLICT(device_id) DO UPDATE SET status = 'revoked'").run(deviceId, new Date().toISOString())
    markRemovedFromCamp(db, { peerId: 'peer-x', reason: 'device_revoked' })
    expect(db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(deviceId).status).toBe('revoked')
    expect(isRemovedFromCamp(db)).toBe(true)
    expect(handlers.getSyncStatus().startFreshAvailable).toBe(false)
    const before = snapshot(userData)
    await expectUntouched(before, await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' }))
    expect(await handlers.startFreshPreview()).toEqual({ ok: false, error: 'not_removed' })
  })

  it('a missing or wrong confirmation is refused before anything is checked or stopped', async () => {
    revokeThisDevice()
    const before = snapshot(userData)
    for (const confirm of [undefined, 'start_fresh', 'yes']) {
      expect(await handlers.startFreshOnThisComputer({ confirm })).toEqual({ ok: false, error: 'confirmation_mismatch' })
    }
    expect(await handlers.startFreshOnThisComputer()).toEqual({ ok: false, error: 'confirmation_mismatch' })
    expect(snapshot(userData)).toEqual(before)
    expect(events).toEqual([])
  })

  it('a re-grant that lands while sync stops aborts the wipe, restarts, and moves nothing', async () => {
    revokeThisDevice()
    const before = snapshot(userData)
    shutdownHook = () => {
      doc = signedEntry(doc, 'grant', founder.db, 'founder', deviceId, { target_peer_id: founder.peerId })
      projectAll(db, doc)
    }
    const res = await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })
    expect(res).toEqual({ ok: false, error: 'not_removed', restarting: true })
    expect(snapshot(userData)).toEqual(before)
    expect(fs.existsSync(path.join(userData, LOCAL_RESET_JOURNAL))).toBe(false)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(events).not.toContain('close')
  })

  it('is single-flight: a second call while one is running is refused', async () => {
    revokeThisDevice()
    let release
    shutdownHook = () => new Promise((r) => { release = r })
    const first = handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })).toEqual({ ok: false, error: 'in_progress' })
    release()
    expect((await first).ok).toBe(true)
  })

  it('reports unavailable when no runner is wired', async () => {
    revokeThisDevice()
    setLocalResetRunner(null)
    expect(await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('startFreshPreview: the other camps on this computer', () => {
  it('names every other camp, inside and outside userData, and touches none of them', async () => {
    revokeThisDevice()
    expect(handlers.getSyncStatus().startFreshAvailable).toBe(true)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-startfresh-out-'))
    tmpDirs.push(outside)
    fs.mkdirSync(path.join(userData, 'projects'))
    const b = path.join(userData, 'projects', 'b.sqlite'); const c = path.join(userData, 'projects', 'c.sqlite'); const o = path.join(outside, 'elsewhere.sqlite')
    for (const f of [b, c, o]) fs.writeFileSync(f, `bytes of ${path.basename(f)}`)
    fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify([
      { path: path.join(userData, 'shoresh.sqlite'), campName: 'This Camp' },
      { path: b, campName: 'Camp B' }, { path: c }, { path: o, campName: 'Outside Camp' },
    ]))
    const before = snapshot(userData); const outBefore = snapshot(outside)
    const res = await handlers.startFreshPreview()
    expect(res.ok).toBe(true)
    expect(res.camps).toEqual([
      { name: 'Camp B', file: path.join('projects', 'b.sqlite'), outsideShoresh: false },
      { name: 'c.sqlite', file: path.join('projects', 'c.sqlite'), outsideShoresh: false },
      { name: 'Outside Camp', file: o, outsideShoresh: true },
    ])
    expect(snapshot(userData)).toEqual(before)
    expect(snapshot(outside)).toEqual(outBefore)
    await handlers.startFreshOnThisComputer({ confirm: 'START_FRESH' })
    recoverInterruptedLocalReset({ userDataDir: userData })
    expect(fs.readFileSync(o, 'utf8')).toBe('bytes of elsewhere.sqlite')
    expect(snapshot(outside)).toEqual(outBefore)
  })

  it('lists nothing when this is the only camp', async () => {
    revokeThisDevice()
    expect(await handlers.startFreshPreview()).toEqual({ ok: true, camps: [] })
  })
})

describe('only the gated handler reaches the reset', () => {
  const electronDir = path.dirname(new URL(import.meta.url).pathname)
  const sources = () => fs.readdirSync(electronDir, { recursive: true })
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !f.includes('node_modules'))
    .map((f) => [f, fs.readFileSync(path.join(electronDir, f), 'utf8')])

  it('runLocalReset, createLocalResetRunner and the runner variable are referenced only where expected', () => {
    const users = (needle) => sources().filter(([, s]) => s.includes(needle)).map(([f]) => f).sort()
    expect(users('runLocalReset')).toEqual(['db/localReset.js', 'main.js'])
    expect(users('createLocalResetRunner')).toEqual(['localResetRunner.js', 'main.js'])
    const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8')
    expect(main.match(/await localResetRunner\(/g)).toHaveLength(1)
    expect(main.match(/handle\('shoresh:start-fresh-on-this-computer'/g)).toHaveLength(1)
    expect(main).toMatch(/if \(!isLocallyRemoved\(db, deviceId\)\) return \{ ok: false, error: 'not_removed' \}/)
  })

  it('recovery runs before the encryption-disable recovery and before any db is opened', () => {
    const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8')
    const a = main.indexOf('recoverInterruptedLocalReset({')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(main.indexOf('recoverInterruptedDisable({'))
    expect(a).toBeLessThan(main.indexOf('openLocalDb(dbPath'))
  })
})
