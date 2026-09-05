'use strict';
/*
 * oplog.js — a disposable, Host-less op-log over a shared folder.
 *
 * PURPOSE OF THE EXPERIMENT
 * -------------------------
 * Shoresh today has a real, field-level operation log (electron/ops/operations.js):
 *   op = { id, entity, entity_id, field, value, device_id, timestamp,
 *          parent_op_id, client_write_id, seq/host_seq }
 * ...but a single "Host" assigns the authoritative order (seq/host_seq) and does
 * conflict adjudication. The Teams/Word analogy the owner wants has NO permanent
 * Host — any peer may be offline, and changes flow through a shared folder.
 *
 * This harness answers ONE question the real code can't answer by inspection:
 *   If we drop the always-on Host sequencer and let peers exchange ops through a
 *   shared directory, can two SQLite databases still CONVERGE to identical state
 *   under duplicates, reordering, offline gaps, restarts, partial writes, and
 *   genuine conflicts — with an understandable conflict model?
 *
 * The substitution being tested:
 *   Host-assigned seq   ->   Lamport logical clock + deterministic tiebreak
 *   Host adjudication    ->   Last-Writer-Wins by (lamport, device_id),
 *                             with genuine concurrent edits RECORDED as conflicts
 *                             (never silently dropped) so a human can see them.
 *
 * Transport = a plain folder. Each op is one immutable JSON file, written
 * tmp-then-rename so a reader never sees a half-written file. This is exactly
 * what OneDrive/Dropbox/Syncthing/a NAS would move for us.
 *
 * This file is NOT wired into the app. It imports nothing from electron/ or src/.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

// --- schema: a tiny slice of the real domain plus a real-shaped op log --------
function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT,
      location TEXT
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,            -- globally-unique op identity (real shape)
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      device_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      parent_op_id TEXT,             -- the op this write believed it followed
      client_write_id TEXT,          -- idempotency key (real shape)
      lamport INTEGER NOT NULL       -- REPLACES Host seq: logical clock
    );
    CREATE INDEX IF NOT EXISTS idx_ops_target ON operations(entity, entity_id, field);
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      entity TEXT, entity_id TEXT, field TEXT,
      op_a TEXT, op_b TEXT,          -- the two colliding op ids
      note TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

function lamportNow(db) {
  const row = db.prepare('SELECT MAX(lamport) AS m FROM operations').get();
  return row && row.m ? row.m : 0;
}

// Deterministic winner for a (entity_id, field): highest (lamport, device_id).
// Both peers compute this identically from the same set of ops => convergence.
function winningValue(db, entity, entityId, field) {
  const row = db.prepare(
    `SELECT value FROM operations
      WHERE entity=? AND entity_id=? AND field=?
      ORDER BY lamport DESC, device_id DESC
      LIMIT 1`
  ).get(entity, entityId, field);
  return row ? row.value : undefined;
}

function reproject(db, entity, entityId, field) {
  const val = winningValue(db, entity, entityId, field);
  // ensureExists placeholder then set the field (mirrors real applyProjection)
  db.prepare('INSERT OR IGNORE INTO entities(id) VALUES (?)').run(entityId);
  if (field === 'location' || field === 'name') {
    db.prepare(`UPDATE entities SET ${field}=? WHERE id=?`).run(val, entityId);
  }
}

// --- local edit: mint an op, apply it, and emit it to the shared folder -------
function localEdit(db, deviceId, sharedDir, { entity, entity_id, field, value }) {
  const parent = db.prepare(
    `SELECT id FROM operations WHERE entity=? AND entity_id=? AND field=?
      ORDER BY lamport DESC, device_id DESC LIMIT 1`
  ).get(entity, entity_id, field);
  const op = {
    id: uuid(),
    entity, entity_id, field,
    value: value == null ? null : String(value),
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    parent_op_id: parent ? parent.id : null,
    client_write_id: uuid(),
    lamport: lamportNow(db) + 1,
  };
  applyOp(db, op);                 // update local state first (local-first)
  emitOpFile(sharedDir, op);       // then publish durably to the folder
  return op;
}

// --- apply an op to local state. Idempotent. Records genuine conflicts. -------
// Returns 'applied' | 'duplicate'.
function applyOp(db, op) {
  const existing = db.prepare('SELECT id FROM operations WHERE id=?').get(op.id);
  if (existing) return 'duplicate';           // idempotent on op id (dup delivery)

  // Genuine-conflict detection BEFORE inserting: another op sharing this op's
  // parent (concurrent edit off the same base) with a different value.
  if (op.parent_op_id) {
    const sibling = db.prepare(
      `SELECT id, value FROM operations
        WHERE entity=? AND entity_id=? AND field=? AND parent_op_id IS ? AND id<>?`
    ).get(op.entity, op.entity_id, op.field, op.parent_op_id, op.id);
    if (sibling && sibling.value !== op.value) {
      recordConflict(db, op, sibling);
    }
  }

  db.prepare(
    `INSERT INTO operations
       (id, entity, entity_id, field, value, device_id, timestamp,
        parent_op_id, client_write_id, lamport)
     VALUES (@id,@entity,@entity_id,@field,@value,@device_id,@timestamp,
             @parent_op_id,@client_write_id,@lamport)`
  ).run(op);

  // Advance our logical clock past anything we just learned about.
  const seen = lamportNow(db);
  if (op.lamport < seen) {
    // no-op: our clock is already ahead; next localEdit uses seen+1
  }
  reproject(db, op.entity, op.entity_id, op.field);
  return 'applied';
}

function recordConflict(db, opA, opB) {
  // Idempotent: one conflict row per unordered {opA,opB} pair.
  const [a, b] = [opA.id, opB.id].sort();
  const cid = 'cf_' + a + '_' + b;
  const exists = db.prepare('SELECT id FROM conflicts WHERE id=?').get(cid);
  if (exists) return;
  db.prepare(
    `INSERT INTO conflicts(id, entity, entity_id, field, op_a, op_b, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(cid, opA.entity, opA.entity_id, opA.field, a, b,
        'concurrent edit off same base; LWW winner kept, human should confirm',
        new Date().toISOString());
}

// --- the shared-folder transport ---------------------------------------------
function emitOpFile(sharedDir, op) {
  fs.mkdirSync(sharedDir, { recursive: true });
  // Filename sorts by lamport then device for humans; content is the truth.
  const base = String(op.lamport).padStart(9, '0') + '-' + op.device_id + '-' + op.id;
  const finalPath = path.join(sharedDir, base + '.op.json');
  const tmpPath = path.join(sharedDir, base + '.op.json.tmp');
  // tmp-then-rename: a reader scanning for *.op.json never sees a partial file.
  fs.writeFileSync(tmpPath, JSON.stringify(op));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

// Scan the folder, apply every op we don't already have. Dedupe by op id.
// Returns { applied, duplicates, skippedPartial }.
function sync(db, sharedDir) {
  let applied = 0, duplicates = 0, skippedPartial = 0;
  if (!fs.existsSync(sharedDir)) return { applied, duplicates, skippedPartial };
  const files = fs.readdirSync(sharedDir).filter(f => f.endsWith('.op.json'));
  // Apply in filename order (lamport-first). Convergence does NOT depend on this
  // order — reproject recomputes the winner every time — but applying low-lamport
  // first keeps parent rows present before children, matching real replay.
  files.sort();
  for (const f of files) {
    let op;
    try {
      op = JSON.parse(fs.readFileSync(path.join(sharedDir, f), 'utf8'));
    } catch (e) {
      skippedPartial++;               // half-written / corrupt: ignore, retry later
      continue;
    }
    const r = applyOp(db, op);
    if (r === 'applied') applied++; else duplicates++;
  }
  return { applied, duplicates, skippedPartial };
}

function getEntity(db, id) {
  return db.prepare('SELECT * FROM entities WHERE id=?').get(id);
}
function pendingConflicts(db) {
  return db.prepare('SELECT * FROM conflicts').all();
}

module.exports = {
  openDb, localEdit, applyOp, sync, emitOpFile, getEntity, pendingConflicts,
  lamportNow, winningValue,
};
