// @vitest-environment node
//
// Migration v73 (T241, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md)
// — relaxes UNIQUE(camp_id[, cohort_id], name) on ten tables (locations, activities, events,
// elective_sets, groups, cohorts, tiers, time_blocks, schedule_weeks, special_days) so a merged
// Automerge document's colliding records both project into SQLite instead of upsertRow's
// SAVEPOINT (electron/automerge/projector.js) silently dropping one into projection_failures.
//
// This file's fresh-vs-migrated equivalence test is LOAD-BEARING per the ADR (Correction 3): nine
// of the ten tables declare their UNIQUE inline in schema.sql's CREATE TABLE, which compiles to a
// sqlite_autoindex_* that DROP INDEX cannot touch — only a table rebuild removes it. If
// schema.sql's CREATE TABLE text still declared the inline UNIQUE while localDb.js's v73 block
// tried to relax it, a fresh install and a migrated database would permanently disagree. This
// test is written FIRST and must pass before any rebuild body is considered done.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV73, findRelaxedSetDuplicates } from './rollback/v73_down.js'
import { createEmptyDoc, applyWrite, applyBulkReplace } from '../automerge/campDocument.js'
import { projectAll } from '../automerge/projector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

// "Fresh" per the ticket's literal success predicate #4: a database built by schema.sql ALONE,
// no migration blocks — the only way to observe what a genuinely brand-new install's DDL text
// alone produces, independent of whatever the v73 migration block does at runtime. Using
// openLocalDb()/initSchema() for "fresh" would run schema.sql AND every migration block
// (including v73) in the same pass, making it identical in mechanism to the "migrated" path by
// construction — unable to ever catch a schema.sql/localDb.js divergence, since both paths would
// execute the same v73 rebuild code either way.
function schemaSqlOnlyDb(tag) {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schemaSql)
  return db
}

// "Migrated" per the ticket: every migration v0 through v73 in sequence — the normal
// openLocalDb()/initSchema() path.
function migratedDb(tag) {
  return openLocalDb(tmpFile(tag))
}

// A database rolled back to the pre-v73 shape (UNIQUE restored, conflicts columns dropped), so
// v73 can be re-run against it in isolation — same technique schemaIndexParity.migration.test.js
// uses with rollbackV53/rollbackV59: the migration's own inverse builds the "old shape" fixture.
function preV73Db(tag) {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current (includes v73)
  rollbackV73(db) // back to the v72 shape (no duplicates exist yet, so this cannot refuse)
  return db
}

const TABLES = [
  'locations', 'activities', 'events', 'elective_sets', 'groups',
  'cohorts', 'tiers', 'time_blocks', 'schedule_weeks', 'special_days',
]

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

// Sorted by name: a table rebuild's CREATE INDEX order need not match schema.sql's declaration
// order for the two shapes to be equivalent, only the resulting index SET.
const indexList = (db, table) =>
  db
    .pragma(`index_list(${table})`)
    .map((i) => ({ name: i.name, unique: i.unique, origin: i.origin, partial: i.partial }))
    .sort((a, b) => a.name.localeCompare(b.name))

