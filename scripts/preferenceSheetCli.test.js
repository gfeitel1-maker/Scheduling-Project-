// Tests for the headless camper-preference-sheet importer (T226).
//
// Mirrors scripts/ingestCli.test.js: a real temp db, real fixture files, the
// exported core called directly — no subprocess, no MCP envelope. The stdio
// round trip is covered separately in scripts/mcp/preferenceSheetE2E.test.js.
//
// Every expectation is derived from the FIXTURE (re-read and counted here),
// never read back out of the module under test.

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from './preferenceSheetCli.js'

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const SHEET = path.join(SAMPLES, 'fabricated-camper-preferences-100.csv')
const SAME_NAME_SHEET = path.join(SAMPLES, 'fabricated-camper-preferences-same-name.csv')
const SCHEDULE_SAMPLE = path.join(SAMPLES, 'campB-by-day.txt')

// Independent reading of the fixture, so the assertions below describe the
// SHEET rather than whatever the parser happened to produce.
function readFixtureExpectations(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  const header = lines[0].split(',')
  const rankColumns = header.map((h, i) => [h, i]).filter(([h]) => /^#\d+$/.test(h)).map(([, i]) => i)
  const body = lines.slice(1).map((l) => l.split(','))
  const labels = new Set()
  let preferences = 0
  for (const row of body) {
    for (const i of rankColumns) {
      const v = (row[i] ?? '').trim()
      if (!v) continue
      preferences += 1
      labels.add(v.toLowerCase().replace(/\s+/g, ''))
    }
  }
  return { campers: body.length, choices: labels.size, preferences, body, header }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-prefcli-'))
}

function bootstrapDb(dir, { withCamp = true, withDevice = true } = {}) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  let campId = null
  if (withCamp) {
    campId = randomUUID()
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  }
  let deviceId = null
  if (withDevice) {
    deviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  }
  const userId = randomUUID()
  if (campId) {
    db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')")
      .run(userId, campId)
  }
  db.close()
  return { dbPath, campId, deviceId, userId }
}

function counts(dbPath) {
  const db = openLocalDb(dbPath)
  try {
    const c = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    return {
      campers: c('campers'),
      choices: c('elective_choices'),
      preferences: c('elective_preferences'),
      runs: c('elective_assignment_runs'),
      operations: c('operations'),
    }
  } finally {
    db.close()
  }
}

