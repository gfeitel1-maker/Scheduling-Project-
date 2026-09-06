// CR3 — Automerge (the TRUTH + merge + conflict) → SQLite (the queryable working
// copy). Proves: the Automerge doc projects into SQLite; SQLite is rebuildable
// from the doc ALONE (mirrors the earlier 19/19 reconstruction, now with Automerge
// as truth); and a genuine conflict lands as a SURFACEABLE flag row in SQLite.
import Database from 'better-sqlite3'
import * as A from '@automerge/automerge'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + (d ? '  -> ' + d : '')) } }
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cr3-'))

function openDb (file) {
  const db = new Database(file)
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT, location TEXT);
    CREATE TABLE IF NOT EXISTS conflicts (entity_id TEXT, field TEXT, values_json TEXT);
  `)
  return db
}

// PROJECTION: deterministically materialize an Automerge schedule doc into SQLite.
// Also surfaces genuine same-field conflicts (Automerge.getConflicts) as flag rows —
// this is where the CRDT's "keep competing values" becomes a human-facing conflict.
function project (db, doc) {
  db.exec('DELETE FROM entities; DELETE FROM conflicts;')
  const insE = db.prepare('INSERT OR REPLACE INTO entities(id,name,location) VALUES (?,?,?)')
  const insC = db.prepare('INSERT INTO conflicts(entity_id,field,values_json) VALUES (?,?,?)')
  for (const [id, ent] of Object.entries(doc)) {
    insE.run(id, ent.name ?? null, ent.location ?? null)
    for (const field of ['name', 'location']) {
      const c = A.getConflicts(ent, field)
      if (c && Object.keys(c).length > 1) insC.run(id, field, JSON.stringify(Object.values(c)))
    }
  }
}

function stateHash (db) {
  const rows = db.prepare('SELECT id,name,location FROM entities ORDER BY id').all()
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

// --- build a schedule doc, project, query ------------------------------------
console.log('1. Automerge doc projects into a queryable SQLite')
let doc = A.from({ archery: { name: 'Archery', location: 'unassigned' },
                   pottery: { name: 'Pottery', location: 'unassigned' } })
doc = A.change(doc, d => { d.archery.location = 'Field 1'; d.pottery.location = 'Kiln' })
const dbA = openDb(path.join(SB, 'a.sqlite'))
project(dbA, doc)
check('SQLite queryable: Archery @ Field 1',
  dbA.prepare('SELECT location FROM entities WHERE id=?').get('archery').location === 'Field 1')
check('SQLite queryable: Pottery @ Kiln',
  dbA.prepare('SELECT location FROM entities WHERE id=?').get('pottery').location === 'Kiln')
const survivorHash = stateHash(dbA)

console.log('\n2. Edit in Automerge, re-project — SQLite reflects it')
doc = A.change(doc, d => { d.archery.location = 'Field 3' })
project(dbA, doc)
check('re-projected: Archery @ Field 3',
  dbA.prepare('SELECT location FROM entities WHERE id=?').get('archery').location === 'Field 3')

console.log('\n3. DELETE SQLite; REBUILD from the Automerge doc ALONE')
const docBytes = A.save(doc)             // the portable "document"
dbA.close(); fs.rmSync(path.join(SB, 'a.sqlite'))
const rebuilt = openDb(path.join(SB, 'rebuilt.sqlite'))
project(rebuilt, A.load(docBytes))       // rebuild working copy from the doc only
check('rebuilt SQLite matches the doc (Archery @ Field 3)',
  rebuilt.prepare('SELECT location FROM entities WHERE id=?').get('archery').location === 'Field 3')
// deterministic rebuild: two independent rebuilds match
const rebuilt2 = openDb(path.join(SB, 'rebuilt2.sqlite'))
project(rebuilt2, A.load(docBytes))
check('two independent rebuilds identical (deterministic)', stateHash(rebuilt) === stateHash(rebuilt2))

console.log('\n4. A genuine same-slot conflict SURFACES as a SQLite flag row')
let g = A.from({ archery: { name: 'Archery', location: 'BASE' } })
let gBytes = A.save(g)
let greg = A.load(gBytes), taylor = A.load(gBytes)
greg   = A.change(greg,   d => { d.archery.location = 'Field 1' })   // concurrent, same slot
taylor = A.change(taylor, d => { d.archery.location = 'Field 3' })
const conflicted = A.merge(A.clone(greg), taylor)
const dbC = openDb(path.join(SB, 'c.sqlite'))
project(dbC, conflicted)
const flag = dbC.prepare('SELECT * FROM conflicts WHERE entity_id=? AND field=?').get('archery', 'location')
check('conflict landed as a surfaceable flag row in SQLite', !!flag,
  'flag=' + JSON.stringify(flag))
if (flag) console.log('     director would see competing values:', flag.values_json)
check('state still converged to one deterministic value',
  ['Field 1', 'Field 3'].includes(dbC.prepare('SELECT location FROM entities WHERE id=?').get('archery').location))

console.log('\n' + '='.repeat(58))
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
console.log('Automerge = truth + auto-merge + conflict record;  SQLite = queryable,')
console.log('rebuildable working copy; conflicts surface as flags. Full local story.')
console.log('sandbox: ' + SB)
console.log('='.repeat(58))
process.exit(fail === 0 ? 0 : 1)
