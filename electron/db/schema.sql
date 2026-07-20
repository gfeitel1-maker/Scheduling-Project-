CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
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
  availability TEXT
);

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL
);

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
