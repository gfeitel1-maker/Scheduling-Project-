CREATE TABLE IF NOT EXISTS camps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen_at TEXT
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
