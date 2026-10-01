// Tests for the headless camper-preference-sheet importer (T226).
//
// Mirrors scripts/ingestCli.test.js: a real temp db, real fixture files, the
// exported core called directly — no subprocess, no MCP envelope. The stdio
// round trip is covered separately in scripts/mcp/preferenceSheetE2E.test.js.
//
// Every expectation is derived from the FIXTURE (re-read and counted here),
// never read back out of the module under test.

import { describe, it, expect, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../electron/db/testDbTemplate.js'
import { runPreferenceSheetCli } from './preferenceSheetCli.js'
import { deriveCamperId, electiveChoiceLabelKey } from '../electron/ops/electiveDerivedIds.js'

afterAll(cleanupTemplatedDbs)

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

// A SMALL SLICE of the same fixture, written into the test's own temp dir.
//
// The two run-identity tests below assert a property of
// deriveImportedElectiveRunId(camp_id, source_sha256) — a pure function of the
// camp and the document's BYTES. Row count has no bearing on it, so proving it
// against the full sheet bought no coverage and paid ~8,564 field-level op rows
// per commit for the privilege (the op log is per entity/field: 1,000
// preferences x 8 fields, 100 campers x 5, plus choices and the run). Both
// tests commit TWICE. A six-row slice is ~565 rows per commit instead.
//
// Stated as work rather than as seconds ON PURPOSE. These two tests were once
// justified with wall-clock timings taken on a shared 4-core machine at load
// 70-517, and that was not a measurement: identical reps of one commit in one
// process ranged 2.2s to 9.8s wall against ~0.9s CPU. Wall clock here says what
// else was running, not what this code costs. If you need to re-justify the
// slice, count op rows or use process.cpuUsage() with the arms interleaved.
//
// The slice keeps the real header and real rows, so the parse/commit/derive
// path is the identical one; only the volume changes. The 100-camper volume is
// still covered, by the exact-counts test above and by
// scripts/mcp/preferenceSheetE2E.test.js over the stdio transport.
function sliceOfSheet(dir, name, rows = 6) {
  const lines = fs.readFileSync(SHEET, 'utf8').trim().split('\n')
  const file = path.join(dir, name)
  fs.writeFileSync(file, `${[lines[0], ...lines.slice(1, rows + 1)].join('\n')}\n`)
  return file
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-prefcli-'))
}

function bootstrapDb(dir, { withCamp = true, withDevice = true } = {}) {
  const { db, file: dbPath } = openTemplatedDb()
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

  // Keeps the FULL 100-camper sheet where the two run-identity tests below take
  // a six-row slice, and the asymmetry is deliberate: here the cost IS the
  // purpose. This asserts the whole document lands exactly the rows the fixture
  // describes, at the scale where derived-id collisions and name-dedup
  // regressions have actually been caught. Slicing it would delete the coverage
  // rather than make it cheaper.
  //
  // It briefly carried a per-test timeout override. The commit writes 8,564
  // field-level op rows (1,000 preferences x 8 fields, 100 campers x 5, plus
  // choices and the run), and `appendOp` was opening a per-op SAVEPOINT inside
  // the boundary `runAtomic` had already promised — which obliged SQLite to keep
  // sub-journal undo records for every write inside it. T309 fixed that
  // (`insideAtomicBoundary`, electron/ops/operations.js), so the override is
  // gone and this runs at the default testTimeout again.
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
    const sheet = sliceOfSheet(dir, 'resent.csv')
    const expected = readFixtureExpectations(sheet)

    const first = runPreferenceSheetCli({ file: sheet, dbPath, action: 'commit', authorUserId: userId })
    expect(first.ok).toBe(true)
    const afterFirst = counts(dbPath)
    expect(afterFirst.runs).toBe(1)
    // The slice really imported a populated run. Without this, an unreadable
    // slice would write nothing and every "unchanged" assertion below would
    // hold vacuously — the test would go green by importing twice as hard as
    // it could not import once.
    expect(expected.campers).toBeGreaterThan(1)
    expect(expected.preferences).toBeGreaterThan(1)
    expect(afterFirst.campers).toBe(expected.campers)
    expect(afterFirst.preferences).toBe(expected.preferences)

    const second = runPreferenceSheetCli({ file: sheet, dbPath, action: 'commit', authorUserId: userId })
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

    const original = sliceOfSheet(dir, 'original.csv')
    const corrected = path.join(dir, 'corrected.csv')
    const lines = fs.readFileSync(original, 'utf8').trim().split('\n')
    // One camper's name spelled differently — a real correction, still valid.
    lines[1] = lines[1].replace(/^([^,]*,)([^,]*)/, '$1Corrected Name')
    fs.writeFileSync(corrected, `${lines.join('\n')}\n`)
    expect(fs.readFileSync(corrected)).not.toEqual(fs.readFileSync(original))

    const a = runPreferenceSheetCli({ file: original, dbPath, action: 'commit' })
    const b = runPreferenceSheetCli({ file: corrected, dbPath, action: 'commit' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.runId).not.toBe(a.runId)
    expect(counts(dbPath).runs).toBe(2)
    // Non-vacuity again: two runs of a document that imported NOTHING would
    // also carry two different ids.
    expect(counts(dbPath).campers).toBeGreaterThan(1)
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

  // T285 SLICE A INVERTED THIS TEST DELIBERATELY, and the history is worth
  // keeping rather than overwriting.
  //
  // It used to assert that two columns headed '#1' are REFUSED, naming the header
  // rather than the camper (Red Hat F3 — blaming the camper sent a director
  // hunting through rows for a data problem that is not there). The half about
  // WHO to blame was right and still holds. The refusal was wrong: ADR §14.1
  // rules that shape is not a reason to refuse ingest, and ADR §4.1 says two
  // columns claiming one rank is an UNORDERED SET — a tie among equals — which is
  // perfectly readable. So the file now imports, those choices carry rank NULL
  // rather than an order invented from column position, and a
  // DUPLICATED_RANK_HEADER residue item names the rank and the columns.
  //
  // The original worry is ANSWERED, not dropped: an unranked preference is exempt
  // from the contradictory-ranks check, so no director is sent hunting rows for a
  // row-1 problem. That assertion is kept below.
  it('reads duplicate rank columns as an unordered set, naming the header not the campers', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const file = path.join(dir, 'dup-rank-header.csv')
    fs.writeFileSync(file, 'Camper Name,Division,#1,#1\nAri Green,Aleph,Swim,Archery\n')

    const result = runPreferenceSheetCli({ file, dbPath, action: 'preview' })

    expect(result.ok).toBe(true)
    expect(result.blocked).toBeNull()
    // Never blamed on a camper — the surviving half of Red Hat F3. There is no
    // error at all now, which is the strongest form of "not blamed on a camper".
    expect(result.error).toBeNull()

    const dup = result.residue.filter((r) => r.kind === 'DUPLICATED_RANK_HEADER')
    expect(dup).toHaveLength(1)
    expect(dup[0].rank).toBe(1)
    expect(dup[0].columns).toEqual(['C', 'D'])
    expect(dup[0].message).toMatch(/equally acceptable/)
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

  // The LIVE-WALK condition (board item i-same-name-sheet-solves-silently-
  // dropping-a-camper, seen 2026-09-30 on the acceptance camp). The test above
  // uses an EMPTY catalog, so every row is read and the collision is obvious. The
  // real camp had a CATALOG, and the second Ari's choices (Robotics/Soccer/Dance)
  // were outside it — so that row was skipped as junk BEFORE the same-name guard
  // could see it, the sheet solved 2 of 3, and nothing said who was dropped. With
  // a partial catalog the preview must still block and the commit must write
  // nothing, through the real CLI ingest path.
  it('blocks the same-name sheet even when a same-name row’s choices are outside the camp catalog, writing nothing', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath, campId } = bootstrapDb(dir)
    // Ari #1's choices (Archery, Ceramics) are catalogued; Ari #2's
    // (Robotics, Soccer, Dance) are not — the live-walk shape.
    const seed = openLocalDb(dbPath)
    for (const name of ['Archery', 'Ceramics']) {
      seed.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, name)
    }
    seed.close()
    const before = counts(dbPath)

    const preview = runPreferenceSheetCli({ file: SAME_NAME_SHEET, dbPath, action: 'preview' })
    expect(preview.ok).toBe(true)
    expect(preview.sameNameCampers).toHaveLength(1)
    expect(preview.sameNameCampers[0].display_name).toBe('Ari Feldman')
    // The divisions are what let a director tell the two children apart.
    expect(preview.sameNameCampers[0].divisionLabels).toEqual(['Alonim', 'Nitzanim'])
    expect(preview.blocked).toMatch(/more than one row/)

    const commit = runPreferenceSheetCli({ file: SAME_NAME_SHEET, dbPath, action: 'commit' })
    expect(commit.ok).toBe(false)
    expect(commit.error).toMatch(/more than one row/)
    expect(counts(dbPath)).toEqual(before)
  })

  // T285 SLICE E/F INVERTED THIS DELIBERATELY. It used to assert that a SCHEDULE
  // file fed to the preference reader is REFUSED for having no ranked columns.
  //
  // ADR §14.1 rules that the machine seam never refuses a file it can read: the
  // CLI and MCP tools exist so an agent can drive this software, and a refusal
  // there is the bridge failing rather than a safety property. So the file is now
  // ACCEPTED, and the safety property that actually mattered is asserted directly
  // instead of being inferred from the refusal: NOTHING IS WRITTEN. The reader
  // says what it could not resolve rather than declining to look.
  //
  // This is also the case that keeps constraint 1 honest. A schedule grid and a
  // filled planner are the same geometry (ADR §3.3), so nothing here decides which
  // it is; it states the one thing true of both — the page names no camper, so it
  // holds no camper preferences.
  it('accepts a schedule file, writes nothing, and says what it could not resolve', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = bootstrapDb(dir)

    const result = runPreferenceSheetCli({ file: SCHEDULE_SAMPLE, dbPath, action: 'preview' })

    expect(result.ok).toBe(true)
    expect(result.counts).toEqual({ campers: 0, choices: 0, preferences: 0 })
    // The whole point: read, not written.
    expect(counts(dbPath).operations).toBe(0)
    expect(counts(dbPath).campers).toBe(0)

    const misses = result.residue.filter((r) => r.kind === 'NO_CAMPER_NAMES' || r.kind === 'NO_READABLE_CHOICES')
    expect(misses.length).toBeGreaterThan(0)
    for (const m of misses) {
      expect(m.head.length).toBeGreaterThan(0)
      expect(m.why.length).toBeGreaterThan(20)
    }
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

  // Board item i-declared-camper-dropped-when-all-choices-outside-catalog. The
  // CLI reads its own camp's roster into the catalog (same change as
  // AssignmentPanel's own door), so a sheet row naming an EXISTING camper whose
  // choices are all outside a PARTIAL catalog is DECLARED and imported with no
  // preferences, named in residue — not silently dropped as junk.
  //
  // The roster match decides keep-vs-skip ONLY; the row's camper id is derived
  // from the row itself (name-mode, since the sheet carries no id), NEVER
  // substituted from the roster camper's stored id. Here the roster camper was
  // itself created name-mode (the ordinary re-import case), so the row's own
  // derivation CONVERGES onto it by id-equality — no second row, no clobber —
  // which is how convergence is supposed to work, rather than by reaching into
  // the roster for an id (which would re-key a different same-named child onto
  // this camper, and null its external id on commit).
  it('imports a roster camper with no preferences, and names them in residue, when their sheet choices are all outside a partial catalog', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath, campId } = bootstrapDb(dir)
    const seed = openLocalDb(dbPath)
    // Partial catalog — the camp has Archery, not Robotics/Soccer.
    seed.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, 'Archery')
    // T321: the roster camper's own id is a random token, resolved through
    // camper_identity_keys — seed that mapping too, or this row reads as a
    // pre-migration, un-backfilled camper (accepted limitation: converges
    // only on a LATER touch, not this one) rather than the ordinary
    // already-converged re-import case this test means to cover.
    const lookupId = deriveCamperId(campId, { displayName: 'Ari Green' })
    const camperId = randomUUID()
    seed.prepare('INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, ?)')
      .run(camperId, campId, 'Ari Green')
    seed.prepare(
      'INSERT INTO camper_identity_keys (id, camp_id, key_mode, key_value, camper_id) VALUES (?, ?, ?, ?, ?)'
    ).run(lookupId, campId, 'name', electiveChoiceLabelKey('Ari Green'), camperId)
    seed.close()
    const before = counts(dbPath)

    const file = path.join(dir, 'prefs.csv')
    fs.writeFileSync(file, 'Camper Name,Division,#1,#2\nAri Green,Arad,Robotics,Soccer\n')

    const preview = runPreferenceSheetCli({ file, dbPath, action: 'preview' })
    expect(preview.ok).toBe(true)
    expect(preview.blocked).toBeNull()
    expect(preview.counts.campers).toBe(1)
    expect(preview.counts.preferences).toBe(0)
    const finding = preview.residue.filter((r) => r.kind === 'NO_RECOGNISABLE_CHOICE')
    expect(finding).toHaveLength(1)
    expect(finding[0].head).toContain('Ari Green')

    const commit = runPreferenceSheetCli({ file, dbPath, action: 'commit' })
    expect(commit.ok).toBe(true)
    const after = counts(dbPath)
    // The EXISTING roster camper — no second row minted.
    expect(after.campers).toBe(before.campers)
    expect(after.preferences).toBe(before.preferences)

    const db = openLocalDb(dbPath)
    try {
      const camper = db.prepare('SELECT id FROM campers WHERE display_name = ?').get('Ari Green')
      expect(camper.id).toBe(camperId)
    } finally {
      db.close()
    }
  })
})