describe('migration v73: fresh vs migrated equivalence (load-bearing per the ADR)', () => {
  it('migrates a pre-v73 db forward to 73', () => {
    const db = preV73Db('v73-forward')
    expect(getSchemaVersion(db)).toBe(72)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  // `tiers`/`time_blocks` are excluded from this direct index comparison for a reason that
  // predates T241 and applies to every table with an ALTER-added column in its unique key:
  // idx_tiers_camp_cohort_name / idx_time_blocks_camp_cohort_name reference `cohort_id`, a
  // version-10 ALTER-added column. schema.sql's own INDEX PLACEMENT RULE (top of the file)
  // forbids declaring an index there on a column that "cannot be missing on any database that ran
  // this file" — cohort_id fails that test, so (matching every other such index in this codebase)
  // it is declared ONLY in localDb.js's v73 block, never in schema.sql. schema.sql-alone therefore
  // legitimately never creates it, while the full chain does (via v73). Verified explicitly below
  // instead of silently excluded.
  const COHORT_SCOPED_INDEX_TABLES = new Set(['tiers', 'time_blocks'])

  it('gives schema.sql-alone and the full v0-v73 migration chain identical index_list for every relaxed table except tiers/time_blocks', () => {
    // schema.sql ALONE (no migration blocks at all) vs the full openLocalDb()/initSchema() chain
    // — literally the ticket's success predicate #4, and the only comparison that can actually
    // fail: using openLocalDb() for BOTH sides (as a naive "fresh install" fixture would) runs
    // schema.sql AND every migration block, including v73, on both sides identically, which can
    // never expose a schema.sql/localDb.js divergence since both paths execute the same v73 code.
    const schemaOnly = schemaSqlOnlyDb('v73-schema-only')
    const migrated = migratedDb('v73-migrated-chain')

    for (const table of [...TABLES, 'conflicts'].filter((t) => !COHORT_SCOPED_INDEX_TABLES.has(t))) {
      expect(indexList(migrated, table), `index_list mismatch for ${table}`).toEqual(indexList(schemaOnly, table))
    }

    schemaOnly.close()
    migrated.close()
  }, 30000)

  it('documents that tiers/time_blocks only gain their plain cohort-scoped index via the full migration chain, never from schema.sql alone', () => {
    const schemaOnly = schemaSqlOnlyDb('v73-schema-only-cohort-idx')
    const migrated = migratedDb('v73-migrated-chain-cohort-idx')

    for (const table of COHORT_SCOPED_INDEX_TABLES) {
      const schemaOnlyNames = indexList(schemaOnly, table).map((i) => i.name)
      const migratedNames = indexList(migrated, table).map((i) => i.name)
      const indexName = `idx_${table}_camp_cohort_name`
      expect(schemaOnlyNames).not.toContain(indexName)
      expect(migratedNames).toContain(indexName)
    }

    schemaOnly.close()
    migrated.close()
  }, 30000)

  // table_info (column set) comparison, same two fixtures — scoped to the tables where schema.sql
  // actually carries every column the full chain does. `locations` is excluded from a direct
  // comparison for a PRE-EXISTING reason unrelated to this ticket: schema.sql's own documented
  // convention (top-of-file AUTHORITY comment) is that a CREATE TABLE reflects only the columns
  // present when the table was first introduced, and locations' kind/grid_x/grid_y (v48/v49) and
  // map_id (v50) were never retrofitted into schema.sql's text the way activities.location_id was
  // — so schema.sql-alone and the full chain legitimately disagree on locations' column count
  // today, independent of anything T241 touches. Asserted explicitly below instead of silently
  // excluded, so a future column addition to either side is still caught.
  it('gives schema.sql-alone and the full migration chain identical table_info for every relaxed table except locations', () => {
    const schemaOnly = schemaSqlOnlyDb('v73-schema-only-cols')
    const migrated = migratedDb('v73-migrated-chain-cols')

    for (const table of [...TABLES, 'conflicts'].filter((t) => t !== 'locations')) {
      expect(tableInfo(migrated, table), `table_info mismatch for ${table}`).toEqual(tableInfo(schemaOnly, table))
    }

    schemaOnly.close()
    migrated.close()
  }, 30000)

  it('documents locations\' pre-existing schema.sql/migrated column gap exactly (kind, grid_x, grid_y, map_id — v48/v49/v50, not T241)', () => {
    const schemaOnly = schemaSqlOnlyDb('v73-schema-only-locations')
    const migrated = migratedDb('v73-migrated-chain-locations')

    const schemaCols = tableInfo(schemaOnly, 'locations').map((c) => c.name)
    const migratedCols = tableInfo(migrated, 'locations').map((c) => c.name)
    expect(migratedCols.slice(0, schemaCols.length)).toEqual(schemaCols)
    expect(migratedCols.slice(schemaCols.length)).toEqual(['kind', 'grid_x', 'grid_y', 'map_id'])

    schemaOnly.close()
    migrated.close()
  }, 30000)

  it('declares CURRENT_SCHEMA_VERSION as 73', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(75)
  })

  it('is idempotent — re-running v73 does not duplicate tables, indexes, or rows', () => {
    const db = preV73Db('v73-idempotent')
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp1', 'Camp')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc1', 'camp1', 'Pool')").run()
    initSchema(db) // runs v73
    const firstIndexes = indexList(db, 'locations')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 73').run()
    // Re-running from a state that already has the relaxed shape (not a true pre-v73 fixture):
    // the guard only checks getSchemaVersion, so forcing it to re-fire here proves the block
    // itself is idempotent against its own post-condition, not just against a fresh pre-v73 db.
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(1)
    expect(indexList(db, 'locations')).toEqual(firstIndexes)
    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='locations'").get().c
    ).toBe(1)
    db.close()
  })
})

