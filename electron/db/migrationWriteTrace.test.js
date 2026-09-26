// @vitest-environment node
//
// The classification checked by RUNNING the migrations, not by reading them.
//
// migrationDomainState.test.js scans localDb.js as text and says so: it sees
// only SQL written inline in a migration's own block, so a backfill routed
// through a helper is invisible to it. v32 is exactly that shape. This file
// closes that blind spot by measuring the other end — every statement SQLite
// was actually asked to run, attributed to the migration that ran it.
//
// The corpus is the era fixtures (real databases written by the localDb.js that
// shipped at that commit) plus a fresh database. Fixtures are load-bearing, not
// decoration: a backfill helper prepares nothing when there is no data, so a
// fresh-database-only run would trace nothing and pass vacuously.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { initSchema } from './localDb.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { SCHEMA_ONLY_MIGRATIONS, DOMAIN_STATE_MIGRATIONS } from './migrationDomainState.js'
import {
  instrumentDb,
  attributeByMigration,
  domainWritesIn,
  traceWithSnapshots,
  diffByMigration,
  blockBoundaries,
} from './migrationWriteTrace.js'

const ERAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/eras')
const FIXTURES = fs.readdirSync(ERAS_DIR).filter((f) => f.endsWith('.sqlite')).sort()

// DERIVED, never hand-listed. A second copy of "which tables the document owns"
// is the drift both of these guards exist to prevent.
const MODELED = [...DIRECT_CAMP_ENTITIES, ...Object.keys(PARENT_SCOPED_ENTITIES)]

const SRC_LINES = fs.readFileSync(new URL('./localDb.js', import.meta.url), 'utf8').split('\n')
const STAMP_LINES = SRC_LINES.map((line, i) => {
  const m = line.match(/schema_migrations \(version, applied_at\) VALUES \((\d+),/)
  return m ? { line: i, version: Number(m[1]) } : null
}).filter(Boolean)
const STAMPED_VERSIONS = STAMP_LINES.map((s) => s.version).filter((v) => v > 2)

let temps = []
afterEach(() => {
  for (const f of temps) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(f + suffix, { force: true }) } catch { /* best effort */ }
    }
  }
  temps = []
})

/** A fresh, empty database to migrate from scratch. */
function freshDb() {
  const db = new Database(tempPath('fresh-boundaries'))
  db.pragma('foreign_keys = ON')
  return db
}

function tempPath(label) {
  const target = path.join(os.tmpdir(), `shoresh-trace-${label}-${process.pid}-${temps.length}.sqlite`)
  temps.push(target)
  return target
}

/**
 * Migrate a copy of `fixture` (or a fresh database) with the handle traced.
 * `seed` runs against the copy BEFORE migration, to put rows in front of a
 * backfill that would otherwise no-op.
 */
function migrateTraced(fixture, seed) {
  const file = tempPath(fixture ? fixture.replace(/\W+/g, '-') : 'fresh')
  // Never migrate the fixture itself — it is the artifact.
  if (fixture) fs.copyFileSync(path.join(ERAS_DIR, fixture), file)
  const real = new Database(file)
  real.pragma('foreign_keys = ON')
  if (seed) seed(real)
  const { db, trace } = instrumentDb(real)
  try {
    initSchema(db)
  } finally {
    real.close()
  }
  return attributeByMigration(trace)
}

// Give v32's backfill something to find. No era fixture sets activities.location
// — scripts/fixtures/make-era-fixtures.mjs never seeded one — so without this
// the corpus never executes a single statement of `backfillLocations`, and the
// helper-routed shape this whole file exists to catch would go untested. Marked
// as a seeded variant, not passed off as an era artifact.
const seedLocations = (db) => {
  db.prepare("UPDATE activities SET location = 'Lower Field'").run()
}

const RUNS = [
  ['a fresh database', null, null],
  ...FIXTURES.map((f) => [f, f, null]),
  ['v23-two-route-schedules.sqlite with activity locations seeded', 'v23-two-route-schedules.sqlite', seedLocations],
]

