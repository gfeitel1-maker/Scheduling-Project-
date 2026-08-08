import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { writePreMigrationBackup } from './projectManager.js'
import { deriveScheduleTemplateId } from '../ops/scheduleTemplateId.js'
import { applyProjection } from '../ops/projections.js'
import { isBulkReplaceOp, applyBulkReplaceProjection } from '../ops/operations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The highest schema_migrations.version this build of the app knows about.
// If an opened DB file has a higher version, the app refuses to migrate it
// (it was written by a newer build) and returns { code: 'schema_too_new' }.
export const CURRENT_SCHEMA_VERSION = 29

export function initSchema(db) {
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

  // Sub-plan D Task 0: anchor_activities/day_override_templates/
  // day_override_template_slots were created with a minimal/inference-only
  // column set in Sub-plan A. This adds the real columns confirmed by
  // directly re-reading AnchorsScreen.jsx/DayOverridesScreen.jsx's actual
  // insert/update payloads — see schema.sql's comments on each table for
  // the full confirmation note.
  if (getSchemaVersion(db) < 16) {
    db.transaction(() => {
      const addColumnIfMissing = (table, name, type) => {
        const has = db.pragma(`table_info(${table})`).some((col) => col.name === name)
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }

      addColumnIfMissing('anchor_activities', 'time_block_id', 'TEXT')
      addColumnIfMissing('anchor_activities', 'name', 'TEXT')
      addColumnIfMissing('anchor_activities', 'notes', 'TEXT')
      addColumnIfMissing('day_override_templates', 'cohort_id', 'TEXT')
      addColumnIfMissing('day_override_templates', 'frequency_mode', 'TEXT')
      addColumnIfMissing('day_override_template_slots', 'time_block_id', 'TEXT')
      addColumnIfMissing('day_override_template_slots', 'activity_id', 'TEXT')
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
          db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(keepRow.id, dupeId)
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
        db.prepare('UPDATE template_overlays SET template_id = ? WHERE template_id = ?').run(newId, oldId)
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
        const overlays = db.prepare('SELECT * FROM template_overlays WHERE template_id = ? ORDER BY id').all(orphanId)
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
            db.prepare(
              `INSERT OR REPLACE INTO schedule_snapshots
                 (id, template_id, name, is_auto, created_at, slots, overlays)
               VALUES (?, ?, ?, 0, ?, ?, ?)`
            ).run(
              snapshotId, t.id, snapName, now,
              JSON.stringify(snapSlots), JSON.stringify(snapOverlays)
            )

            for (const [table, rows] of [['template_slots', slots], ['template_overlays', overlays]]) {
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
}

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