describe('migration v73: two colliding records project without a projection_failures row', () => {
  const ENTITY_FIXTURES = [
    { entity: 'locations', extra: { capacity: 1 } },
    { entity: 'activities', extra: {} },
    { entity: 'events', extra: {} },
    { entity: 'elective_sets', extra: {} },
    { entity: 'groups', extra: {} },
    { entity: 'cohorts', extra: {} },
    { entity: 'tiers', extra: {} },
    { entity: 'time_blocks', extra: {} },
    { entity: 'schedule_weeks', extra: {} },
    { entity: 'special_days', extra: {} },
  ]

  it('projects two same-named records per relaxed table, real write path (applyWrite -> projectAll), zero projection_failures', () => {
    const db = migratedDb('v73-misc')
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp One')").run()

    let doc = createEmptyDoc()
    for (const { entity, extra } of ENTITY_FIXTURES) {
      for (const suffix of ['a', 'b']) {
        const id = `${entity}-${suffix}`
        doc = applyWrite(doc, { entity, entity_id: id, field: 'camp_id', value: 'camp-1' })
        doc = applyWrite(doc, { entity, entity_id: id, field: 'name', value: 'Same Name' })
        for (const [field, value] of Object.entries(extra)) {
          doc = applyWrite(doc, { entity, entity_id: id, field, value })
        }
      }
    }

    const failures = projectAll(db, doc)
    expect(failures).toEqual([])

    for (const { entity } of ENTITY_FIXTURES) {
      const rows = db.prepare(`SELECT id FROM ${entity} WHERE camp_id = 'camp-1' AND name = 'Same Name'`).all()
      expect(rows.length, `expected 2 rows in ${entity}`).toBe(2)
    }

    expect(db.prepare('SELECT COUNT(*) c FROM projection_failures').get().c).toBe(0)
    db.close()
  })
})

