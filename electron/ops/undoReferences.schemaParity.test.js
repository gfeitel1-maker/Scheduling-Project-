// @vitest-environment node
//
// U2 (creation/deletion undo) — the mechanical guarantee behind
// UNDO_REFERENCE_CHECKS. docs/adr/2026-08-17-onescreen-reconciliation-undo.md,
// U2 mechanism section + the 3rd Red Hat pass amendment: registry
// completeness must be a MECHANICAL invariant, not human diligence, because
// a by-hand FK search already missed 3 real edges once.
//
// Three guarantees, each a separate describe block:
// 1. Every DB-enforced REFERENCES clause pointing at a U2-deletable entity
//    is registered with enforced:true (schema.sql parsed directly — catches
//    a future migration adding an FK).
// 2. The NAMING-CONVENTION SCANNER — every real *_id/*_ids column on a fully
//    migrated db is either registered or explicitly accepted with a reason.
// 3. The scanner is PROVEN to catch a planted missing edge, not just proven
//    to pass today.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb } from '../db/localDb.js'
import { UNDO_REFERENCE_CHECKS, U2_DELETABLE_ENTITIES } from './undoReferences.js'
import { INGESTIBLE_ENTITIES } from './ingest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-undoref-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
function migratedDb() {
  return openLocalDb(tmpFile('migrated'))
}

// --- helpers -----------------------------------------------------------

// Parses `<table>` blocks for `<column> ... REFERENCES <targetTable>(id)`.
// Deliberately dumb regex over the DDL text (same idiom the ADR cites for
// campScopedEntities) — it reads the actual CREATE TABLE statements, so it
// cannot miss a future DB-level FK the way a hand-search can.
function parseSchemaReferences(sql) {
  const edges = []
  const tableBlockRe = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g
  let tableMatch
  while ((tableMatch = tableBlockRe.exec(sql))) {
    const [, tableName, body] = tableMatch
    const columnRe = /^\s*(\w+)\s+TEXT\s+(?:NOT NULL\s+)?REFERENCES\s+(\w+)\(id\)/gm
    let colMatch
    while ((colMatch = columnRe.exec(body))) {
      const [, column, targetTable] = colMatch
      edges.push({ fromTable: tableName, fromColumn: column, toEntity: targetTable })
    }
  }
  return edges
}

