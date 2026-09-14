// Build the historical database fixtures used by
// electron/db/eraMigration.test.js (T154), from the REAL localDb.js of the era
// — checked out of git history, not reconstructed by today's code.
//
// That distinction is the whole point. A fixture produced by running today's
// migration chain up to version N proves only that today's code agrees with
// itself; it cannot catch a migration that mis-reads a shape today's code would
// never have written. These are built by the code that actually shipped.
//
// Run from the repo root:  node scripts/fixtures/make-era-fixtures.mjs
// Commit whatever it writes under test/fixtures/eras/.
//
// Deterministic: fixed ids, fixed timestamps, no randomness — so re-running it
// produces the same bytes and a diff means a real change.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'test/fixtures/eras')

// One per meaningful era. `sha` is the commit whose localDb.js is used; `v` is
// the schema version that code migrates to, recorded in the filename so a
// reader does not have to run anything to know what they are looking at.
const ERAS = [
  { name: 'v10-renderer-local-first', sha: '9e49ec0', v: 10 },
  { name: 'v23-two-route-schedules', sha: '0f951b8', v: 23 },
  { name: 'v34-special-days', sha: 'b47fefd', v: 34 },
  { name: 'v48-tile-world', sha: '1b0452f', v: 48 },
]

// A small camp, written with plain SQL against whatever tables that era had.
// Deliberately minimal and defensive: every insert is attempted and a failure
// on a table that did not exist yet is skipped, so one script covers every era.
const CAMP = 'camp-era-0000'
const SEED = [
  `INSERT INTO camps (id, name) VALUES ('${CAMP}', 'Era Camp')`,
  `INSERT INTO cohorts (id, camp_id, name) VALUES ('coh-1', '${CAMP}', 'Main')`,
  `INSERT INTO tiers (id, camp_id, name, cohort_id) VALUES ('tier-1', '${CAMP}', 'Aleph', 'coh-1')`,
  `INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('grp-1', '${CAMP}', 'Bunk 1', 'tier-1')`,
  `INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('grp-2', '${CAMP}', 'Bunk 2', 'tier-1')`,
  `INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES ('day-1', '${CAMP}', 'Monday', 1, 0)`,
  `INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES ('day-2', '${CAMP}', 'Tuesday', 2, 1)`,
  `INSERT INTO time_blocks (id, camp_id, name, cohort_id, sort_order) VALUES ('tb-1', '${CAMP}', 'Block 1', 'coh-1', 0)`,
  `INSERT INTO activities (id, camp_id, name) VALUES ('act-1', '${CAMP}', 'Swim')`,
  `INSERT INTO activities (id, camp_id, name) VALUES ('act-2', '${CAMP}', 'Archery')`,
  `INSERT INTO schedule_templates (id, camp_id, name) VALUES ('tpl-1', '${CAMP}', 'Week 1')`,
  `INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id) VALUES ('slot-1', 'tpl-1', 'grp-1', 'day-1', 'tb-1', 'act-1')`,
  `INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id) VALUES ('slot-2', 'tpl-1', 'grp-2', 'day-1', 'tb-1', 'act-2')`,
]

fs.mkdirSync(OUT, { recursive: true })
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-era-'))

for (const era of ERAS) {
  const dir = path.join(stage, era.sha)
  fs.mkdirSync(dir, { recursive: true })
  // localDb.js of the later eras imports siblings (projectManager, and a few
  // ops/* helpers). Copy the era's whole electron/db and electron/ops, so the
  // code that runs is that era's code all the way down rather than a hybrid of
  // old migrations and today's helpers — which is the failure mode this whole
  // fixture approach exists to avoid.
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', era.sha, 'electron/db', 'electron/ops'], { cwd: ROOT })
    .toString()
    .split('\n')
    .filter((f) => f && !f.endsWith('.test.js'))
  for (const file of files) {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // `git show` writes the blob exactly; localDb.js contains a load-bearing
    // NUL byte (see the repo's own notes), so this must stay a byte copy.
    fs.writeFileSync(target, execFileSync('git', ['show', `${era.sha}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }))
  }
  // The era's code lives outside node_modules, so point its better-sqlite3
  // import at this repo's copy by running it from a directory inside the repo.
  const runRoot = path.join(ROOT, 'node_modules', '.era-fixture', era.sha)
  for (const file of files) {
    const target = path.join(runRoot, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(dir, file), target)
  }

  const { openLocalDb } = await import(pathToFileURL(path.join(runRoot, 'electron/db/localDb.js')).href)
  const outPath = path.join(OUT, `${era.name}.sqlite`)
  fs.rmSync(outPath, { force: true })
  const db = openLocalDb(outPath)
  let applied = 0
  for (const sql of SEED) {
    try { db.prepare(sql).run(); applied += 1 } catch { /* table/column not in this era — expected */ }
  }
  const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v
  db.close()
  if (version !== era.v) {
    throw new Error(`${era.name}: expected schema v${era.v}, the era's own code produced v${version}`)
  }
  console.log(`${era.name}: schema v${version}, ${applied}/${SEED.length} seed rows`)
}

fs.rmSync(path.join(ROOT, 'node_modules', '.era-fixture'), { recursive: true, force: true })
fs.rmSync(stage, { recursive: true, force: true })
console.log(`\nwrote fixtures to ${path.relative(ROOT, OUT)}`)