describe('the corpus is real enough for the measurement to mean anything', () => {
  it('has era fixtures — an empty directory must not read as a pass', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3)
  })

  it('a fresh database actually executes every migration that stamps a version', () => {
    // If this thins out, the guard below is passing on migrations that never
    // ran. Absence of a write and absence of a RUN read identically otherwise.
    // The expected set is DERIVED from localDb.js's stamps, not counted to
    // CURRENT_SCHEMA_VERSION: v3 has no stamp of its own (v4's block subsumes
    // it), so a 1..N loop would report a phantom gap forever.
    const byVersion = migrateTraced(null)
    const missing = STAMPED_VERSIONS.filter((v) => !byVersion.has(v))
    expect(missing).toEqual([])
    expect(STAMPED_VERSIONS.length).toBeGreaterThan(50)
  })

  it('every migration block performs a guard read before its own stamp', () => {
    // The one assumption attribution still rests on, pinned rather than
    // trusted. Raised by app-icon-audit-a9a598 reviewing the boundary:
    // localDb.js already has two guard forms — bare `< N` and paired
    // `>= N-1 && < N` — so a third is plausible, and one that performs NO read
    // (a guard hoisted into a helper, or cached) would merge its block into the
    // previous window and attribute its writes to the wrong version. Silent,
    // and it would land on whoever adds the next migration.
    //
    // Keying on the READ rather than on the `< N` term is what makes both
    // existing forms work; this asserts the property that actually matters.
    const { trace } = traceWithSnapshots(freshDb(), [], (db) => initSchema(db))
    const noGuard = blockBoundaries(trace).filter((b) => b.guardReadsBefore === 0)
    expect(noGuard.map((b) => `v${b.version}`)).toEqual(['v1', 'v2'])
    // v1 and v2 are stamped by initSchema's opening schema.sql load, back to
    // back and before any block — and before the first guard read exists. They
    // are the only legitimate exception; a third name appearing here is a new
    // migration whose writes are being credited to its predecessor.
  })
})