// Board item 9b — THE CLI DOOR SEES BUNDLE NAMES.
//
// Kept as its own describe because it needs a camp with an elective set and a
// bundle, which none of the fixtures above have. The assertion is OBSERVABLE
// rather than a peek at the catalog object: a label a bundle claims must stop
// coming back as UNRESOLVED_CHOICE_LABEL residue. Asserting on the catalog
// itself would pass against a catalog nothing reads.
describe('runPreferenceSheetCli — a bundle is a label a sheet may name', () => {
  const dirs = []
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  const BUNDLE_NAME = 'Ropes Intensive'

  function campWithBundle(dir, { inAnotherSet = false } = {}) {
    const { dbPath, campId, userId } = bootstrapDb(dir)
    const db = openLocalDb(dbPath)
    const activityId = randomUUID()
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, 'Ropes')
    const setId = randomUUID()
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(setId, campId, 'Session 1')
    let ownerSetId = setId
    if (inAnotherSet) {
      ownerSetId = randomUUID()
      db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)')
        .run(ownerSetId, campId, 'Session 2')
    }
    db.prepare('INSERT INTO elective_bundles (id, elective_set_id, activity_id, name) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), ownerSetId, activityId, BUNDLE_NAME)
    db.close()
    return { dbPath, campId, userId }
  }

  function sheetNaming(dir, label) {
    const file = path.join(dir, 'prefs.csv')
    fs.writeFileSync(file, `Camper,Division,#1\nAvi Cohen,Older,${label}\n`)
    return file
  }

  it('a preference naming a bundle by its director-given name resolves', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = campWithBundle(dir)

    const out = runPreferenceSheetCli({ file: sheetNaming(dir, BUNDLE_NAME), dbPath, action: 'preview' })

    expect(out.error).toBe(null)
    expect(out.residue.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL' && r.label === BUNDLE_NAME)).toEqual([])
    expect(out.counts.preferences).toBe(1)
  })

  it('a bundle in ANOTHER elective set resolves too — the read is CAMP-WIDE', () => {
    // Deliberate, and it is the whole reason this door reads camp-wide rather
    // than scoping to one set: the panel door has no single set to scope by at
    // classification time either, and a bundle that resolves through one door
    // and not the other is exactly the two-catalogues drift
    // buildPreferenceCatalog exists to prevent.
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = campWithBundle(dir, { inAnotherSet: true })

    const out = runPreferenceSheetCli({ file: sheetNaming(dir, BUNDLE_NAME), dbPath, action: 'preview' })

    expect(out.residue.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL' && r.label === BUNDLE_NAME)).toEqual([])
  })

  it('a label NO bundle and no activity claims is still unresolved — the catalogue did not go blind', () => {
    const dir = makeTmpDir()
    dirs.push(dir)
    const { dbPath } = campWithBundle(dir)

    const out = runPreferenceSheetCli({ file: sheetNaming(dir, 'Underwater Basketweaving'), dbPath, action: 'preview' })

    expect(out.residue.some((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL' && r.label === 'Underwater Basketweaving'))
      .toBe(true)
  })
})