// U2_DELETABLE_ENTITIES ACCEPTED-NON-REFERENCE allowlist for the naming-
// convention scanner. Every entry needs a reason. Adding a new *_id/*_ids
// column anywhere in the schema requires either a UNDO_REFERENCE_CHECKS
// entry or an entry here — the scanner below fails otherwise.
const ACCEPTED_NON_REFERENCES = [
  // -- camp/singleton scoping columns: point at camps, never a U2-deletable entity --
  { table: 'users', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'source_aliases', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'declined_two_row_splits', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity (host-local decline-memory, never undone)' },
  { table: 'compound_cell_decisions', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity (host-local compound-cell-interpretation memory, never undone)' },
  { table: 'import_evidence', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'groups', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'tiers', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'activities', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'cohorts', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'days_of_operation', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'time_blocks', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'anchor_activities', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'schedule_weeks', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'schedule_templates', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'locations', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'camp_maps', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'audit_events', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'migration_v26_retired_orphan_log', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'location_migration_reviews', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'special_days', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'elective_sets', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'events', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'day_overrides', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },

  // -- pointers at non-U2-deletable entities (users, devices, templates, etc.) --
  { table: 'devices', column: 'authorized_by_user_id', reason: 'points at users, not a U2-deletable entity' },
  { table: 'devices', column: 'revoked_by_user_id', reason: 'points at users, not a U2-deletable entity' },
  { table: 'operations', column: 'author_user_id', reason: 'points at users, not a U2-deletable entity' },
  { table: 'operations', column: 'device_id', reason: 'points at devices, not a U2-deletable entity' },
  { table: 'operations', column: 'parent_op_id', reason: 'points at operations, not a U2-deletable entity' },
  { table: 'operations', column: 'client_write_id', reason: 'idempotency token, not an entity pointer' },
  { table: 'conflicts', column: 'existing_op_id', reason: 'points at operations, not a U2-deletable entity' },
  { table: 'locks', column: 'holder_device_id', reason: 'points at devices, not a U2-deletable entity' },
  { table: 'template_slots', column: 'template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'locations', column: 'map_id', reason: 'points at camp_maps (a map image, restore-refused / not a U2-deletable entity); a dangling map_id resolves to the primary map (v50 pair, ADR 2026-08-26)' },
  { table: 'schedule_snapshots', column: 'template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'schedule_templates', column: 'week_id', reason: 'points at schedule_weeks, not a U2-deletable entity' },
  { table: 'pending_writes', column: 'pending_id', reason: 'internal queue key, not an entity pointer' },
  { table: 'pending_writes', column: 'client_write_id', reason: 'idempotency token, not an entity pointer' },
  { table: 'pending_writes', column: 'parent_op_id', reason: 'points at operations, not a U2-deletable entity' },
  { table: 'pending_restores', column: 'pending_id', reason: 'internal queue key, not an entity pointer' },
  { table: 'special_day_time_blocks', column: 'special_day_id', reason: 'points at special_days, not a U2-deletable entity' },
  { table: 'special_day_slots', column: 'special_day_id', reason: 'points at special_days, not a U2-deletable entity' },
  { table: 'special_day_slots', column: 'time_block_id', reason: 'points at special_day_time_blocks, not a U2-deletable entity' },
  { table: 'elective_set_activities', column: 'elective_set_id', reason: 'points at elective_sets, not a U2-deletable entity' },
  { table: 'template_slots', column: 'elective_set_id', reason: 'points at elective_sets, not a U2-deletable entity' },
  { table: 'template_slots', column: 'event_id', reason: 'points at events, not a U2-deletable entity' },
  // Events internal sub-schedule Slice 2 (docs/adr/2026-08-22-event-
  // internal-subschedule.md §3).
  { table: 'event_time_blocks', column: 'event_id', reason: 'points at events, not a U2-deletable entity' },
  { table: 'event_groups', column: 'event_id', reason: 'points at events, not a U2-deletable entity' },
  { table: 'event_slots', column: 'event_id', reason: 'points at events, not a U2-deletable entity' },
  { table: 'event_slots', column: 'time_block_id', reason: 'points at event_time_blocks, not a U2-deletable entity' },
  { table: 'week_activity_exclusions', column: 'week_id', reason: 'points at schedule_weeks, not a U2-deletable entity' },
  { table: 'week_group_exclusions', column: 'week_id', reason: 'points at schedule_weeks, not a U2-deletable entity' },
  { table: 'week_location_exclusions', column: 'week_id', reason: 'points at schedule_weeks, not a U2-deletable entity' },
  // T108 Phase 2 review round 3.
  { table: 'day_overrides', column: 'schedule_week_id', reason: 'points at schedule_weeks, not a U2-deletable entity' },
  // v42 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md Slice 1):
  { table: 'anchor_activities', column: 'schedule_week_id', reason: 'optional binding to schedule_weeks, not a U2-deletable entity — mirrors day_overrides.schedule_week_id' },
  // v43 (docs/work/specs/2026-08-23-unified-schedule-overlay-slices.md
  // Slice 3a).
  { table: 'elective_sets', column: 'schedule_week_id', reason: 'optional binding to schedule_weeks, not a U2-deletable entity — mirrors anchor_activities.schedule_week_id' },
  // is_all_groups is not an *_id/*_ids column so the scanner never flags it;
  // no entry needed (matches anchor_activities.is_all_groups, likewise unlisted).
  { table: 'audit_events', column: 'actor_user_id', reason: 'points at users, not a U2-deletable entity' },
  { table: 'audit_events', column: 'device_id', reason: 'points at devices, not a U2-deletable entity' },
  { table: 'migration_v24_repoint_log', column: 'row_id', reason: 'historical migration journal row key, not an entity pointer' },
  { table: 'migration_v24_repoint_log', column: 'old_template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'migration_v24_repoint_log', column: 'new_template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'migration_v26_retired_orphan_log', column: 'orphan_template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'migration_v26_retired_orphan_log', column: 'real_template_id', reason: 'points at schedule_templates, not a U2-deletable entity' },
  { table: 'migration_v26_retired_orphan_log', column: 'snapshot_id', reason: 'points at schedule_snapshots, not a U2-deletable entity' },
  { table: 'migration_v26_retired_orphan_log', column: 'row_id', reason: 'historical migration journal row key, not an entity pointer' },

  // -- polymorphic entity_id/target_id columns: paired with an entity_type/target_type
  //    column, no single-table target, and each schema comment says so explicitly --
  { table: 'source_aliases', column: 'entity_id', reason: 'polymorphic (entity_type varies), schema.sql documents "not a FK"' },
  { table: 'import_evidence', column: 'entity_id', reason: 'polymorphic (entity_type varies), schema.sql documents "not a FK", cleaned up by U2\'s dedicated import_evidence delete, not this registry' },
  { table: 'import_evidence', column: 'import_run_id', reason: 'groups rows from one commitIngest call, not an entity pointer' },
  { table: 'operations', column: 'entity_id', reason: 'polymorphic (entity varies), no single-table target' },
  { table: 'conflicts', column: 'entity_id', reason: 'polymorphic (entity varies), no single-table target' },
  { table: 'locks', column: 'entity_id', reason: 'polymorphic (entity varies), no single-table target' },
  { table: 'pending_writes', column: 'entity_id', reason: 'polymorphic (entity varies), no single-table target' },
  { table: 'pending_restores', column: 'entity_id', reason: 'polymorphic (entity varies), no single-table target' },
  { table: 'audit_events', column: 'target_id', reason: 'polymorphic (target_type varies), no single-table target' },

  // -- source_aliases is host-local, admin-only confirmation metadata; a stale
  //    cohort_id after a cohort is undo-deleted leaves an alias unmatched on
  //    the next reimport (a missed suggestion), not a corrupted live record --
  { table: 'source_aliases', column: 'cohort_id', reason: 'host-local alias-confirmation metadata (never synced, never rendered as a live reference); a stale pointer after undo makes a future reimport not auto-match, not a corrupted live record' },

  // -- open_reconciliation_decisions: host-local journal of unresolved import
  //    decisions (ADR 2026-08-28-persisted-reconciliation-decisions.md), never
  //    synced, delete-to-close lifecycle, recomputed wholesale on each commit;
  //    same posture as source_aliases/import_evidence above --
  { table: 'open_reconciliation_decisions', column: 'camp_id', reason: 'scopes to camps, not a U2-deletable entity' },
  { table: 'open_reconciliation_decisions', column: 'entity_id', reason: 'polymorphic (entity_type varies), schema.sql documents "not a FK" — mirrors source_aliases.entity_id' },
  { table: 'open_reconciliation_decisions', column: 'cohort_id', reason: 'host-local journal metadata (never synced); a stale pointer after undo makes a row not match on the next import, not a corrupted live record — mirrors source_aliases.cohort_id' },
  { table: 'open_reconciliation_decisions', column: 'import_run_id', reason: 'groups rows from one commitIngest call, not an entity pointer — mirrors import_evidence.import_run_id' },

  // -- documented dead column --
  { table: 'anchor_activities', column: 'unit_id', reason: 'documented dead/unused legacy column (schema.sql comment above anchor_activities: never read or written), not a live reference despite the name' },

  // -- recomputed-on-every-device local journal: regenerated wholesale, not
  //    a live reference the undo/schedule layer reads --
  { table: 'location_migration_reviews', column: 'location_id', reason: 'local-only review journal, recomputed identically on every device (schema.sql comment), never read as a live reference' },
]

function acceptedReason(table, column) {
  return ACCEPTED_NON_REFERENCES.find((e) => e.table === table && e.column === column)?.reason
}

describe('UNDO_REFERENCE_CHECKS — schema-derived FK edges', () => {
  it('registers every DB-enforced REFERENCES clause pointing at a U2-deletable entity, with enforced:true', () => {
    const schemaEdges = parseSchemaReferences(schemaSql).filter((e) =>
      U2_DELETABLE_ENTITIES.has(e.toEntity)
    )
    expect(schemaEdges.length).toBeGreaterThan(0) // sanity: the parser actually found real edges

    for (const edge of schemaEdges) {
      const registered = UNDO_REFERENCE_CHECKS.find(
        (c) => c.fromTable === edge.fromTable && c.fromColumn === edge.fromColumn && c.toEntity === edge.toEntity
      )
      expect(
        registered,
        `schema.sql declares ${edge.fromTable}.${edge.fromColumn} REFERENCES ${edge.toEntity}(id) but UNDO_REFERENCE_CHECKS has no matching entry`
      ).toBeTruthy()
      expect(
        registered.enforced,
        `${edge.fromTable}.${edge.fromColumn} is a DB-level FK — must be enforced:true`
      ).toBe(true)
    }
  })

  it('does not claim enforced:true for an edge schema.sql does not actually declare', () => {
    const schemaEdgeKeys = new Set(
      parseSchemaReferences(schemaSql).map((e) => `${e.fromTable}.${e.fromColumn}->${e.toEntity}`)
    )
    for (const check of UNDO_REFERENCE_CHECKS.filter((c) => c.enforced)) {
      const key = `${check.fromTable}.${check.fromColumn}->${check.toEntity}`
      expect(schemaEdgeKeys.has(key), `${key} is registered enforced:true but schema.sql has no such REFERENCES clause`).toBe(true)
    }
  })
})

describe('UNDO_REFERENCE_CHECKS — convention (enforced:false) edges name real columns', () => {
  it('every enforced:false entry names a column that actually exists on its table', () => {
    const db = migratedDb()
    for (const check of UNDO_REFERENCE_CHECKS.filter((c) => !c.enforced)) {
      const cols = db.pragma(`table_info(${check.fromTable})`).map((c) => c.name)
      expect(cols, `${check.fromTable}.${check.fromColumn} — column not found on a migrated db`).toContain(check.fromColumn)
    }
  })
})

describe('anchor_activities has no incoming references', () => {
  it('no schema-parsed edge and no registered entry targets anchor_activities', () => {
    const schemaEdgesIntoAnchors = parseSchemaReferences(schemaSql).filter((e) => e.toEntity === 'anchor_activities')
    expect(schemaEdgesIntoAnchors).toEqual([])
    // The one real convention edge into anchor_activities (template_slots.anchor_id)
    // IS registered below — this asserts there are no OTHER, undiscovered ones by
    // requiring every UNDO_REFERENCE_CHECKS entry targeting anchor_activities to be
    // exactly that one known edge.
    const registeredIntoAnchors = UNDO_REFERENCE_CHECKS.filter((c) => c.toEntity === 'anchor_activities')
    expect(registeredIntoAnchors).toEqual([
      { fromTable: 'template_slots', fromColumn: 'anchor_id', toEntity: 'anchor_activities', kind: 'scalar', enforced: false },
    ])
  })
})

describe('U2_DELETABLE_ENTITIES stays in sync with INGESTIBLE_ENTITIES', () => {
  it('is exactly INGESTIBLE_ENTITIES plus anchor_activities', () => {
    expect([...U2_DELETABLE_ENTITIES].sort()).toEqual([...INGESTIBLE_ENTITIES, 'anchor_activities'].sort())
  })
})

describe('the naming-convention scanner', () => {
  // Adding a new *_id/*_ids column to any U2_DELETABLE_ENTITIES table, or to
  // any table that could reference one, must add a case to
  // UNDO_REFERENCE_CHECKS or to ACCEPTED_NON_REFERENCES above — this test is
  // the enforcement, not a suggestion.
  it('every *_id/*_ids column on a migrated db is registered or explicitly accepted', () => {
    const db = migratedDb()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    const unaccounted = []
    for (const table of tables) {
      const cols = db.pragma(`table_info(${table})`).map((c) => c.name)
      for (const column of cols) {
        if (column === 'id') continue
        if (!/_ids?$/.test(column)) continue
        const registered = UNDO_REFERENCE_CHECKS.some((c) => c.fromTable === table && c.fromColumn === column)
        const accepted = acceptedReason(table, column)
        if (!registered && !accepted) unaccounted.push(`${table}.${column}`)
      }
    }
    expect(unaccounted, 'unregistered/unaccepted *_id or *_ids columns found').toEqual([])
  })

  it('proves the scanner catches a planted missing edge (removing a known registration fails the check)', () => {
    // Same body as the real scanner test above, but run against a registry
    // with one KNOWN real edge stripped out and NOT added to the allowlist —
    // proving a miss actually fails, not just that today's registry happens
    // to pass.
    const db = migratedDb()
    const plantedRegistry = UNDO_REFERENCE_CHECKS.filter(
      (c) => !(c.fromTable === 'template_slots' && c.fromColumn === 'anchor_id')
    )
    expect(plantedRegistry.length).toBe(UNDO_REFERENCE_CHECKS.length - 1) // sanity: the strip actually removed one

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    const unaccounted = []
    for (const table of tables) {
      const cols = db.pragma(`table_info(${table})`).map((c) => c.name)
      for (const column of cols) {
        if (column === 'id') continue
        if (!/_ids?$/.test(column)) continue
        const registered = plantedRegistry.some((c) => c.fromTable === table && c.fromColumn === column)
        const accepted = acceptedReason(table, column)
        if (!registered && !accepted) unaccounted.push(`${table}.${column}`)
      }
    }
    expect(unaccounted).toEqual(['template_slots.anchor_id'])
  })
})
