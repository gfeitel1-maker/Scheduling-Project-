// Tests for the ingestion CLI core (T51). Mirrors
// test/integration/scenarios/21-ingest-prior-year.js's temp-db setup, but
// drives the exported runIngestCli directly — not via a subprocess — so
// these exercise real logic and stay fast enough to be the focused gate.

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { runIngestCli } from './ingestCli.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-cli-'))
}

function bootstrapDb(dir) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  const deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  db.close()
  return { dbPath, campId, deviceId }
}

describe('runIngestCli', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('--preview writes nothing and reports created/updated/unchanged/conflict counts plus residuals', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const before = openLocalDb(dbPath)
    const countsBefore = {
      groups: before.prepare('SELECT COUNT(*) c FROM groups').get().c,
      activities: before.prepare('SELECT COUNT(*) c FROM activities').get().c,
      ops: before.prepare('SELECT COUNT(*) c FROM operations').get().c,
    }
    before.close()

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.summary.created.groups).toBe(14)
    expect(result.summary.held).toBe(false)
    expect(result.summary.conflicts).toBe(0)
    expect(typeof result.summary.unchanged).toBe('number')
    expect(Array.isArray(result.residual.cells)).toBe(true)
    expect(Array.isArray(result.residual.sheets)).toBe(true)

    const after = openLocalDb(dbPath)
    expect(after.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(countsBefore.groups)
    expect(after.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(countsBefore.activities)
    expect(after.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(countsBefore.ops)
    after.close()
  })

  it('--commit writes the expected rows', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.summary.created.groups).toBe(14)

    const db = openLocalDb(dbPath)
    expect(db.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(14)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups'").get().c).toBeGreaterThan(0)
    db.close()
  })

  it('--json result has the stable documented keys', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview', json: true })

    for (const key of ['ok', 'action', 'mode', 'file', 'db', 'error', 'summary', 'conflicts', 'residual', 'exitCode']) {
      expect(result).toHaveProperty(key)
    }
    for (const key of ['created', 'updated', 'unchanged', 'conflicts', 'held', 'total', 'fixedEventsCreated']) {
      expect(result.summary).toHaveProperty(key)
    }
  })

  it('errors on a missing file', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: path.join(dir, 'nope.txt'), dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/cannot read file/)
  })

  it('errors on a missing db', () => {
    const dir = makeTmpDir()
    dirs.push(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath: path.join(dir, 'nope.sqlite'), action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/db not found/)
  })

  it('errors on a db with no camp bootstrapped', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const dbPath = path.join(dir, 'shoresh.sqlite')
    openLocalDb(dbPath).close() // fresh schema, no camps row

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/no camp bootstrapped/)
  })

  it('attributes written ops to --author when given, and leaves them unattributed when omitted', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const db0 = openLocalDb(dbPath)
    const userId = randomUUID()
    db0.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, (SELECT id FROM camps LIMIT 1), 'Ruth', 'h', 's', 'admin')")
      .run(userId)
    db0.close()

    const withAuthor = runIngestCli({ file: SAMPLE, dbPath, action: 'commit', authorUserId: userId })
    expect(withAuthor.ok).toBe(true)

    const db1 = openLocalDb(dbPath)
    const unattributed = db1
      .prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id IS NULL")
      .get().c
    const attributed = db1
      .prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id = ?")
      .get(userId).c
    expect(unattributed).toBe(0)
    expect(attributed).toBeGreaterThan(0)
    db1.close()
  })

  it('leaves ops unattributed when --author is omitted', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })
    expect(result.ok).toBe(true)

    const db = openLocalDb(dbPath)
    const attributed = db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups' AND author_user_id IS NOT NULL").get().c
    expect(attributed).toBe(0)
    db.close()
  })

  it('re-importing the same file twice creates nothing new the second time', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })
    const second = runIngestCli({ file: SAMPLE, dbPath, action: 'commit' })

    expect(second.ok).toBe(true)
    expect(second.summary.created.groups).toBe(0)
    expect(second.summary.created.activities).toBe(0)
  })

  // T224 — the CLI/MCP path must refuse a workbook that is not a schedule.
  //
  // Found by running a synthetic camper elective-selection sheet through this
  // CLI: it committed the form's COLUMN HEADERS ('#1', '#2', 'Division', ...)
  // as camp groups and again as tiers, reported ok/exitCode 0, and dropped
  // every camper name without a warning. src/ingest/scheduleShape.js already
  // implements this refusal and was imported only from ImportScreen.jsx, so
  // the UI enforced a gate the CLI and the MCP tools bypassed entirely.
  //
  // The fixture is fabricated here at runtime rather than committed: it stands
  // in for a real camp's selection form, and no such artifact belongs in this
  // repo.
  function writeSelectionSheet(dir) {
    const header = ['Camper Name', 'Division', 'Swim Alternative (Y/N)', '#1', '#2', '#3', '#4', '#5']
    const rows = [
      header,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga', 'Sailing', 'Ceramics', 'Tennis'],
      ['Noa Katz', 'Bogrim', 'Y', 'Ceramics', 'Tennis', 'Archery', 'Gaga', 'Sailing'],
      ['Lev Stern', 'Arad', 'N', 'Sailing', 'Archery', 'Tennis', 'Ceramics', 'Gaga'],
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Camper Selections')
    const file = path.join(dir, 'selections.xlsx')
    fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    return file
  }

  it('refuses a camper selection sheet instead of committing its column headers as groups', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const file = writeSelectionSheet(dir)

    const result = runIngestCli({ file, dbPath, action: 'commit' })

    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.error).toMatch(/schedule/i)
    // No proposal was formed at all, so there is nothing to mistake for a
    // partial success.
    expect(result.summary).toBeNull()

    // And the refusal is a refusal, not a report: the database is untouched.
    const after = openLocalDb(dbPath)
    expect(after.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(0)
    expect(after.prepare('SELECT COUNT(*) c FROM tiers').get().c).toBe(0)
    expect(after.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(0)
    after.close()
  })

  // Guards the other half: the gate must not start refusing real schedules.
  it('still accepts a real schedule file', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const result = runIngestCli({ file: SAMPLE, dbPath, action: 'preview' })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  // T223 — the gate above is whole-FILE (isScheduleShaped is `pages.some`),
  // so a workbook with ONE schedule-shaped tab used to launder every sibling
  // tab through extraction. A camper-selection tab living alongside a real
  // schedule tab in the SAME file committed the selection tab's headers as
  // groups/tiers while still reporting exit 0. Fixed by extracting only from
  // pages that individually pass the gate (partitionSchedulePages), and
  // surfacing the declined tab rather than dropping it silently.
  function writeMixedWorkbook(dir) {
    const selectionHeader = ['Camper Name', 'Division', 'Swim Alternative (Y/N)', '#1', '#2']
    const selectionRows = [
      selectionHeader,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga'],
      ['Noa Katz', 'Bogrim', 'Y', 'Ceramics', 'Tennis'],
    ]
    const scheduleHeader = ['Time', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    const scheduleRows = [
      scheduleHeader,
      ['9:00-9:20', 'Swim', 'Art', 'Swim', 'Art', 'Swim'],
      ['9:20-9:40', 'Art', 'Swim', 'Art', 'Swim', 'Art'],
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(selectionRows), 'Camper Selections')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scheduleRows), 'Elective Menu')
    const file = path.join(dir, 'mixed.xlsx')
    fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    return file
  }

  it('commits a mixed workbook, reporting the declined tab and never creating its headers as groups/tiers', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const file = writeMixedWorkbook(dir)

    const result = runIngestCli({ file, dbPath, action: 'commit' })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.declinedPages).toEqual(['Camper Selections'])

    const after = openLocalDb(dbPath)
    const groupNames = after.prepare('SELECT name FROM groups').all().map((r) => r.name)
    const tierNames = after.prepare('SELECT name FROM tiers').all().map((r) => r.name)
    expect(groupNames).not.toContain('Division')
    expect(tierNames).not.toContain('#1')
    expect(tierNames).not.toContain('Swim Alternative (Y/N)')
    after.close()
  })
})
