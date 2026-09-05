'use strict';
/*
 * project-cli.cjs — drive the .shoresh project experiment by hand, across two
 * computers, using a shared folder (OneDrive/Dropbox/Syncthing/NAS) to hold the
 * package. Each computer keeps its OWN local sqlite (outside the package).
 *
 *   node project-cli.cjs init    --pkg "<shared>/test-project.shoresh" [--name "Camp Achva"] [--season "Summer 2027"]
 *   node project-cli.cjs edit    --pkg "<...>" --entity archery --field location --value "Field 1"
 *   node project-cli.cjs sync    --pkg "<...>"
 *   node project-cli.cjs show    --pkg "<...>"
 *   node project-cli.cjs watch   --pkg "<...>" [--interval 3000]
 *   node project-cli.cjs rebuild --pkg "<...>" --out ./rebuilt.sqlite
 *
 * Defaults: --device = this computer's hostname; --db = ./<device>.sqlite (local,
 * NOT in the shared folder). --field is 'name' or 'location'.
 *
 * The printed STATE HASH is the convergence check: when both computers print the
 * same hash after syncing, they have converged. It is also what "rebuild" must
 * reproduce from the package alone.
 */
const os = require('os');
const path = require('path');
const P = require('./project.cjs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const cmd = process.argv[2];
const DEVICE = arg('device', os.hostname().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'device');
const PKG = arg('pkg', null);
const DB = arg('db', path.resolve('./' + DEVICE + '.sqlite'));

function requirePkg() {
  if (!PKG) { console.error('ERROR: --pkg "<path to the shared test-project.shoresh>" is required'); process.exit(2); }
}

function printState(db, label) {
  const rows = db.prepare('SELECT id, name, location FROM entities ORDER BY id').all();
  const { hash } = P.snapshotState(db);
  const conflicts = P.pendingConflicts(db);
  console.log('\n' + (label || 'state') + '  (device=' + DEVICE + ')');
  if (rows.length === 0) console.log('  (no entities yet)');
  for (const r of rows) console.log('  ' + r.id.padEnd(12) + ' name=' + (r.name ?? '·') + '  location=' + (r.location ?? '·'));
  if (conflicts.length) console.log('  ⚠ ' + conflicts.length + ' recorded conflict(s) — a human should confirm the winner');
  console.log('  STATE HASH: ' + hash);
}

function open() {
  const project = P.openProject(PKG);
  return P.openInstance(project, DB, DEVICE);
}

if (cmd === 'init') {
  requirePkg();
  const project = P.createProject(PKG, { name: arg('name', 'Untitled Camp'), season: arg('season', ''), createdBy: DEVICE });
  console.log('Created/opened project package: ' + project.dir);
  console.log('  name:   ' + project.meta.name);
  console.log('  season: ' + project.meta.season);
  console.log('  id:     ' + project.meta.projectId);
  console.log('\nLocal engine (this computer) will live at: ' + DB);
  console.log('Next: run `edit` here, and `sync` on the other computer once the folder propagates.');
} else if (cmd === 'edit') {
  requirePkg();
  const entity = arg('entity', null), field = arg('field', null), value = arg('value', null);
  if (!entity || !field || value == null) { console.error('ERROR: edit needs --entity <id> --field <name|location> --value <v>'); process.exit(2); }
  const inst = open();
  P.sync(inst); // catch up first so our change builds on the latest we can see
  const op = P.edit(inst, { entityId: entity, field, value });
  console.log('Published op ' + op.id + '  (' + entity + '.' + field + ' = "' + value + '", lamport ' + op.lamport + ')');
  console.log('It is now an immutable file in the shared package journal. The folder will propagate it.');
  printState(inst.db, 'state after edit');
} else if (cmd === 'sync') {
  requirePkg();
  const inst = open();
  const r = P.sync(inst);
  console.log('Synced from package: applied ' + r.applied + ' new op(s), ' + r.duplicates + ' already had.');
  printState(inst.db, 'state after sync');
} else if (cmd === 'show') {
  requirePkg();
  printState(open().db, 'current local state (no sync)');
} else if (cmd === 'watch') {
  requirePkg();
  const interval = parseInt(arg('interval', '3000'), 10);
  console.log('Watching ' + PKG + ' every ' + interval + 'ms. Ctrl-C to stop.');
  let lastHash = null;
  const tick = () => {
    const inst = open();
    P.sync(inst);
    const { hash } = P.snapshotState(inst.db);
    if (hash !== lastHash) { lastHash = hash; printState(inst.db, 'CHANGE detected'); }
    inst.db.close();
  };
  tick();
  setInterval(tick, interval);
} else if (cmd === 'rebuild') {
  requirePkg();
  const out = arg('out', path.resolve('./rebuilt.sqlite'));
  const project = P.openProject(PKG);
  const inst = P.rebuildFromProject(project, out, 'rebuilt');
  console.log('Rebuilt a fresh sqlite at ' + out + ' from ONLY the package (' + P.readJournal(project).length + ' journal ops).');
  printState(inst.db, 'reconstructed state');
  console.log('\nCompare the STATE HASH above with the other computer\'s `sync` output — they must match exactly.');
} else {
  console.log('usage: node project-cli.cjs <init|edit|sync|show|watch|rebuild> --pkg "<path>" [...]');
  console.log('see the header of this file for full options.');
  process.exit(cmd ? 2 : 0);
}
