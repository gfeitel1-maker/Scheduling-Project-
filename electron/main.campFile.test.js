// @vitest-environment node
//
// T381 phase 2: the IPC half of Save whole camp / Open a saved camp. Auth gating, the native dialogs (injected), the
// temp-file-then-rename write, the pre-bootstrap pick (size check before read, validation in main, nothing but a
// basename ever returned), and the post-login load (single-use pick, fresh-camp refusal).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { makeHandlers, ensureDeviceRow } from './main.js'
import { PERMISSIONS } from './auth/permissions.js'
import { appendOp } from './ops/operations.js'
import { exportCampFile, serializeCampFile } from './ops/campFile/exportCampFile.js'
import { validateCampFile } from './ops/campFile/validateCampFile.js'
import { readCampStatus, canStartOver } from './ops/campFile/campFileLifecycle.js'
import { readLoadIncomplete } from './ops/campFile/loadCampFile.js'
import { makeFreshCamp, buildFixtureCamp } from './ops/campFile/campFileTestSupport.js'
import { setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

afterAll(() => cleanupTemplatedDbs())

let dir, db, deviceId, campId, dialogs, openDbs

async function bootstrapDb({ name = 'Camp Probe' } = {}) {
  const { db: d } = openTemplatedDb()
  openDbs.push(d)
  const dId = getOrCreateDeviceId(d)
  const cId = randomUUID()
  d.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(cId, name)
  const key = ensureHostSigningKey(d)
  d.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, cId)
  ensureDeviceRow(d, dId)
  d.prepare('UPDATE devices SET pairing_status = ?, authorized_at = ? WHERE id = ?').run('authorized', new Date().toISOString(), dId)
  const apply = async (args) => ({ status: 'applied', op: appendOp(d, { ...args, author_user_id: null, device_id: dId, parent_op_id: null }) })
  const admin = await createUser(d, { camp_id: cId, name: 'Director', pin: '135790', role: 'admin' }, apply)
  await createUser(d, { camp_id: cId, name: 'Staffer', pin: '246810', role: 'staff' }, apply)
  return { db: d, deviceId: dId, campId: cId, adminId: admin.id }
}

async function loginAs(name, pin) {
  const handlers = makeHandlers(db, deviceId, { campFileDialogs: dialogs })
  await handlers.chooseMode({ mode: 'host' })
  const { token } = await handlers.login({ name, pin })
  return { handlers, token }
}

beforeEach(async () => {
  openDbs = []
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-campfile-ipc-'))
  setUserDataDirGetter(() => dir)
  dialogs = { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
  ;({ db, deviceId, campId } = await bootstrapDb())
})
afterEach(() => {
  resetLiveDocForTests()
  for (const d of openDbs) { try { d.close() } catch { /* closed */ } }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Save whole camp (saveCampFile)', () => {
  it('is admin-only by default-deny: no staff grant exists', () => {
    expect(PERMISSIONS.staff).not.toContain('camp.save_file')
    expect(PERMISSIONS.admin).toContain('*')
  })

  it('refuses a staff session before any dialog opens', async () => {
    const { handlers, token } = await loginAs('Staffer', '246810')
    await expect(handlers.saveCampFile({ token })).rejects.toThrow(/admin role required/)
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
  })

  it('refuses a missing token and a forged token', async () => {
    const { handlers } = await loginAs('Director', '135790')
    await expect(handlers.saveCampFile({})).rejects.toThrow(/token is required/)
    await expect(handlers.saveCampFile({ token: 'forged' })).rejects.toThrow(/invalid session/)
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
  })

  it('offers "<camp name>.shoresh-camp", writes a valid file by temp-and-rename, and returns the basename only', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    const target = path.join(dir, 'chosen.shoresh-camp')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    const result = await handlers.saveCampFile({ token })
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith('Camp Probe.shoresh-camp')
    expect(result.ok).toBe(true)
    expect(result.fileName).toBe('chosen.shoresh-camp')
    expect(typeof result.counts).toBe('object')
    expect(JSON.stringify(result)).not.toContain(dir)
    expect(validateCampFile(fs.readFileSync(target)).ok).toBe(true)
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('makes the offered name safe when the camp name has path characters', async () => {
    db.prepare('UPDATE camps SET name = ?').run('Camp/../Wi:ld*')
    const { handlers, token } = await loginAs('Director', '135790')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: true })
    await handlers.saveCampFile({ token })
    const offered = dialogs.showSaveDialog.mock.calls[0][0]
    expect(offered).toMatch(/\.shoresh-camp$/)
    expect(offered).not.toMatch(/[\\/:*]/)
  })

  it('adds the extension when the chosen name lacks it', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'plain') })
    const result = await handlers.saveCampFile({ token })
    expect(result.fileName).toBe('plain.shoresh-camp')
    expect(fs.existsSync(path.join(dir, 'plain.shoresh-camp'))).toBe(true)
  })

  it('reports a cancelled dialog as a refusal that wrote nothing', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await handlers.saveCampFile({ token })).toEqual({ ok: false, reason: 'canceled' })
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.shoresh-camp') || n.includes('.tmp'))).toEqual([])
  })

  it('returns what the exporter left out because it pointed at something gone', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    const ids = buildFixtureCamp(db, { campId, deviceId, userId: null })
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM locations WHERE id = ?').run(ids.field)
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'gap.shoresh-camp') })
    const result = await handlers.saveCampFile({ token })
    expect(result.ok).toBe(true)
    expect(result.report.nulledReferences + result.report.droppedRows).toBeGreaterThan(0)
    expect(result.leftOut).toBe(result.report.nulledReferences + result.report.droppedRows)
  })

  it('reports nothing left out for a clean camp', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'clean.shoresh-camp') })
    const result = await handlers.saveCampFile({ token })
    expect(result.leftOut).toBe(0)
  })

  it('reports a write failure in plain words and leaves no half file', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'missing-folder', 'x.shoresh-camp') })
    const result = await handlers.saveCampFile({ token })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('write_failed')
    expect(JSON.stringify(result)).not.toContain(dir)
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.shoresh-camp') || n.includes('.tmp'))).toEqual([])
  })
})

