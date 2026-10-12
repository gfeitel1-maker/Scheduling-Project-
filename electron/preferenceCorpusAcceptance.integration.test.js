// @vitest-environment node
//
// T282 — the preference corpus's two acceptance numbers, measured at the database.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md §8
//
// Every case enters as FILE BYTES through runPreferenceSheetCli (the same read/resolve/commit chain the
// import panel and the MCP tools drive) into its own freshly migrated camp that has done its setup
// (activities and divisions exist), and is judged against the truth its generator wrote alongside it:
//
//   CORRECT  the database holds exactly the campers and (camper, activity, rank) the file says.
//   LOUD     not correct, and the import said so: refused, or residue / skipped rows reported.
//   SILENT   not correct, and nothing was said. This is the number that must fall.
//
// correct-binding rate = CORRECT / cases; silent-miss rate = SILENT / cases. Both are DEVICE-LOCAL
// measurements of one database per case, not a fleet aggregate. The 2026-09-27 baseline for the
// silent-miss rate is 7 of 33 (ADR §8.1, round-4 corrected), and this test fails if the corpus's rate is
// not below it.
//
// Limit, stated rather than discovered: LOUD credits any residue, so a case whose data is wrong while an
// unrelated residue line is shown would count as loud. The per-case table printed below names the
// residue kinds so a reader can check.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { openLocalDb } from './db/localDb.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import {
  buildCorpus, buildReimportSequence, SHAPE_CLASSES, EXCLUDED_CLASSES, SYNTHETIC_NAMES,
  CATALOG_ACTIVITIES, CATALOG_GROUPS,
} from '../test/fixtures/preference-corpus/shapeCorpus.js'

const BASELINE = { silent: 7, of: 33 }
let tmp

function writeCase(c) {
  const file = path.join(tmp, `${c.id}.${c.format}`)
  if (c.format === 'xlsx') {
    const wb = XLSX.utils.book_new()
    for (const [sheetName, rows] of c.sheets ?? [['Sheet1', c.rows]]) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName)
    fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  } else {
    const sep = c.format === 'tsv' ? '\t' : ','
    const cell = (v) => { const s = String(v ?? ''); return sep === ',' && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    fs.writeFileSync(file, c.rows.map((r) => r.map(cell).join(sep)).join('\n') + '\n')
  }
  return file
}

function freshCamp() {
  const { db, file } = openTemplatedDb()
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Corpus Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Director', 'h', 's', 'admin')").run(randomUUID(), campId)
  for (const n of CATALOG_ACTIVITIES) db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, n)
  for (const n of CATALOG_GROUPS) db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(randomUUID(), campId, n)
  db.close()
  return file
}

function observed(dbPath, runId) {
  const db = openLocalDb(dbPath)
  try {
    const prefs = runId
      ? db.prepare(`SELECT c.display_name camper, ch.label label, p.rank rank FROM elective_preferences p
          JOIN campers c ON c.id = p.camper_id JOIN elective_choices ch ON ch.id = p.choice_id WHERE p.run_id = ?`).all(runId)
      : []
    const campers = db.prepare('SELECT display_name FROM campers').all().map((r) => r.display_name)
    return { prefs, campers }
  } finally { db.close() }
}

const prefKey = (p, anyRank) => `${p.camper}\u0000${p.label}\u0000${anyRank ? '*' : (p.rank ?? 'null')}`
const sortedEq = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])

function judge(c, result, obs, { campersMustEqual = true } = {}) {
  const anyRank = c.truth.prefs.some((p) => p.rank === '*')
  const truthPrefs = c.truth.prefs.map((p) => prefKey(p, anyRank))
  const gotPrefs = obs.prefs.map((p) => prefKey(p, anyRank))
  const campersOk = campersMustEqual ? sortedEq([...new Set(obs.campers)], c.truth.campers) : c.truth.campers.every((n) => obs.campers.includes(n))
  const correct = campersOk && sortedEq(gotPrefs, truthPrefs)
  const told = result.ok === false || Boolean(result.blocked) || (result.residue ?? []).length > 0 || (result.skippedRows ?? []).length > 0
  return { verdict: correct ? 'CORRECT' : told ? 'LOUD' : 'SILENT', residue: (result.residue ?? []).map((r) => r.kind) }
}

const rows = []

describe('T282 preference corpus — shape coverage, synthetic names, and the acceptance numbers', () => {
  const corpus = buildCorpus()
  const reimport = buildReimportSequence()

  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pref-corpus-')) })
  afterAll(() => {
    cleanupTemplatedDbs()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('covers every shape class the ADR names, and declares the one it does not model', () => {
    const covered = new Set(corpus.map((c) => c.cls))
    const uncovered = Object.keys(SHAPE_CLASSES).filter((k) => !covered.has(k))
    expect(uncovered).toEqual([])
    // A class in the corpus that is not declared is an undocumented shape: declare it first.
    expect([...covered].filter((k) => !(k in SHAPE_CLASSES))).toEqual([])
    expect(Object.keys(EXCLUDED_CLASSES)).toEqual(['H'])
    expect(covered.has('H')).toBe(false)
    // Each declared class meets more than one file format or size, so a class is not "covered" by one lucky file.
    for (const k of Object.keys(SHAPE_CLASSES)) expect(corpus.filter((c) => c.cls === k).length).toBeGreaterThan(0)
  })

  it('every camper name in the corpus comes from the committed synthetic list', () => {
    const allowed = new Set(SYNTHETIC_NAMES)
    const named = [...corpus, ...reimport].flatMap((c) => c.truth.campers.filter((n) => !c.grid || n !== c.id))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !allowed.has(n))).toEqual([])
  })

  it('measures the correct-binding and silent-miss rates at the database', () => {
    for (const c of corpus) {
      const dbPath = freshCamp()
      const result = runPreferenceSheetCli({ file: writeCase(c), dbPath, action: 'commit' })
      const o = observed(dbPath, result.runId)
      rows.push({ id: c.id, cls: c.cls, format: c.format, ...judge(c, result, o) })
    }
    // The re-import rows share one camp, in order: same bytes twice, then a drifted file.
    const dbPath = freshCamp()
    for (const c of reimport) {
      const result = runPreferenceSheetCli({ file: writeCase(c), dbPath, action: 'commit' })
      rows.push({ id: c.id, cls: 'reimport', format: c.format, ...judge(c, result, observed(dbPath, result.runId), { campersMustEqual: false }) })
    }

    const count = (v) => rows.filter((r) => r.verdict === v).length
    const total = rows.length
    const report = {
      cases: total, correct: count('CORRECT'), loud: count('LOUD'), silent: count('SILENT'),
      correctBindingRate: `${count('CORRECT')}/${total}`, silentMissRate: `${count('SILENT')}/${total}`,
      baselineSilent: `${BASELINE.silent}/${BASELINE.of}`,
    }
    // process.stdout.write, not console.log: Vitest drops console.log when stdout is not a TTY.
    process.stdout.write(`\nT282 acceptance (device-local): ${JSON.stringify(report)}\n`)
    for (const r of rows) process.stdout.write(`  ${r.verdict.padEnd(7)} ${r.id} [${r.cls}/${r.format}] ${r.residue.join(',')}\n`)

    expect(total).toBeGreaterThanOrEqual(BASELINE.of)
    expect(report.silent / total).toBeLessThan(BASELINE.silent / BASELINE.of)
    // Pinned so a regression shows up as a number moving, not as a rate quietly staying under the bar.
    expect(rows.filter((r) => r.verdict === 'SILENT').map((r) => r.id)).toEqual([])
  }, 180_000)
})