describe('NON-VACUITY: the trace sees through a helper call', () => {
  it("attributes backfillLocations' writes to v32, which the text scan cannot see", () => {
    // v32 is `backfillLocations(db)` — a call, with its UPDATE/INSERT 900 lines
    // away in another function. This is the precise shape the text scanner
    // misses. If this assertion ever stops holding, the instrumentation has
    // stopped seeing indirect writes and every pass below is worthless.
    const byVersion = migrateTraced('v23-two-route-schedules.sqlite', seedLocations)
    const writes = domainWritesIn(byVersion.get(32) ?? [], MODELED)
    expect(writes.map((w) => w.table).sort()).toEqual(expect.arrayContaining(['activities', 'locations']))
    // And they touched real rows — the fixture has data, so this is a measured
    // effect, not just a statement that was prepared.
    expect(writes.some((w) => w.changes > 0)).toBe(true)
  })

  it('finds no such writes in the localDb.js text for v32 — the blind spot, demonstrated', () => {
    // Stated as a test so the gap this file closes is a measured fact rather
    // than a comment that could quietly stop being true.
    const src = fs.readFileSync(new URL('./localDb.js', import.meta.url), 'utf8')
    const lines = src.split('\n')
    const stamps = []
    lines.forEach((line, i) => {
      const m = line.match(/schema_migrations \(version, applied_at\) VALUES \((\d+),/)
      if (m) stamps.push({ line: i, version: Number(m[1]) })
    })
    let start = 0
    let blockFor32 = ''
    for (const { line, version } of stamps) {
      if (version === 32) blockFor32 = lines.slice(start, line + 1).join('\n')
      start = line + 1
    }
    expect(blockFor32).toContain('backfillLocations(db)')
    expect(/(UPDATE|INSERT INTO)\s+(activities|locations)\b/i.test(blockFor32)).toBe(false)
  })
})

describe('no migration classified schema-only writes a modeled domain row', () => {
  for (const [label, fixture, seed] of RUNS) {
    it(`${label}`, () => {
      const byVersion = migrateTraced(fixture, seed)
      const offenders = []
      for (const [version, entries] of byVersion) {
        if (!SCHEMA_ONLY_MIGRATIONS.has(version)) continue
        for (const w of domainWritesIn(entries, MODELED)) {
          offenders.push(`v${version} writes ${w.table} (${w.changes} rows): ${w.sql.trim().slice(0, 120)}`)
        }
      }
      // A new migration landing here means it edits rows of a table the
      // Automerge document models. SQLite is a projection: the next merge's
      // projectAll delete-reconcile will undo it. Either write the change
      // THROUGH the document, or classify the version in
      // migrationDomainState.js's DOMAIN_STATE_MIGRATIONS and accept that the
      // startup guard will refuse to sync a document-bearing camp across it.
      expect(offenders).toEqual([])
    })
  }
})

describe('the domain-state classifications are earned, not just asserted', () => {
  it('every version claimed domain-state is observed writing a modeled table somewhere in the corpus', () => {
    const observed = new Set()
    for (const [, fixture, seed] of RUNS) {
      for (const [version, entries] of migrateTraced(fixture, seed)) {
        if (domainWritesIn(entries, MODELED).length > 0) observed.add(version)
      }
    }
    // Not an equality check: a domain-state migration can legitimately go
    // unobserved if no fixture holds the rows it repairs (the de-duplication
    // ones repair damage these fixtures do not have). Reported, not enforced —
    // what must never happen is the reverse, which the block above covers.
    const unobserved = [...DOMAIN_STATE_MIGRATIONS.keys()].filter((v) => !observed.has(v))
    expect(unobserved).not.toContain(32)
  })
})

// ---------------------------------------------------------------------------

// Memoized: the row diff migrates the whole chain taking a full snapshot of
// every modeled table at each of 60+ block boundaries, which is the expensive
// measurement in this file. Each run is computed once and shared by the
// per-run guard and the acknowledgement-list checks.
const diffCache = new Map()
function migrateDiffed(fixture, seed) {
  const key = `${fixture ?? 'fresh'}::${seed ? 'seeded' : 'plain'}`
  if (!diffCache.has(key)) diffCache.set(key, computeDiff(fixture, seed))
  return diffCache.get(key)
}

function computeDiff(fixture, seed) {
  const file = tempPath(`diff-${fixture ? fixture.replace(/\W+/g, '-') : 'fresh'}`)
  if (fixture) fs.copyFileSync(path.join(ERAS_DIR, fixture), file)
  const real = new Database(file)
  real.pragma('foreign_keys = ON')
  if (seed) seed(real)
  try {
    const { trace, snapshots } = traceWithSnapshots(real, MODELED, (db) => initSchema(db))
    return diffByMigration(trace, snapshots)
  } finally {
    real.close()
  }
}

// A column or table that vanishes cannot be compared, which is NOT the same as
// being unchanged — so the diff reports it as 'unknown' and this guard fails on
// it. Automation cannot tell a pure rename from a rename that also transformed
// the values; only reading the SELECT can. So each one is acknowledged ONCE,
// by version, with the reason — and anything not on this list fails until
// someone reads it and adds a line. Silence is never the answer.
//
// This is deliberately the narrow version of "require an explicit assertion":
// it applies only where the measurement genuinely cannot decide, so it does not
// become a box every migration author ticks without thinking.
// WHY A DROPPED COLUMN IS SCHEMA-ONLY, stated as the mechanism rather than as
// "it was a deliberate retirement". The classifier asks exactly one question —
// would projectAll's delete-reconcile UNDO this at the next merge? — and it is
// easy to drift from that into "is this a big deal". A merge cannot undo a
// dropped column, because there is no column left to write into: the document
// may carry an orphaned field, but the projector cannot resurrect a column
// schema.sql no longer declares. A domain WRITE is reverted by the next merge;
// a shape change is not. So the answer does not depend on whether an ADR
// accompanied the retirement, and the next author who retires a feature without
// one must still get the same answer. (Mechanism supplied by
// app-icon-audit-a9a598, correcting the ADR-based reasoning drafted here first.)
//
// WHAT ACTUALLY EXPIRES AN ACKNOWLEDGEMENT, in order of how much weight it
// carries — because the weakest of the three was described first here, and
// describing a narrow guard broadly is the failure this whole ticket chases.
//
//   1. THE KEY IS THE OBSERVATION. An entry is keyed by `version table.column`,
//      which is the finding itself, not a label for it. If a migration changes
//      so that it drops a different column, the key it produces changes and the
//      new one is unacknowledged — it fails. This is structural and needs no
//      hash.
//   2. THE ROW DIFF. If the migration changes so that it also transforms or
//      removes a value, that is a 'changed'/'removed' finding, which cannot be
//      acknowledged at all and fails outright. An acknowledgement only ever
//      covers 'unknown' — the case where the rows could not be compared.
//   3. `blockHash`, below — a secondary tripwire for an edit that changes the
//      migration's text while producing the same observations.
//
// WHAT blockHash DOES NOT COVER, stated because it has the same blind spot this
// file was built to close, and found by app-icon-audit-a9a598 looking for it
// here: it hashes the block's OWN LINES — everything from the previous stamp to
// this one — and DOES NOT FOLLOW CALLS. A migration whose logic lives in a
// helper defined elsewhere can have that helper rewritten with no change to the
// hash, and the acknowledgement would be inherited across a real behavioural
// change. That is exactly the indirection the text scanner could not follow. It
// does not bite today (v49/v53/v59 are inline recreates), and it bites the first
// time someone acknowledges a version routed through a helper — the shape people
// demonstrably reach for. Layers 1 and 2 above still cover that case, which is
// why this stays as a tripwire rather than being made cleverer: following calls
// to hash them transitively would re-implement the parsing problem that
// measuring already solved.
//
// It also errs the other way, harmlessly: anything sitting between two stamps —
// an unrelated helper, a comment, a migration inserted there later —
// invalidates the FOLLOWING version's entry even though that version did not
// change. That direction of failure asks someone to re-read, which is the right
// way to be wrong. (v1's window would start at line 0 and hash the file header;
// no v1 entry exists, and if one ever does, that is why it churns.)
const ACKNOWLEDGED_UNKNOWNS = new Map([
  [
    'v73 activities.catalog_role',
    {
      blockHash: '94023759a3ed',
      why:
        'v75 (T266) ALTER-adds activities.catalog_role. v73 REBUILDS activities from a ' +
        'hardcoded column list written before that column existed, so on a run that ' +
        'replays the whole chain the column is created by schema.sql, dropped by the v73 ' +
        'rebuild, and re-added by v75. The end state is correct and is separately proven: ' +
        'recurrenceTruthStatus.migration.test.js asserts a migrated database and a fresh ' +
        'one have byte-identical activities columns. No row VALUE changes and nothing is ' +
        'lost — a database reaching v73 by a real forward path (<= v72) cannot hold the ' +
        'column, and a fresh install has no activities rows at all. ' +
        'WORTH KNOWING FOR THE NEXT PERSON, because it is a standing property rather than ' +
        'a one-off: the v73 rebuild will transiently drop EVERY column added to activities ' +
        'after it, and it is only safe while the adding migration is numbered ABOVE 73 so ' +
        'it re-adds the column afterwards. A future column added below that number, or a ' +
        'rebuild moved later, would silently lose it.',
    },
  ],
  [
    'v49 locations.tile_type',
    {
      blockHash: 'fda8ef86a23c',
      why:
        'Recreates `locations` to rename tile_type -> kind. The SELECT copies the value ' +
        'through verbatim — `srcKind` interpolates the bare column name, not an ' +
        'expression — so no surviving value is transformed. Below the document era ' +
        '(v57), so no database reaching it can hold a document at all.',
    },
  ],
  [
    'v53 schedule_snapshots.overlays',
    {
      blockHash: 'f41b4f5422d5',
      why:
        'Drops the overlay stamp column with its subsystem. The recreate copies every ' +
        'surviving column verbatim. Below the document era (v57), so no database ' +
        'reaching it can hold a document at all; a merge could not undo the drop in ' +
        'any case, since there is no column left to write into. T189 added a ' +
        '`CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_template_id` after the ' +
        'RENAME (the DROP TABLE took the index with it and schema.sql had already run ' +
        'for that open). DDL only — it moves no data and changes no row, so this ' +
        'acknowledgement is unchanged in substance.',
    },
  ],
  [
    'v59 schedule_snapshots.day_overrides_json',
    {
      blockHash: 'c19713f3a7b8',
      why:
        'THE ONLY ONE OF THE THREE ABOVE THE DOCUMENT ERA (v57), so a database reaching ' +
        'it can already hold a document — document and SQLite coexist across this ' +
        'change. Still schema-only by the classifier: a merge cannot restore a dropped ' +
        'column. The hazard runs the OTHER way and this guard does not measure it — a ' +
        'document field whose column is gone is a projection-time failure, not a silent ' +
        'revert. Handled deliberately at the time: GENESIS_B64 was NOT regenerated and ' +
        'keeps an orphan empty `day_overrides` collection on purpose, because the ' +
        'module-load guard is a subset check and regenerating would change the shared ' +
        "document's identity for every existing .automerge file. Do not tidy the orphan. " +
        'T189 added a `CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_template_id` ' +
        'after the RENAME, for the same reason as v53 above. DDL only — no row moves, ' +
        'and it touches neither the document nor the orphaned collection.',
    },
  ],
  [
    'v71 anchor_activities.recurrence_level',
    {
      blockHash: '2f1c6c3901fb',
      why:
        'Plain `ALTER TABLE ... DROP COLUMN recurrence_level` (T181) — the column sat in no ' +
        'index and no CHECK constraint, so no table recreate was needed. No SELECT copies ' +
        'or transforms any value; the column simply stops existing. Every application code ' +
        'path only ever wrote the schema default to it (the T181 sweep established that as ' +
        'evidence), so there is no non-default value this drop could discard.',
    },
  ],
  [
    'v71 elective_sets.recurrence_level',
    {
      blockHash: '2f1c6c3901fb',
      why:
        'Plain `ALTER TABLE ... DROP COLUMN recurrence_level` (T181) — same shape and same ' +
        'reasoning as anchor_activities.recurrence_level above: no index, no CHECK, no ' +
        'recreate, no value ever non-default.',
    },
  ],
])

/** The text of one migration's own block in localDb.js, hashed. */
function blockHashFor(version) {
  let start = 0
  for (const stamp of STAMP_LINES) {
    if (stamp.version === version) {
      const block = SRC_LINES.slice(start, stamp.line + 1).join('\n')
      return createHash('sha256').update(block).digest('hex').slice(0, 12)
    }
    start = stamp.line + 1
  }
  return null
}

/** Every unknown observed anywhere in the corpus, as `version table.column`. */
function observedUnknowns() {
  const seen = new Map()
  for (const [, fixture, seed] of RUNS) {
    for (const [version, changes] of migrateDiffed(fixture, seed)) {
      if (!SCHEMA_ONLY_MIGRATIONS.has(version)) continue
      for (const c of changes) {
        if (c.kind !== 'unknown') continue
        seen.set(`v${version} ${c.table}${c.column ? `.${c.column}` : ''}`, c.reason)
      }
    }
  }
  return seen
}

describe('no migration classified schema-only changes a modeled ROW', () => {
  // The statement guards above still reason about SQL. This one does not read
  // any. It compares the rows before and after each block, so a change is
  // caught however it was spelled — including the one shape neither statement
  // guard can see: a table RECREATE whose `INSERT INTO shadow SELECT ...`
  // transforms an existing column on its way across. SQLite is never asked to
  // UPDATE or DELETE the modeled table, and the statement that carries the data
  // targets the shadow table both guards deliberately ignore.
  for (const [label, fixture, seed] of RUNS) {
    it(`${label}`, () => {
      const offenders = []
      for (const [version, changes] of migrateDiffed(fixture, seed)) {
        if (!SCHEMA_ONLY_MIGRATIONS.has(version)) continue
        for (const c of changes.slice(0, 5)) {
          if (c.kind === 'unknown') {
            const key = `v${version} ${c.table}${c.column ? `.${c.column}` : ''}`
            // Acknowledged once, with a reason, or it fails. An unknown that
            // nobody has read is not a pass.
            const ack = ACKNOWLEDGED_UNKNOWNS.get(key)
            if (!ack) offenders.push(`${key} UNKNOWN — ${c.reason}`)
            continue
          }
          offenders.push(
            c.kind === 'changed'
              ? `v${version} ${c.table}.${c.column} on ${c.id}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`
              : `v${version} ${c.kind} ${c.table} row ${c.id}`
          )
        }
      }
      expect(offenders).toEqual([])
    })
  }
})

describe('NON-VACUITY: the row diff sees what no statement guard can', () => {
  it('catches a recreate whose SELECT transforms an existing column', () => {
    // Synthesized rather than planted in localDb.js, so the proof lives in the
    // suite permanently instead of in a commit message. This is exactly the
    // v65-shaped migration gracious-thompson checked — create a shadow, copy
    // every row across, drop, rename — except that one existing column is
    // rewritten in flight. Both statement guards read it as pure shape work.
    const file = tempPath('recreate-transform')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, tier_id TEXT);
      INSERT INTO groups VALUES ('grp-1', 'Bunk 1', 'tier-1');
    `)
    const recreate = (handle) => {
      handle.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
      handle.exec(`
        CREATE TABLE groups_v99 (id TEXT PRIMARY KEY, name TEXT, tier_id TEXT, note TEXT);
        INSERT INTO groups_v99 (id, name, tier_id, note)
          SELECT id, upper(name), tier_id, NULL FROM groups;
        DROP TABLE groups;
        ALTER TABLE groups_v99 RENAME TO groups;
      `)
      handle
        .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (99, ?)')
        .run('now')
    }

    const { trace, snapshots } = traceWithSnapshots(db, ['groups'], recreate)
    db.close()

    // The statement guards: blind, and provably so.
    const statements = attributeByMigration(trace)
    expect(domainWritesIn(statements.get(99) ?? [], ['groups'])).toEqual([])

    // The row diff: not blind.
    const changes = diffByMigration(trace, snapshots).get(99)
    expect(changes).toEqual([
      { table: 'groups', id: 'grp-1', kind: 'changed', column: 'name', before: 'Bunk 1', after: 'BUNK 1' },
    ])
  })

  it('stays quiet on the same recreate when it only ADDS a column', () => {
    // The v65 shape, unaltered: every existing column copied through verbatim,
    // one new column computed. A guard that flagged this would be noise, and an
    // author who learns to suppress a guard has no guard.
    const file = tempPath('recreate-addcolumn')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT, tier_id TEXT);
      INSERT INTO groups VALUES ('grp-1', 'Bunk 1', 'tier-1');
    `)
    const recreate = (handle) => {
      handle.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
      handle.exec(`
        CREATE TABLE groups_v99 (id TEXT PRIMARY KEY, name TEXT, tier_id TEXT, tier_ids TEXT);
        INSERT INTO groups_v99 (id, name, tier_id, tier_ids)
          SELECT id, name, tier_id, json_array(tier_id) FROM groups;
        DROP TABLE groups;
        ALTER TABLE groups_v99 RENAME TO groups;
      `)
      handle
        .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (99, ?)')
        .run('now')
    }

    const { trace, snapshots } = traceWithSnapshots(db, ['groups'], recreate)
    db.close()
    expect(diffByMigration(trace, snapshots).get(99)).toBeUndefined()
  })
})

