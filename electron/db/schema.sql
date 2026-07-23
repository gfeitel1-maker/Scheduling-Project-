CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  signing_secret TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  camp_id TEXT REFERENCES camps(id),
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_camp_name ON users(camp_id, name);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen_at TEXT,
  last_synced_at TEXT,
  -- Op-log watermark for reconnect catch-up (Task 10 round-4 Fix 3). NULL
  -- means "never watermarked yet" — the first authenticate for a device
  -- only establishes the baseline (current max operations.seq) without
  -- sending anything, so a device's very first connection doesn't get
  -- flooded with the entire pre-existing op history. Every authenticate
  -- after that sends operations rows with seq > last_synced_seq.
  last_synced_seq INTEGER
);

CREATE TABLE IF NOT EXISTS operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  author_user_id TEXT REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  timestamp TEXT NOT NULL,
  parent_op_id TEXT REFERENCES operations(id),
  -- Client-generated idempotency key (Task 10 round-5 Fix 3). Set once by
  -- the client when a write is first attempted and carried unchanged on any
  -- retry (e.g. a flushQueue retry after a 'timeout'/'disconnected' result
  -- whose submit_op may actually have been applied server-side already).
  -- handleSubmitOp checks this before appendOp so a retried submission of
  -- the same logical write returns the original op instead of minting a
  -- second, distinct op id. NULL for ops that predate this fix or don't
  -- carry a key; the partial unique index below only constrains non-NULL
  -- values so multiple NULLs are allowed.
  client_write_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity, entity_id, field);
-- Note: the unique index on operations.client_write_id is NOT created here.
-- This whole schema.sql is exec'd unconditionally on every open, including
-- against a pre-migration db whose existing `operations` table predates the
-- client_write_id column (that column is added by the guarded, version-gated
-- ALTER in localDb.js's initSchema). Creating the index here would fail with
-- "no such column" on such a db, before the migration block ever runs. The
-- index is created in initSchema's version-8 migration block instead, right
-- after the column is confirmed to exist.

-- Durable record of every conflict ever detected (either locally, via
-- detectConflict in handleSubmitOp on the host, or received over the wire as
-- an op_conflict message on a client). This is what makes conflicts survive
-- an app restart: the in-memory usePendingConflicts state is fed live events
-- only, so without this table a pending conflict would silently vanish on
-- relaunch. existing_op_id is the id of the op the LOSING write collided
-- with — a resolution write always sets its parent_op_id to this value, so
-- "is this conflict resolved" is answered by checking whether any op with
-- parent_op_id = existing_op_id now exists (see listPendingConflicts).
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  incoming_op TEXT NOT NULL,
  existing_op TEXT NOT NULL,
  existing_op_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_pending ON conflicts(entity, entity_id, field, resolved_at);

CREATE TABLE IF NOT EXISTS locks (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  holder_device_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, field)
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  tier_id TEXT,
  availability TEXT,
  UNIQUE(camp_id, name)
);
-- Round 2 Red Hat fix (Sub-plan C Task 1): the UNIQUE above only applies to
-- brand-new installs, since this whole file runs as CREATE TABLE IF NOT
-- EXISTS. Any db that already ran an earlier schema version keeps its
-- pre-existing groups table verbatim; the actual enforcement for those dbs
-- comes from the idx_groups_camp_name index added in localDb.js's
-- version-12 migration — same pattern as idx_cohorts_camp_name (version 11).

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  cohort_id TEXT REFERENCES cohorts(id),
  UNIQUE(camp_id, cohort_id, name)
);
-- Round 2 Red Hat fix (mirrors the time_blocks version-13 fix): the UNIQUE
-- above only applies to brand-new installs, since this whole file runs as
-- CREATE TABLE IF NOT EXISTS. Any db that already ran an earlier schema
-- version keeps its pre-existing tiers table (without cohort_id/sort_order,
-- added later via ALTER TABLE in localDb.js's version-10 migration)
-- verbatim; the actual enforcement for those dbs comes from the
-- idx_tiers_camp_cohort_name index added in localDb.js's version-14
-- migration — same pattern as idx_time_blocks_camp_cohort_name (version 13).

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_slots (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  group_id TEXT REFERENCES groups(id),
  activity_id TEXT REFERENCES activities(id),
  day_id TEXT,
  time_block_id TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_identity (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Durable backing store for syncClient's write queue (Task 10 round-5 Fix
-- 1). Previously the queue lived only in an in-memory array, so a queued
-- write's resolution choice was lost with zero trace if the app closed or
-- crashed before flushQueue synced it — while the UI had already shown a
-- confident "Saved — will sync when connected". Every write queued while
-- offline is persisted here BEFORE it's acknowledged to the caller as
-- 'queued', reloaded into the in-memory queue on syncClient startup, and
-- only deleted once flushQueue genuinely confirms it applied (or it's
-- superseded/moot).
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

-- Renderer Supabase->local-first migration, Sub-plan A (schema version 10).
-- New tables required by cohorts/time-blocks/anchors/schedule-template
-- screens that previously had no local-schema equivalent. See
-- docs/superpowers/specs/2026-07-21-renderer-supabase-migration-design.md
-- for the full column rationale.
CREATE TABLE IF NOT EXISTS cohorts (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  session_week_start TEXT,
  session_week_end TEXT,
  capacity_source TEXT,
  anchor_model TEXT,
  sort_order INTEGER,
  UNIQUE(camp_id, name)
);
-- Round 2 Red Hat fix (Sub-plan B Task 2): the UNIQUE above only applies to
-- brand-new installs, since this whole file runs as CREATE TABLE IF NOT
-- EXISTS. Any db that already ran schema version 10 keeps its pre-existing
-- cohorts table verbatim; the actual enforcement for those dbs comes from
-- the idx_cohorts_camp_name index added in localDb.js's version-11 migration.

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
  sort_order INTEGER,
  UNIQUE(camp_id, cohort_id, name)
);
-- Round 2 Red Hat fix (Sub-plan D Task 1): scoped by cohort_id, not just
-- camp_id, because block names are cohort-local (mirrors groups/cohorts/
-- days_of_operation's camp-level UNIQUE, but time_blocks additionally
-- partitions by cohort). The UNIQUE above only applies to brand-new
-- installs, since this whole file runs as CREATE TABLE IF NOT EXISTS. Any
-- db that already ran an earlier schema version keeps its pre-existing
-- time_blocks table verbatim; the actual enforcement for those dbs comes
-- from the idx_time_blocks_camp_cohort_name index added in localDb.js's
-- version-13 migration — same pattern as idx_groups_camp_name (version 12).
-- template_slots.time_block_id is a plain TEXT column (no REFERENCES), so
-- there is no FK to repoint when deduping, unlike groups.id/template_slots.group_id.

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

-- slots/overlays are JSON TEXT columns: a snapshot is an immutable
-- point-in-time blob by design, not something field-level-synced (see design
-- doc) — do not generalize this pattern to any actively-edited table.
CREATE TABLE IF NOT EXISTS schedule_snapshots (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES schedule_templates(id),
  name TEXT,
  is_auto INTEGER,
  created_at TEXT NOT NULL,
  slots TEXT,
  overlays TEXT
);

-- Minimal viable columns only; exact shape is deferred to Sub-plan D, which
-- will ALTER these as needed once DayOverridesScreen.jsx's exact
-- insert/update payloads are re-read directly.
CREATE TABLE IF NOT EXISTS day_override_templates (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS day_override_template_slots (
  id TEXT PRIMARY KEY,
  day_override_template_id TEXT NOT NULL REFERENCES day_override_templates(id)
);
