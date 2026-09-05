'use strict';
/*
 * project.cjs — a disposable implementation of PROJECT_PACKAGE_SPEC.md.
 *
 * The conceptual model (changed from oplog.cjs): the durable, portable thing is a
 * `.shoresh` PROJECT PACKAGE (a directory: project.json + an immutable journal/).
 * SQLite is a throwaway local ENGINE that materializes state from the package and
 * can be rebuilt from it at any time. Shoresh is the product; SQLite is the engine.
 *
 * Imports nothing from the app. Not wired into Shoresh. Experiment only.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// The project package (the durable document)
// ---------------------------------------------------------------------------
function createProject(dir, meta = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  const projectJsonPath = path.join(dir, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    const project = {
      format: 'shoresh-project/v1',
      projectId: meta.projectId || uuid(),
      name: meta.name || 'Untitled Camp',
      season: meta.season || '',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      createdBy: meta.createdBy || 'unknown',
    };
    // temp-then-rename so a reader never sees a partial project.json
    const tmp = projectJsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    fs.renameSync(tmp, projectJsonPath);
  }
  return openProject(dir);
}

function openProject(dir) {
  const projectJsonPath = path.join(dir, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`Not a .shoresh project (no project.json): ${dir}`);
  }
  const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  if (meta.format !== 'shoresh-project/v1') {
    throw new Error(`Unsupported project format: ${meta.format}`);
  }
  return { dir, journalDir: path.join(dir, 'journal'), meta };
}

// Publish one immutable operation file into the journal (temp-then-rename).
function publishOp(project, op) {
  const base =
    String(op.lamport).padStart(9, '0') + '-' + op.deviceId + '-' + op.id;
  const finalPath = path.join(project.journalDir, base + '.op.json');
  const tmpPath = path.join(project.journalDir, base + '.op.json.tmp');
  fs.writeFileSync(tmpPath, JSON.stringify(op));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

// Read every finalized op file. Returns them in a deterministic total order:
// (lamport, deviceId, id). Ignores *.tmp and unparseable/partial files.
function readJournal(project) {
  const files = fs
    .readdirSync(project.journalDir)
    .filter((f) => f.endsWith('.op.json'));
  const ops = [];
  for (const f of files) {
    let op;
    try {
      op = JSON.parse(fs.readFileSync(path.join(project.journalDir, f), 'utf8'));
    } catch {
      continue; // torn/partial — skip, it'll be complete on a later read
    }
    ops.push(op);
  }
  ops.sort((a, b) =>
    a.lamport - b.lamport ||
    (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return ops;
}

// A content manifest of the journal (filename -> sha256), for proving immutability.
function journalManifest(project) {
  const out = {};
  for (const f of fs.readdirSync(project.journalDir)) {
    if (!f.endsWith('.op.json')) continue;
    const buf = fs.readFileSync(path.join(project.journalDir, f));
    out[f] = crypto.createHash('sha256').update(buf).digest('hex');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The local engine (disposable SQLite working state)
// ---------------------------------------------------------------------------
function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY, name TEXT, location TEXT
    );
    -- local mirror of applied ops: derived state, used for idempotency, the
    -- logical clock, and LWW recomputation. Rebuildable from the package.
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, entity TEXT, entity_id TEXT, field TEXT, value TEXT,
      device_id TEXT, parent_op_id TEXT, client_write_id TEXT, ts TEXT, lamport INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ops_target ON operations(entity, entity_id, field);
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY, entity TEXT, entity_id TEXT, field TEXT,
      op_a TEXT, op_b TEXT, created_at TEXT
    );
  `);
  return db;
}

function lamportNow(db) {
  const r = db.prepare('SELECT MAX(lamport) AS m FROM operations').get();
  return r && r.m ? r.m : 0;
}

// Deterministic winner for a field: highest (lamport, device_id).
function reproject(db, entity, entityId, field) {
  const row = db
    .prepare(
      `SELECT value FROM operations WHERE entity=? AND entity_id=? AND field=?
       ORDER BY lamport DESC, device_id DESC LIMIT 1`
    )
    .get(entity, entityId, field);
  const value = row ? row.value : undefined;
  db.prepare('INSERT OR IGNORE INTO entities(id) VALUES (?)').run(entityId); // ensureExists
  if (field === 'name' || field === 'location') {
    db.prepare(`UPDATE entities SET ${field}=? WHERE id=?`).run(value, entityId);
  }
}

// Apply one op to local state. Idempotent by op id. Records genuine conflicts
// (two ops off the same parent with different values). Returns 'applied'|'duplicate'.
function applyOp(db, op) {
  if (db.prepare('SELECT id FROM operations WHERE id=?').get(op.id)) return 'duplicate';
  if (op.parentOpId) {
    const sibling = db
      .prepare(
        `SELECT id, value FROM operations
         WHERE entity=? AND entity_id=? AND field=? AND parent_op_id IS ? AND id<>?`
      )
      .get(op.entity, op.entityId, op.field, op.parentOpId, op.id);
    if (sibling && sibling.value !== op.value) recordConflict(db, op, sibling);
  }
  db.prepare(
    `INSERT INTO operations
       (id, entity, entity_id, field, value, device_id, parent_op_id, client_write_id, ts, lamport)
     VALUES (@id,@entity,@entityId,@field,@value,@deviceId,@parentOpId,@clientWriteId,@ts,@lamport)`
  ).run(op);
  reproject(db, op.entity, op.entityId, op.field);
  return 'applied';
}

function recordConflict(db, opA, opB) {
  const [a, b] = [opA.id, opB.id].sort();
  const cid = 'cf_' + a + '_' + b;
  if (db.prepare('SELECT id FROM conflicts WHERE id=?').get(cid)) return;
  db.prepare(
    `INSERT INTO conflicts(id, entity, entity_id, field, op_a, op_b, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(cid, opA.entity, opA.entityId, opA.field, a, b, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// An instance = a local engine bound to a project
// ---------------------------------------------------------------------------
function openInstance(project, dbPath, deviceId) {
  const db = openDb(dbPath);
  return { db, project, deviceId, dbPath };
}

// Make a change: mint an immutable op, apply locally, publish into the package.
function edit(instance, { entity = 'entities', entityId, field, value }) {
  const { db, deviceId, project } = instance;
  const parent = db
    .prepare(
      `SELECT id FROM operations WHERE entity=? AND entity_id=? AND field=?
       ORDER BY lamport DESC, device_id DESC LIMIT 1`
    )
    .get(entity, entityId, field);
  const op = {
    id: uuid(),
    entity, entityId, field,
    value: value == null ? null : String(value),
    deviceId,
    parentOpId: parent ? parent.id : null,
    clientWriteId: uuid(),
    ts: new Date().toISOString(),
    lamport: lamportNow(db) + 1,
  };
  applyOp(db, op);            // local-first
  publishOp(project, op);     // durable, immutable, into the package
  return op;
}

// Notice + apply operations others published. Returns { applied, duplicates }.
function sync(instance) {
  let applied = 0, duplicates = 0;
  for (const op of readJournal(instance.project)) {
    if (applyOp(instance.db, op) === 'applied') applied++; else duplicates++;
  }
  return { applied, duplicates };
}

// THE RECONSTRUCTION PROOF: build a brand-new SQLite from ONLY the package.
function rebuildFromProject(project, newDbPath, deviceId = 'rebuilt') {
  if (fs.existsSync(newDbPath)) fs.rmSync(newDbPath);
  const instance = openInstance(project, newDbPath, deviceId);
  for (const op of readJournal(project)) applyOp(instance.db, op);
  return instance;
}

// Canonical state snapshot for exact comparison across instances.
function snapshotState(db) {
  const rows = db.prepare('SELECT id, name, location FROM entities ORDER BY id').all();
  const json = JSON.stringify(rows);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  return { rows, json, hash };
}

function getEntity(db, id) {
  return db.prepare('SELECT * FROM entities WHERE id=?').get(id);
}
function pendingConflicts(db) {
  return db.prepare('SELECT * FROM conflicts').all();
}

module.exports = {
  createProject, openProject, openInstance,
  edit, sync, rebuildFromProject,
  snapshotState, getEntity, pendingConflicts,
  readJournal, journalManifest, publishOp,
};
