import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
}

export function openLocalDb(filePath) {
  let db
  try {
    db = new Database(filePath)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    initSchema(db)
  } catch (err) {
    throw new Error(`Failed to open local database at ${filePath}: ${err.message}`)
  }
  return db
}

export function getSchemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) as version FROM schema_migrations').get()
  return row && row.version != null ? row.version : 0
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
