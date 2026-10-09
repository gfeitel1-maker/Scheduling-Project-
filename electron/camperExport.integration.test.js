// @vitest-environment node
//
// T353 — the camper export round-trips through the EXISTING preference-sheet
// import. Real templated DB (openAcceptanceCamp), real CLI import + commitElectiveRun,
// real .xlsx bytes on disk. Nothing between the export and the assertion is mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import { SHEET_RESOLVED } from './fixtures/electiveAcceptanceCamp.js'
import { exportCamperWorkbook, CAMPER_SHEET } from '../src/utils/exportCamperWorkbook.js'

let camp
let tmpDir

beforeAll(async () => {
  camp = await openAcceptanceCamp()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camper-export-'))
  const seeded = runPreferenceSheetCli({ file: SHEET_RESOLVED, dbPath: camp.file, action: 'commit', authorUserId: camp.userId })
  if (!seeded.ok) throw new Error(`seed import failed: ${seeded.error ?? seeded.blocked}`)
}, 60_000)
afterAll(() => {
  camp?.close()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

const all = (table) => camp.db.prepare(`SELECT * FROM ${table}`).all()
const camperRows = () => camp.db
  .prepare('SELECT id, display_name, external_id, division_label FROM campers WHERE camp_id = ? ORDER BY id')
  .all(camp.fixture.campId)

describe('T353 camper export → edit → re-import', () => {
  it('updates the edited field without duplicating or losing a camper', () => {
    const before = camperRows()
    const target = before.find((c) => c.external_id === 'SYN-1001')
    expect(target.division_label).toBe('Younger')

    const wb = exportCamperWorkbook({
      campers: all('campers'),
      groups: all('groups'),
      preferences: all('elective_preferences'),
      choices: all('elective_choices'),
    })

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[CAMPER_SHEET], { header: 1, defval: '' })
    const header = rows[0]
    const idCol = header.indexOf('Camper ID')
    const divCol = header.indexOf('Division')
    let edited = 0
    for (const row of rows.slice(1)) {
      if (row[idCol] === 'SYN-1001') { row[divCol] = 'Older'; edited += 1 }
    }
    expect(edited).toBeGreaterThan(0)

    const out = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), CAMPER_SHEET)
    const file = path.join(tmpDir, 'campers-edited.xlsx')
    fs.writeFileSync(file, XLSX.write(out, { type: 'buffer', bookType: 'xlsx' }))

    const result = runPreferenceSheetCli({ file, dbPath: camp.file, action: 'commit', authorUserId: camp.userId })
    expect(result.error ?? result.blocked ?? null).toBeNull()
    expect(result.ok).toBe(true)

    const after = camperRows()
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id))
    expect(after.find((c) => c.id === target.id).division_label).toBe('Older')
    for (const c of before.filter((x) => x.id !== target.id)) {
      expect(after.find((a) => a.id === c.id)).toEqual(c)
    }
  })
})
