// T282 / T278 round 3 — run the probe corpus against TODAY'S CODE, unmodified.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md section 8
//
// This is a MEASUREMENT harness, not a test. It reports what the system does;
// it asserts nothing, because a baseline you assert on is a baseline you are
// tempted to move. Every probe enters at FILE BYTES through the same exported
// core the CLI, the MCP server and (for the preference reader) the renderer
// drive — `runPreferenceSheetCli` or `runIngestCli`. No probe hand-builds a
// `parsed` object; three incidents are on record from exactly that (T62,
// T197 round 1, the v78 fallback row).
//
// Each probe gets its OWN freshly bootstrapped temp database, so one probe's
// writes can never be read as another's, and the re-import probes are the only
// ones that share one.
//
//   node scripts/preferenceCorpusProbe.mjs            # table to stdout
//   node scripts/preferenceCorpusProbe.mjs --json <f> # also write raw results

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from './preferenceSheetCli.js'
import { runIngestCli } from './ingestCli.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'test/fixtures/preference-corpus')
const PROBES = path.join(DIR, 'probes')
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))

const TABLES = ['campers', 'elective_choices', 'elective_preferences', 'elective_assignment_runs',
  'groups', 'tiers', 'activities', 'days', 'time_blocks', 'schedule_templates', 'operations']

function bootstrapDb(dir) {
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Probe Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Probe', 'h', 's', 'admin')")
    .run(randomUUID(), campId)
  db.close()
  return dbPath
}

function snapshot(dbPath) {
  const db = openLocalDb(dbPath)
  try {
    const out = {}
    for (const t of TABLES) {
      try { out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c } catch { out[t] = null }
    }
    out._sample_choices = db.prepare('SELECT label FROM elective_choices LIMIT 5').all().map((r) => r.label)
    try {
      out._all_activities = db.prepare('SELECT name FROM activities').all().map((r) => r.name)
    } catch { out._all_activities = null }
    try {
      out._sample_groups = db.prepare('SELECT name FROM groups LIMIT 6').all().map((r) => r.name)
    } catch { out._sample_groups = [] }
    try {
      // NOTE: `campers` has no `division` column (electron/db/localDb.js:2677).
      // Probing for it is how that was found, and the catch is the finding.
      out._sample_divisions = [...new Set(db.prepare('SELECT division FROM campers').all().map((r) => r.division))]
    } catch (e) { out._sample_divisions = [`UNREADABLE: ${e.message}`] }
    try {
      out._sample_camper_names = db.prepare('SELECT display_name FROM campers LIMIT 4').all().map((r) => r.display_name)
    } catch { out._sample_camper_names = [] }
    return out
  } finally { db.close() }
}

const delta = (before, after) => {
  const d = {}
  for (const t of TABLES) if (after[t] !== before[t]) d[t] = `${before[t] ?? '-'} -> ${after[t] ?? '-'}`
  return d
}

function runOne(probe, dbPath) {
  const file = path.join(PROBES, probe.file)
  const before = snapshot(dbPath)
  let result, threw = null
  try {
    result = probe.entry === 'pref'
      ? runPreferenceSheetCli({ file, dbPath, action: 'commit' })
      : runIngestCli({ file, dbPath, action: 'commit', mode: 'add' })
  } catch (e) {
    threw = `${e.name}: ${e.message}`
    result = null
  }
  const after = snapshot(dbPath)
  return {
    threw,
    ok: result?.ok ?? null,
    exitCode: result?.exitCode ?? null,
    error: result?.error ?? null,
    blocked: result?.blocked ?? null,
    counts: result?.counts ?? null,
    mapping: result?.mapping ? {
      nameIndex: result.mapping.nameIndex,
      externalIdIndex: result.mapping.externalIdIndex,
      divisionIndex: result.mapping.divisionIndex,
      rankColumns: result.mapping.rankColumns,
      unmapped: result.mapping.unmapped,
    } : null,
    sameNameCampers: (result?.sameNameCampers ?? []).length,
    skippedRows: result?.skippedRows ?? [],
    summary: result?.summary ?? null,
    declinedPages: result?.declinedPages ?? null,
    residual: result?.residual ?? null,
    dbDelta: delta(before, after),
    dbAfter: after,
  }
}