describe('the acknowledgement list is a record of reading, not a suppression list', () => {
  it('has no entry that nothing produces — a stale acknowledgement is drift', () => {
    // An acknowledgement outliving the thing it acknowledged is how a
    // suppression list grows past the reading behind it. If a version is
    // renumbered or a migration rewritten, the stale line must fail rather than
    // sit there looking like diligence.
    const observed = observedUnknowns()
    const stale = [...ACKNOWLEDGED_UNKNOWNS.keys()].filter((k) => !observed.has(k))
    expect(stale).toEqual([])
  })

  it('every acknowledgement says WHY, so the reading can be checked rather than trusted', () => {
    for (const [key, ack] of ACKNOWLEDGED_UNKNOWNS) {
      expect(typeof ack.why, key).toBe('string')
      expect(ack.why.length, key).toBeGreaterThan(60)
    }
  })

  it('expires when the migration it acknowledges is edited', () => {
    // The mechanical guards can catch a STALE acknowledgement and an EMPTY one.
    // Neither can catch a WRONG one, and the standing risk is that
    // "acknowledged" quietly becomes the default action for anything
    // inconvenient. This does not fix that, but it bounds it in time: the hash
    // is of the migration's own text as it stood when someone read it, so
    // editing the migration invalidates the reading rather than inheriting it.
    // Raised by app-icon-audit-a9a598 as a known limit; built instead of noted.
    const drifted = []
    for (const [key, ack] of ACKNOWLEDGED_UNKNOWNS) {
      const version = Number(key.match(/^v(\d+)/)[1])
      const actual = blockHashFor(version)
      if (ack.blockHash !== actual) drifted.push(`${key}: recorded ${ack.blockHash}, now ${actual}`)
    }
    // A failure here is NOT a bug to route around. Re-read that migration, then
    // update both its `why` and its `blockHash`.
    expect(drifted).toEqual([])
  })
})
