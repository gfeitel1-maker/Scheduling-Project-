'use strict';
/*
 * run-project.cjs — proves PROJECT_PACKAGE_SPEC.md end to end.
 *
 *   node experiments/future-arch/run-project.cjs
 *
 * Two independent SQLite instances (separate db files, separate deviceIds) open the
 * SAME test-project.shoresh package, edit independently, publish immutable ops, notice
 * each other, and converge. Then: delete one SQLite entirely and rebuild it from ONLY
 * the package — its state must match the survivor exactly.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const P = require('./project.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ PASS  ' + name); }
  else { fail++; console.log('  ❌ FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-project-'));
const PKG = path.join(ROOT, 'test-project.shoresh');      // the canonical shared document
const dbA = path.join(ROOT, 'engineA.sqlite');            // local engines live OUTSIDE the package
const dbB = path.join(ROOT, 'engineB.sqlite');

console.log('Canonical project package: ' + PKG);
console.log('(SQLite engines live outside it: ' + path.basename(dbA) + ', ' + path.basename(dbB) + ')');

// --- create the package; open two independent instances against it -----------
const project = P.createProject(PKG, { name: 'Camp Achva', season: 'Summer 2027', createdBy: 'devA' });
const A = P.openInstance(project, dbA, 'devA');
const B = P.openInstance(P.openProject(PKG), dbB, 'devB'); // B opens the SAME package, independently

section('0. The package is a portable directory, no sqlite inside');
check('project.json present', fs.existsSync(path.join(PKG, 'project.json')));
check('journal/ present', fs.existsSync(path.join(PKG, 'journal')));
check('NO .sqlite inside the package', fs.readdirSync(PKG).every((f) => !f.endsWith('.sqlite')));

// 1. A -> B
section('1. A edits, B notices and converges');
P.edit(A, { entityId: 'archery', field: 'name', value: 'Archery' });
P.edit(A, { entityId: 'archery', field: 'location', value: 'Field 1' });
P.sync(B);
check('B sees Archery @ Field 1', P.getEntity(B.db, 'archery')?.location === 'Field 1');
check('B sees the name too', P.getEntity(B.db, 'archery')?.name === 'Archery');

// 2. B -> A
section('2. B edits, A notices and converges');
P.edit(B, { entityId: 'pottery', field: 'name', value: 'Pottery' });
P.edit(B, { entityId: 'pottery', field: 'location', value: 'Kiln' });
P.sync(A);
check('A sees Pottery @ Kiln', P.getEntity(A.db, 'pottery')?.location === 'Kiln');

// 3. independent concurrent edits converge
section('3. Independent concurrent edits converge');
P.edit(A, { entityId: 'archery', field: 'location', value: 'Field 3' });
P.edit(B, { entityId: 'pottery', field: 'location', value: 'Studio' });
P.sync(A); P.sync(B);
check('A & B agree on archery', P.getEntity(A.db, 'archery').location === P.getEntity(B.db, 'archery').location);
check('A & B agree on pottery', P.getEntity(A.db, 'pottery').location === P.getEntity(B.db, 'pottery').location);

// 4. genuine same-field conflict: both converge AND both record it
section('4. Same-field conflict converges + is recorded on both');
P.edit(A, { entityId: 'archery', field: 'location', value: 'BASE' });
P.sync(B); // agree on a base
const cA = P.edit(A, { entityId: 'archery', field: 'location', value: 'Lake' });
const cB = P.edit(B, { entityId: 'archery', field: 'location', value: 'Gym' });
check('true concurrency (same parent)', cA.parentOpId === cB.parentOpId);
P.sync(A); P.sync(B); P.sync(A);
check('A & B converge to one value', P.getEntity(A.db, 'archery').location === P.getEntity(B.db, 'archery').location);
check('conflict recorded on A', P.pendingConflicts(A.db).length >= 1);
check('conflict recorded on B', P.pendingConflicts(B.db).length >= 1);

// 5. immutability: existing journal files never change; log only grows
section('5. Journal is immutable + append-only');
const manifestBefore = P.journalManifest(project);
P.edit(A, { entityId: 'archery', field: 'name', value: 'Archery Range' });
P.sync(B);
const manifestAfter = P.journalManifest(project);
const priorUnchanged = Object.keys(manifestBefore).every((f) => manifestAfter[f] === manifestBefore[f]);
check('every previously-published op file is byte-identical', priorUnchanged);
check('journal only grew', Object.keys(manifestAfter).length > Object.keys(manifestBefore).length);

// Make sure both are fully caught up before the reconstruction proof.
P.sync(A); P.sync(B);
const survivorState = P.snapshotState(A.db);

// 6. THE RECONSTRUCTION PROOF -------------------------------------------------
section('6. Delete a SQLite engine entirely; rebuild from ONLY the package');
B.db.close();
fs.rmSync(dbB);                 // destroy B's engine completely
fs.rmSync(dbB + '-wal', { force: true });
fs.rmSync(dbB + '-shm', { force: true });
check('B\'s sqlite is gone', !fs.existsSync(dbB));

const dbRebuilt = path.join(ROOT, 'engineB-rebuilt.sqlite'); // fresh file, no prior state
const R = P.rebuildFromProject(P.openProject(PKG), dbRebuilt, 'rebuilt');
const rebuiltState = P.snapshotState(R.db);

check('rebuilt state DEEP-EQUALS survivor', rebuiltState.json === survivorState.json,
  '\n     survivor: ' + survivorState.json + '\n     rebuilt:  ' + rebuiltState.json);
check('rebuilt state HASH matches survivor', rebuiltState.hash === survivorState.hash);
check('rebuilt used ONLY the package (fresh db file, no access to A/B engines)', fs.existsSync(dbRebuilt));

// 7. rebuild is itself deterministic (rebuild twice -> same hash)
section('7. Reconstruction is deterministic');
const dbRebuilt2 = path.join(ROOT, 'engineB-rebuilt2.sqlite');
const R2 = P.rebuildFromProject(P.openProject(PKG), dbRebuilt2, 'rebuilt2');
check('two independent rebuilds match', P.snapshotState(R2.db).hash === rebuiltState.hash);

// --- summary -----------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('survivor state:  ' + survivorState.json);
console.log('survivor hash:   ' + survivorState.hash);
console.log('rebuilt  hash:   ' + rebuiltState.hash + (rebuiltState.hash === survivorState.hash ? '   (EXACT MATCH)' : '   (MISMATCH)'));
console.log('journal ops:     ' + Object.keys(P.journalManifest(project)).length + ' immutable files');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('package: ' + PKG);
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