// Classification is MECHANICAL from the observation, so it cannot flatter the
// system. (b) and (c) are separated by exactly one thing: whether the operator
// was told. (c) is the category that matters — the ticket exists because of one
// instance of it.
function classify(probe, obs) {
  if (obs.threw) return 'THREW'
  const wroteNothing = Object.keys(obs.dbDelta).filter((t) => t !== 'operations').length === 0
  if (obs.ok === false) return 'BREAKS LOUDLY'
  if (obs.blocked) return 'BREAKS LOUDLY'
  if (wroteNothing) return 'BREAKS SILENTLY'   // reported success and wrote nothing
  return 'COMMITTED'                            // needs a correctness read, below
}

const dirs = []
const results = []
const byId = new Map(manifest.probes.map((p) => [p.id, p]))

for (const probe of manifest.probes) {
  if (probe.reimport === 'same' || probe.reimport?.startsWith('drift-of-')) continue
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-corpus-'))
  dirs.push(dir)
  const dbPath = bootstrapDb(dir)
  const obs = runOne(probe, dbPath)
  results.push({ ...probe, observed: obs, bucket: classify(probe, obs) })
}

// The re-import pair shares ONE database on purpose: idempotency and drift are
// only observable across two sequential imports into the same camp.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-corpus-reimport-'))
  dirs.push(dir)
  const dbPath = bootstrapDb(dir)
  const p37 = byId.get('P37')
  const first = runOne(p37, dbPath)
  const second = runOne(p37, dbPath)
  const p38 = byId.get('P38')
  const drift = runOne(p38, dbPath)
  results.push({ ...p37, observed: { ...first, _second_import: second }, bucket: classify(p37, first) })
  results.push({ ...p38, observed: drift, bucket: classify(p38, drift) })
}

const jsonFlag = process.argv.indexOf('--json')
const out = {
  generated: new Date().toISOString().slice(0, 10),
  probes: results.length,
  buckets: results.reduce((a, r) => ({ ...a, [r.bucket]: (a[r.bucket] ?? 0) + 1 }), {}),
  results,
}
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  fs.mkdirSync(path.dirname(process.argv[jsonFlag + 1]), { recursive: true })
  fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(out, null, 2) + '\n')
}

// process.stdout.write, not console.log: Vitest and captured gate output drop
// console.log when stdout is not a TTY.
for (const r of results) {
  process.stdout.write(
    `${r.id}\t${r.entry}\t${r.bucket}\t` +
    `ok=${r.observed.ok} delta=${JSON.stringify(r.observed.dbDelta)}\n` +
    (r.observed.threw ? `      THREW ${r.observed.threw}\n` : '') +
    (r.observed.error ? `      error: ${r.observed.error}\n` : '') +
    (r.observed.blocked ? `      blocked: ${r.observed.blocked}\n` : '') +
    (r.observed.mapping ? `      mapping: ${JSON.stringify(r.observed.mapping)}\n` : '') +
    (r.observed.counts ? `      counts: ${JSON.stringify(r.observed.counts)}\n` : '') +
    (r.observed.skippedRows?.length ? `      skipped: ${JSON.stringify(r.observed.skippedRows)}\n` : '') +
    (r.observed.dbAfter?._sample_choices?.length ? `      choices: ${JSON.stringify(r.observed.dbAfter._sample_choices)}\n` : '') +
    (r.observed.dbAfter?._sample_divisions?.length ? `      divisions: ${JSON.stringify(r.observed.dbAfter._sample_divisions)}\n` : '') +
    (r.observed.dbAfter?._sample_camper_names?.length ? `      campers: ${JSON.stringify(r.observed.dbAfter._sample_camper_names)}\n` : '') +
    (r.observed.dbAfter?._sample_groups?.length ? `      groups: ${JSON.stringify(r.observed.dbAfter._sample_groups)}\n` : '') +
    (r.observed.summary ? `      summary: ${JSON.stringify(r.observed.summary).slice(0, 400)}\n` : '') +
    (r.observed.declinedPages?.length ? `      declinedPages: ${JSON.stringify(r.observed.declinedPages)}\n` : '') +
    (r.observed.dbAfter?._all_activities ? `      activities: ${JSON.stringify(r.observed.dbAfter._all_activities)}\n` : '') +
    (r.observed._second_import ? `      2nd import: ok=${r.observed._second_import.ok} delta=${JSON.stringify(r.observed._second_import.dbDelta)} err=${r.observed._second_import.error}\n` : '')
  )
}
process.stdout.write(`\n${JSON.stringify(out.buckets)}\n`)
for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
