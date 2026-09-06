// Tests the "automerge piece" with a MAINTAINED CRDT (Automerge v3), after
// cr-sqlite proved stale/broken on modern Node. Two questions the owner flagged:
//   1. Do independent edits auto-merge / converge? (the CRDT promise)
//   2. When two people edit the SAME slot, does the library let us DETECT and
//      SURFACE that as a domain conflict (not silently pick a winner)?
import * as A from '@automerge/automerge'

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  -> ' + detail : '')) }
}

// A shared "schedule document": entities with a location field.
let base = A.from({ archery: { name: 'Archery', location: 'unassigned' },
                    pottery: { name: 'Pottery', location: 'unassigned' } })

console.log('1. Independent concurrent edits converge (the CRDT promise)')
let greg = A.clone(base), taylor = A.clone(base)
greg   = A.change(greg,   d => { d.archery.location = 'Field 1' })   // Greg moves Archery
taylor = A.change(taylor, d => { d.pottery.location = 'Kiln' })       // Taylor moves Pottery (different entity)
let merged = A.merge(A.clone(greg), taylor)
check('Archery @ Field 1 after merge', merged.archery.location === 'Field 1')
check('Pottery @ Kiln after merge',   merged.pottery.location === 'Kiln')
// both peers converge to identical state
let mergedOther = A.merge(A.clone(taylor), greg)
check('both merge directions identical',
  JSON.stringify(merged) === JSON.stringify(mergedOther))

console.log('\n2. Genuine SAME-SLOT conflict — does it converge AND stay surfaceable?')
let g2 = A.clone(base), t2 = A.clone(base)
g2 = A.change(g2, d => { d.archery.location = 'Field 1' })  // Greg: Archery -> Field 1
t2 = A.change(t2, d => { d.archery.location = 'Field 3' })  // Taylor: Archery -> Field 3 (SAME slot, concurrent)
let conflicted = A.merge(A.clone(g2), t2)
// Automerge deterministically picks ONE winner so state still converges…
check('converges to a single deterministic value',
  ['Field 1', 'Field 3'].includes(conflicted.archery.location),
  'got ' + conflicted.archery.location)
let conflictedOther = A.merge(A.clone(t2), g2)
check('winner is the same on both peers (deterministic)',
  conflicted.archery.location === conflictedOther.archery.location)
// …BUT the competing values remain accessible — this is what lets Shoresh
// SURFACE the conflict to a human instead of silently overwriting.
const conflicts = A.getConflicts(conflicted.archery, 'location')
check('getConflicts EXPOSES both competing values (surfaceable to a human)',
  conflicts && Object.keys(conflicts).length >= 2,
  'conflicts=' + JSON.stringify(conflicts))
if (conflicts) {
  console.log('     competing values Shoresh could show the director:',
    JSON.stringify(Object.values(conflicts)))
}
// And a NON-conflict field returns no conflicts (so we only surface real ones)
check('non-conflicting field reports no conflict',
  A.getConflicts(merged.archery, 'location') === undefined)

console.log('\n3. Binary changes are exchangeable (what libp2p would ship)')
const g3 = A.change(A.clone(base), d => { d.archery.location = 'Lake' })
const changes = A.getChanges(base, g3)          // the delta, as bytes
check('produced binary change(s)', Array.isArray(changes) && changes.length >= 1)
let receiver = A.clone(base)
;[receiver] = A.applyChanges(receiver, changes) // apply on the other side
check('receiver applied the change', receiver.archery.location === 'Lake')

console.log('\n' + '='.repeat(56))
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
console.log('Automerge: converges automatically, AND getConflicts() surfaces')
console.log('genuine same-slot conflicts — solving the exact domain-conflict')
console.log('concern (silent-merge) that cr-sqlite would have left to us.')
console.log('='.repeat(56))
process.exit(fail === 0 ? 0 : 1)