// A saved camp file from a fully built camp A, to open into fresh camps.
let savedFilePath
async function writeSavedFile() {
  const src = openTemplatedDb().db
  openDbs.push(src)
  const A = makeFreshCamp(src, { name: 'Camp A' })
  buildFixtureCamp(src, A)
  savedFilePath = path.join(dir, 'camp-a.shoresh-camp')
  fs.writeFileSync(savedFilePath, serializeCampFile(exportCampFile(src, A.campId)))
}

function campLessHandlers() {
  const { db: d } = openTemplatedDb()
  openDbs.push(d)
  const dId = getOrCreateDeviceId(d)
  return { d, handlers: makeHandlers(d, dId, { campFileDialogs: dialogs }) }
}
const choose = (filePath) => dialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

describe('Open a saved camp: pickCampFile (before the camp exists)', () => {
  it('validates in main and returns the camp name, counts and a basename, never a path', async () => {
    await writeSavedFile()
    const { handlers } = campLessHandlers()
    choose(savedFilePath)
    const result = await handlers.pickCampFile()
    expect(result.ok).toBe(true)
    expect(result.fileName).toBe('camp-a.shoresh-camp')
    expect(result.campName).toBe('Camp A')
    expect(result.counts.groups).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(dir)
  })

  it('refuses a file that is not a camp file, naming the basename only', async () => {
    const { handlers } = campLessHandlers()
    const junk = path.join(dir, 'notes.shoresh-camp')
    fs.writeFileSync(junk, 'hello')
    choose(junk)
    const result = await handlers.pickCampFile()
    expect(result).toMatchObject({ ok: false, reason: 'not_a_camp_file', fileName: 'notes.shoresh-camp' })
    expect(JSON.stringify(result)).not.toContain(dir)
  })

  it('refuses an oversize file from its size alone, without reading it', async () => {
    const { handlers } = campLessHandlers()
    const big = path.join(dir, 'big.shoresh-camp')
    fs.closeSync(fs.openSync(big, 'w'))
    fs.truncateSync(big, 65 * 1024 * 1024)
    const readSpy = vi.spyOn(fs, 'readFileSync')
    choose(big)
    const result = await handlers.pickCampFile()
    expect(result).toMatchObject({ ok: false, reason: 'too_large' })
    expect(readSpy.mock.calls.some(([p]) => p === big)).toBe(false)
    readSpy.mockRestore()
  })

  it('reports a cancelled dialog without touching anything', async () => {
    const { handlers } = campLessHandlers()
    dialogs.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await handlers.pickCampFile()).toEqual({ ok: false, reason: 'canceled' })
  })

  it('refuses once a camp exists on this device, before any dialog', async () => {
    const handlers = makeHandlers(db, deviceId, { campFileDialogs: dialogs })
    expect(await handlers.pickCampFile()).toMatchObject({ ok: false, reason: 'camp_not_empty' })
    expect(dialogs.showOpenDialog).not.toHaveBeenCalled()
  })
})

// The real order: pick (no camp yet) -> bootstrap -> sign in -> load, all on one handler set.
async function pickBootstrapLogin(filePath) {
  const { d, handlers } = campLessHandlers()
  await handlers.chooseMode({ mode: 'host', campName: 'Camp A' })
  choose(filePath)
  const picked = await handlers.pickCampFile()
  await handlers.bootstrapCamp({ campName: 'Camp A', adminName: 'Director', adminPin: '135790' })
  const { token } = await handlers.login({ name: 'Director', pin: '135790' })
  return { d, handlers, token, picked }
}

