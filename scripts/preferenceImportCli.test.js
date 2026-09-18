import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceImportCli } from './preferenceImportCli.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pref-cli-'))
}

function xlsxFile(dir, aoa) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1')
  const file = path.join(dir, 'prefs.xlsx')
  fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  return file
}

describe('runPreferenceImportCli', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('previews and reports resolutions', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const dbPath = path.join(dir, 'shoresh.sqlite')
    const db = openLocalDb(dbPath)
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('group-a', campId, 'Bunk A')
    db.close()

    const file = xlsxFile(dir, [
      ['Display Name', 'Group', 'Choice 1'],
      ['Alice Cohen', 'Bunk A', 'Swim'],
    ])
    const mapping = {
      displayName: 0,
      group: 1,
      externalId: null,
      noPreferenceValues: [],
      choices: [{ label: 'Choice 1', isLinked: false, memberColumns: [2] }],
    }

    const result = runPreferenceImportCli({ file, dbPath, camp_id: campId, run_id: 'run-1', mapping, action: 'preview' })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.result.camperResolutions[0].status).toBe('offered_new')
  })

  it('refuses any action other than preview', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const result = runPreferenceImportCli({ file: 'x', dbPath: 'y', camp_id: 'c', run_id: 'r', mapping: {}, action: 'commit' })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toMatch(/only supports action 'preview'/)
  })

  it('writes nothing (preview-only) — row counts unaffected', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const dbPath = path.join(dir, 'shoresh.sqlite')
    const db = openLocalDb(dbPath)
    const campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('group-a', campId, 'Bunk A')
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    db.close()

    const file = xlsxFile(dir, [
      ['Display Name', 'Group', 'Choice 1'],
      ['Alice Cohen', 'Bunk A', 'Swim'],
    ])
    const mapping = {
      displayName: 0,
      group: 1,
      externalId: null,
      noPreferenceValues: [],
      choices: [{ label: 'Choice 1', isLinked: false, memberColumns: [2] }],
    }
    runPreferenceImportCli({ file, dbPath, camp_id: campId, run_id: 'run-1', mapping, action: 'preview' })

    const db2 = openLocalDb(dbPath)
    const after = db2.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    db2.close()
    expect(after).toBe(before)
  })
})
