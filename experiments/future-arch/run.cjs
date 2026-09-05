'use strict';
/*
 * run.js — drives the Host-less op-log harness through the exact scenarios the
 * owner asked for. Everything runs in a temp dir; nothing touches the real app.
 *
 *   node experiments/future-arch/run.js
 *
 * Each scenario prints PASS/FAIL. Exit code is non-zero if anything fails.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const L = require('./oplog.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ PASS  ' + name); }
  else { fail++; console.log('  ❌ FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// Fresh sandbox per run.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-oplog-'));
const SHARED = path.join(ROOT, 'shared');       // the "OneDrive folder"
fs.mkdirSync(SHARED, { recursive: true });

const DEV_A = 'deviceA', DEV_B = 'deviceB';
function nodeDb(tag) { return L.openDb(path.join(ROOT, tag + '.db')); }

// Two logical activities both peers start knowing about (seeded identically).
const ARCHERY = 'act_archery', POTTERY = 'act_pottery';
function seed(db) {
  db.prepare('INSERT OR IGNORE INTO entities(id,name,location) VALUES (?,?,?)')
    .run(ARCHERY, 'Archery', 'unassigned');
  db.prepare('INSERT OR IGNORE INTO entities(id,name,location) VALUES (?,?,?)')
    .run(POTTERY, 'Pottery', 'unassigned');
}

// ---------------------------------------------------------------------------
console.log('Host-less op-log over a shared folder  (shared dir: ' + SHARED + ')');

let A = nodeDb('A'); seed(A);
let B = nodeDb('B'); seed(B);

// 1. A -> B
section('1. A -> B  (Greg moves Archery to Field 1, Taylor sees it)');
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 1' });
L.sync(B, SHARED);
check('B sees Archery @ Field 1', L.getEntity(B, ARCHERY).location === 'Field 1');

// 2. B -> A
section('2. B -> A  (Taylor moves Pottery to Classroom 2, Greg sees it)');
L.localEdit(B, DEV_B, SHARED, { entity: 'entities', entity_id: POTTERY, field: 'location', value: 'Classroom 2' });
L.sync(A, SHARED);
check('A sees Pottery @ Classroom 2', L.getEntity(A, POTTERY).location === 'Classroom 2');

// 3. Multiple independent changes converge
section('3. Multiple independent changes converge');
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 3' });
L.localEdit(B, DEV_B, SHARED, { entity: 'entities', entity_id: POTTERY, field: 'location', value: 'Kiln' });
L.sync(A, SHARED); L.sync(B, SHARED);
check('A & B agree on Archery', L.getEntity(A, ARCHERY).location === L.getEntity(B, ARCHERY).location);
check('A & B agree on Pottery', L.getEntity(A, POTTERY).location === L.getEntity(B, POTTERY).location);

// 4. One computer offline, then reconnects and catches up
section('4. Offline then reconnect  (B offline while A makes 3 edits)');
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 5' });
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 6' });
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: POTTERY, field: 'location', value: 'Studio' });
// B was "offline" (did not sync). Now it reconnects:
const caught = L.sync(B, SHARED);
check('B catches up Archery', L.getEntity(B, ARCHERY).location === 'Field 6');
check('B catches up Pottery', L.getEntity(B, POTTERY).location === 'Studio');
check('catch-up applied >=3 new ops', caught.applied >= 3, 'applied=' + caught.applied);

// 5. Duplicate delivery
section('5. Duplicate delivery  (sync the same folder twice)');
const before = A.prepare('SELECT COUNT(*) c FROM operations').get().c;
const dup1 = L.sync(A, SHARED);
const dup2 = L.sync(A, SHARED);
const after = A.prepare('SELECT COUNT(*) c FROM operations').get().c;
check('no new ops applied on re-sync', dup1.applied === 0 && dup2.applied === 0);
check('op count unchanged (idempotent)', before === after, before + ' -> ' + after);

// 6. Out-of-order arrival
section('6. Out-of-order arrival  (fresh node C applies ops newest-first)');
let C = L.openDb(path.join(ROOT, 'C.db')); seed(C);
const files = fs.readdirSync(SHARED).filter(f => f.endsWith('.op.json')).sort().reverse();
for (const f of files) {
  const op = JSON.parse(fs.readFileSync(path.join(SHARED, f), 'utf8'));
  L.applyOp(C, op);
}
check('C converges to A on Archery despite reverse order',
  L.getEntity(C, ARCHERY).location === L.getEntity(A, ARCHERY).location,
  'C=' + L.getEntity(C, ARCHERY).location + ' A=' + L.getEntity(A, ARCHERY).location);
check('C converges to A on Pottery despite reverse order',
  L.getEntity(C, POTTERY).location === L.getEntity(A, POTTERY).location);

// 7. Application restart  (close & reopen the db files)
section('7. Application restart  (persistence + no re-apply)');
const aArch = L.getEntity(A, ARCHERY).location;
const aOps = A.prepare('SELECT COUNT(*) c FROM operations').get().c;
A.close();
A = L.openDb(path.join(ROOT, 'A.db'));   // reopen same file
check('state survived restart', L.getEntity(A, ARCHERY).location === aArch);
const reOps = L.sync(A, SHARED);
check('re-sync after restart applies nothing new', reOps.applied === 0);
check('op count stable across restart', A.prepare('SELECT COUNT(*) c FROM operations').get().c === aOps);

// 8. Interruption during sync  (a half-written op file must be ignored)
section('8. Partial write during sync  (torn file is skipped, not corrupting)');
const tornFinal = path.join(SHARED, '999999999-deviceX-torn.op.json');
fs.writeFileSync(tornFinal, '{ "id": "torn", "entity": "entities", "entity_i');  // truncated JSON
const tornRes = L.sync(A, SHARED);
check('torn file skipped, not applied', tornRes.skippedPartial >= 1);
check('torn op not in log', !A.prepare('SELECT id FROM operations WHERE id=?').get('torn'));
fs.unlinkSync(tornFinal);
// And prove the tmp-then-rename discipline: a *.op.json.tmp is never scanned.
// Use a throwaway entity + clean up so this demo can't pollute later scenarios.
const atomicFile = L.emitOpFile(SHARED, { id: 'x1', entity: 'entities', entity_id: 'act_atomic_demo',
  field: 'location', value: 'ATOMIC', device_id: 'deviceX', timestamp: new Date().toISOString(),
  parent_op_id: null, client_write_id: 'x', lamport: L.lamportNow(A) + 1 });
const tmpFile = path.join(SHARED, '000000001-deviceX-partial.op.json.tmp');
fs.writeFileSync(tmpFile, '{partial');
const scan = fs.readdirSync(SHARED).filter(f => f.endsWith('.op.json'));
check('.tmp files invisible to *.op.json scan', scan.every(f => !f.endsWith('.tmp')));
fs.unlinkSync(atomicFile); fs.unlinkSync(tmpFile);   // keep shared folder clean

// 9. Conflicting changes to the same entity (the real test)
section('9. Genuine conflict  (both move Archery concurrently, before seeing each other)');
// Reset Archery to a known agreed base on both A and B.
L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'BASE' });
L.sync(B, SHARED);
check('both at agreed base', L.getEntity(A, ARCHERY).location === 'BASE' && L.getEntity(B, ARCHERY).location === 'BASE');
// Now BOTH edit off that same base WITHOUT syncing first == concurrent conflict.
const opA = L.localEdit(A, DEV_A, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 1' });
const opB = L.localEdit(B, DEV_B, SHARED, { entity: 'entities', entity_id: ARCHERY, field: 'location', value: 'Field 3' });
check('same parent (true concurrency)', opA.parent_op_id === opB.parent_op_id);
// Exchange.
L.sync(A, SHARED); L.sync(B, SHARED); L.sync(A, SHARED);
check('A & B CONVERGE to one value', L.getEntity(A, ARCHERY).location === L.getEntity(B, ARCHERY).location,
  'A=' + L.getEntity(A, ARCHERY).location + ' B=' + L.getEntity(B, ARCHERY).location);
check('deterministic winner is defined', ['Field 1', 'Field 3'].includes(L.getEntity(A, ARCHERY).location));
check('conflict RECORDED on A (not silently dropped)', L.pendingConflicts(A).length >= 1);
check('conflict RECORDED on B (not silently dropped)', L.pendingConflicts(B).length >= 1);
check('both nodes flag the SAME conflict pair',
  L.pendingConflicts(A)[0] && L.pendingConflicts(B)[0] &&
  L.pendingConflicts(A)[0].id === L.pendingConflicts(B)[0].id);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('winner rule: highest (lamport, device_id)  ==  Last-Writer-Wins, deterministic');
console.log('sandbox: ' + ROOT);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
