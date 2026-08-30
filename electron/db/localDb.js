import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { writePreMigrationBackup } from './projectManager.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'
import { deriveLocationId } from '../ops/locationId.js'
import { applyProjection } from '../ops/projections.js'
import { isBulkReplaceOp, applyBulkReplaceProjection } from '../ops/operations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The highest schema_migrations.version this build of the app knows about.
// If an opened DB file has a higher version, the app refuses to migrate it
// (it was written by a newer build) and returns { code: 'schema_too_new' }.
export const CURRENT_SCHEMA_VERSION = 53

export function initSchema(db) {
  // template_overlays was retired in v53 (docs/adr/2026-08-30-retire-overlay-
  // stamp-subsystem.md). Historical migrations below (v21, v27) repoint it as a
  // child of schedule_templates. On a genuine forward migration the table
  // exists from v10 until v53 drops it, so those repoints always run against a
  // real table. This guard makes them no-op when the table is already gone —
  // the case exercised when a test resets schema_migrations to a pre-v21/v27
  // version on an already-fully-migrated (v53) database.
  const tableExists = (name) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  db.exec(schema)
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(
    new Date().toISOString()
  )
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(
    new Date().toISOString()
  )

  if (getSchemaVersion(db) < 4) {
    const campIdColumn = db
      .pragma('table_info(users)')
      .find((col) => col.name === 'camp_id')
    const campIdIsNotNull = campIdColumn ? campIdColumn.notnull === 1 : false

    if (campIdIsNotNull) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            camp_id TEXT REFERENCES camps(id),
            name TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            pin_salt TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
          );
          INSERT INTO users_new SELECT * FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_users_camp_name ON users(camp_id, name);
        `)
      })()
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(
      new Date().toISOString()
    )
  }

  if (getSchemaVersion(db) < 5) {
    const hasLastSyncedAt = db
      .pragma('table_info(devices)')
      .some((col) => col.name === 'last_synced_at')

    if (!hasLastSyncedAt) {
      db.exec('ALTER TABLE devices ADD COLUMN last_synced_at TEXT')
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)').run(
      new Date().toISOString()
    )
  }

  if (getSchemaVersion(db) < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        name TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT
      );
    `)

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?)').run(
      new Date().toISOString()
    )
  }

  // Task 10 round-4 Fix 3: per-device op-log watermark so a reconnecting
  // device can be sent exactly the `operations` rows it missed while it was
  // offline (see syncServer.js's sendMissedOps). Distinct from
  // last_synced_at, which only gates the one-time first-pairing full_sync of
  // users/camps and is never advanced afterward.
  if (getSchemaVersion(db) < 7) {
    const hasLastSyncedSeq = db
      .pragma('table_info(devices)')
      .some((col) => col.name === 'last_synced_seq')

    if (!hasLastSyncedSeq) {
      db.exec('ALTER TABLE devices ADD COLUMN last_synced_seq INTEGER')
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?)').run(
      new Date().toISOString()
    )
  }

  // Task 10 round-5 Fix 1 (durable write queue) and Fix 3 (retry idempotency
  // key): add the pending_writes table and the operations.client_write_id
  // column to existing databases that predate this schema.
  if (getSchemaVersion(db) < 8) {
    const hasClientWriteId = db
      .pragma('table_info(operations)')
      .some((col) => col.name === 'client_write_id')

    if (!hasClientWriteId) {
      db.exec('ALTER TABLE operations ADD COLUMN client_write_id TEXT')
    }

    // Created here (not in schema.sql's unconditional exec) because this
    // column may only just have been added above by the ALTER on a
    // pre-migration db — see the comment on this index's omission in
    // schema.sql for why.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_client_write_id ON operations(client_write_id) WHERE client_write_id IS NOT NULL'
    )

    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_writes (
        pending_id TEXT PRIMARY KEY,
        client_write_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT,
        parent_op_id TEXT,
        created_at TEXT NOT NULL
      );
    `)

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (8, ?)').run(
      new Date().toISOString()
    )
  }

  // Fix: a session token signed by one process's ephemeral in-memory secret
  // could never be verified by a different process (Host vs. Client) using
  // its own independent secret — this made a Client's freshly-obtained
  // token from the remote-login flow unusable for any subsequent local IPC
  // call. Move the signing secret onto the camps row so every device that
  // has synced a camp shares the same secret.
  if (getSchemaVersion(db) < 9) {
    const hasSigningSecret = db
      .pragma('table_info(camps)')
      .some((col) => col.name === 'signing_secret')

    if (!hasSigningSecret) {
      db.exec('ALTER TABLE camps ADD COLUMN signing_secret TEXT')
    }

    const campsNeedingSecret = db.prepare('SELECT id FROM camps WHERE signing_secret IS NULL').all()
    for (const camp of campsNeedingSecret) {
      db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(
        randomBytes(32).toString('hex'),
        camp.id
      )
    }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (9, ?)').run(
      new Date().toISOString()
    )
  }

  // Renderer Supabase->local-first migration, Sub-plan A: the 9 previously
  // Supabase-only tables (cohorts, days_of_operation, time_blocks,
  // anchor_activities, schedule_templates, template_overlays,
  // schedule_snapshots, day_override_templates, day_override_template_slots)
  // plus column additions to tiers/activities/template_slots. See
  // docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md.
  if (getSchemaVersion(db) < 10) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cohorts (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          session_week_start TEXT,
          session_week_end TEXT,
          capacity_source TEXT,
          anchor_model TEXT,
          sort_order INTEGER
        );

        CREATE TABLE IF NOT EXISTS days_of_operation (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          label TEXT NOT NULL,
          day_of_week INTEGER,
          sort_order INTEGER
        );

        CREATE TABLE IF NOT EXISTS time_blocks (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          cohort_id TEXT REFERENCES cohorts(id),
          name TEXT NOT NULL,
          start_time TEXT,
          end_time TEXT,
          part_of_day TEXT,
          sort_order INTEGER
        );

        CREATE TABLE IF NOT EXISTS anchor_activities (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          cohort_id TEXT REFERENCES cohorts(id),
          day_id TEXT REFERENCES days_of_operation(id),
          unit_id TEXT,
          span_blocks INTEGER,
          is_all_groups INTEGER,
          group_ids TEXT
        );

        CREATE TABLE IF NOT EXISTS schedule_templates (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS template_overlays (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES schedule_templates(id),
          unit_id TEXT,
          day_id TEXT REFERENCES days_of_operation(id),
          from_block_order INTEGER,
          to_block_order INTEGER,
          label TEXT
        );

        CREATE TABLE IF NOT EXISTS schedule_snapshots (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES schedule_templates(id),
          name TEXT,
          is_auto INTEGER,
          created_at TEXT NOT NULL,
          slots TEXT,
          overlays TEXT
        );

        CREATE TABLE IF NOT EXISTS day_override_templates (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS day_override_template_slots (
          id TEXT PRIMARY KEY,
          day_override_template_id TEXT NOT NULL REFERENCES day_override_templates(id)
        );
      `)

      const hasTierSortOrder = db
        .pragma('table_info(tiers)')
        .some((col) => col.name === 'sort_order')
      if (!hasTierSortOrder) {
        db.exec('ALTER TABLE tiers ADD COLUMN sort_order INTEGER')
      }

      const hasTierCohortId = db
        .pragma('table_info(tiers)')
        .some((col) => col.name === 'cohort_id')
      if (!hasTierCohortId) {
        db.exec('ALTER TABLE tiers ADD COLUMN cohort_id TEXT REFERENCES cohorts(id)')
      }

      const hasActivityPriority = db
        .pragma('table_info(activities)')
        .some((col) => col.name === 'priority')
      if (!hasActivityPriority) {
        db.exec('ALTER TABLE activities ADD COLUMN priority INTEGER')
      }

      const hasActivityIsLocked = db
        .pragma('table_info(activities)')
        .some((col) => col.name === 'is_locked')
      if (!hasActivityIsLocked) {
        db.exec('ALTER TABLE activities ADD COLUMN is_locked INTEGER')
      }

      const hasActivitySpanBlocks = db
        .pragma('table_info(activities)')
        .some((col) => col.name === 'span_blocks')
      if (!hasActivitySpanBlocks) {
        db.exec('ALTER TABLE activities ADD COLUMN span_blocks INTEGER')
      }

      const hasSlotFlags = db
        .pragma('table_info(template_slots)')
        .some((col) => col.name === 'flags')
      if (!hasSlotFlags) {
        db.exec('ALTER TABLE template_slots ADD COLUMN flags TEXT')
      }

      const hasSlotIsReleased = db
        .pragma('table_info(template_slots)')
        .some((col) => col.name === 'is_released')
      if (!hasSlotIsReleased) {
        db.exec('ALTER TABLE template_slots ADD COLUMN is_released INTEGER')
      }

      const hasSlotIsSpanHead = db
        .pragma('table_info(template_slots)')
        .some((col) => col.name === 'is_span_head')
      if (!hasSlotIsSpanHead) {
        db.exec('ALTER TABLE template_slots ADD COLUMN is_span_head INTEGER')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (10, ?)').run(
      new Date().toISOString()
    )
  }

  // Round 2 Red Hat fix (Sub-plan B Task 2, HIGH finding 1): closes the
  // duplicate-cohort race at the actual DB layer. A fresh install already
  // gets UNIQUE(camp_id, name) via schema.sql's CREATE TABLE; a db that
  // already ran version 10 keeps its old cohorts table as-is (CREATE TABLE
  // IF NOT EXISTS never retrofits it), so this adds the same guarantee via
  // a standalone unique index — mirroring how idx_users_camp_name (version
  // 4) was added for the pre-existing `users` table above. Duplicate
  // (camp_id, name) rows that already exist from before this fix (i.e. a
  // pre-fix race already produced two "Main" cohorts) would make the
  // CREATE UNIQUE INDEX itself fail, so any but the first row per
  // (camp_id, name) is deleted first.
  //
  // Round 2 escalation (GOVERNOR judgment call after 2 consecutive failed
  // Red Hat rounds on this task): the original version of this migration
  // deleted duplicate rows outright and claimed cohorts had "no established
  // consumers yet." That claim was false — schema.sql already declares
  // `time_blocks.cohort_id` and `anchor_activities.cohort_id` as FK
  // references to cohorts(id), and openLocalDb turns on
  // `PRAGMA foreign_keys = ON` before this migration runs. Red Hat
  // reproduced a real crash: deleting a duplicate cohort that a time_block
  // or anchor_activity still pointed at threw `FOREIGN KEY constraint
  // failed` and made openLocalDb throw, bricking app launch for any device
  // that had already hit the round-1 race. Fix: before deleting each
  // duplicate row, repoint every FK reference (time_blocks.cohort_id,
  // anchor_activities.cohort_id) from the duplicate's id to the surviving
  // (MIN rowid) row's id, so no reference is left dangling and no delete
  // can violate a foreign key.
  if (getSchemaVersion(db) < 11) {
    db.transaction(() => {
      const survivors = db
        .prepare(
          `SELECT camp_id, name, MIN(rowid) as keep_rowid
           FROM cohorts GROUP BY camp_id, name HAVING COUNT(*) > 1`
        )
        .all()

      for (const { camp_id, name, keep_rowid } of survivors) {
        const keepRow = db
          .prepare('SELECT id FROM cohorts WHERE rowid = ?')
          .get(keep_rowid)
        const dupes = db
          .prepare(
            'SELECT id FROM cohorts WHERE camp_id = ? AND name = ? AND rowid != ?'
          )
          .all(camp_id, name, keep_rowid)

        for (const { id: dupeId } of dupes) {
          db.prepare('UPDATE time_blocks SET cohort_id = ? WHERE cohort_id = ?').run(
            keepRow.id,
            dupeId
          )
          db.prepare(
            'UPDATE anchor_activities SET cohort_id = ? WHERE cohort_id = ?'
          ).run(keepRow.id, dupeId)
        }
      }

      db.exec(`
        DELETE FROM cohorts
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM cohorts GROUP BY camp_id, name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cohorts_camp_name ON cohorts(camp_id, name);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, ?)').run(
      new Date().toISOString()
    )
  }

  // Round 2 Red Hat fix (Sub-plan C Task 1 round 2, HIGH finding 3):
  // closes the same duplicate-name race for `groups` that idx_cohorts_camp_name
  // (version 11) closed for `cohorts`. A fresh install gets UNIQUE(camp_id,
  // name) via schema.sql's CREATE TABLE; a db that already ran an earlier
  // schema version keeps its old groups table as-is (CREATE TABLE IF NOT
  // EXISTS never retrofits it), so this adds the same guarantee via a
  // standalone unique index. Any pre-existing (camp_id, name) duplicate
  // rows would make the CREATE UNIQUE INDEX itself fail, so duplicates are
  // deduped first (keeping the lowest rowid) — and, per the cohorts
  // version-11 precedent (and the app-launch-bricking bug that omission
  // caused), every FK reference to the row being deleted is repointed to
  // the surviving row FIRST. The only such reference is
  // template_slots.group_id (schema.sql) — anchor_activities.group_ids is
  // a plain TEXT column (JSON blob), not a REFERENCES column, so it has no
  // FK to repoint.
  if (getSchemaVersion(db) < 12) {
    db.transaction(() => {
      const survivors = db
        .prepare(
          `SELECT camp_id, name, MIN(rowid) as keep_rowid
           FROM groups GROUP BY camp_id, name HAVING COUNT(*) > 1`
        )
        .all()

      for (const { camp_id, name, keep_rowid } of survivors) {
        const keepRow = db
          .prepare('SELECT id FROM groups WHERE rowid = ?')
          .get(keep_rowid)
        const dupes = db
          .prepare(
            'SELECT id FROM groups WHERE camp_id = ? AND name = ? AND rowid != ?'
          )
          .all(camp_id, name, keep_rowid)

        for (const { id: dupeId } of dupes) {
          db.prepare('UPDATE template_slots SET group_id = ? WHERE group_id = ?').run(
            keepRow.id,
            dupeId
          )
        }
      }

      db.exec(`
        DELETE FROM groups
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM groups GROUP BY camp_id, name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_camp_name ON groups(camp_id, name);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (12, ?)').run(
      new Date().toISOString()
    )
  }

  // Round 2 Red Hat fix (Sub-plan D Task 1, HIGH finding 1): time_blocks had
  // NO uniqueness constraint at all, unlike groups/cohorts/days_of_operation
  // (all UNIQUE(camp_id, name)) — concurrent same-named adds from two
  // devices silently created permanent duplicates with zero conflict
  // signal. Scoped by cohort_id (not just camp_id) since block names are
  // cohort-local. A fresh install gets UNIQUE(camp_id, cohort_id, name) via
  // schema.sql's CREATE TABLE; a db that already ran an earlier schema
  // version keeps its old time_blocks table as-is (CREATE TABLE IF NOT
  // EXISTS never retrofits it), so this adds the same guarantee via a
  // standalone unique index — same pattern as idx_groups_camp_name
  // (version 12). SQLite treats NULL as distinct in UNIQUE indexes, so
  // grouping by cohort_id directly (rather than coalescing) already gives
  // the right semantics — two rows with cohort_id NULL are never
  // considered duplicates of each other by the index, matching how a
  // block with no cohort has no cohort-local name collision to guard
  // against. Any pre-existing (camp_id, cohort_id, name) duplicate rows
  // would make the CREATE UNIQUE INDEX itself fail, so duplicates are
  // deduped first (keeping the lowest rowid). template_slots.time_block_id
  // (schema.sql) is a plain TEXT column, not a REFERENCES column, so
  // unlike groups.id/template_slots.group_id there is no FK to repoint.
  if (getSchemaVersion(db) < 13) {
    db.transaction(() => {
      db.exec(`
        DELETE FROM time_blocks
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM time_blocks GROUP BY camp_id, cohort_id, name
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_time_blocks_camp_cohort_name
          ON time_blocks(camp_id, cohort_id, name);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (13, ?)').run(
      new Date().toISOString()
    )
  }

  // Closes the same missing-uniqueness gap idx_time_blocks_camp_cohort_name
  // (version 13) closed for time_blocks, for tiers: unit names are
  // cohort-scoped, and tiers had NO uniqueness constraint at all, so
  // concurrent same-named adds from two devices silently created permanent
  // duplicates with zero conflict signal. A fresh install gets
  // UNIQUE(camp_id, cohort_id, name) via schema.sql's CREATE TABLE; a db
  // that already ran an earlier schema version keeps its old tiers table as
  // -is (CREATE TABLE IF NOT EXISTS never retrofits it, and cohort_id/
  // sort_order on those dbs came from the version-10 ALTER TABLE), so this
  // adds the same guarantee via a standalone unique index.
  //
  // Unlike time_blocks (version 13), tiers.id IS referenced elsewhere:
  // groups.tier_id (schema.sql) is a plain TEXT column with no DB-level
  // FOREIGN KEY constraint, so the dedup DELETE below would succeed
  // silently even if a surviving group still pointed at a duplicate's id —
  // the exact FK-repoint gap this project already hit once (Sub-plan B
  // Task 2's cohorts migration, and fixed for groups.id/template_slots at
  // version 12) — same JS-loop repoint-then-delete pattern reused here,
  // since GROUP BY includes cohort_id (nullable) and SQL `=` on NULL never
  // matches, so the repoint must be done in JS, not a NULL-unsafe SQL join.
  if (getSchemaVersion(db) < 14) {
    db.transaction(() => {
      const survivors = db
        .prepare(
          `SELECT camp_id, cohort_id, name, MIN(rowid) as keep_rowid
           FROM tiers GROUP BY camp_id, cohort_id, name HAVING COUNT(*) > 1`
        )
        .all()

      for (const { camp_id, cohort_id, name, keep_rowid } of survivors) {
        const keepRow = db
          .prepare('SELECT id FROM tiers WHERE rowid = ?')
          .get(keep_rowid)
        const dupes = db
          .prepare(
            `SELECT id FROM tiers
             WHERE camp_id = ? AND name = ? AND cohort_id IS ? AND rowid != ?`
          )
          .all(camp_id, name, cohort_id, keep_rowid)

        for (const { id: dupeId } of dupes) {
          db.prepare('UPDATE groups SET tier_id = ? WHERE tier_id = ?').run(
            keepRow.id,
            dupeId
          )
        }
      }

      db.exec(`
        DELETE FROM tiers
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM tiers GROUP BY camp_id, cohort_id, name
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_camp_cohort_name
          ON tiers(camp_id, cohort_id, name);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (14, ?)').run(
      new Date().toISOString()
    )
  }

  // ActivitiesScreen migration off Supabase. Adds every field the screen
  // actually needs beyond the priority/is_locked/span_blocks columns added
  // at version 10 (location, is_outdoor, max_groups_per_slot, min_per_week,
  // max_per_week, same_tier_only, eligible_tier_ids, eligible_group_ids,
  // prefer_before_day, prefer_before_day_min, weather_alternative_id,
  // notes), and closes the same missing-uniqueness gap
  // idx_groups_camp_name (version 12) closed for groups: activities are
  // camp-scoped only (no cohort_id — unlike tiers/time_blocks), and had NO
  // uniqueness constraint at all. A fresh install gets UNIQUE(camp_id, name)
  // via schema.sql's CREATE TABLE; a db that already ran an earlier schema
  // version keeps its old activities table as-is (CREATE TABLE IF NOT
  // EXISTS never retrofits it), so this adds the same guarantee via a
  // standalone unique index.
  //
  // Two references to activities.id need repointing before the dedupe
  // DELETE, mirroring the groups.id/template_slots.group_id fix (version
  // 12): template_slots.activity_id IS a DB-level REFERENCES column
  // (schema.sql), so deleting a duplicate without repointing would throw
  // `FOREIGN KEY constraint failed`. activities.weather_alternative_id is a
  // self-reference (plain TEXT column, no DB-level FK — like
  // groups.tier_id's version-14 precedent), repointed too so a surviving
  // activity's "weather alternative" pointer isn't silently orphaned by a
  // dedupe delete of the activity it pointed at.
  if (getSchemaVersion(db) < 15) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('activities', 'location', 'TEXT')
      addColumnIfMissing('activities', 'is_outdoor', 'INTEGER')
      addColumnIfMissing('activities', 'max_groups_per_slot', 'INTEGER')
      addColumnIfMissing('activities', 'min_per_week', 'INTEGER')
      addColumnIfMissing('activities', 'max_per_week', 'INTEGER')
      addColumnIfMissing('activities', 'same_tier_only', 'INTEGER')
      addColumnIfMissing('activities', 'eligible_tier_ids', 'TEXT')
      addColumnIfMissing('activities', 'eligible_group_ids', 'TEXT')
      addColumnIfMissing('activities', 'prefer_before_day', 'INTEGER')
      addColumnIfMissing('activities', 'prefer_before_day_min', 'INTEGER')
      addColumnIfMissing('activities', 'weather_alternative_id', 'TEXT')
      addColumnIfMissing('activities', 'notes', 'TEXT')

      const survivors = db
        .prepare(
          `SELECT camp_id, name, MIN(rowid) as keep_rowid
           FROM activities GROUP BY camp_id, name HAVING COUNT(*) > 1`
        )
        .all()

      for (const { camp_id, name, keep_rowid } of survivors) {
        const keepRow = db
          .prepare('SELECT id FROM activities WHERE rowid = ?')
          .get(keep_rowid)
        const dupes = db
          .prepare(
            'SELECT id FROM activities WHERE camp_id = ? AND name = ? AND rowid != ?'
          )
          .all(camp_id, name, keep_rowid)

        for (const { id: dupeId } of dupes) {
          db.prepare('UPDATE template_slots SET activity_id = ? WHERE activity_id = ?').run(
            keepRow.id,
            dupeId
          )
          db.prepare(
            'UPDATE activities SET weather_alternative_id = ? WHERE weather_alternative_id = ?'
          ).run(keepRow.id, dupeId)
        }
      }

      db.exec(`
        DELETE FROM activities
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM activities GROUP BY camp_id, name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_camp_name ON activities(camp_id, name);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (15, ?)').run(
      new Date().toISOString()
    )
  }

  // Sub-plan D Task 0: anchor_activities was created with a minimal/
  // inference-only column set in Sub-plan A. This adds the real columns
  // confirmed by directly re-reading AnchorsScreen.jsx's actual
  // insert/update payloads — see schema.sql's comments on the table for
  // the full confirmation note.
  //
  // This block originally also backfilled day_override_templates/
  // day_override_template_slots columns — removed in v46 (docs/adr/
  // 2026-08-23-override-family-model.md §6a) along with the tables
  // themselves: a pre-v10 device migrating forward now skips straight past
  // both tables' existence, and v46's DROP TABLE IF EXISTS is a no-op for
  // it, same end state as a device that already had them.
  if (getSchemaVersion(db) < 16) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('anchor_activities', 'time_block_id', 'TEXT')
      addColumnIfMissing('anchor_activities', 'name', 'TEXT')
      addColumnIfMissing('anchor_activities', 'notes', 'TEXT')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (16, ?)').run(
      new Date().toISOString()
    )
  }

  // Sub-plan E Task 3: template_slots never gained anchor_id/is_anchor
  // columns (unlike flags/is_released/is_span_head, added at version 10) —
  // surfaced only now because ScheduleScreen.jsx's generate()/placeAnchors()/
  // restoreSnapshot() rows carry both and bulk_replace inserts directly into
  // this table's real columns, so a missing column fails loudly instead of
  // being silently dropped like an unregistered field-level write would be.
  if (getSchemaVersion(db) < 17) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('template_slots', 'anchor_id', 'TEXT')
      addColumnIfMissing('template_slots', 'is_anchor', 'INTEGER')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (17, ?)').run(
      new Date().toISOString()
    )
  }

  // Bulk-replace conflict detection compared raw operations.seq across two
  // unrelated per-db AUTOINCREMENT counters (Host's vs Client's), causing
  // spurious conflicts on nearly every second bulk_replace to the same
  // scope. host_seq lets the Client persist the Host's real seq (already on
  // the wire in op_applied) instead of discarding it for a fresh local
  // number. NULL on Host-authored rows (Host's own seq is already
  // canonical). See docs/adr/2026-07-24-bulk-replace-seq-fix.md.
  if (getSchemaVersion(db) < 18) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('operations', 'host_seq', 'INTEGER')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (18, ?)').run(
      new Date().toISOString()
    )
  }

  // Append-only audit event log — see
  // docs/adr/2026-07-25-append-only-audit-event-log.md. Local-only, does not
  // flow through the operations table/sync.
  if (getSchemaVersion(db) < 19) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camp_id TEXT,
        actor_user_id TEXT,
        device_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        occurred_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
        reason TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id);
    `)

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (19, ?)').run(
      new Date().toISOString()
    )
  }

  // Device trust, pairing, and revocation — see
  // docs/adr/2026-07-25-device-trust-revocation.md and
  // docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md
  // ("Schema (sub-task 1)"). Adds pairing/authorization/revocation columns
  // to devices (a device row existing no longer implies it may log in), the
  // Host-only host_signing_key singleton, and camps.signing_public_key
  // (Ed25519, supersedes the HMAC signing_secret — kept, not dropped, per
  // the ADR's own note).
  if (getSchemaVersion(db) < 20) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('devices', 'authorized_at', 'TEXT')
      addColumnIfMissing('devices', 'authorized_by_user_id', 'TEXT')
      addColumnIfMissing('devices', 'revoked_at', 'TEXT')
      addColumnIfMissing('devices', 'revoked_by_user_id', 'TEXT')
      addColumnIfMissing('devices', 'revocation_reason', 'TEXT')
      addColumnIfMissing('devices', 'device_secret_identifier', 'TEXT')
      // NOT NULL DEFAULT 'pending' cannot be added directly via ALTER TABLE
      // ADD COLUMN on a version of SQLite that rejects a non-constant
      // default combined with NOT NULL in some configurations; add it
      // nullable-with-default here (SQLite backfills the default for
      // existing rows on ADD COLUMN either way) — matching every other
      // ALTER in this file, none of which use inline NOT NULL.
      // Per the design doc's explicit non-goal ("no migration tooling for
      // existing pre-pairing camps — this app has not shipped production
      // camp data"), a pre-migration device row is NOT auto-authorized here.
      // It lands as 'pending' like any other unauthorized row and must be
      // explicitly authorized via the approveDevice IPC handler (Host admin
      // approval flow, sub-task 2) before it can act again — the
      // stricter, revocation-first behavior this whole ADR exists for.
      const hasPairingStatus = db
        .pragma('table_info(devices)')
        .some((col) => col.name === 'pairing_status')
      if (!hasPairingStatus) {
        // NOT NULL DEFAULT 'pending', matching schema.sql's declaration
        // exactly — SQLite's ALTER TABLE ADD COLUMN supports NOT NULL
        // combined with a constant DEFAULT (backfills existing rows with the
        // default), so this can match schema.sql's column definition
        // verbatim rather than diverging into a nullable variant.
        db.exec("ALTER TABLE devices ADD COLUMN pairing_status TEXT NOT NULL DEFAULT 'pending'")
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS host_signing_key (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          public_key TEXT NOT NULL,
          private_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `)

      addColumnIfMissing('camps', 'signing_public_key', 'TEXT')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (20, ?)').run(
      new Date().toISOString()
    )
  }

  // T7 fix (see docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md
  // and its companion design doc, Part 3.4): schedule_templates.id becomes a
  // pure function of camp_id (deriveScheduleTemplateId, electron/ops/scheduleTemplateId.js)
  // instead of a random UUID, so two devices that independently mint a
  // "Master Template" row for the same camp always agree on its id. Existing
  // rows must be RE-KEYED to that deterministic value, not just backstopped
  // by the UNIQUE(camp_id) constraint added below — schedule_templates.
  // ensureExists (electron/ops/projections.js) is INSERT OR IGNORE, so a
  // create attempt using the deterministic id against a camp whose existing
  // row has a DIFFERENT (pre-existing, random-UUID) id would be silently
  // absorbed by a bare UNIQUE(camp_id) constraint — no throw, no row created,
  // the following field UPDATE affects zero rows. See the design doc's
  // Finding 2 for the full mechanism this closes.
  if (getSchemaVersion(db) < 21) {
    db.transaction(() => {
      // 1. Dedupe: for any camp_id with more than one row (not live in
      // production today, but a correct migration must still handle it),
      // keep MIN(rowid) and repoint every table that references a
      // duplicate's id to the survivor before deleting the duplicates. This
      // step keeps an EXISTING row (the survivor), so — unlike step 2's
      // rename — it does not need the insert-copy dance: no id actually
      // changes here, only which row a shared id's data ends up under.
      const survivors = db
        .prepare(
          `SELECT camp_id, MIN(rowid) as keep_rowid FROM schedule_templates GROUP BY camp_id HAVING COUNT(*) > 1`
        )
        .all()

      for (const { camp_id, keep_rowid } of survivors) {
        const keepRow = db.prepare('SELECT id FROM schedule_templates WHERE rowid = ?').get(keep_rowid)
        const dupes = db
          .prepare('SELECT id FROM schedule_templates WHERE camp_id = ? AND rowid != ?')
          .all(camp_id, keep_rowid)

        for (const { id: dupeId } of dupes) {
          db.prepare('UPDATE template_slots SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
          if (tableExists('template_overlays')) {
            db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
          }
          db.prepare('UPDATE schedule_snapshots SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
        }
      }

      db.exec(
        `DELETE FROM schedule_templates WHERE rowid NOT IN (SELECT MIN(rowid) FROM schedule_templates GROUP BY camp_id)`
      )

      // 2. Re-key: after dedupe, exactly one row per camp_id. Rewrite each
      // row's id to the deterministic value via insert-copy -> repoint ->
      // delete-old — never a raw UPDATE of the referenced primary key.
      // template_overlays/schedule_snapshots have a NOT NULL REFERENCES
      // schedule_templates(id) with foreign_keys=ON (schema.sql), and that
      // check is immediate (not deferred) per-statement: the instant a raw
      // UPDATE changed the parent's id, any child still pointing at the old
      // value would reference a row that no longer exists. Inserting the new
      // row BEFORE repointing children (and deleting the old row only after
      // every child is repointed) means no child ever points at a
      // non-existent parent.
      const rows = db.prepare('SELECT id, camp_id, name FROM schedule_templates').all()
      for (const { id: oldId, camp_id, name } of rows) {
        const newId = deriveScheduleTemplateId(camp_id)
        if (newId === oldId) continue
        db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(newId, camp_id, name)
        db.prepare('UPDATE template_slots SET template_id = ? WHERE template_id = ?').run(newId, oldId)
        if (tableExists('template_overlays')) {
          db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(newId, oldId)
        }
        db.prepare('UPDATE schedule_snapshots SET template_id = ? WHERE template_id = ?').run(newId, oldId)
        db.prepare('DELETE FROM schedule_templates WHERE id = ?').run(oldId)
      }

      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp ON schedule_templates(camp_id);')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (21, ?)').run(
      new Date().toISOString()
    )
  }

  // T7 fix, Part 4.1: a device that has not yet completed its first domain
  // sync must not be permitted to run schedule-mutating actions (the
  // write-gate itself is slice 2, ScheduleScreen.jsx — this migration only
  // lays down the persisted flag it reads). device_identity is this
  // install's own per-device singleton row (getOrCreateDeviceId), distinct
  // from the camp-wide `devices` roster.
  if (getSchemaVersion(db) < 22) {
    db.transaction(() => {
      const has = db.pragma('table_info(device_identity)').some((c) => c.name === 'first_sync_completed_at')
      if (!has) db.exec('ALTER TABLE device_identity ADD COLUMN first_sync_completed_at TEXT')

      // Backfill: a device that already has a camps row at migration time
      // already has SOME camp data locally — it's either the pre-existing
      // Host, or a Client that already completed a sync before this gate
      // existed. Do not retroactively gate it; the gate is meant to apply
      // only to a Client pairing for the first time AFTER this ships, not to
      // punish an already-working install.
      const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
      if (camp) {
        db.prepare(
          'UPDATE device_identity SET first_sync_completed_at = COALESCE(first_sync_completed_at, ?)'
        ).run(new Date().toISOString())
      }
    })()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (22, ?)').run(
      new Date().toISOString()
    )
  }

  // Plural candidate schedules per camp
  // (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md). A camp may
  // now hold two schedules — one per building route — instead of one. v21's
  // UNIQUE(camp_id) made that impossible, so it is replaced by
  // UNIQUE(camp_id, kind): the invariant v21 established (a route cannot fork
  // into duplicate rows) is preserved, only its scope narrows.
  //
  // Nothing is deleted, re-keyed or rewritten here. The existing row keeps
  // WHATEVER id it already has and acquires kind='generated'; the manual row is
  // created lazily, on first use, through the ordinary op-log path.
  //
  // CORRECTION 2026-07-29: this comment previously claimed the existing row
  // "keeps its byte-identical deterministic id". That is FALSE for any camp
  // whose schedule_templates row was minted AFTER migration v21 ran by a
  // renderer that still used crypto.randomUUID() (the renderer half of the T7
  // deterministic-id work landed only on the plural-routes branch). v21's
  // re-key is a one-shot data fix; it does not constrain rows created later.
  // Such a camp's generated row has a RANDOM UUID id, so a renderer that
  // resolved the route by deriving the id found no row, tried to insert one,
  // and lost silently to UNIQUE(camp_id, 'generated') — generation appeared to
  // do nothing. The renderer now resolves by (camp_id, kind) instead of by
  // derived id; see the Correction 2026-07-29 block in
  // docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md.
  if (getSchemaVersion(db) < 23) {
    db.transaction(() => {
      const hasKind = db.pragma('table_info(schedule_templates)').some((c) => c.name === 'kind')
      if (!hasKind) {
        // NOT NULL is safe on ALTER because a non-null default is supplied, and
        // it is REQUIRED: SQLite treats distinct NULLs as non-conflicting, so a
        // nullable kind would let (camp_id, NULL) rows multiply — exactly the
        // fork v21 exists to prevent.
        db.exec("ALTER TABLE schedule_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'generated'")
      }
      // Belt-and-braces alongside the column default: idempotent, and correct
      // even if a row somehow arrived with an empty kind.
      db.exec("UPDATE schedule_templates SET kind = 'generated' WHERE kind IS NULL OR kind = ''")

      db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp')
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp_kind ON schedule_templates(camp_id, kind);'
      )

      repairMissingScheduleTemplates(db)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (23, ?)').run(
      new Date().toISOString()
    )
  }

  // Adopt the orphaned template_slots left behind by the resolution defect
  // described in the v23 correction above. A generate() that lost its
  // schedule_templates insert to UNIQUE(camp_id, kind) still wrote its slots —
  // template_slots has no declared FK, so they were accepted — under the
  // DERIVED id, which no schedule_templates row holds. loadAll() gates every
  // route on the parent row existing, so those slots are invisible: work the
  // director produced and never saw.
  //
  // DATA ONLY, no DDL on any existing table. Nothing is ever deleted, and
  // nothing is merged where merging could lose a visible week:
  //   adopt  only when the resolved row for (camp_id, kind) has ZERO rows in
  //          that child table — there is provably no competing week.
  //   leave  otherwise. The orphans stay exactly where they are, invisible and
  //          harmless, recoverable by hand indefinitely.
  // Every move is journalled so the inverse (electron/db/rollback/v24_down.js)
  // is computed from data rather than guessed.
  //
  // LOCAL ONLY, deliberately: this repoints rows directly and appends NO
  // operation, so it does not replicate. An orphan set is a local artefact of a
  // local failed generate, and inventing a "repoint" op would add a sync
  // primitive whose replay semantics nobody has designed. Two consequences the
  // next reader should not mistake for oversights: devices adopt independently
  // as each upgrades (so a peer still on v23 keeps reading that route as not
  // started until it upgrades), and an orphan set that arrives on a peer AFTER
  // that peer has run v24 is never adopted there. Both are recoverable by hand
  // and neither loses data.
  if (getSchemaVersion(db) < 24) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS migration_v24_repoint_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        old_template_id TEXT NOT NULL,
        new_template_id TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`)

      const now = new Date().toISOString()
      const templates = db.prepare('SELECT id, camp_id, kind FROM schedule_templates').all()
      const present = new Set(templates.map((t) => t.id))

      for (const t of templates) {
        // The derived id is used here ONLY to attribute an orphan to a route,
        // once, inside a migration, because no other evidence of an orphan's
        // route exists. This is NOT a precedent for parsing ids at runtime —
        // schedule_templates.kind remains the sole route authority (ADR
        // Decision §1). There is no runtime path through this code.
        const orphanId = deriveScheduleTemplateId(t.camp_id, t.kind)
        if (orphanId === t.id || present.has(orphanId)) continue

        for (const table of ['template_slots', 'template_overlays', 'schedule_snapshots']) {
          if (!tableExists(table)) continue // template_overlays retired in v53
          const mine = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE template_id = ?`).get(t.id).c
          if (mine > 0) continue // a competing week exists — leave the orphans alone
          const orphans = db.prepare(`SELECT id FROM ${table} WHERE template_id = ?`).all(orphanId)
          if (orphans.length === 0) continue
          for (const { id } of orphans) {
            db.prepare(`UPDATE ${table} SET template_id = ? WHERE id = ?`).run(t.id, id)
            db.prepare(
              `INSERT INTO migration_v24_repoint_log
                 (table_name, row_id, old_template_id, new_template_id, applied_at)
               VALUES (?, ?, ?, ?, ?)`
            ).run(table, id, orphanId, t.id, now)
          }
        }
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (24, ?)').run(
      new Date().toISOString()
    )
  }

  // v25 — pending_restores, the durable queue of restore requests a Client
  // could not deliver while the Host was unreachable
  // (docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md).
  //
  // DDL only, no data movement, so unlike v24 there is no journal table and
  // re-applying this migration is harmless (it recreates an empty table).
  // See electron/db/rollback/v25_down.js.
  //
  // The statement text must stay byte-identical to schema.sql's copy —
  // sqlite_master stores the original CREATE TABLE text, so a fresh database
  // and a migrated one would otherwise differ in a way no column check
  // catches. pendingRestores.migration.test.js asserts exactly that.
  if (getSchemaVersion(db) < 25) {
    db.transaction(() => {
      db.exec(PENDING_RESTORES_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (25, ?)').run(
      new Date().toISOString()
    )
  }

  // v26 — retire the orphaned template_slots v24 correctly declined to repoint,
  // by preserving each set as a Version first
  // (docs/adr/2026-07-30-retiring-orphaned-schedule-slots.md).
  //
  // v24 adopts an orphan set only when the real template has no competing rows.
  // Where it does — the dev camp holds 50 visible slots — v24 left the orphans
  // alone, which was right: repointing would overwrite a week the director can
  // see with one they cannot. That parking is now unaffordable. T21 makes
  // deleting a used record conditional on snapshotting the affected routes
  // first, and an orphan belongs to no route, so the delete refuses and NO
  // group can be deleted on any camp carrying orphans.
  //
  // So: snapshot, then delete — the same shape as T21 itself, using the answer
  // this app already has for "destroy something recoverable" rather than
  // inventing a second one.
  //
  // THE ONE PROPERTY THAT MATTERS: the snapshot must succeed or that camp's
  // rows stay. Per camp, not per migration — each camp runs in its own nested
  // transaction (a SAVEPOINT), so a failed preservation rolls back to exactly
  // the state before it and every other camp still completes. A migration that
  // deletes rows it failed to preserve is worse than one that does nothing.
  //
  // LOCAL ONLY, as v24 is, and for a stronger reason than precedent: an orphan
  // row has no parent, and sendFullSyncIfFirstPairing ships child rows joined
  // THROUGH schedule_templates, so orphans have never been able to reach a
  // peer. They are a per-device artefact; nothing here changes that. The
  // recovered Version is written without an op too, so an ALREADY-PAIRED peer
  // never learns of it — deliberate, not an oversight. The week only ever
  // existed on this device, and emitting an op would make a local repair into a
  // sync event whose deterministic id would collide across devices holding
  // DIFFERENT orphan sets. (A device pairing for the FIRST time does receive
  // it: schedule_snapshots is parent-scoped and the recovered row has a real
  // parent, unlike the orphan slots it was made from. That is the ordinary
  // behaviour of any Version and needs no special handling.)
  if (getSchemaVersion(db) < 26) {
    // Set only when a snapshot INSERT failed. The v26 stamp is withheld in
    // that case so the camp is retried on the next launch: skipping is the
    // safe outcome for one run, but without a retry the camp's orphans — and
    // the T21 block they cause — would be permanent.
    let retryNeeded = false
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS migration_v26_retired_orphan_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- camp_id/kind are NULLABLE on purpose: an orphan set with no owning
        -- template row cannot be attributed to either, and a guessed camp_id
        -- is worse than none on the row support reads when T21 is still
        -- blocked for a camp.
        camp_id TEXT,
        kind TEXT,
        orphan_template_id TEXT NOT NULL,
        real_template_id TEXT,
        snapshot_id TEXT,
        outcome TEXT NOT NULL,
        reason TEXT,
        table_name TEXT,
        row_id TEXT,
        row_json TEXT,
        applied_at TEXT NOT NULL
      );`)

      const now = new Date().toISOString()
      const journal = db.prepare(
        `INSERT INTO migration_v26_retired_orphan_log
           (camp_id, kind, orphan_template_id, real_template_id, snapshot_id,
            outcome, reason, table_name, row_id, row_json, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      const templates = db.prepare('SELECT id, camp_id, kind FROM schedule_templates').all()
      const present = new Set(templates.map((t) => t.id))
      const handled = new Set()
      // Scoped to THIS device. The orphan id is derived from camp_id + kind,
      // both of which replicate, so an id built from it alone would be the
      // SAME on two devices holding DIFFERENT recovered weeks. The Version row
      // has a real parent and so does travel on a first-pairing full sync, and
      // deleting a Version emits a replicating DELETE_FIELD op keyed by id —
      // so a shared id means deleting the unfamiliar week here deletes a
      // different week there, undetectably (the names are identical too).
      // device_identity is local and never replicates.
      const deviceId = getOrCreateDeviceId(db)

      for (const t of templates) {
        // Same use, same limit, as v24: the derived id attributes an orphan to
        // a route, once, inside a migration, because no other evidence of its
        // route exists. NOT a precedent for parsing ids at runtime —
        // schedule_templates.kind remains the sole route authority
        // (plural-candidates ADR, Decision §1). There is no runtime path here.
        const orphanId = deriveScheduleTemplateId(t.camp_id, t.kind)
        if (orphanId === t.id || present.has(orphanId)) continue

        const slots = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all(orphanId)
        // template_overlays retired in v53: absent once the drop has run (the
        // artificial post-v53 mid-history rollback exercised by tests). On a
        // genuine forward migration it exists here and this reads real rows.
        const overlays = tableExists('template_overlays')
          ? db.prepare('SELECT * FROM template_overlays WHERE template_id = ? ORDER BY id').all(orphanId)
          : []
        handled.add(orphanId)
        if (slots.length === 0 && overlays.length === 0) continue

        // The payload shape saveSnapshot writes (src/screens/ScheduleScreen.jsx).
        // A Version the existing restore path cannot read is a deletion with
        // extra steps, so the field set and encoding are matched exactly.
        //
        // saveSnapshot reads rows that have already been through
        // normalizeSlots; these are raw. The two coercions it would have
        // applied are re-implemented here rather than imported: normalizeSlots
        // lives under src/, which electron-builder does NOT package, so an
        // electron-side import of it works in electron:dev and fails in the
        // installed app, at migration time, on a real database.
        const snapSlots = slots.map((s) => ({
          group_id: s.group_id,
          day_id: s.day_id,
          time_block_id: s.time_block_id,
          activity_id: s.activity_id,
          anchor_id: s.anchor_id,
          is_anchor: s.is_anchor === null || s.is_anchor === undefined ? s.is_anchor : s.is_anchor === 1,
          flags: parseSlotFlags(s.flags),
        }))
        const snapOverlays = overlays.map((o) => ({
          unit_id: o.unit_id,
          day_id: o.day_id,
          from_block_order: o.from_block_order,
          to_block_order: o.to_block_order,
          label: o.label,
        }))

        // Deterministic per device, so a rollback followed by a roll-forward
        // cannot mint a SECOND Version in the director's list. Internal; never
        // displayed.
        const snapshotId = `v26-recovered:${deviceId}:${orphanId}`

        // A roll-forward after a rollback re-writes this row. If the director
        // renamed the Version in between, their name is what the list showed
        // them and it is kept — the migration only supplies a name when there
        // is none. The prior row is journalled below either way.
        const priorSnap = db
          .prepare('SELECT * FROM schedule_snapshots WHERE id = ?')
          .get(snapshotId)
        const snapName = priorSnap && priorSnap.name ? priorSnap.name : V26_RECOVERED_WEEK_NAME

        try {
          db.transaction(() => {
            if (priorSnap) {
              journal.run(
                t.camp_id, t.kind, orphanId, t.id, snapshotId,
                'replaced', 'a recovered Version already existed and was rewritten',
                'schedule_snapshots', snapshotId, JSON.stringify(priorSnap), now
              )
            }
            // The overlays column was dropped in v53. When it is still present
            // (genuine forward migration, or a real pre-v53 device) the recovered
            // Version carries its overlays; when absent (post-v53) the snapshot is
            // slots-only, matching the retired subsystem.
            const snapshotsHaveOverlays = db
              .pragma('table_info(schedule_snapshots)')
              .some((c) => c.name === 'overlays')
            if (snapshotsHaveOverlays) {
              db.prepare(
                `INSERT OR REPLACE INTO schedule_snapshots
                   (id, template_id, name, is_auto, created_at, slots, overlays)
                 VALUES (?, ?, ?, 0, ?, ?, ?)`
              ).run(
                snapshotId, t.id, snapName, now,
                JSON.stringify(snapSlots), JSON.stringify(snapOverlays)
              )
            } else {
              db.prepare(
                `INSERT OR REPLACE INTO schedule_snapshots
                   (id, template_id, name, is_auto, created_at, slots)
                 VALUES (?, ?, ?, 0, ?, ?)`
              ).run(snapshotId, t.id, snapName, now, JSON.stringify(snapSlots))
            }

            const retiredTables = tableExists('template_overlays')
              ? [['template_slots', slots], ['template_overlays', overlays]]
              : [['template_slots', slots]]
            for (const [table, rows] of retiredTables) {
              for (const row of rows) {
                db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id)
                journal.run(
                  t.camp_id, t.kind, orphanId, t.id, snapshotId,
                  'retired', null, table, row.id, JSON.stringify(row), now
                )
              }
            }
          })()
        } catch (err) {
          retryNeeded = true
          journal.run(
            t.camp_id, t.kind, orphanId, t.id, null,
            'skipped', `snapshot failed: ${err?.message || String(err)}`,
            null, null, null, now
          )
        }
      }

      // An orphan set whose derived id maps to no template row at all cannot be
      // preserved — schedule_snapshots.template_id carries a real FK, so there
      // is nowhere legal to write the Version. Per the ADR those rows are left
      // rather than deleted unpreserved, which means T21 stays blocked for that
      // camp. Journalled so the condition is visible in the field instead of
      // silent. None exist on any database measured so far.
      const stranded = db.prepare(
        `SELECT DISTINCT s.template_id AS tid FROM template_slots s
          WHERE NOT EXISTS (SELECT 1 FROM schedule_templates t WHERE t.id = s.template_id)
          ORDER BY s.template_id`
      ).all()
      // Already journalled on an earlier attempt — the stamp is withheld when a
      // snapshot fails, so this block can run on several launches and must not
      // re-append the same permanent condition each time.
      const alreadyStranded = db.prepare(
        `SELECT DISTINCT orphan_template_id AS tid FROM migration_v26_retired_orphan_log
          WHERE outcome = 'skipped' AND real_template_id IS NULL`
      ).all().map((r) => r.tid)
      const strandedSeen = new Set(alreadyStranded)
      for (const { tid } of stranded) {
        if (handled.has(tid) || strandedSeen.has(tid)) continue
        strandedSeen.add(tid)
        // camp_id/kind stay NULL: there is no template row to attribute this
        // set to, and `SELECT id FROM camps LIMIT 1` would be a guess — right
        // only under the single-camp-per-device invariant, wrong and
        // misleading anywhere else.
        journal.run(
          null, null, tid, null, null,
          'skipped', 'no owning template — nothing legal to attach a Version to',
          null, null, null, now
        )
      }
    })()

    // Withheld when a camp's snapshot failed, so the next launch retries that
    // camp. Everything already retired is a no-op on the retry (its orphan set
    // is empty and the loop `continue`s), and the recovered Version is written
    // under a stable per-device id, so a retry cannot duplicate work. A camp
    // whose orphans are STRANDED does not withhold the stamp: that condition
    // is permanent, and blocking the version forever would re-run the whole
    // migration on every launch to no effect.
    if (!retryNeeded) {
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (26, ?)').run(
        new Date().toISOString()
      )
    }
  }

  // Schedule weeks first-class (docs/adr/2026-08-02-schedule-weeks-first-class.md).
  // A camp previously held one manual + one generated schedule_templates row
  // total; it now holds one such pair PER WEEK. Every existing camp gets
  // exactly one schedule_weeks row named "Week 1" and every existing
  // schedule_templates row is pointed at it — nothing is deleted, nothing is
  // re-keyed, both of a camp's existing schedules land under the same week.
  // Gated on v26 having COMPLETED (>= 26), not merely `< 27`. v26 uses a
  // deferred-retry pattern — if a camp's snapshot write fails it leaves the
  // version unstamped so the next launch retries — and getSchemaVersion is
  // MAX(version). A bare `< 27` guard would let v27 stamp 27 while v26 is still
  // pending, pushing MAX past 26 so v26's `< 26` guard never fires again and
  // its orphan cleanup is skipped forever. `>= 26 && < 27` runs v27 only once
  // v26 is done (including in the same fresh-install pass, right after v26
  // stamps), and stays out of the way while v26 is deferred.
  if (getSchemaVersion(db) >= 26 && getSchemaVersion(db) < 27) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS schedule_weeks (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        name TEXT NOT NULL,
        sort_order INTEGER,
        is_archived INTEGER NOT NULL DEFAULT 0
      )`)

      // Deterministic per-camp id — this migration runs independently on every
      // device that opens this camp's db, and two devices migrating the same
      // camp without coordination must agree on the row id or the week forks
      // once sync replays it (same reasoning as deriveScheduleTemplateId).
      const camps = db.prepare('SELECT id FROM camps').all()
      const insertWeek = db.prepare(
        'INSERT OR IGNORE INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)'
      )
      for (const c of camps) {
        insertWeek.run(`schedule-week:${c.id}:1`, c.id, 'Week 1')
      }

      const hasWeekId = db.pragma('table_info(schedule_templates)').some((c) => c.name === 'week_id')
      if (!hasWeekId) {
        db.exec('ALTER TABLE schedule_templates ADD COLUMN week_id TEXT REFERENCES schedule_weeks(id)')
      }
      // Every EXISTING schedule_templates row (both a camp's manual and its
      // generated row, if present) is re-pointed at that camp's Week 1 — the
      // existing rows keep whatever id they already have, same "nothing is
      // re-keyed" principle the v22 comment above states for kind.
      db.exec(`UPDATE schedule_templates SET week_id = (
        SELECT id FROM schedule_weeks WHERE schedule_weeks.camp_id = schedule_templates.camp_id
      ) WHERE week_id IS NULL OR week_id = ''`)

      db.exec('DROP INDEX IF EXISTS idx_schedule_templates_camp_kind')
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_week_kind ON schedule_templates(week_id, kind)'
      )
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_weeks_camp_name ON schedule_weeks(camp_id, name)'
      )
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (27, ?)').run(
      new Date().toISOString()
    )
  }

  // Per-week activity and group exclusion tables
  // (docs/adr/2026-08-03-multi-week-slices-2-3.md).
  // Gated on >= 27 (not a bare < 28) for the same reason v27 is gated on >= 26:
  // v26 uses deferred retry and getSchemaVersion is MAX(version), so a bare
  // < 28 gate would let v28 stamp 28 while v27 is still pending.
  if (getSchemaVersion(db) >= 27 && getSchemaVersion(db) < 28) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS week_activity_exclusions (
          id TEXT PRIMARY KEY,
          week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
          activity_id TEXT NOT NULL REFERENCES activities(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_week_activity_exclusions_week_activity
          ON week_activity_exclusions(week_id, activity_id);

        CREATE TABLE IF NOT EXISTS week_group_exclusions (
          id TEXT PRIMARY KEY,
          week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
          group_id TEXT NOT NULL REFERENCES groups(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_week_group_exclusions_week_group
          ON week_group_exclusions(week_id, group_id);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (28, ?)').run(
      new Date().toISOString()
    )
  }

  // v29 — per-field provenance: operations.source
  // (docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md).
  // A single nullable TEXT column recording whether a field write came from an
  // import ('import') or a human ('human'); NULL decodes to human (§3). It is
  // added ONLY here (not in schema.sql's CREATE TABLE) so that on both a fresh
  // install and a 28->29 migrated db it is appended LAST — after the
  // migration-only host_seq (v18) — keeping PRAGMA table_info(operations)
  // byte-identical across the two (see the note in schema.sql).
  //
  // NULLABLE is a hard requirement, not a convenience (ADR §5 guardrail 1): a
  // NOT NULL constraint would reject provenance-less ops replicated by a peer
  // that predates this column and would break the NULL=human decode.
  //
  // Gated `>= 28` (matching how v28 gates `>= 27`) so it runs only once v28 has
  // completed, including in the same fresh-install pass right after v28 stamps.
  if (getSchemaVersion(db) >= 28 && getSchemaVersion(db) < 29) {
    db.transaction(() => {
      const hasSource = db.pragma('table_info(operations)').some((c) => c.name === 'source')
      if (!hasSource) db.exec('ALTER TABLE operations ADD COLUMN source TEXT')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (29, ?)').run(
      new Date().toISOString()
    )
  }

  // v30 — source_aliases, the host-local "this imported label means this
  // existing entity" memory (docs/adr/2026-08-09-s1b-host-local-aliases.md).
  //
  // Both-places DDL, following the v25/pending_restores precedent: the table
  // and its index are declared here AND in schema.sql, byte-identical text
  // (SOURCE_ALIASES_DDL), so a fresh install and a migrated db agree on
  // PRAGMA table_info(source_aliases). DDL only, no data movement — reapplying
  // this migration is harmless (CREATE TABLE/INDEX IF NOT EXISTS).
  //
  // Deliberately NOT registered anywhere sync touches (PROJECTIONS,
  // DIRECT_CAMP_ENTITIES, full_sync) — see the ADR's "why this reverses the
  // prior two ADRs" section. Import (and alias confirmation) is host-only and
  // admin-only, so there is exactly one writer and one copy of this table.
  if (getSchemaVersion(db) >= 29 && getSchemaVersion(db) < 30) {
    db.transaction(() => {
      db.exec(SOURCE_ALIASES_DDL)
      db.exec(SOURCE_ALIASES_INDEX_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (30, ?)').run(
      new Date().toISOString()
    )
  }

  // Both-places DDL, same discipline as the v30 block above: the table and
  // its index are declared here AND in schema.sql, byte-identical text
  // (IMPORT_EVIDENCE_DDL), so a fresh install and a migrated db agree on
  // PRAGMA table_info(import_evidence). DDL only, no data movement —
  // reapplying this migration is harmless (CREATE TABLE/INDEX IF NOT EXISTS).
  //
  // Deliberately NOT registered anywhere sync touches (PROJECTIONS,
  // DIRECT_CAMP_ENTITIES, full_sync) — host-local, same as source_aliases.
  // docs/adr/2026-08-10-ingestion-evidence-persistence.md.
  if (getSchemaVersion(db) >= 30 && getSchemaVersion(db) < 31) {
    db.transaction(() => {
      db.exec(IMPORT_EVIDENCE_DDL)
      db.exec(IMPORT_EVIDENCE_INDEX_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (31, ?)').run(
      new Date().toISOString()
    )
  }

  // v32 — camp locations become a first-class entity
  // (docs/adr/2026-08-15-camp-locations-entity.md). Three schema changes plus a
  // deterministic backfill of every existing free-text activities.location
  // string into a `locations` row.
  //
  // Both-places DDL for the two new tables (LOCATIONS_DDL /
  // WEEK_LOCATION_EXCLUSIONS_DDL), same discipline as v30/v31: byte-identical
  // text here and in schema.sql, asserted by locations.migration.test.js. The
  // index and the activities.location_id column live only here (an ALTER-added
  // column's index cannot live in schema.sql, which re-runs against
  // pre-migration dbs).
  //
  // Gated `>= 31` (matching how v31 gates `>= 30`) so it runs only once v31 has
  // completed, including in the same fresh-install pass right after v31 stamps.
  //
  // THE BACKFILL EMITS NO OP. It is a DDL-time side effect, exactly like the
  // v27 schedule_weeks backfill. INV-1 (the ADR's single most important
  // invariant): each device runs this independently, so every id it mints MUST
  // be a pure function of replicated inputs (camp_id + the TRIM-only,
  // case-sensitive place name) or an already-paired Host and its tablets would
  // mint different ids for the same place. See deriveLocationId. Trimming is
  // plain JS `.trim()` done in JS (not SQL TRIM, whose whitespace semantics
  // differ) so this migration and the restore re-resolution path agree.
  if (getSchemaVersion(db) >= 31 && getSchemaVersion(db) < 32) {
    db.transaction(() => {
      db.exec(LOCATIONS_DDL)
      db.exec(WEEK_LOCATION_EXCLUSIONS_DDL)
      db.exec(WEEK_LOCATION_EXCLUSIONS_INDEX_DDL)

      const hasLocationId = db
        .pragma('table_info(activities)')
        .some((c) => c.name === 'location_id')
      if (!hasLocationId) db.exec('ALTER TABLE activities ADD COLUMN location_id TEXT')

      // Local-only review journal (like migration_v24_repoint_log): recomputed
      // identically on every device, never replicated, never in any sync
      // registry. Holds the three review kinds the M3 Locations screen renders
      // before first regeneration. Created inside the migration (not schema.sql)
      // so a fresh install — which runs this block too — gets it as well,
      // keeping the fresh/migrated table set identical.
      db.exec(`CREATE TABLE IF NOT EXISTS location_migration_reviews (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,        -- 'capacity_disagreement' | 'was_unlimited' | 'near_duplicate'
        detail TEXT,               -- compact JSON, see backfillLocations
        created_at TEXT NOT NULL
      )`)

      backfillLocations(db)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (32, ?)').run(
      new Date().toISOString()
    )
  }

  // v33 — the optional camp map (M6, docs/adr/2026-08-16-locations-optional-map.md
  // D1). One new table, no backfill: camp_maps starts empty on every existing
  // camp (image_data NULL), and a row is created lazily by PROJECTIONS.camp_maps'
  // ensureExists on first write, exactly like locations' own blank-row seeding.
  // No column-order trap: every column is present in CAMP_MAPS_DDL from the
  // start (no later ALTER-added column), so fresh and migrated installs are
  // identical by construction — no index needed either.
  if (getSchemaVersion(db) >= 32 && getSchemaVersion(db) < 33) {
    db.transaction(() => {
      db.exec(CAMP_MAPS_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (33, ?)').run(
      new Date().toISOString()
    )
  }

  // v34 — special days (T40 slice 1, data shape only,
  // docs/work/specs/2026-08-20-special-days-data-shape-design.md). Three new
  // tables, no backfill: every camp starts with zero special days, and rows
  // are minted uuids created interactively (author UI is a separate,
  // non-goal follow-on for this slice) — no DDL-time side effect, so this
  // block emits no op, same posture as v33's camp_maps.
  if (getSchemaVersion(db) >= 33 && getSchemaVersion(db) < 34) {
    db.transaction(() => {
      db.exec(SPECIAL_DAYS_DDL)
      db.exec(SPECIAL_DAY_TIME_BLOCKS_DDL)
      db.exec(SPECIAL_DAY_SLOTS_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (34, ?)').run(
      new Date().toISOString()
    )
  }

  // v35 — group-level electives (T41 slice 1, data shape + engine-skip +
  // registration only, docs/work/specs/2026-08-20-group-electives-design.md).
  // Two new tables, no backfill: every camp starts with zero elective sets.
  // ALSO extends the existing template_slots table with a nullable
  // elective_set_id column — template_slots is a DRIFTED TABLE (see the
  // schema.sql comment above it), so this is an ALTER, not folded into a
  // CREATE TABLE. No DDL-time side effect (no existing slot gets a non-null
  // elective_set_id), so this block emits no op, same posture as v33/v34.
  if (getSchemaVersion(db) >= 34 && getSchemaVersion(db) < 35) {
    db.transaction(() => {
      db.exec(ELECTIVE_SETS_DDL)
      db.exec(ELECTIVE_SET_ACTIVITIES_DDL)
      const hasElectiveSetId = db
        .pragma('table_info(template_slots)')
        .some((col) => col.name === 'elective_set_id')
      if (!hasElectiveSetId) db.exec('ALTER TABLE template_slots ADD COLUMN elective_set_id TEXT')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (35, ?)').run(
      new Date().toISOString()
    )
  }

  // v36 — elective durability marker (T103, docs/adr/2026-08-20-electives-
  // authoring.md D2). Single nullable-additive column on the existing
  // elective_sets table: `is_reusable INTEGER NOT NULL DEFAULT 1`. Every
  // existing row (created under v35, before this marker existed) becomes
  // reusable/durable by the DEFAULT — matches "existing rows = reusable" from
  // the ADR. No op is written (DDL-only, same posture as v33/v34/v35).
  if (getSchemaVersion(db) >= 35 && getSchemaVersion(db) < 36) {
    db.transaction(() => {
      const hasIsReusable = db
        .pragma('table_info(elective_sets)')
        .some((col) => col.name === 'is_reusable')
      if (!hasIsReusable) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN is_reusable INTEGER NOT NULL DEFAULT 1')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (36, ?)').run(
      new Date().toISOString()
    )
  }

  // v37 — special_days.notes (T106, ADR 2026-08-20-special-days-authoring-and-
  // day-override-repoint.md D2). Single nullable-additive column on the
  // existing special_days table: free-text record/print notes (teams, points,
  // staffing, trip times) — never solved, only recorded. No backfill (existing
  // rows get NULL). No op is written (DDL-only, same posture as v33/v34/v35/v36).
  if (getSchemaVersion(db) >= 36 && getSchemaVersion(db) < 37) {
    db.transaction(() => {
      const hasNotes = db
        .pragma('table_info(special_days)')
        .some((col) => col.name === 'notes')
      if (!hasNotes) {
        db.exec('ALTER TABLE special_days ADD COLUMN notes TEXT')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (37, ?)').run(
      new Date().toISOString()
    )
  }

  // v38 — day_overrides re-point (T108, ADR 2026-08-21-day-overrides-repoint-
  // shape.md D1/§5.2). Two additive changes, no backfill: every camp starts
  // with zero day_overrides rows, and every existing schedule_snapshots row
  // gets NULL day_overrides_json. No op is written (DDL-only, same posture
  // as v33-v37).
  if (getSchemaVersion(db) >= 37 && getSchemaVersion(db) < 38) {
    db.transaction(() => {
      db.exec(DAY_OVERRIDES_DDL)
      const hasDayOverridesJson = db
        .pragma('table_info(schedule_snapshots)')
        .some((col) => col.name === 'day_overrides_json')
      if (!hasDayOverridesJson) {
        db.exec('ALTER TABLE schedule_snapshots ADD COLUMN day_overrides_json TEXT')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (38, ?)').run(
      new Date().toISOString()
    )
  }

  // v39 — elective_set_activities.camper_headcount (Electives Slice 1, ADR
  // docs/adr/2026-08-22-nested-schedules-electives-and-events.md §2, design
  // docs/work/specs/2026-08-22-electives-nested-schedule-slices.md Slice 1).
  // Single nullable-additive column: the per-offering capacity T41 deferred.
  // NULL = no cap, never "zero campers". No backfill (existing rows get
  // NULL). No op is written (DDL-only, same posture as v33-v38).
  if (getSchemaVersion(db) >= 38 && getSchemaVersion(db) < 39) {
    db.transaction(() => {
      const hasCamperHeadcount = db
        .pragma('table_info(elective_set_activities)')
        .some((col) => col.name === 'camper_headcount')
      if (!hasCamperHeadcount) {
        db.exec('ALTER TABLE elective_set_activities ADD COLUMN camper_headcount INTEGER')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (39, ?)').run(
      new Date().toISOString()
    )
  }

  // v40 — events overlay placement (Slice 1, docs/adr/2026-08-22-events-
  // overlay-placement.md, docs/work/specs/2026-08-22-events-overlay-slices.md).
  // One new table (events), no backfill: every camp starts with zero events.
  // ALSO extends the existing template_slots table with a nullable event_id
  // column — template_slots is a DRIFTED TABLE (see the schema.sql comment
  // above it), so this is an ALTER, not folded into a CREATE TABLE. Mirrors
  // v35's elective_set_id shape exactly. No DDL-time side effect, so this
  // block emits no op, same posture as v33-v39.
  if (getSchemaVersion(db) >= 39 && getSchemaVersion(db) < 40) {
    db.transaction(() => {
      db.exec(EVENTS_DDL)
      const hasEventId = db
        .pragma('table_info(template_slots)')
        .some((col) => col.name === 'event_id')
      if (!hasEventId) db.exec('ALTER TABLE template_slots ADD COLUMN event_id TEXT')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (40, ?)').run(
      new Date().toISOString()
    )
  }

  // v41 — event internal sub-schedule (Slice 2, docs/adr/2026-08-22-event-
  // internal-subschedule.md). Three new tables, no backfill: every existing
  // event starts with zero time blocks / zero groups / zero slots. No
  // DDL-time side effect, so this block emits no op, same posture as v33-v40.
  if (getSchemaVersion(db) >= 40 && getSchemaVersion(db) < 41) {
    db.transaction(() => {
      db.exec(EVENT_TIME_BLOCKS_DDL)
      db.exec(EVENT_GROUPS_DDL)
      db.exec(EVENT_SLOTS_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (41, ?)').run(
      new Date().toISOString()
    )
  }

  // v42 — recurrence-axis storage on anchor_activities (unified-schedule-
  // overlay Slice 1, docs/work/specs/2026-08-23-unified-schedule-overlay-
  // slices.md). Two additive columns, no backfill logic needed:
  // schedule_week_id NULL preserves today's implicit meaning exactly
  // (all-weeks). recurrence_level is NOT NULL DEFAULT 'daily' — every
  // existing anchor IS daily-recurring, and SQLite's ADD COLUMN ... NOT NULL
  // DEFAULT 'daily' populates every existing row with that value for free.
  // Storage + projection only — no UI, no engine use in this slice. No
  // DDL-time side effect, so this block emits no op, same posture as v33-v41.
  if (getSchemaVersion(db) >= 41 && getSchemaVersion(db) < 42) {
    db.transaction(() => {
      const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
      if (!cols.includes('schedule_week_id')) {
        db.exec('ALTER TABLE anchor_activities ADD COLUMN schedule_week_id TEXT')
      }
      if (!cols.includes('recurrence_level')) {
        db.exec("ALTER TABLE anchor_activities ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (42, ?)').run(
      new Date().toISOString()
    )
  }

  // v43 — recurring-event binding shape on elective_sets (unified-schedule-
  // overlay Slice 3a, docs/work/specs/2026-08-23-unified-schedule-overlay-
  // slices.md). Six additive columns mirroring anchor_activities' binding
  // shape exactly, no backfill logic needed: the five nullable columns
  // preserve today's implicit meaning (unbound). recurrence_level is NOT
  // NULL DEFAULT 'daily' — every existing elective_set IS effectively
  // daily-recurring, and SQLite's ADD COLUMN ... NOT NULL DEFAULT 'daily'
  // populates every existing row with that value for free. Storage +
  // projection only — no UI, no engine use in this slice. No DDL-time side
  // effect, so this block emits no op, same posture as v33-v42.
  if (getSchemaVersion(db) >= 42 && getSchemaVersion(db) < 43) {
    db.transaction(() => {
      const cols = db.pragma('table_info(elective_sets)').map((c) => c.name)
      // No REFERENCES clause on the ALTER-added columns, mirroring v42's
      // anchor_activities.schedule_week_id precedent — schema.sql declares
      // the FK for a fresh install; table_info (name/type/notnull/default/pk,
      // what the fresh-vs-migrated equivalence test checks) is identical
      // either way.
      if (!cols.includes('day_id')) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN day_id TEXT')
      }
      if (!cols.includes('time_block_id')) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN time_block_id TEXT')
      }
      if (!cols.includes('is_all_groups')) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN is_all_groups INTEGER')
      }
      if (!cols.includes('group_ids')) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN group_ids TEXT')
      }
      if (!cols.includes('schedule_week_id')) {
        db.exec('ALTER TABLE elective_sets ADD COLUMN schedule_week_id TEXT')
      }
      if (!cols.includes('recurrence_level')) {
        db.exec("ALTER TABLE elective_sets ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (43, ?)').run(
      new Date().toISOString()
    )
  }

  // v44 — truth-status × binding-vector activity ontology
  // (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §3.2/§3.5).
  // One additive, nullable column. No backfill: every existing row stays
  // NULL (not-yet-classified/mixed). Storage + projection only — no writer,
  // no engine use, no UI in this slice. No DDL-time side effect, so this
  // block emits no op, same posture as v33-v43.
  if (getSchemaVersion(db) >= 43 && getSchemaVersion(db) < 44) {
    db.transaction(() => {
      const cols = db.pragma('table_info(activities)').map((c) => c.name)
      if (!cols.includes('recurrence_truth_status')) {
        db.exec('ALTER TABLE activities ADD COLUMN recurrence_truth_status TEXT')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (44, ?)').run(
      new Date().toISOString()
    )
  }

  // v45 — Slice 4 engine location-contention prerequisite (docs/work/specs/
  // 2026-08-23-slice4-engine-location-contention.md §1/§6). Two additive,
  // nullable columns: anchor_activities.location_id and events.location_id,
  // matching activities.location_id's FK-by-convention (no DB-level FOREIGN
  // KEY). No backfill: every existing row stays NULL (unconstrained, same as
  // today). Storage + projection only — no engine use, no writer, no UI in
  // this slice. No DDL-time side effect, so this block emits no op, same
  // posture as v33-v44.
  if (getSchemaVersion(db) >= 44 && getSchemaVersion(db) < 45) {
    db.transaction(() => {
      const anchorCols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
      if (!anchorCols.includes('location_id')) {
        db.exec('ALTER TABLE anchor_activities ADD COLUMN location_id TEXT')
      }
      const eventCols = db.pragma('table_info(events)').map((c) => c.name)
      if (!eventCols.includes('location_id')) {
        db.exec('ALTER TABLE events ADD COLUMN location_id TEXT')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (45, ?)').run(
      new Date().toISOString()
    )
  }

  // v46 — drop the confirmed-dead day_override_templates/
  // day_override_template_slots pair (docs/adr/2026-08-23-override-family-
  // model.md §6a; removal trigger set by 2026-08-21-day-overrides-repoint-
  // shape.md §Q3). No writer ever existed for either table (day_overrides,
  // schema v38, replaced the mechanism they were built for) — confirmed by
  // grep across src/ and electron/ before this migration was written. Child
  // before parent, matching the FK direction
  // (day_override_template_slots.day_override_template_id REFERENCES
  // day_override_templates(id)). DDL-only, emits no op, same posture as
  // v33-v45.
  if (getSchemaVersion(db) >= 45 && getSchemaVersion(db) < 46) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS day_override_template_slots')
      db.exec('DROP TABLE IF EXISTS day_override_templates')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (46, ?)').run(
      new Date().toISOString()
    )
  }

  // v47 — declined_two_row_splits, the host-local "director said no to this
  // split suggestion" memory (docs/adr/2026-08-23-two-rows-multipattern-split.md,
  // docs/work/specs/2026-08-23-two-rows-slice2-affordance.md "Decline-memory").
  //
  // Both-places DDL, following the v30/source_aliases precedent: the table is
  // declared here AND in schema.sql, byte-identical text
  // (DECLINED_TWO_ROW_SPLITS_DDL), so a fresh install and a migrated db agree
  // on PRAGMA table_info(declined_two_row_splits). DDL only, no data movement
  // — reapplying this migration is harmless (CREATE TABLE IF NOT EXISTS).
  //
  // Deliberately NOT registered anywhere sync touches (PROJECTIONS,
  // DIRECT_CAMP_ENTITIES, full_sync) — same reasoning as source_aliases:
  // exactly one writer (electron/ops/declinedSplits.js), host-only, admin-only.
  if (getSchemaVersion(db) >= 46 && getSchemaVersion(db) < 47) {
    db.transaction(() => {
      db.exec(DECLINED_TWO_ROW_SPLITS_DDL)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (47, ?)').run(
      new Date().toISOString()
    )
  }

  // v48 — tile world placement columns on locations
  // (docs/work/specs/2026-08-25-tile-world-day-map.md §4).
  // Three additive, nullable columns. A location is "tile-placed" when all
  // three are non-null. No backfill — existing rows stay NULL. DDL-only, no
  // op emitted, same posture as v33-v47.
  if (getSchemaVersion(db) >= 47 && getSchemaVersion(db) < 48) {
    db.transaction(() => {
      const cols = db.pragma('table_info(locations)').map((c) => c.name)
      if (!cols.includes('tile_type')) {
        db.exec(`ALTER TABLE locations ADD COLUMN tile_type TEXT CHECK(
          tile_type IS NULL OR tile_type IN ('building','pool','field','cabin','court','nature','generic')
        ) DEFAULT NULL`)
      }
      if (!cols.includes('grid_x')) {
        db.exec('ALTER TABLE locations ADD COLUMN grid_x INTEGER DEFAULT NULL')
      }
      if (!cols.includes('grid_y')) {
        db.exec('ALTER TABLE locations ADD COLUMN grid_y INTEGER DEFAULT NULL')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (48, ?)').run(
      new Date().toISOString()
    )
  }

  // v49 — rename tile_type → kind and expand the allowed-value set with
  // 'classroom' and 'office'. grid_x / grid_y stay for op-log replay.
  // SQLite RENAME COLUMN (3.25+) carries the old CHECK constraint, which only
  // allows 7 values. We recreate the table to widen the constraint to 9 values.
  // Foreign-key references to locations (operations, week_location_exclusions,
  // activities, etc.) use TEXT ids and are unaffected by a table recreation.
  // Gated `>= 48 && < 49`, not a bare `< 49`, to honour the MAX-version
  // continuity chain the v26 block above documents: a bare lower bound would
  // fire while v26 is still deferred (getSchemaVersion === 25), stamp 49, and
  // push MAX past 26 so v26's orphan cleanup never retries.
  if (getSchemaVersion(db) >= 48 && getSchemaVersion(db) < 49) {
    db.transaction(() => {
      const cols = db.pragma('table_info(locations)').map((c) => c.name)
      const hasTileType = cols.includes('tile_type')
      const hasKind = cols.includes('kind')
      const hasGridX = cols.includes('grid_x')
      const hasGridY = cols.includes('grid_y')

      if (hasTileType || hasKind || hasGridX || hasGridY) {
        // Recreate with expanded CHECK and canonical column name 'kind'.
        const srcKind = hasTileType ? 'tile_type' : (hasKind ? 'kind' : 'NULL')
        const srcGridX = hasGridX ? 'grid_x' : 'NULL'
        const srcGridY = hasGridY ? 'grid_y' : 'NULL'
        db.pragma('foreign_keys = OFF')
        db.exec(`
          CREATE TABLE locations_v49 (
            id TEXT PRIMARY KEY,
            camp_id TEXT NOT NULL REFERENCES camps(id),
            name TEXT NOT NULL,
            capacity INTEGER NOT NULL DEFAULT 1,
            notes TEXT,
            sort_order INTEGER,
            map_geometry TEXT,
            kind TEXT CHECK(
              kind IS NULL OR kind IN ('building','classroom','pool','field','cabin','court','nature','office','generic')
            ) DEFAULT NULL,
            grid_x INTEGER DEFAULT NULL,
            grid_y INTEGER DEFAULT NULL,
            UNIQUE(camp_id, name)
          );
          INSERT INTO locations_v49
            SELECT id, camp_id, name, capacity, notes, sort_order, map_geometry,
                   ${srcKind}, ${srcGridX}, ${srcGridY}
            FROM locations;
          DROP TABLE locations;
          ALTER TABLE locations_v49 RENAME TO locations;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_camp_name ON locations(camp_id, name);
        `)
        db.pragma('foreign_keys = ON')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (49, ?)').run(
      new Date().toISOString()
    )
  }

  // v50 — indoor/outdoor map pair per camp + per-location map reference
  // (docs/adr/2026-08-26-indoor-outdoor-map-pair-and-sim-seed.md D1/D2).
  // camp_maps: add `kind` and relax UNIQUE(camp_id) → UNIQUE(camp_id, kind) so a
  // camp can hold up to two maps (indoor floor plan + outdoor grounds). Changing
  // a UNIQUE constraint requires a table recreate (SQLite can't ALTER it) — same
  // recreate-and-copy shape as v49's locations rewrite. Existing single-map rows
  // (id = camp_id) copy across with kind = NULL and are never reclassified.
  // locations: add nullable `map_id` naming which camp_maps row a location's
  // map_geometry is drawn against (NULL = the camp's only map — today's behavior,
  // unchanged for every camp that never adds a second map).
  //
  // Guard is `>= 49 && < 50`, NOT a bare `< 50`: the MAX-version continuity chain
  // (v27–v48) requires each block to fire ONLY from its immediate predecessor. A
  // bare lower bound lets this block fire from any earlier version — e.g. if v26
  // withholds its stamp (getSchemaVersion stays 25), a bare `< 50` would run anyway,
  // stamp 50, and push MAX() past the unstamped v26 so its data-safety cleanup never
  // retries. That is exactly the retireOrphanSlots bug #194's bare `< 49` reintroduced.
  if (getSchemaVersion(db) >= 49 && getSchemaVersion(db) < 50) {
    db.transaction(() => {
      const mapCols = db.pragma('table_info(camp_maps)').map((c) => c.name)
      if (!mapCols.includes('kind')) {
        db.pragma('foreign_keys = OFF')
        db.exec(`
          CREATE TABLE camp_maps_v50 (
            id TEXT PRIMARY KEY,
            camp_id TEXT NOT NULL REFERENCES camps(id),
            image_data TEXT,
            image_mime TEXT,
            image_width INTEGER,
            image_height INTEGER,
            kind TEXT,
            UNIQUE(camp_id, kind)
          );
          INSERT INTO camp_maps_v50 (id, camp_id, image_data, image_mime, image_width, image_height)
            SELECT id, camp_id, image_data, image_mime, image_width, image_height FROM camp_maps;
          DROP TABLE camp_maps;
          ALTER TABLE camp_maps_v50 RENAME TO camp_maps;
        `)
        db.pragma('foreign_keys = ON')
      }
      const locCols = db.pragma('table_info(locations)').map((c) => c.name)
      if (!locCols.includes('map_id')) {
        db.exec('ALTER TABLE locations ADD COLUMN map_id TEXT DEFAULT NULL')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (50, ?)').run(
      new Date().toISOString()
    )
  }

  // v51 — Fixed vs Recurring events: anchor_activities.kind
  // (docs/adr/2026-08-28-fixed-vs-recurring-events.md §3/§5). Fixed =
  // all-camp (is_all_groups=1, unit_id/group_ids empty), Recurring =
  // group- or division-scoped — classification-only, zero engine change
  // (ADR §4). SQLite ADD COLUMN cannot attach a cross-column CHECK to an
  // existing table, so this needs the same recreate-and-copy shape v48/v49/
  // v50 already used, not a bare ALTER TABLE ADD COLUMN.
  //
  // Backfill is NOT a free DEFAULT (the trap this ADR names explicitly,
  // §5/§9): `kind = 'fixed'` only if the row is already all-groups-scoped
  // (is_all_groups=1 AND unit_id IS NULL AND group_ids empty); every other
  // existing row — anything unit_id- or group_ids-scoped — backfills to
  // 'recurring'. A free `DEFAULT 'fixed'` would mis-backfill every scoped
  // row and immediately violate the new CHECK. The rule is a deterministic
  // function of columns every row already has (ADR §5's data-safety
  // verdict: zero rows lost or silently misclassified).
  //
  // No op-log write for the backfill — a DDL-time side effect, same
  // precedent as the v32 locations backfill (see backfillLocations below)
  // and v42/v43's recurrence-axis migrations: this is a local schema fact,
  // not a director-authored change, and must not appear in `operations`/
  // sync as a phantom bulk edit.
  //
  // Guard is `>= 50 && < 51`, NOT a bare `< 51` — see the v50 block's
  // comment above for the load-bearing reason (bug #194).
  if (getSchemaVersion(db) >= 50 && getSchemaVersion(db) < 51) {
    db.transaction(() => {
      const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
      if (!cols.includes('kind')) {
        db.pragma('foreign_keys = OFF')
        db.exec(`
          CREATE TABLE anchor_activities_v51 (
            id TEXT PRIMARY KEY,
            camp_id TEXT NOT NULL REFERENCES camps(id),
            cohort_id TEXT REFERENCES cohorts(id),
            day_id TEXT REFERENCES days_of_operation(id),
            time_block_id TEXT,
            name TEXT,
            unit_id TEXT,
            span_blocks INTEGER,
            is_all_groups INTEGER,
            group_ids TEXT,
            notes TEXT,
            schedule_week_id TEXT REFERENCES schedule_weeks(id),
            recurrence_level TEXT NOT NULL DEFAULT 'daily',
            location_id TEXT,
            kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'recurring')),
            CHECK (
              kind = 'recurring'
              OR (kind = 'fixed' AND is_all_groups = 1 AND unit_id IS NULL
                  AND (group_ids IS NULL OR group_ids = '[]'))
            )
          );
          INSERT INTO anchor_activities_v51
            SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
                   is_all_groups, group_ids, notes, schedule_week_id, recurrence_level, location_id,
                   CASE
                     WHEN is_all_groups = 1 AND unit_id IS NULL AND (group_ids IS NULL OR group_ids = '[]')
                       THEN 'fixed'
                     ELSE 'recurring'
                   END
            FROM anchor_activities;
          DROP TABLE anchor_activities;
          ALTER TABLE anchor_activities_v51 RENAME TO anchor_activities;
        `)
        db.pragma('foreign_keys = ON')
      }
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (51, ?)').run(
      new Date().toISOString()
    )
  }

  // v52 — open_reconciliation_decisions (docs/adr/2026-08-28-persisted-
  // reconciliation-decisions.md). Host-local journal of still-unresolved
  // reconciliation decisions, same posture as source_aliases/import_evidence.
  // No backfill: every camp starts with zero open decisions.
  if (getSchemaVersion(db) >= 51 && getSchemaVersion(db) < 52) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS open_reconciliation_decisions (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          entity_type TEXT NOT NULL,
          cohort_id TEXT,
          entity_id TEXT,
          identity_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          domain_key TEXT NOT NULL,
          child_key TEXT NOT NULL,
          entity_name TEXT,
          reason TEXT,
          import_run_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_open_reconciliation_decisions_lookup
          ON open_reconciliation_decisions (camp_id, entity_type, cohort_id);
      `)
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (52, ?)').run(
      new Date().toISOString()
    )
  }

  // v53 — retire the overlay/stamp subsystem (docs/adr/2026-08-30-retire-overlay-stamp-subsystem.md).
  // Drops template_overlays outright (no live writer — the authoring path was already dead, see the
  // ADR §1) and drops schedule_snapshots.overlays (hard cutover, no back-compat: pre-production, no
  // real camp data, existing snapshot overlays JSON is discarded per the ADR's explicit decision).
  // Guard is `>= 52 && < 53`, NOT a bare `< 53` — see the v50 block's comment for the load-bearing
  // reason (bug #194). day_overrides_json MUST stay the last column on the rebuilt table.
  if (getSchemaVersion(db) >= 52 && getSchemaVersion(db) < 53) {
    db.transaction(() => {
      db.pragma('foreign_keys = OFF')
      db.exec(`DROP TABLE IF EXISTS template_overlays;`)
      db.exec(`
        CREATE TABLE schedule_snapshots_v53 (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES schedule_templates(id),
          name TEXT,
          is_auto INTEGER,
          created_at TEXT NOT NULL,
          slots TEXT,
          day_overrides_json TEXT
        );
        INSERT INTO schedule_snapshots_v53
          SELECT id, template_id, name, is_auto, created_at, slots, day_overrides_json
          FROM schedule_snapshots;
        DROP TABLE schedule_snapshots;
        ALTER TABLE schedule_snapshots_v53 RENAME TO schedule_snapshots;
      `)
      db.pragma('foreign_keys = ON')
    })()

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (53, ?)').run(
      new Date().toISOString()
    )
  }
}

// Deterministic v32 backfill (INV-1). One `locations` row per distinct
// (camp_id, TRIM-only/case-sensitive name); id derived purely from those two
// inputs; activities.location_id set to that id; three kinds of review item
// recorded for the M3 screen. Emits NO op — a DDL-time side effect. Runs inside
// the v32 transaction.
//
// Dedupe is TRIM-only and case-sensitive: `"Pool"` and `"pool"` stay two rows
// (CONSTITUTION Art. V forbids a silent merge by a migration the director never
// saw). Case-variant names are SURFACED as a near_duplicate review, never
// merged. Capacity is seeded to the most permissive DECLARED value —
// MAX(COALESCE(NULLIF(cap, 0), 1)) — so NULL and 0 read as 1 (closing today's
// accidental "unlimited"), never tighter than any activity stated.
export function backfillLocations(db) {
  const rows = db
    .prepare('SELECT id, camp_id, location, max_groups_per_slot FROM activities WHERE location IS NOT NULL')
    .all()

  // key: `${camp_id} ${trimmedName}` -> { camp_id, name, activityIds, caps }
  const places = new Map()
  for (const r of rows) {
    const name = String(r.location).trim()
    if (name === '') continue
    const key = `${r.camp_id} ${name}`
    let place = places.get(key)
    if (!place) {
      place = { camp_id: r.camp_id, name, activityIds: [], caps: [] }
      places.set(key, place)
    }
    place.activityIds.push(r.id)
    place.caps.push(r.max_groups_per_slot)
  }

  if (places.size === 0) return

  // sort_order by name, per camp.
  const byCamp = new Map()
  for (const place of places.values()) {
    if (!byCamp.has(place.camp_id)) byCamp.set(place.camp_id, [])
    byCamp.get(place.camp_id).push(place)
  }
  for (const list of byCamp.values()) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    list.forEach((place, i) => {
      place.sort_order = i
    })
  }

  const insertLoc = db.prepare(
    'INSERT OR IGNORE INTO locations (id, camp_id, name, capacity, notes, sort_order, map_geometry) VALUES (?, ?, ?, ?, NULL, ?, NULL)'
  )
  const setLocId = db.prepare('UPDATE activities SET location_id = ? WHERE id = ?')
  const insertReview = db.prepare(
    'INSERT OR IGNORE INTO location_migration_reviews (id, camp_id, location_id, name, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const now = new Date().toISOString()

  // Normalize one declared cap the same way the seeded capacity does: NULL/0
  // (accidental "unlimited") read as 1. Math.max(1, ...) also floors a negative
  // cap to 1 — capacity must never be < 1 or M2's occupancy check corrupts.
  const declared = (cap) => Math.max(1, cap == null || cap === 0 ? 1 : cap)

  for (const place of places.values()) {
    const id = deriveLocationId(place.camp_id, place.name)
    const declaredCaps = place.caps.map(declared)
    const capacity = Math.max(...declaredCaps)

    insertLoc.run(id, place.camp_id, place.name, capacity, place.sort_order)
    for (const activityId of place.activityIds) setLocId.run(id, activityId)

    // (a) Capacity disagreement — contributing activities declared different
    //     numbers. Keeps the permissive value (above) and asks (Q1).
    const distinctCaps = [...new Set(declaredCaps)]
    if (distinctCaps.length > 1) {
      insertReview.run(
        `review:capacity_disagreement:${id}`,
        place.camp_id, id, place.name, 'capacity_disagreement',
        JSON.stringify({ declaredCaps: distinctCaps.sort((a, b) => a - b), seededCapacity: capacity }),
        now
      )
    }

    // (b) Was-effectively-unlimited, now capped at 1 (Red Hat, Q2). Every
    //     contributing activity had a NULL/0 cap, so there is no disagreement to
    //     raise (a) — this case needs its own flag.
    if (place.caps.every((cap) => cap == null || cap === 0)) {
      insertReview.run(
        `review:was_unlimited:${id}`,
        place.camp_id, id, place.name, 'was_unlimited',
        JSON.stringify({ seededCapacity: capacity }),
        now
      )
    }
  }

  // (c) Near-duplicate names — TRIM-equal but case-different, per camp. A
  //     first-run merge review the director must see before capacity (now a
  //     trusted number) is under-enforced across the split (Red Hat).
  for (const [camp_id, list] of byCamp) {
    const byLower = new Map()
    for (const place of list) {
      const lower = place.name.toLowerCase()
      if (!byLower.has(lower)) byLower.set(lower, [])
      byLower.get(lower).push(place.name)
    }
    for (const variants of byLower.values()) {
      if (variants.length < 2) continue
      for (const name of variants) {
        const id = deriveLocationId(camp_id, name)
        insertReview.run(
          `review:near_duplicate:${id}`,
          camp_id, id, name, 'near_duplicate',
          JSON.stringify({ variants: [...variants].sort() }),
          now
        )
      }
    }
  }
}

// Byte-identical duplicate of the locations block in schema.sql
// (docs/adr/2026-08-15-camp-locations-entity.md D1). Kept as a constant so the
// v32 migration cannot drift from it by a stray space — same discipline as
// SOURCE_ALIASES_DDL / IMPORT_EVIDENCE_DDL above.
export const LOCATIONS_DDL = `CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  sort_order INTEGER,
  map_geometry TEXT,
  UNIQUE(camp_id, name)
)`

// Byte-identical duplicate of the week_location_exclusions block in schema.sql.
// The third instance of the v28 week_*_exclusions pattern.
export const WEEK_LOCATION_EXCLUSIONS_DDL = `CREATE TABLE IF NOT EXISTS week_location_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  location_id TEXT NOT NULL
)`

export const WEEK_LOCATION_EXCLUSIONS_INDEX_DDL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_week_location_exclusions_week_location ON week_location_exclusions(week_id, location_id)'

// Byte-identical duplicate of the camp_maps block in schema.sql (schema v33,
// docs/adr/2026-08-16-locations-optional-map.md D1). Kept as a constant so the
// v33 migration cannot drift from it by a stray space — same discipline as
// LOCATIONS_DDL above.
export const CAMP_MAPS_DDL = `CREATE TABLE IF NOT EXISTS camp_maps (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  image_data TEXT,
  image_mime TEXT,
  image_width INTEGER,
  image_height INTEGER,
  kind TEXT,
  UNIQUE(camp_id, kind)
)`

// Byte-identical duplicates of the special_days / special_day_time_blocks /
// special_day_slots blocks in schema.sql (schema v34, T40 slice 1,
// docs/work/specs/2026-08-20-special-days-data-shape-design.md). Kept as
// constants so the v34 migration cannot drift from schema.sql by a stray
// space — same discipline as LOCATIONS_DDL/CAMP_MAPS_DDL above.
export const SPECIAL_DAYS_DDL = `CREATE TABLE IF NOT EXISTS special_days (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  notes TEXT,
  UNIQUE(camp_id, name)
)`

export const SPECIAL_DAY_TIME_BLOCKS_DDL = `CREATE TABLE IF NOT EXISTS special_day_time_blocks (
  id TEXT PRIMARY KEY,
  special_day_id TEXT NOT NULL REFERENCES special_days(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT
)`

export const SPECIAL_DAY_SLOTS_DDL = `CREATE TABLE IF NOT EXISTS special_day_slots (
  id TEXT PRIMARY KEY,
  special_day_id TEXT NOT NULL REFERENCES special_days(id),
  group_id TEXT NOT NULL,
  time_block_id TEXT NOT NULL,
  activity_id TEXT,
  location_id TEXT
)`

// Byte-identical duplicates of the elective_sets / elective_set_activities
// blocks in schema.sql (schema v35, T41 slice 1,
// docs/work/specs/2026-08-20-group-electives-design.md). Kept as constants so
// the v35 migration cannot drift from schema.sql by a stray space — same
// discipline as SPECIAL_DAYS_DDL above.
export const ELECTIVE_SETS_DDL = `CREATE TABLE IF NOT EXISTS elective_sets (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  is_reusable INTEGER NOT NULL DEFAULT 1,
  day_id TEXT REFERENCES days_of_operation(id),
  time_block_id TEXT,
  is_all_groups INTEGER,
  group_ids TEXT,
  schedule_week_id TEXT REFERENCES schedule_weeks(id),
  recurrence_level TEXT NOT NULL DEFAULT 'daily',
  UNIQUE(camp_id, name)
)`

export const ELECTIVE_SET_ACTIVITIES_DDL = `CREATE TABLE IF NOT EXISTS elective_set_activities (
  id TEXT PRIMARY KEY,
  elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
  activity_id TEXT NOT NULL,
  camper_headcount INTEGER,
  UNIQUE(elective_set_id, activity_id)
)`

// Byte-identical duplicate of the events block in schema.sql (schema v40,
// Events overlay placement Slice 1, docs/adr/2026-08-22-events-overlay-
// placement.md; location_id added v45, docs/work/specs/2026-08-23-slice4-
// engine-location-contention.md §6). Kept as a constant so the v40 migration
// cannot drift from schema.sql by a stray space — same discipline as
// ELECTIVE_SETS_DDL above, kept in sync with later ALTER-added columns.
export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  notes TEXT,
  location_id TEXT,
  UNIQUE(camp_id, name)
)`

// Byte-identical duplicates of the event_time_blocks / event_groups /
// event_slots blocks in schema.sql (schema v41, Events internal sub-
// schedule Slice 2, docs/adr/2026-08-22-event-internal-subschedule.md).
// Kept as constants so the v41 migration cannot drift from schema.sql by a
// stray space — same discipline as SPECIAL_DAYS_DDL/EVENTS_DDL above.
export const EVENT_TIME_BLOCKS_DDL = `CREATE TABLE IF NOT EXISTS event_time_blocks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT
)`

export const EVENT_GROUPS_DDL = `CREATE TABLE IF NOT EXISTS event_groups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL
)`

export const EVENT_SLOTS_DDL = `CREATE TABLE IF NOT EXISTS event_slots (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  event_group_id TEXT NOT NULL,
  time_block_id TEXT NOT NULL,
  activity_id TEXT,
  location_id TEXT
)`

// Byte-identical duplicate of the day_overrides block in schema.sql (schema
// v38, T108, ADR 2026-08-21-day-overrides-repoint-shape.md D1). Kept as a
// constant so the v38 migration cannot drift from schema.sql by a stray
// space — same discipline as SPECIAL_DAYS_DDL/ELECTIVE_SETS_DDL above.
export const DAY_OVERRIDES_DDL = `CREATE TABLE IF NOT EXISTS day_overrides (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  schedule_week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  day_id TEXT NOT NULL REFERENCES days_of_operation(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  time_block_id TEXT NOT NULL,
  activity_id TEXT REFERENCES activities(id),
  kind TEXT NOT NULL DEFAULT 'swap',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_week_id, day_id, group_id, time_block_id)
)`

// Director-facing, and it appears in Versions beside weeks they saved
// themselves — months later, with no memory of saving it. It has to explain
// itself without naming a table, a migration, or an "orphan" (CONSTITUTION
// Article V).
export const V26_RECOVERED_WEEK_NAME = 'Recovered week — found during an update'

// The `flags` coercion normalizeSlots performs on read, re-implemented for the
// v26 migration. See the note at its call site for why it is not imported.
// stripStaleFlags is deliberately NOT replicated — and that omission covers
// BOTH of the things it does: the stale-flag families, and its filter on
// __proto__/constructor/prototype keys (its defence against a peer planting
// them over LAN sync). Stripping here would be strictly less preserving, and
// normalizeSlots strips on every read anyway, so nothing copied verbatim into
// this payload can reach a consumer unsanitized.
function parseSlotFlags(flags) {
  if (flags && typeof flags === 'object') return flags
  if (typeof flags !== 'string' || flags === '') return {}
  try {
    return JSON.parse(flags)
  } catch {
    return {}
  }
}

// Byte-identical duplicate of the pending_restores block in schema.sql. Kept
// as a constant so the v25 migration cannot drift from it by a stray space.
export const PENDING_RESTORES_DDL = `CREATE TABLE IF NOT EXISTS pending_restores (
  pending_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (entity, entity_id)
)`

// Byte-identical duplicate of the source_aliases block in schema.sql
// (docs/adr/2026-08-09-s1b-host-local-aliases.md §1/§7). Kept as a constant
// so the v30 migration cannot drift from it by a stray space — the same
// discipline as PENDING_RESTORES_DDL above.
export const SOURCE_ALIASES_DDL = `CREATE TABLE IF NOT EXISTS source_aliases (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  entity_type TEXT NOT NULL,     -- one of the 6 ingestible types, validated at the write boundary
  cohort_id TEXT,                -- populated ONLY for cohort-scoped types (tiers, time_blocks); NULL otherwise
  source_label TEXT NOT NULL,    -- the raw label as it appeared in the imported file
  entity_id TEXT NOT NULL,       -- plain TEXT, not a FK (entity_type varies; no single-table target)
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  confirmed_by TEXT,             -- plain TEXT user id, provenance only
  confirmed_at TEXT NOT NULL,
  superseded_by TEXT             -- id of the alias row that replaced this one, when status='superseded'
)`

export const SOURCE_ALIASES_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_source_aliases_lookup ON source_aliases (camp_id, entity_type, cohort_id)'

// Byte-identical duplicate of the declined_two_row_splits block in
// schema.sql (docs/adr/2026-08-23-two-rows-multipattern-split.md). Kept as a
// constant so the v47 migration cannot drift from it by a stray space — the
// same discipline as SOURCE_ALIASES_DDL above.
export const DECLINED_TWO_ROW_SPLITS_DDL = `CREATE TABLE IF NOT EXISTS declined_two_row_splits (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  activity_name_normalized TEXT NOT NULL,  -- normalizeName(name) — the read side must match
  declined_at TEXT NOT NULL,
  UNIQUE(camp_id, activity_name_normalized)
)`

// Byte-identical duplicate of the import_evidence block in schema.sql
// (docs/adr/2026-08-10-ingestion-evidence-persistence.md). Kept as a constant
// so the v31 migration cannot drift from it by a stray space — the same
// discipline as SOURCE_ALIASES_DDL above.
export const IMPORT_EVIDENCE_DDL = `CREATE TABLE IF NOT EXISTS import_evidence (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  entity_type TEXT NOT NULL,     -- 'activities' | 'anchor_activities' — the two types
                                  -- that carry inferred/observed fields today
  entity_id TEXT NOT NULL,       -- plain TEXT, not a FK (same reasoning as source_aliases.entity_id)
  field TEXT NOT NULL,           -- the plan field this evidence supports, e.g.
                                  -- 'eligible_group_names' | 'min_per_week' | 'days' | 'scope'
  tag TEXT NOT NULL,             -- 'observed' | 'inferred' (parent ADR D1/OQ1)
  confidence TEXT NOT NULL,      -- 'high' | 'low' — reuses CONFIDENCE.* (src/ingest/confidence.js)
  support TEXT NOT NULL,         -- compact JSON: see the ADR's "What to persist"
  import_run_id TEXT NOT NULL,   -- groups every row one commitIngest call wrote
  committed_at TEXT NOT NULL
)`

export const IMPORT_EVIDENCE_INDEX_DDL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_import_evidence_latest ON import_evidence (camp_id, entity_type, entity_id, field)'

// A peer still on <=v22 rejects the manual candidate's schedule_templates row
// (its UNIQUE(camp_id) absorbs the INSERT OR IGNORE) and then FK-violates on
// every child op. applyRemoteOp swallows projection failures by design and
// sendFullSyncIfFirstPairing never re-syncs a device that has synced once, so
// nothing else would ever repair that device. The op-log rows themselves are
// durable — they are inserted BEFORE projection is attempted — so the missing
// tables can be rebuilt from the log at upgrade time.
//
// Deliberately BOUNDED to templates that are currently ABSENT, and to the
// children of only those templates. An unbounded "replay everything" would
// delete-then-reinsert correctly-projected rows, turning a repair into a
// destructive operation.
function repairMissingScheduleTemplates(db) {
  const templateOps = db
    .prepare(
      `SELECT * FROM operations WHERE entity = 'schedule_templates' ORDER BY seq ASC`
    )
    .all()
  if (templateOps.length === 0) return

  const present = new Set(db.prepare('SELECT id FROM schedule_templates').all().map((r) => r.id))
  const missing = [...new Set(templateOps.map((o) => o.entity_id))].filter((id) => !present.has(id))
  if (missing.length === 0) return

  const missingSet = new Set(missing)
  for (const op of templateOps) {
    if (!missingSet.has(op.entity_id)) continue
    try { applyProjection(db, op) } catch { /* one unreplayable op must not abort the rest */ }
  }

  const recovered = new Set(
    db.prepare('SELECT id FROM schedule_templates').all().map((r) => r.id)
  )
  const targets = missing.filter((id) => recovered.has(id))
  if (targets.length === 0) return

  const targetSet = new Set(targets)
  const childOps = db
    .prepare(
      `SELECT * FROM operations
        WHERE entity IN ('template_slots', 'template_overlays', 'schedule_snapshots')
        ORDER BY seq ASC`
    )
    .all()

  // `owned` grows as the pass discovers which child rows belong to a recovered
  // template. A child op is replayed only once its row is known to be one of
  // theirs — every other row in these tables projected correctly and must not
  // be touched.
  const owned = new Set()
  for (const op of childOps) {
    try {
      if (isBulkReplaceOp(op)) {
        if (!targetSet.has(op.entity_id)) continue
        applyBulkReplaceProjection(db, op)
        const table = op.entity
        for (const r of db.prepare(`SELECT id FROM ${table} WHERE template_id = ?`).all(op.entity_id)) {
          owned.add(r.id)
        }
      } else if (op.field === 'template_id' && targetSet.has(op.value)) {
        applyProjection(db, op)
        owned.add(op.entity_id)
      } else if (owned.has(op.entity_id)) {
        applyProjection(db, op)
      }
    } catch { /* best-effort repair — see above */ }
  }
}

export function openLocalDb(filePath) {
  let db
  try {
    db = new Database(filePath)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')

    // Schema-too-new guard: if this file was written by a newer build of the
    // app, refuse to migrate it — running older migrations on a newer schema
    // risks data corruption. The caller receives a thrown Error whose `code`
    // property is 'schema_too_new' so IPC handlers can return a friendly
    // message instead of a generic crash.
    const existingVersion = getSchemaVersion(db)
    if (existingVersion > CURRENT_SCHEMA_VERSION) {
      db.close()
      const err = new Error(
        `This project file was created by a newer version of Shoresh ` +
        `(schema v${existingVersion}, app supports up to v${CURRENT_SCHEMA_VERSION}). ` +
        `Please update the app to open it.`
      )
      err.code = 'schema_too_new'
      throw err
    }

    // Pre-migration backup: if the DB already has data and needs migrating,
    // write a .bak copy BEFORE any migration runs so the original is
    // recoverable if a migration fails mid-way. Best-effort — backup failure
    // must not block opening the DB (the per-migration transactions are the
    // primary safety net; this is a human-accessible extra).
    if (existingVersion > 0 && existingVersion < CURRENT_SCHEMA_VERSION) {
      try {
        writePreMigrationBackup(filePath)
      } catch {
        /* non-fatal — proceed with migration */
      }
    }

    initSchema(db)
  } catch (err) {
    // Close the handle if it was opened before the failure so we don't leak a
    // file descriptor. Safe to call on an already-closed db (schema_too_new
    // path closes it above, then re-throws here).
    try { if (db) db.close() } catch { /* ignore — already closed or never opened */ }
    // Re-throw schema_too_new as-is; wrap everything else.
    if (err.code === 'schema_too_new') throw err
    throw new Error(`Failed to open local database at ${filePath}: ${err.message}`)
  }
  return db
}

export function getSchemaVersion(db) {
  // schema_migrations may not exist yet (fresh DB before initSchema runs).
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
    return row && row.version != null ? row.version : 0
  } catch {
    return 0
  }
}

export function getOrCreateDeviceId(db) {
  const existing = db.prepare('SELECT id FROM device_identity LIMIT 1').get()
  if (existing) return existing.id
  const id = randomUUID()
  db.prepare('INSERT INTO device_identity (id, created_at) VALUES (?, ?)').run(
    id,
    new Date().toISOString()
  )
  return id
}
