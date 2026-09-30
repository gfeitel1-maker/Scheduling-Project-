// T198 — scripts/electivesCli.js's core: `preview`/`commit` are a LITERAL PASSTHROUGH to
// runPreferenceSheetCli (scripts/preferenceSheetCli.js already owns and tests that logic in full —
// see scripts/preferenceSheetCli.test.js), and `export` is the one new action, built from
// buildElectiveRunProjectionInput (electron/ops/electiveRunProjectionInput.js) the same way the MCP
// export tool is (scripts/mcp/tools.js's exportElectiveAssignmentsTool) — see the three-way parity
// assertion in electron/electiveAcceptanceSurfaces.integration.test.jsx for the full-fixture proof
// that the two agree.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from './preferenceSheetCli.js'
import { runElectivesCli } from './electivesCli.js'

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const SHEET = path.join(SAMPLES, 'fabricated-camper-preferences-100.csv')

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-electivescli-'))
}

function sliceOfSheet(dir, name, rows = 6) {
  const lines = fs.readFileSync(SHEET, 'utf8').trim().split('\n')
  const file = path.join(dir, name)
  fs.writeFileSync(file, `${[lines[0], ...lines.slice(1, rows + 1)].join('\n')}\n`)
  return file
}

function bootstrapDb(dir) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  const deviceId = randomUUID()
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  const userId = randomUUID()
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')")
    .run(userId, campId)
  db.close()
  return { dbPath, campId, deviceId, userId }
}

function bootstrapRun(dir) {
  const { dbPath, campId } = bootstrapDb(dir)
  const db = openLocalDb(dbPath)
  const runId = randomUUID()
  db.prepare(
    "INSERT INTO elective_assignment_runs (id, camp_id, name, status, source_sha256, solver_generation) VALUES (?, ?, 'Run 1', 'draft', 'deadbeef', 'gen-1')"
  ).run(runId, campId)
  db.close()
  return { dbPath, campId, runId }
}

describe('runElectivesCli', () => {
  const dirs = []
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true })
  })

  describe('preview / commit — literal passthrough', () => {
    it('preview returns exactly what runPreferenceSheetCli returns for the same arguments', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, userId } = bootstrapDb(dir)
      const file = sliceOfSheet(dir, 'sheet.csv')

      const viaElectivesCli = runElectivesCli({ action: 'preview', file, dbPath, authorUserId: userId })
      const direct = runPreferenceSheetCli({ file, dbPath, action: 'preview', authorUserId: userId })

      expect(viaElectivesCli).toEqual(direct)
      expect(viaElectivesCli.ok).toBe(true)
    })

    it('commit writes a run through the same path runPreferenceSheetCli uses directly', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, userId } = bootstrapDb(dir)
      const file = sliceOfSheet(dir, 'sheet.csv')

      const result = runElectivesCli({ action: 'commit', file, dbPath, authorUserId: userId })

      expect(result.ok).toBe(true)
      expect(result.runId).toBeTruthy()
      const db = openLocalDb(dbPath)
      const row = db.prepare('SELECT id FROM elective_assignment_runs WHERE id = ?').get(result.runId)
      db.close()
      expect(row).toBeTruthy()
    })
  })

  describe('export', () => {
    it('refuses without a runId', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)
      const result = runElectivesCli({ action: 'export', dbPath })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/runId/)
    })

    it('refuses for a db file that does not exist', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const result = runElectivesCli({ action: 'export', runId: 'x', dbPath: path.join(dir, 'nope.sqlite') })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/db not found/)
    })

    it('returns RUN_NOT_FOUND for an unknown run', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath } = bootstrapDb(dir)
      const result = runElectivesCli({ action: 'export', runId: 'does-not-exist', dbPath })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('RUN_NOT_FOUND')
    })

    it('rejects an unknown format', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, runId } = bootstrapRun(dir)
      const result = runElectivesCli({ action: 'export', runId, dbPath, format: 'yaml' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/format/)
    })

    it('format json returns the versioned combined projection document', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, runId } = bootstrapRun(dir)
      const result = runElectivesCli({ action: 'export', runId, dbPath, format: 'json' })
      expect(result.ok).toBe(true)
      expect(result.export.format_version).toBe(1)
      expect(result.export).toHaveProperty('child_schedules')
      expect(result.export).toHaveProperty('activity_rosters')
      expect(result.export).toHaveProperty('exceptions')
      expect(result.export).toHaveProperty('summary')
    })

    it('format xlsx writes a workbook to the given file', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, runId } = bootstrapRun(dir)
      const outFile = path.join(dir, 'out.xlsx')
      const result = runElectivesCli({ action: 'export', runId, dbPath, format: 'xlsx', file: outFile })
      expect(result.ok).toBe(true)
      expect(fs.existsSync(outFile)).toBe(true)
      const workbook = XLSX.read(fs.readFileSync(outFile), { type: 'buffer' })
      expect(workbook.SheetNames).toContain('Activity Roster')
    })

    it('rejects format xlsx without a file path', () => {
      const dir = makeTmpDir()
      dirs.push(dir)
      const { dbPath, runId } = bootstrapRun(dir)
      const result = runElectivesCli({ action: 'export', runId, dbPath, format: 'xlsx' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/file/)
    })
  })

  it('rejects an unknown action', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const result = runElectivesCli({ action: 'generate', dbPath })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown action/)
  })
})
