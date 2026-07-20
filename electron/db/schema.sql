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
  last_synced_at TEXT
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
  parent_op_id TEXT REFERENCES operations(id)
);
CREATE INDEX IF NOT EXISTS idx_operations_entity ON operations(entity, entity_id, field);

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