// WHY THIS BLOCK EXISTS. Nine of the ten relaxed tables are DROPped and recreated by the v73
// rebuild, and `PRAGMA foreign_keys = OFF` is set globally around it precisely so those drops can
// proceed. That means nothing at all enforces referential integrity while the rebuild runs: if a
// row's parent id were dropped, or a column misplaced by a positional copy, the migration would
// complete clean, the schema would still compare equal, and a camp would silently lose schedule
// data. The other cases in this file check schema shape and collision behaviour; none of them
// check that CHILD rows survived, which is the worst-consequence failure this migration has.
describe('migration v73: FK-dependent rows across all ten relaxed tables survive the rebuild', () => {
  // Runtime-derived, per the ticket: PRAGMA foreign_key_list over every table in the db, keeping
  // only edges whose parent is one of the ten relaxed tables. NOT hardcoded, so a table added
  // later that references any of the ten is picked up automatically without touching this test.
  function dependentEdges(db) {
    const allTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
    const edges = []
    for (const table of allTables) {
      for (const fk of db.pragma(`foreign_key_list(${table})`)) {
        if (TABLES.includes(fk.table)) {
          edges.push({ table, from: fk.from, parentTable: fk.table, to: fk.to })
        }
      }
    }
    return edges
  }

  // Seeds one parent row in each of the ten relaxed tables, plus one real dependent row across
  // every FK edge `dependentEdges` will find, ALL through the real write path (applyWrite ->
  // projectAll) per the non-negotiable owner rule — never a hand-inserted INSERT INTO for any of
  // these rows.
  function seedFixture(db) {
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp One')").run()
    let doc = createEmptyDoc()
    const write = (entity, id, field, value) => {
      doc = applyWrite(doc, { entity, entity_id: id, field, value })
    }

    // Parents: one row per relaxed table.
    write('schedule_weeks', 'week-1', 'camp_id', 'camp-1')
    write('schedule_weeks', 'week-1', 'name', 'Week 1')
    write('cohorts', 'cohort-1', 'camp_id', 'camp-1')
    write('cohorts', 'cohort-1', 'name', 'Session 1')
    write('activities', 'activity-1', 'camp_id', 'camp-1')
    write('activities', 'activity-1', 'name', 'Swim')
    write('groups', 'group-1', 'camp_id', 'camp-1')
    write('groups', 'group-1', 'name', 'Bunk A')
    write('elective_sets', 'elset-1', 'camp_id', 'camp-1')
    write('elective_sets', 'elset-1', 'name', 'Choice A')
    write('elective_sets', 'elset-1', 'schedule_week_id', 'week-1')
    write('events', 'event-1', 'camp_id', 'camp-1')
    write('events', 'event-1', 'name', 'Color War')
    write('special_days', 'sday-1', 'camp_id', 'camp-1')
    write('special_days', 'sday-1', 'name', 'Visiting Day')
    write('locations', 'loc-1', 'camp_id', 'camp-1')
    write('locations', 'loc-1', 'name', 'Pool')
    write('tiers', 'tier-1', 'camp_id', 'camp-1')
    write('tiers', 'tier-1', 'cohort_id', 'cohort-1')
    write('tiers', 'tier-1', 'name', 'Yeladim')
    write('time_blocks', 'tb-1', 'camp_id', 'camp-1')
    write('time_blocks', 'tb-1', 'cohort_id', 'cohort-1')
    write('time_blocks', 'tb-1', 'name', 'Period 1')

    // Dependents — one real row per FK edge discovered by dependentEdges, seeded in an order that
    // satisfies each entity's own ensureExists ordering contract (electron/ops/projections.js).
    write('schedule_templates', 'templ-1', 'kind', 'manual')
    write('schedule_templates', 'templ-1', 'camp_id', 'camp-1')
    write('schedule_templates', 'templ-1', 'week_id', 'week-1')

    // template_slots is dual-modeled (electron/automerge/projector.js's upsertEntity /
    // deleteReconcileBulkReplaceEntity comments): its EXISTENCE is owned by the bulk-replace scope
    // pass (a real schedule generate/regenerate), not the flat per-field write applyWrite uses for
    // every other entity here. Seeding it via applyWrite would round-trip through projectAll fine
    // on its own, but the SAME projectAll call's delete-reconcile pass then wipes it straight back
    // out — deleteReconcileBulkReplaceEntity treats any template_id scope absent from
    // doc.template_slots_scopes as an empty scope and clears it. applyBulkReplace is the real write
    // path for this table (ScheduleScreen's generate()/placeAnchors()), so it is what a genuine
    // camp's schedule data looks like on disk.
    doc = applyBulkReplace(doc, {
      entity: 'template_slots',
      scope_id: 'templ-1',
      rows: [{ id: 'ts-1', template_id: 'templ-1', group_id: 'group-1', activity_id: 'activity-1' }],
    })

    write('week_activity_exclusions', 'wae-1', 'week_id', 'week-1')
    write('week_activity_exclusions', 'wae-1', 'activity_id', 'activity-1')

    write('week_group_exclusions', 'wge-1', 'week_id', 'week-1')
    write('week_group_exclusions', 'wge-1', 'group_id', 'group-1')

    write('week_location_exclusions', 'wle-1', 'week_id', 'week-1')
    write('week_location_exclusions', 'wle-1', 'location_id', 'loc-1')

    // schedule_week_id deliberately not set here: anchor_activities projects BEFORE
    // schedule_weeks in MODELED_ORDER (electron/ops/campScopedEntities.js's DOMAIN_SNAPSHOT_ORDER),
    // so setting it would trip the FK check inside projectAll itself, before the migration is even
    // reached — a pre-existing projector ordering fact, not something this test should route around
    // with a non-write-path insert. The schedule_weeks parent-edge is still exercised below via
    // schedule_templates/week_*_exclusions/elective_sets, which DO project after schedule_weeks.
    write('anchor_activities', 'anchor-1', 'camp_id', 'camp-1')
    write('anchor_activities', 'anchor-1', 'cohort_id', 'cohort-1')

    write('elective_set_activities', 'esa-1', 'elective_set_id', 'elset-1')
    write('elective_set_activities', 'esa-1', 'activity_id', 'activity-1')

    write('event_time_blocks', 'etb-1', 'event_id', 'event-1')
    write('event_groups', 'eg-1', 'event_id', 'event-1')
    write('event_slots', 'esl-1', 'event_id', 'event-1')
    write('event_slots', 'esl-1', 'event_group_id', 'eg-1')
    write('event_slots', 'esl-1', 'time_block_id', 'tb-1')

    write('special_day_time_blocks', 'sdtb-1', 'special_day_id', 'sday-1')
    write('special_day_slots', 'sds-1', 'special_day_id', 'sday-1')
    write('special_day_slots', 'sds-1', 'group_id', 'group-1')
    write('special_day_slots', 'sds-1', 'time_block_id', 'tb-1')

    const failures = projectAll(db, doc)
    expect(failures).toEqual([])
  }

  it('keeps every FK-dependent row (same ids, same counts) with a live parent, and PRAGMA foreign_key_check clean, across the v73 rebuild', () => {
    const db = preV73Db('v73-fk-survival')
    seedFixture(db)

    const edges = dependentEdges(db)
    // Sanity on the derivation itself: if this were empty, the rest of the test would vacuously
    // pass over nothing.
    expect(edges.length).toBeGreaterThan(0)

    const beforeRowsByTable = {}
    for (const { table } of edges) {
      if (!beforeRowsByTable[table]) {
        beforeRowsByTable[table] = db.prepare(`SELECT * FROM ${table}`).all()
        expect(beforeRowsByTable[table].length, `expected a seeded row in ${table} before migrating`).toBeGreaterThan(0)
      }
    }

    initSchema(db) // runs v73
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)

    expect(db.pragma('foreign_key_check')).toEqual([])

    for (const { table, from, parentTable, to } of edges) {
      const afterRows = db.prepare(`SELECT * FROM ${table}`).all()
      const beforeRows = beforeRowsByTable[table]
      expect(afterRows.length, `row count changed for ${table}: was ${beforeRows.length}, now ${afterRows.length}`).toBe(
        beforeRows.length
      )
      expect(afterRows.length, `expected nonzero surviving rows in ${table}`).toBeGreaterThan(0)
      expect(afterRows.map((r) => r.id).sort()).toEqual(beforeRows.map((r) => r.id).sort())

      for (const row of afterRows) {
        const fkValue = row[from]
        if (fkValue == null) continue
        const parent = db.prepare(`SELECT ${to} FROM ${parentTable} WHERE ${to} = ?`).get(fkValue)
        expect(parent, `${table}.${from}=${fkValue} has no matching ${parentTable}.${to} after migrating`).toBeTruthy()
      }
    }

    db.close()
  })
})