describe('Open a saved camp: loadCampFile (after bootstrap and login)', () => {
  it('is admin-only by default-deny', () => {
    expect(PERMISSIONS.staff).not.toContain('camp.load_file')
  })

  it('refuses when no file was picked', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    expect(await handlers.loadCampFile({ token })).toMatchObject({ ok: false, reason: 'no_file_picked' })
  })

  it('refuses a staff session', async () => {
    const { handlers, token } = await loginAs('Staffer', '246810')
    expect(() => handlers.loadCampFile({ token })).toThrow(/admin role required/)
  })

  it('loads the picked file into the fresh camp once and clears the pick', async () => {
    await writeSavedFile()
    const { d, handlers, token, picked } = await pickBootstrapLogin(savedFilePath)
    expect(picked.ok).toBe(true)
    const result = await handlers.loadCampFile({ token })
    expect(result.ok).toBe(true)
    expect(result.counts.groups).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(dir)
    expect(d.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(result.counts.groups)
    expect(readLoadIncomplete(d)).toBeNull()
    expect(await handlers.loadCampFile({ token })).toMatchObject({ ok: false, reason: 'no_file_picked' })
  })

  it('refuses to load into a camp that already has setup data and writes nothing', async () => {
    await writeSavedFile()
    const { d, handlers, token } = await pickBootstrapLogin(savedFilePath)
    const campRow = d.prepare('SELECT id FROM camps').get()
    const gid = randomUUID()
    appendOp(d, { entity: 'groups', entity_id: gid, field: 'camp_id', value: campRow.id, device_id: getOrCreateDeviceId(d), author_user_id: null })
    appendOp(d, { entity: 'groups', entity_id: gid, field: 'name', value: 'Existing', device_id: getOrCreateDeviceId(d), author_user_id: null })
    const result = await handlers.loadCampFile({ token })
    expect(result).toMatchObject({ ok: false, reason: 'camp_not_empty' })
    expect(d.prepare('SELECT COUNT(*) AS n FROM groups').get().n).toBe(1)
    expect(readLoadIncomplete(d)).toBeNull()
  })
})

describe('Open a saved camp: the incomplete marker is set before bootstrap', () => {
  it('beginCampFileLoad marks the profile before any camp exists; a launch after bootstrap-ok / load-never-ran reports loadIncomplete and allows Start over', async () => {
    await writeSavedFile()
    const { d, handlers } = campLessHandlers()
    choose(savedFilePath)
    await handlers.pickCampFile()
    expect(handlers.beginCampFileLoad()).toEqual({ ok: true })
    expect(readLoadIncomplete(d)).not.toBeNull()
    await handlers.chooseMode({ mode: 'host', campName: 'Camp A' })
    await handlers.bootstrapCamp({ campName: 'Camp A', adminName: 'Director', adminPin: '135790' })
    expect(readCampStatus(d)).toMatchObject({ loadIncomplete: true })
    expect(canStartOver(d)).toBe(true)
  })

  it('refuses to begin with no picked file, and once a camp exists', async () => {
    const { handlers } = campLessHandlers()
    expect(handlers.beginCampFileLoad()).toMatchObject({ ok: false, reason: 'no_file_picked' })
    const existing = makeHandlers(db, deviceId, { campFileDialogs: dialogs })
    expect(existing.beginCampFileLoad()).toMatchObject({ ok: false })
    expect(readLoadIncomplete(db)).toBeNull()
  })

  it('picking again (backing out and choosing another file) clears a marker left with no camp behind it', async () => {
    await writeSavedFile()
    const { d, handlers } = campLessHandlers()
    choose(savedFilePath)
    await handlers.pickCampFile()
    handlers.beginCampFileLoad()
    dialogs.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await handlers.pickCampFile()
    expect(readLoadIncomplete(d)).toBeNull()
  })

  it('a completed load clears it', async () => {
    await writeSavedFile()
    const { d, handlers } = campLessHandlers()
    choose(savedFilePath)
    await handlers.pickCampFile()
    handlers.beginCampFileLoad()
    await handlers.chooseMode({ mode: 'host', campName: 'Camp A' })
    await handlers.bootstrapCamp({ campName: 'Camp A', adminName: 'Director', adminPin: '135790' })
    const { token } = await handlers.login({ name: 'Director', pin: '135790' })
    expect((await handlers.loadCampFile({ token })).ok).toBe(true)
    expect(readLoadIncomplete(d)).toBeNull()
  })
})
