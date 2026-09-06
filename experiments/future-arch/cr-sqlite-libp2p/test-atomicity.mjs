// STAGE 0 SPIKE — does Automerge's change() give us the ingest importer's
// atomic all-or-nothing rollback for free?
//
// The invariant to preserve (electron/ops/ingest.js:1038-1042): during an import,
// mutations accumulate; if a conflict is detected, a HELD sentinel is thrown and the
// WHOLE SQLite transaction rolls back, leaving the DB byte-identical — nothing partial
// persists. Under Automerge, the equivalent question is:
//
//   If a callback passed to A.change(doc, fn) throws PART-WAY THROUGH after already
//   mutating several fields across several entities (incl. nested), is the returned/
//   original doc left COMPLETELY unchanged — zero mutations recorded, no partial write,
//   and still usable afterwards?
//
// If YES, ingest's rollback maps onto change()+throw directly.
// If NO, ingestion needs the "stage in a plain object, commit in ONE change() only after
//   all validation passes" pattern instead — which this spike also proves works.
//
//   node test-atomicity.mjs
import * as A from '@automerge/automerge'

let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
const HELD = Symbol('HELD') // mirror ingest.js's sentinel

// ---------------------------------------------------------------------------
// Baseline doc: two entities already present (like a camp mid-setup).
let doc = A.from({
  archery: { name: 'Archery', location: 'Field 1' },
  pottery: { name: 'Pottery', location: 'Kiln' },
})
const headsBefore = A.getHeads(doc)
const snapshotBefore = JSON.stringify(doc)

// === Case 1: throw AFTER mutating several fields across several entities =====
// This is the exact ingest shape: mutate a lot, then discover a conflict and bail.
let threw = null
try {
  doc = A.change(doc, (d) => {
    d.archery.location = 'CHANGED-A'          // mutate existing field
    d.pottery.location = 'CHANGED-B'          // mutate a second entity
    d.swimming = { name: 'Swimming', location: 'Lake' } // ADD a new entity
    d.archery.capacity = 30                    // add a nested new field
    // conflict discovered here — abort the whole import
    throw HELD
  })
} catch (e) { threw = e }

check('change() callback threw and we caught the HELD sentinel', threw === HELD)
check('doc heads UNCHANGED after aborted change (nothing committed)',
  JSON.stringify(A.getHeads(doc)) === JSON.stringify(headsBefore),
  { before: headsBefore, after: A.getHeads(doc) })
check('doc content byte-identical to pre-change snapshot',
  JSON.stringify(doc) === snapshotBefore, doc)
check('the ADDED entity (swimming) did NOT persist', doc.swimming === undefined, doc.swimming)
check('the ADDED nested field (archery.capacity) did NOT persist', doc.archery.capacity === undefined)
check('the MUTATED fields rolled back (archery.location still Field 1)', doc.archery.location === 'Field 1', doc.archery.location)
check('the second MUTATED entity rolled back (pottery.location still Kiln)', doc.pottery.location === 'Kiln', doc.pottery.location)

// === Case 2: doc is still USABLE after an aborted change (not corrupted) =====
let ok = false
try {
  doc = A.change(doc, (d) => { d.archery.location = 'Field 2' })
  ok = doc.archery.location === 'Field 2'
} catch { ok = false }
check('doc still writable after an aborted change (no corruption)', ok, doc.archery.location)

// === Case 3: a SUCCESSFUL change still commits atomically (control) ==========
const headsC = A.getHeads(doc)
doc = A.change(doc, (d) => { d.tennis = { name: 'Tennis', location: 'Court' }; d.pottery.location = 'Kiln 2' })
check('successful multi-entity change commits (heads advanced)',
  JSON.stringify(A.getHeads(doc)) !== JSON.stringify(headsC))
check('successful change persisted BOTH mutations', doc.tennis?.location === 'Court' && doc.pottery.location === 'Kiln 2')

// === Case 4: the "stage-then-commit" fallback pattern (if Case 1 had failed) =
// Prove the alternative works too: accumulate into a plain object, validate, and only
// then apply in ONE change(). This is the design ingest would use if change()+throw
// were unsafe — so we know we have a proven fallback either way.
let doc2 = A.from({ a: { v: 1 } })
function stagedImport (base, rows, validate) {
  const staged = {} // plain JS, no Automerge mutation yet
  for (const r of rows) staged[r.id] = { v: r.v }
  const problem = validate(staged)
  if (problem) return { doc: base, applied: false, problem } // bail BEFORE any change()
  return { doc: A.change(base, (d) => { for (const [id, val] of Object.entries(staged)) d[id] = val }), applied: true }
}
const rejected = stagedImport(doc2, [{ id: 'b', v: 2 }, { id: 'c', v: 3 }], (s) => s.c ? 'c not allowed' : null)
check('staged import BAILED on validation, base doc untouched', rejected.applied === false && rejected.doc.b === undefined && rejected.doc.c === undefined)
const accepted = stagedImport(doc2, [{ id: 'b', v: 2 }], () => null)
check('staged import COMMITTED atomically when validation passed', accepted.applied === true && accepted.doc.b?.v === 2)

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed  (Stage 0 — Automerge atomic-abort spike)')
console.log(pass >= 11 && fail === 0
  ? 'VERDICT: change()+throw gives ingest atomic rollback for free; stage-then-commit fallback also proven.'
  : 'VERDICT: review failures above — atomicity assumption is NOT clean; ingest needs the stage-then-commit design.')
process.exit(fail === 0 ? 0 : 1)
