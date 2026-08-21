-- BASE SCHEMA ONLY — NOT the current schema shape.
--
-- This file is executed unconditionally on every database open (initSchema in
-- localDb.js). Because every statement is guarded with CREATE TABLE IF NOT
-- EXISTS / CREATE INDEX IF NOT EXISTS, re-execution on an already-migrated
-- database is safe and idempotent — it adds nothing, because the table already
-- exists and SQLite skips the statement entirely.
--
-- AUTHORITY: localDb.js migrations are the authoritative source for the
-- current schema shape. The columns visible in a running database are those
-- declared here PLUS every ALTER TABLE ADD COLUMN executed by the migration
-- blocks in localDb.js. A table's CREATE TABLE statement here reflects only
-- the columns that existed when the table was first introduced; every column
-- added later appears only in the migration that added it.
--
-- To inspect a running database's actual column list:
--   PRAGMA table_info(table_name);
-- Run this against a migrated db (after initSchema completes), not a fresh
-- one, to see all columns including migration-added ones.
--
-- INDEX PLACEMENT RULE (empirically derived from this file and localDb.js):
--   schema.sql  — indexes on columns that are NOT NULL or otherwise present
--                 in the original CREATE TABLE (i.e. they cannot be missing
--                 on any database that ran this file). Re-execution is safe
--                 because IF NOT EXISTS guards them.
--   localDb.js  — indexes on columns added by ALTER TABLE in a migration, or
--                 UNIQUE indexes on tables that needed deduplication logic
--                 before the index could be safely created. These cannot live
--                 here because re-executing schema.sql against a pre-migration
--                 db would hit "no such column" before the ALTER TABLE ran.
--                 Examples: idx_operations_client_write_id (v8, column added
--                 v8), idx_schedule_templates_week_kind (v27, column added
--                 v23), idx_week_activity_exclusions_week_activity (v28).

CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  signing_secret TEXT,
  -- Ed25519 public key (hex), superseding signing_secret (HMAC) per
  -- docs/adr/2026-07-25-device-trust-revocation.md. signing_secret is kept
  -- (not dropped) for now — see that ADR's own note on why a token-format
  -- migration is out of scope for this slice. Distributed to every device
  -- via the same full-sync path signing_secret used.
  signing_public_key TEXT
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
  last_synced_seq INTEGER,
  -- Device trust/pairing/revocation, per
  -- docs/adr/2026-07-25-device-trust-revocation.md. A device row existing no
  -- longer implies it may log in — authorize() and handleAuthenticate both
  -- require authorized_at NOT NULL AND revoked_at IS NULL, re-checked fresh
  -- on every call (never cached). pairing_status defaults to 'pending' for a
  -- freshly self-registered row (see syncServer.js's handleAuthenticate).
  authorized_at TEXT,
  authorized_by_user_id TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  revocation_reason TEXT,
  -- Random secret minted by the Host at pairing approval time (sub-task 2),
  -- handed to the device once. Plaintext at rest, same precedent as
  -- camps.signing_secret (see that column's comment) — the Host must hold
  -- the raw value to compute/verify an HMAC with it. Doubles as the
  -- HMAC key for this device's own 'local' token type (see localAuth.js).
  device_secret_identifier TEXT,
  pairing_status TEXT NOT NULL DEFAULT 'pending'
  -- 'pending' | 'authorized' | 'denied' | 'revoked'
);

-- Host-only singleton. NEVER included in any full-sync SELECT/payload (see
-- syncServer.js's sendFullSyncIfFirstPairing — only users/camps are sent)
-- and never sent over the wire in any other message. Generated once, at
-- bootstrapCamp(), only on the device that becomes Host — see
-- localAuth.js's ensureHostSigningKey. private_key never leaves this device.
CREATE TABLE IF NOT EXISTS host_signing_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,  -- hex-encoded SPKI DER, mirrors camps.signing_public_key
  private_key TEXT NOT NULL, -- hex-encoded PKCS8 DER, Host-local only
  created_at TEXT NOT NULL
);

-- Host-only table, like host_signing_key. NEVER included in any full-sync
-- SELECT/payload, NEVER sent over the wire, NEVER added to DIRECT_CAMP_ENTITIES
-- or PROJECTIONS. Import (and therefore alias confirmation) only ever runs on
-- the host device, admin-gated — see electron/ops/ingest.js, main.js.
-- docs/adr/2026-08-09-s1b-host-local-aliases.md.
CREATE TABLE IF NOT EXISTS source_aliases (
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
);

CREATE INDEX IF NOT EXISTS idx_source_aliases_lookup
  ON source_aliases (camp_id, entity_type, cohort_id);

-- Host-only table, like source_aliases and host_signing_key. NEVER included
-- in any full-sync SELECT/payload, NEVER sent over the wire, NEVER added to
-- DIRECT_CAMP_ENTITIES or PROJECTIONS. Written only from inside commitPlan's
-- commit transaction (electron/ops/ingest.js), admin-gated by the same import
-- IPC boundary as everything else in that transaction.
-- docs/adr/2026-08-10-ingestion-evidence-persistence.md.
CREATE TABLE IF NOT EXISTS import_evidence (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_evidence_latest
  ON import_evidence (camp_id, entity_type, entity_id, field);

-- DRIFTED TABLE: a migrated database has one additional column not listed below.
-- Migration-added columns (see localDb.js):
--   v8:  client_write_id TEXT  (already present in this CREATE TABLE — added here
--          after v8 ran on all known devices)
--   v18: host_seq INTEGER
--   v29: source TEXT  (per-field provenance: 'import' | 'human' | NULL=human;
--          docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md)
-- source is DELIBERATELY NOT in the CREATE TABLE below, unlike client_write_id.
-- It is added by the v29 ALTER (localDb.js) only. Reason (fresh-vs-migrated
-- column-order equivalence, ADR completion evidence #1): host_seq is a
-- migration-only column (v18) that is appended to a FRESH install's operations
-- table AFTER client_write_id. If source were declared in this CREATE TABLE it
-- would sit BEFORE host_seq on a fresh install (...client_write_id, source,
-- host_seq) but AFTER it on a 28->29 migrated db (...client_write_id, host_seq,
-- source), so PRAGMA table_info would differ. Adding source via the v29 ALTER
-- on both paths appends it last on both, keeping the two byte-identical.
-- Use PRAGMA table_info(operations) against a migrated db to see all columns.
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
  name TEXT NOT NULL,
  priority INTEGER,
  is_locked INTEGER,
  span_blocks INTEGER,
  -- FROZEN from schema v32 (docs/adr/2026-08-15-camp-locations-entity.md D5):
  -- `location` is the pre-entity free-text place string. It is RETAINED (kept
  -- in PROJECTIONS.activities.fields so historical op-log replay stays exact,
  -- and as the v32 rollback anchor) but stops being written once the UI moves
  -- to the location_id picker (slice M3). No code path should WRITE this column
  -- after that migration; place identity now lives in `locations`, referenced
  -- by location_id below. The engine still READS it until slice M2.
  location TEXT,
  is_outdoor INTEGER,
  max_groups_per_slot INTEGER,
  min_per_week INTEGER,
  max_per_week INTEGER,
  same_tier_only INTEGER,
  eligible_tier_ids TEXT,
  eligible_group_ids TEXT,
  prefer_before_day INTEGER,
  prefer_before_day_min INTEGER,
  weather_alternative_id TEXT,
  notes TEXT,
  -- v32: nullable FK-by-convention to locations(id), NO DB-level FOREIGN KEY
  -- (matches weather_alternative_id). MUST be the LAST column: it is ALTER-added
  -- on a migrated db (localDb.js v32), which always appends, so declaring it
  -- last here keeps a fresh install's column order byte-identical to a migrated
  -- one (docs/adr/2026-08-15-camp-locations-entity.md, "column-order trap").
  location_id TEXT,
  UNIQUE(camp_id, name)
);
-- Round 2 Red Hat fix (ActivitiesScreen migration): the UNIQUE above only
-- applies to brand-new installs, since this whole file runs as CREATE TABLE
-- IF NOT EXISTS. Any db that already ran an earlier schema version keeps its
-- pre-existing activities table (without these columns, added later via
-- ALTER TABLE in localDb.js's version-15 migration) verbatim; the actual
-- enforcement for those dbs comes from the idx_activities_camp_name index
-- added in localDb.js's version-15 migration — same pattern as
-- idx_groups_camp_name (version 12). activities is camp-scoped only (no
-- cohort_id), matching groups, not tiers/time_blocks.

-- DRIFTED TABLE: a migrated database has 11 columns, not the 6 below.
-- Migration-added columns (see localDb.js):
--   v10: flags TEXT, is_released INTEGER, is_span_head INTEGER
--   v17: anchor_id TEXT, is_anchor INTEGER
--   v35: elective_set_id TEXT (T41 slice 1, group-level electives,
--     docs/work/specs/2026-08-20-group-electives-design.md) — a slot with
--     elective_set_id set is an elective cell (activity_id ignored); the two
--     are mutually exclusive, enforced by the (UI-driven) write path in a
--     later slice.
-- Use PRAGMA table_info(template_slots) against a migrated db to see all 11.
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

-- DRIFTED TABLE: a migrated database has one additional column not listed below.
-- Migration-added columns (see localDb.js):
--   v22: first_sync_completed_at TEXT
-- Use PRAGMA table_info(device_identity) against a migrated db to see all columns.
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

-- Durable queue of restore REQUESTS a Client could not deliver because the
-- Host was unreachable (schema version 25,
-- docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md). A restore
-- executes on the Host — a Client does not hold the op history for records
-- created before it paired — so a Client with no Host records the intent here
-- and sends it when the Host returns. In-memory would not do: a queue that
-- does not survive an app restart is not a queue, and a restart is exactly
-- when a director expects a pending action to persist.
--
-- LOCAL ONLY. This holds intent, not data, and it must never replicate:
-- it is written by direct INSERT (never through appendOp, so no operations
-- row exists for it), it is absent from PROJECTIONS (so even a forged op
-- naming it is a no-op on every device), and it is absent from
-- DIRECT_CAMP_ENTITIES/PARENT_SCOPED_ENTITIES (so it can be neither
-- full-synced nor read through the renderer's generic list() path).
--
-- UNIQUE(entity, entity_id) so three offline presses of Restore produce one
-- intent rather than three. last_error holds a terminal drain failure so it
-- is visible to the director rather than disappearing (ADR: a queued restore
-- whose target is no longer restorable must fail visibly).
--
-- The DDL below is duplicated verbatim in localDb.js's v25 block; the two
-- copies are asserted byte-identical by pendingRestores.migration.test.js.
CREATE TABLE IF NOT EXISTS pending_restores (
  pending_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (entity, entity_id)
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

-- Sub-plan D Task 0 (2026-07-23): confirmed exact field set by re-reading
-- AnchorsScreen.jsx's actual insert/update payloads directly (not the design
-- doc's inference-only sketch, which listed unit_id/span_blocks — neither is
-- actually read or written by the screen). Real fields used: name, day_id,
-- time_block_id, is_all_groups, group_ids, notes. unit_id/span_blocks are
-- kept as unused legacy columns (harmless, avoids a destructive column
-- drop) rather than removed; name/time_block_id/notes are added by the
-- version-16 migration in localDb.js for existing dbs that already ran this
-- file at an earlier version.
CREATE TABLE IF NOT EXISTS anchor_activities (
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
  notes TEXT
);

-- A week is director-named text (e.g. "Week 1"), not a `template`/`slot`/
-- `kind` concept — CONSTITUTION Art. V. Direct-camp-scoped, same sync
-- treatment as groups/tiers (see DIRECT_CAMP_ENTITIES).
-- docs/adr/2026-08-02-schedule-weeks-first-class.md
CREATE TABLE IF NOT EXISTS schedule_weeks (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  is_archived INTEGER NOT NULL DEFAULT 0
);
-- idx_schedule_weeks_camp_name is created by migration v27, not here.

-- `kind` names which of the two schedule-building routes a row belongs to
-- ('generated' | 'manual'). It is load-bearing: the unique index below is what
-- keeps a WEEK to exactly one candidate per route, and NOT NULL is required —
-- distinct NULLs do not conflict in SQLite, so a nullable kind would let the
-- duplicate-row fork that migration v21 exists to prevent back in.
--
-- Column ORDER matters: migration v23 adds `kind` via ALTER TABLE, which always
-- appends, so it must be last here for a fresh db to match a migrated one.
-- week_id (added by v27) appends after it for the same reason.
--
-- A camp now holds one-or-more weeks; each week holds its own manual+generated
-- pair (UNIQUE(week_id, kind) below, created by migration v27, replacing the
-- old camp-scoped UNIQUE(camp_id, kind)). week_id is deliberately NOT declared
-- NOT NULL here even though every row a fresh install ever WRITES will have
-- one: applyProjection's ensureExists only ever knows one field's value per
-- call (see the write-ordering contract comment in electron/ops/projections.js),
-- so the row-creating INSERT cannot guarantee week_id is populated at insert
-- time any more than it could guarantee `kind` was before the write-ordering
-- contract existed. The invariant is enforced by the write path
-- (ensureTemplateRow always supplies week_id) and the unique index below, not
-- by a SQL-level NOT NULL — same "never a retroactive NOT NULL" principle this
-- file already applies to migrated columns, extended here because a
-- single-field ensureExists call can't satisfy it even on a fresh install.
CREATE TABLE IF NOT EXISTS schedule_templates (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generated',
  week_id TEXT REFERENCES schedule_weeks(id)
);

-- idx_schedule_templates_camp_kind is retired (was created by migration v23);
-- schema.sql is re-executed on every open, and a CREATE INDEX naming `kind`
-- would fail on a not-yet-migrated v22 file whose table has no such column,
-- so it was never declared here even when it was current.
--
-- idx_schedule_templates_week_kind (replacing idx_schedule_templates_camp_kind)
-- is created by migration v27, not here, for the same re-execution reason.
-- v27 runs on fresh databases too, so both paths end up identical.

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

-- Sub-plan D Task 0 (2026-07-23): confirmed exact field set by re-reading
-- DayOverridesScreen.jsx's actual insert/update payloads directly.
-- day_override_templates real fields: camp_id, cohort_id, name,
-- frequency_mode. day_override_template_slots real fields: time_block_id,
-- activity_id, keyed to the parent via `template_id` in Supabase — renamed
-- to day_override_template_id locally to match this table's existing FK
-- column name (already used by main.js's PARENT_SCOPED_ENTITIES mapping).
CREATE TABLE IF NOT EXISTS day_override_templates (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  cohort_id TEXT REFERENCES cohorts(id),
  name TEXT NOT NULL,
  frequency_mode TEXT
);

CREATE TABLE IF NOT EXISTS day_override_template_slots (
  id TEXT PRIMARY KEY,
  day_override_template_id TEXT NOT NULL REFERENCES day_override_templates(id),
  time_block_id TEXT,
  activity_id TEXT
);

-- Per-week activity and group exclusion tables (migration v28).
-- A row means "this activity/group does not run in this week." Absence means it runs.
-- idx_week_activity_exclusions_week_activity and idx_week_group_exclusions_week_group
-- are created by migration v28, not here — schema.sql re-executes on every open.
CREATE TABLE IF NOT EXISTS week_activity_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  activity_id TEXT NOT NULL REFERENCES activities(id)
);

CREATE TABLE IF NOT EXISTS week_group_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  group_id TEXT NOT NULL REFERENCES groups(id)
);

-- Camp locations become a first-class entity (schema v32,
-- docs/adr/2026-08-15-camp-locations-entity.md). A physical place and a
-- schedulable location are one thing; capacity is a property of the PLACE
-- ("how many groups fit here at once"), not of the activity. Ordinary
-- camp-scoped replicated entity — field-level ops, DIRECT_CAMP_ENTITIES,
-- nothing host-local. The DDL text below is duplicated verbatim in localDb.js's
-- v32 block (LOCATIONS_DDL); the two copies are asserted byte-identical by
-- locations.migration.test.js. map_geometry is reserved for the optional map
-- (slice M6) and stays NULL until then.
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  sort_order INTEGER,
  map_geometry TEXT,
  UNIQUE(camp_id, name)
);

-- Per-week location availability — "the lake is closed weeks 1 and 2". The
-- third instance of the v28 week_*_exclusions pattern (parent-keyed by week_id,
-- ensureExists gated on week_id). Duplicated verbatim in localDb.js's v32 block
-- (WEEK_LOCATION_EXCLUSIONS_DDL). idx_week_location_exclusions_week_location is
-- created by migration v32, not here (schema.sql re-executes on every open),
-- matching the v28 exclusion indexes.
CREATE TABLE IF NOT EXISTS week_location_exclusions (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES schedule_weeks(id),
  location_id TEXT NOT NULL
);

-- Camp map background image (schema v33, M6,
-- docs/adr/2026-08-16-locations-optional-map.md D1). ONE row per camp, id =
-- camp_id (not a minted uuid) — the map is a singleton the same way `camps`
-- itself is, so there is nothing for two devices to disagree about the
-- identity of. Isolated from `camps` deliberately: `camps` is read on nearly
-- every screen (CLAUDE.md's single-camp-lookup pattern); a background image
-- large enough to matter must not ride along with that read. image_data is
-- ALWAYS re-encoded JPEG (never the uploaded file's original bytes — see D5),
-- capped at ~1MB of base64 text by BOTH the client uploader and appendOp
-- (D2, MAX_FIELD_VALUE_LENGTH in electron/ops/operations.js). NULL image_data
-- is the normal, fully-supported "no map" state — nothing in the app treats
-- it as incomplete. The DDL text below is duplicated verbatim in localDb.js's
-- v33 block (CAMP_MAPS_DDL); the two copies are asserted byte-identical by
-- campMaps.migration.test.js.
CREATE TABLE IF NOT EXISTS camp_maps (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL UNIQUE REFERENCES camps(id),
  image_data TEXT,
  image_mime TEXT,
  image_width INTEGER,
  image_height INTEGER
);

-- C4 (scope-filtered IPC reads): indexes for the three template-scoped
-- tables listByScope queries by template_id. Safe to declare here (unlike
-- the schedule_templates.kind index above) because template_id is NOT NULL
-- from each table's original creation, so re-execution on every open never
-- hits a pre-migration file missing the column.
CREATE INDEX IF NOT EXISTS idx_template_slots_template_id ON template_slots(template_id);
CREATE INDEX IF NOT EXISTS idx_template_overlays_template_id ON template_overlays(template_id);
CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_template_id ON schedule_snapshots(template_id);

-- Special days (schema v34, T40 slice 1,
-- docs/work/specs/2026-08-20-special-days-data-shape-design.md): a standalone,
-- undated, throwaway single-day schedule (Maccabiah / colour war / trip day) —
-- NOT a week, not tied to a calendar date. Ordinary op-log-synced, camp-scoped
-- entity family (same trust model as groups/activities/day_override_templates),
-- not host-local. Closest pattern copied verbatim: day_override_templates +
-- day_override_template_slots (camp-scoped parent + parent-scoped children, no
-- camp_id on children). The DDL text below is duplicated verbatim in
-- localDb.js's v34 block (SPECIAL_DAYS_DDL / SPECIAL_DAY_TIME_BLOCKS_DDL /
-- SPECIAL_DAY_SLOTS_DDL); the three copies are asserted byte-identical by
-- specialDays.migration.test.js.
--
-- special_days: the camp-scoped parent. UNIQUE(camp_id, name) — a camp's
-- special days are distinguished by name, matching locations/groups. No date
-- column: the object is not calendar-dated (named/throwaway, not a dated
-- entry). id is a minted uuid (interactive create — no deriveLocationId-style
-- determinism, per T81/T101).
-- notes (schema v37, T106, ADR 2026-08-20-special-days-authoring-and-day-
-- override-repoint.md D2): free-text record/print surface for a special
-- day's non-schedulable data (team rosters, staffing, points, trip times) —
-- recorded and printed, never solved/parsed. MUST be the LAST column: it is
-- ALTER-added on a migrated db (localDb.js v37), same column-order-trap
-- precedent as elective_sets.is_reusable.
CREATE TABLE IF NOT EXISTS special_days (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  notes TEXT,
  UNIQUE(camp_id, name)
);

-- special_day_time_blocks: parent-scoped by special_day_id, no camp_id column
-- (same shape as day_override_template_slots). Every special day OWNS its time
-- blocks — no polymorphic "reuse camp time_blocks vs own" flag; the "same grid
-- as the normal week" case is served by the author UI seeding a special day's
-- time blocks from the camp's time_blocks at creation, a UI convenience, not a
-- storage branch (design doc's explicit rejection of a uses_camp_time_blocks
-- flag).
CREATE TABLE IF NOT EXISTS special_day_time_blocks (
  id TEXT PRIMARY KEY,
  special_day_id TEXT NOT NULL REFERENCES special_days(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT
);

-- special_day_slots: parent-scoped by special_day_id (no camp_id column) — the
-- grid cells, identified by (special_day_id, group_id, time_block_id).
-- group_id reuses an existing camp `groups` row as the COLUMN (not a
-- throwaway team); time_block_id is this day's OWN row (special_day_time_blocks,
-- not the camp's time_blocks). activity_id/location_id are nullable (empty
-- cell / no location). group_id/activity_id/location_id are deliberately NOT
-- given a SQL REFERENCES clause — they point at live camp entities the same
-- soft way the weekly grid does (render resolves by id; a missing id renders
-- empty), not a hard FK constraint, consistent with the app's op-log model
-- where FK enforcement is by projection, not SQL FKs. No is_span_head/spanning
-- and no person/staff column in this slice (owner-deferred).
CREATE TABLE IF NOT EXISTS special_day_slots (
  id TEXT PRIMARY KEY,
  special_day_id TEXT NOT NULL REFERENCES special_days(id),
  group_id TEXT NOT NULL,
  time_block_id TEXT NOT NULL,
  activity_id TEXT,
  location_id TEXT
);

-- Group-level electives (schema v35, T41 slice 1, data shape + engine-skip +
-- registration only, docs/work/specs/2026-08-20-group-electives-design.md).
-- An elective period runs several activities at once; a group is distributed
-- across them — group-level only, no campers, no solver (owner decisions, see
-- the design doc). The DDL text below is duplicated verbatim in localDb.js's
-- v35 block (ELECTIVE_SETS_DDL / ELECTIVE_SET_ACTIVITIES_DDL); the two copies
-- are asserted byte-identical by electives.migration.test.js. template_slots
-- also gains a nullable elective_set_id column in this migration (an
-- ALTER TABLE, not a CREATE — template_slots is a DRIFTED TABLE, see its
-- comment above).
--
-- elective_sets: the camp-scoped parent, a reusable named set of activity
-- options ("Afternoon Chugim" = {Swim, Art, Archery}). UNIQUE(camp_id, name),
-- matching locations/groups/special_days. id is a minted uuid (interactive
-- create, no deriveLocationId-style determinism).
-- is_reusable (schema v36, T110, docs/adr/2026-08-20-electives-authoring.md
-- D2): the durability marker. A one-off elective placed in a cell is still a
-- real, replicated row (the schema has no inline-string cell content), so it
-- needs an explicit persisted flag every reuse/durable-inventory surface
-- filters on — 0 = one-off, never reusable; 1 (default) = reusable, the
-- normal case. Existing (pre-v36) rows default to reusable. MUST be the LAST
-- column: it is ALTER-added on a migrated db (localDb.js v36), which always
-- appends, so declaring it last here keeps a fresh install's column order
-- byte-identical to a migrated one (same column-order-trap precedent as
-- activities.location_id).
CREATE TABLE IF NOT EXISTS elective_sets (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  sort_order INTEGER,
  is_reusable INTEGER NOT NULL DEFAULT 1,
  UNIQUE(camp_id, name)
);

-- elective_set_activities: parent-scoped by elective_set_id, no camp_id
-- column (mirrors day_override_template_slots/special_day_time_blocks). One
-- row per member activity option. UNIQUE(elective_set_id, activity_id)
-- prevents the same activity being listed twice in one set. activity_id is
-- deliberately NOT given a SQL REFERENCES clause — it points at a live camp
-- `activities` row the same soft way template_slots.activity_id's sibling
-- columns do (render resolves by id), consistent with the app's op-log model.
CREATE TABLE IF NOT EXISTS elective_set_activities (
  id TEXT PRIMARY KEY,
  elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
  activity_id TEXT NOT NULL,
  UNIQUE(elective_set_id, activity_id)
);