describe('runPreferenceSheetCli', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('previews the 100-camper sheet without writing anything', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const before = counts(dbPath)
    const expected = readFixtureExpectations(SHEET)

    const result = runPreferenceSheetCli({ file: SHEET, dbPath, action: 'preview' })

    expect(result.error).toBe(null)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('preview')
    expect(result.counts).toEqual({
      campers: expected.campers,
      choices: expected.choices,
      preferences: expected.preferences,
    })
    expect(result.blocked).toBe(null)
    expect(result.sameNameCampers).toEqual([])
    expect(result.mapping.rankColumns).toHaveLength(10)
    expect(counts(dbPath)).toEqual(before)
  })

  it('commits the sheet and writes exactly the rows the fixture describes', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath, campId, userId } = bootstrapDb(dir)
    const expected = readFixtureExpectations(SHEET)

    const result = runPreferenceSheetCli({
      file: SHEET,
      dbPath,
      action: 'commit',
      runName: 'Session 1 preferences',
      authorUserId: userId,
    })

    expect(result.error).toBe(null)
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.runId).toBeTruthy()

    const after = counts(dbPath)
    expect(after.campers).toBe(expected.campers)
    expect(after.choices).toBe(expected.choices)
    expect(after.preferences).toBe(expected.preferences)
    expect(after.runs).toBe(1)

    const db = openLocalDb(dbPath)
    try {
      // A named camper's rank-1 choice resolves through elective_choices.label.
      const firstRow = expected.body[0]
      const name = firstRow[1]
      const camper = db.prepare('SELECT * FROM campers WHERE display_name = ?').get(name)
      expect(camper.camp_id).toBe(campId)
      expect(camper.external_id).toBe(firstRow[0])
      const rank1 = db
        .prepare(
          'SELECT c.label FROM elective_preferences p JOIN elective_choices c ON c.id = p.choice_id ' +
            'WHERE p.camper_id = ? AND p.rank = 1'
        )
        .get(camper.id)
      expect(rank1.label).toBe(firstRow[3])
      // Every preference in the run points at a choice in the same run.
      const orphans = db
        .prepare(
          'SELECT COUNT(*) c FROM elective_preferences p LEFT JOIN elective_choices c ON c.id = p.choice_id ' +
            'WHERE c.id IS NULL'
        )
        .get().c
      expect(orphans).toBe(0)
    } finally {
      db.close()
    }
  })

  // Red Hat F1. The run id is derived from (camp_id, source_sha256) on this
  // path, so re-sending the same document converges instead of duplicating the
  // whole run under a fresh random run id.
  it('is idempotent on the same bytes — a resent sheet does not duplicate the run', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath, userId } = bootstrapDb(dir)
    const expected = readFixtureExpectations(SHEET)

    const first = runPreferenceSheetCli({ file: SHEET, dbPath, action: 'commit', authorUserId: userId })
    expect(first.ok).toBe(true)
    const afterFirst = counts(dbPath)
    expect(afterFirst.runs).toBe(1)

    const second = runPreferenceSheetCli({ file: SHEET, dbPath, action: 'commit', authorUserId: userId })
    expect(second.ok).toBe(true)
    expect(second.runId).toBe(first.runId)

    const afterSecond = counts(dbPath)
    expect(afterSecond.campers).toBe(expected.campers)
    expect(afterSecond.choices).toBe(expected.choices)
    expect(afterSecond.preferences).toBe(expected.preferences)
    expect(afterSecond.runs).toBe(1)
    // Row-for-row unchanged; only the op-log grows (last-write-wins churn).
    expect(afterSecond.campers).toBe(afterFirst.campers)
    expect(afterSecond.choices).toBe(afterFirst.choices)
    expect(afterSecond.preferences).toBe(afterFirst.preferences)
    expect(afterSecond.operations).toBeGreaterThan(afterFirst.operations)
  })

  // The other half of the semantics: a CORRECTED sheet is a different
  // document, and must be its own run.
  it('treats a corrected sheet (different bytes) as a second run', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const corrected = path.join(dir, 'corrected.csv')
    const lines = fs.readFileSync(SHEET, 'utf8').trim().split('\n')
    // One camper's name spelled differently — a real correction, still valid.
    lines[1] = lines[1].replace(/^([^,]*,)([^,]*)/, '$1Corrected Name')
    fs.writeFileSync(corrected, `${lines.join('\n')}\n`)
    expect(fs.readFileSync(corrected)).not.toEqual(fs.readFileSync(SHEET))

    const a = runPreferenceSheetCli({ file: SHEET, dbPath, action: 'commit' })
    const b = runPreferenceSheetCli({ file: corrected, dbPath, action: 'commit' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.runId).not.toBe(a.runId)
    expect(counts(dbPath).runs).toBe(2)
  })

  // Red Hat F2. A raw 'FOREIGN KEY constraint failed' sends a director nowhere.
  it('refuses an author_user_id with no users row, naming the field and the value', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const before = counts(dbPath)
    const ghost = randomUUID()

    const result = runPreferenceSheetCli({ file: SHEET, dbPath, action: 'commit', authorUserId: ghost })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.error).toContain(ghost)
    expect(result.error).toContain('author_user_id')
    expect(result.error).not.toMatch(/FOREIGN KEY/)
    expect(counts(dbPath)).toEqual(before)
  })

  // Red Hat F3. Two columns headed '#1' is a HEADER defect; blaming the camper
  // sends a director hunting through rows for a data problem that is not there.
  it('refuses duplicate rank columns by naming the header, not the campers', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const before = counts(dbPath)

    const file = path.join(dir, 'dup-rank-header.csv')
    fs.writeFileSync(file, 'Camper Name,Division,#1,#1\nAri Green,Aleph,Swim,Archery\n')

    const result = runPreferenceSheetCli({ file, dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rank #1/)
    expect(result.error).toMatch(/column/i)
    expect(result.error).not.toMatch(/camper holds the same preference rank/)
    expect(counts(dbPath)).toEqual(before)
  })

  it('previews a same-name sheet as blocked, and commit refuses it, writing nothing', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)
    const before = counts(dbPath)

    const preview = runPreferenceSheetCli({ file: SAME_NAME_SHEET, dbPath, action: 'preview' })
    expect(preview.ok).toBe(true)
    expect(preview.sameNameCampers).toHaveLength(1)
    expect(preview.sameNameCampers[0].display_name).toBe('Ari Feldman')
    expect(preview.blocked).toMatch(/more than one row/)

    const commit = runPreferenceSheetCli({ file: SAME_NAME_SHEET, dbPath, action: 'commit' })
    expect(commit.ok).toBe(false)
    expect(commit.error).toMatch(/more than one row/)
    expect(commit.exitCode).toBe(1)
    expect(counts(dbPath)).toEqual(before)
  })

  it('refuses a file whose header has no ranked columns, naming what was not found', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runPreferenceSheetCli({ file: SCHEDULE_SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ranks/)
    expect(counts(dbPath).operations).toBe(0)
  })

  it('refuses a missing file, a missing db, a camp-less db and a device-less db', () => {
    const dir = makeTmpDir()
    dirs.push(dir)

    expect(runPreferenceSheetCli({ file: path.join(dir, 'nope.csv'), dbPath: path.join(dir, 'x.sqlite') }).error)
      .toMatch(/cannot read file/)

    expect(runPreferenceSheetCli({ file: SHEET, dbPath: path.join(dir, 'missing.sqlite') }).error)
      .toMatch(/db not found/)

    const noCamp = bootstrapDb(dir, { withCamp: false })
    expect(runPreferenceSheetCli({ file: SHEET, dbPath: noCamp.dbPath }).error).toMatch(/no camp/)

    const dir2 = makeTmpDir()
    dirs.push(dir2)
    const noDevice = bootstrapDb(dir2, { withDevice: false })
    // A device is only needed to WRITE — preview must still work without one.
    expect(runPreferenceSheetCli({ file: SHEET, dbPath: noDevice.dbPath, action: 'preview' }).ok).toBe(true)
    expect(runPreferenceSheetCli({ file: SHEET, dbPath: noDevice.dbPath, action: 'commit' }).error)
      .toMatch(/no device/)
  })
})