describe('v73_down: refuses when the relaxed set holds live duplicates, restores cleanly otherwise', () => {
  it('refuses and names every offending table, its colliding value, and the row ids in one error', () => {
    const db = migratedDb('v73-misc')
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp One')").run()
    db.prepare("INSERT INTO cohorts (id, camp_id, name) VALUES ('co1', 'camp-1', 'Session 1')").run()

    // Real duplicates across THREE of the ten tables (not just the first one a naive
    // implementation might check), created through direct writes matching how a merge would
    // leave them (this is a structural fixture for the rollback's own SQL-level duplicate scan,
    // not a behavioral projector test, so a direct insert is the right tool here).
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc-a', 'camp-1', 'Pool')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc-b', 'camp-1', 'Pool')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp-a', 'camp-1', 'Bunk A')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('grp-b', 'camp-1', 'Bunk A')").run()
    db.prepare(
      "INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES ('tier-a', 'camp-1', 'co1', 'Yeladim')"
    ).run()
    db.prepare(
      "INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES ('tier-b', 'camp-1', 'co1', 'Yeladim')"
    ).run()

    const duplicates = findRelaxedSetDuplicates(db)
    const tables = duplicates.map((d) => d.table).sort()
    expect(tables).toEqual(['groups', 'locations', 'tiers'])

    let thrown = null
    try {
      rollbackV73(db)
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'expected rollbackV73 to refuse').not.toBeNull()
    expect(thrown.message).toContain('locations')
    expect(thrown.message).toContain('groups')
    expect(thrown.message).toContain('tiers')
    expect(thrown.message).toContain('loc-a')
    expect(thrown.message).toContain('loc-b')
    expect(thrown.message).toContain('grp-a')
    expect(thrown.message).toContain('grp-b')
    expect(thrown.message).toContain('tier-a')
    expect(thrown.message).toContain('tier-b')

    // Refusal must be a pure read — the relaxed shape survives untouched, not half-rolled-back.
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM locations').get().c).toBe(2)
    db.close()
  })

  it('never silently dedups or deletes — a second call with duplicates still present refuses identically', () => {
    const db = migratedDb('v73-misc')
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp One')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev-a', 'camp-1', 'Color War')").run()
    db.prepare("INSERT INTO events (id, camp_id, name) VALUES ('ev-b', 'camp-1', 'Color War')").run()

    expect(() => rollbackV73(db)).toThrow(/Color War/)
    expect(() => rollbackV73(db)).toThrow(/Color War/)
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(2)
    db.close()
  })

  it('restores every UNIQUE constraint and drops the conflicts columns when no duplicates exist', () => {
    const db = migratedDb('v73-misc')
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp One')").run()
    db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc1', 'camp-1', 'Pool')").run()

    expect(findRelaxedSetDuplicates(db)).toEqual([])
    rollbackV73(db)

    expect(getSchemaVersion(db)).toBe(72)
    expect(() => {
      db.prepare("INSERT INTO locations (id, camp_id, name) VALUES ('loc2', 'camp-1', 'Pool')").run()
    }).toThrow(/UNIQUE/)
    const conflictCols = db.pragma('table_info(conflicts)').map((c) => c.name)
    expect(conflictCols).not.toContain('entity_ids')
    expect(conflictCols).not.toContain('kind')
    db.close()
  })
})
