// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, runAtomic } from './operations.js'
import { readRecord } from '../automerge/campDocument.js'
import {
  setUserDataDirGetter,
  resetForTests,
  getDocIfLoaded,
  flushPendingWrites,
} from '../sync/automerge/liveDoc.js'

// Discards the cached template once, at the end (T188/F2b).
afterAll(() => {
  cleanupTemplatedDbs()
})

// THE INVARIANT UNDER TEST
//
// `commitPlan` states the promise this file exists to protect
// (electron/ops/ingest.js:1441): "Any throw below rolls back every op and every
// projected row together, so the camp is either fully imported or untouched."
//
// That promise is kept for SQLite and for the `operations` ledger, which share
// one transaction. It is NOT kept for the Automerge document — the store
// PLATFORM_STATE.md:41 calls "the source of truth replicated between devices."
//
// WHY. `appendOp` runs its own `db.transaction()` and then, once that returns,
// writes the document (operations.js:167-174) on the stated belief that the
// op-log write "has already committed and returned by the time this runs."
// When `appendOp` is called INSIDE another transaction — which every
// multi-write caller does (ingest.js:1444, deleteRecord.js:375/497,
// deleteWeek.js:48, deleteEvent.js:51, deleteSpecialDay.js:36,
// deleteElectiveSet.js:39, duplicateWeek.js:61, restore.js:287) — that belief
// is false. better-sqlite3 nests transactions as SAVEPOINTs, which ingest.js
// itself relies on (:1446, "better-sqlite3 nests as savepoints, so the one
// outer transaction stays the rollback boundary"). The savepoint releases; the
// outer transaction is still open and uncommitted.
//
// So an import that fails partway rolls SQLite back and tells the director
// nothing was imported, while the document keeps every write. The next
// `projectAll` — which runs after every local change and every incoming merge
// (syncNode.js:85, :461) — makes SQLite match the document again and writes the
// abandoned import back in. Work the director was told was discarded returns.
//
// The debounce in liveDoc.js is not a mitigation: only the SAVE to disk is
// deferred. `applyWrite` mutates the in-memory document immediately, and the
// in-memory document is what projectAll and sync read.
//
// THE FIX. An Automerge document cannot be rolled back, so it is not written
// until the outermost transaction has COMMITTED — `runAtomic` (operations.js)
// buffers document writes for the duration and drops them on a throw. Every
// multi-write op path goes through it; the guard at the bottom of this file
// keeps it that way.
let userDataDir
let tmpFile
let db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-txn-boundary-'))
  setUserDataDirGetter(() => userDataDir)
  // Was openLocalDb(freshPath) — the per-test migration-chain replay, ~304ms (T188/F2b).
  // ONLY this setup call is templated. The second openLocalDb further down deliberately
  // builds a DISTINCT second database (a replica / another device) and is left alone.
  const __t = openTemplatedDb()
  db = __t.db
  tmpFile = __t.file
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  resetForTests()
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

const writeGroup = (id, name) =>
  appendOp(db, {
    entity: 'groups', entity_id: id, field: 'name', value: name,
    author_user_id: null, device_id: 'device-1', parent_op_id: null, client_write_id: null,
  })

describe('appendOp inside an outer transaction — the rollback boundary', () => {
  it('leaves NOTHING in the document when the outer transaction rolls back', () => {
    // A committed write FIRST, so the document genuinely exists. Without it the
    // assertions below pass vacuously against a null document — and proving the
    // failed job leaves an EXISTING document untouched is the stronger claim
    // anyway: the buffer must drop only its own writes, never earlier ones.
    runAtomic(db, () => { writeGroup('g0', 'Already here') })
    flushPendingWrites()
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g0').name).toBe('Already here')

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
      throw new Error('import failed partway, as commitPlan is designed to do')
    })).toThrow('import failed partway')
    flushPendingWrites()

    // SQLite and the op-log rolled back to the committed write — this half
    // already worked before the fix.
    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['g0'])
    expect(db.prepare("SELECT DISTINCT entity_id FROM operations WHERE entity = 'groups'").all().map((r) => r.entity_id)).toEqual(['g0'])

    // The document must roll back with them. It is the authoritative store:
    // anything left here is written BACK into SQLite by the next projectAll.
    // NOT guarded by `if (doc)`. An earlier draft wrote
    // `getDocIfLoaded('camp-1')` — the function takes the DB, not a camp id —
    // so it returned null and the assertion never ran. The test passed while
    // measuring nothing. The two control cases below are what caught it.
    const doc = getDocIfLoaded(db)
    expect(doc, 'the document should exist — otherwise this test proves nothing').toBeTruthy()
    expect(readRecord(doc, 'groups', 'g0').name).toBe('Already here')
    expect(readRecord(doc, 'groups', 'g1')).toBeNull()
    expect(readRecord(doc, 'groups', 'g2')).toBeNull()
  })

  it('still records a committed outer transaction in all three stores', () => {
    // The guard against "fix it by never writing the document" — the fix must
    // preserve the working case, not trade one asymmetry for another.
    runAtomic(db, () => { writeGroup('g3', 'Bunk C') })
    flushPendingWrites()

    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g3').name).toBe('Bunk C')
    expect(db.prepare("SELECT COUNT(*) n FROM operations WHERE entity_id = 'g3'").get().n).toBe(1)
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g3').name).toBe('Bunk C')
  })

  it('only the OUTERMOST boundary releases — a nested job cannot flush early', () => {
    // deleteRecord's cascade calls deleteWeek's, which is why this matters: if
    // an inner runAtomic flushed on its own commit, the bug would simply move
    // one level down and the outer rollback would leave the inner writes behind.
    runAtomic(db, () => { writeGroup('g0', 'Already here') })
    flushPendingWrites()

    expect(() => runAtomic(db, () => {
      runAtomic(db, () => { writeGroup('g5', 'Inner') })
      throw new Error('outer failed after the inner one succeeded')
    })).toThrow('outer failed')
    flushPendingWrites()

    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['g0'])
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g5')).toBeNull()
  })

  it('buffers per database, never process-wide', () => {
    // The same discipline docRegistry/broadcastCallbacks already use in
    // liveDoc.js, for the reason documented there: integration scenarios run
    // two devices in ONE process, and shared global state made one device's
    // node serve the other's writes (scenario 30). A global depth counter would
    // repeat it — device A's rollback discarding device B's buffer.
    const otherFile = path.join(os.tmpdir(), `shoresh-txn-other-${Date.now()}-${Math.random()}.sqlite`)
    const other = openLocalDb(otherFile)
    try {
      other.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-2', 'Device Two')
      other.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')

      // Device B commits a write while device A is mid-transaction and failing.
      expect(() => runAtomic(db, () => {
        writeGroup('gA', 'Device A, doomed')
        runAtomic(other, () => {
          appendOp(other, {
            entity: 'groups', entity_id: 'gB', field: 'name', value: 'Device B, fine',
            author_user_id: null, device_id: 'device-2', parent_op_id: null, client_write_id: null,
          })
        })
        throw new Error('device A rolls back')
      })).toThrow('device A rolls back')
      flushPendingWrites()

      // A rolled back; B did not, and B's document write survived A's failure.
      expect(db.prepare('SELECT id FROM groups').all()).toEqual([])
      expect(other.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['gB'])
      expect(readRecord(getDocIfLoaded(other), 'groups', 'gB').name).toBe('Device B, fine')
    } finally {
      other.close()
      if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile)
    }
  })

  it('a top-level write is unaffected — it was always correct', () => {
    writeGroup('g4', 'Bunk D')
    flushPendingWrites()
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g4').name).toBe('Bunk D')
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g4').name).toBe('Bunk D')
  })
})

// Structural guard. The fix is only as good as its adoption: a future
// multi-write path that reaches for `db.transaction` directly gets the old
// behaviour back silently, and no behavioural test would catch it because that
// path would look correct in isolation.
//
// WHAT THIS DOES NOT CATCH, stated plainly rather than implied (Red Hat):
//   - a file that opens a bare transaction around a HELPER which itself calls
//     appendOp (slotOccupants.js's clearSlotOccupant is such a helper today);
//     the new file's own source would contain no `appendOp(` to match on.
//   - a transaction built indirectly, or through a wrapper under another name.
// It is a textual check over three directories, not a call-graph proof. It
// catches the copy-paste case, which is the likely one.
describe('no write path opens its own transaction around an op append', () => {
  it('every multi-write module uses runAtomic', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const opsDir = new URL('.', import.meta.url).pathname
    // Widened past electron/ops/ (Red Hat): a new multi-write module placed
    // under automerge/ or sync/ would previously not have been scanned at all.
    const dirs = [opsDir, opsDir + '../automerge/', opsDir + '../sync/automerge/']
    // These legitimately own a bare transaction: operations.js defines runAtomic
    // and appendOp's own inner transaction; the rest write ONLY host-local
    // tables that never reach the document, so there is nothing to keep in step.
    const ALLOWED = new Set([
      'operations.js', 'confirmAlias.js', 'confirmCompoundCellPattern.js',
      'migrationReviews.js', 'openReconciliationDecisions.js', 'projectionRepair.js',
    ])
    const offenders = []
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.js') || file.includes('.test.') || ALLOWED.has(file)) continue
        const src = readFileSync(dir + file, 'utf8')
        // `appendBulkReplaceOp` too (Red Hat): a file using only the bulk
        // primitive would have slipped the old `appendOp(`-only filter.
        if (!src.includes('appendOp(') && !src.includes('appendBulkReplaceOp(')) continue
        for (const [i, line] of src.split('\n').entries()) {
          const t = line.trim()
          if (line.includes('db.transaction(') && !t.startsWith('//') && !t.startsWith('*')) {
            offenders.push(`${file}:${i + 1}`)
          }
        }
      }
    }
    expect(offenders, 'use runAtomic(db, fn) so the document shares the rollback boundary').toEqual([])
  })
})


// Second structural guard, for the invariant T309 rests on
// (docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md).
//
// `appendOp` no longer opens its own transaction while a `runAtomic` frame is
// open — that boundary already promises all-or-nothing, and the nested
// SAVEPOINT cost just over half the CPU of a 100-camper import (1,566 ms ->
// 740 ms on an idle machine). The guarantee that
// makes it safe is NOT in appendOp; it is a property of every caller:
//
//   no write path may catch an appendOp throw and CONTINUE while inside a
//   runAtomic body.
//
// A caller that did would already be breaking runAtomic's contract ("the camp
// is either fully imported or untouched" cannot survive stepping over a failed
// write). But before T309 it broke it QUIETLY — the per-op savepoint undid
// that one op — and after T309 the operations row survives with no projected
// row. So the invariant is checked rather than assumed.
//
// TWO THINGS A FIRST DRAFT OF THIS GUARD MISSED, both found by Red Hat review
// by extracting its algorithm and running it against planted violations, and
// both re-confirmed here by planting them in real files:
//
//   - It matched only the literal tokens `appendOp(`/`appendBulkReplaceOp(`.
//     But this repo's DOMINANT idiom is a local alias — ingest.js's `write`
//     and `remove`, commitElectiveRun.js's `write`, finalizeElectiveRun.js's,
//     attributeElectiveSubject.js's. A `try { write(db, …) } catch {}` inside
//     runAtomic sailed straight through. Aliases are now collected per file
//     (below) and matched as call tokens too.
//   - It located the callback body as "the first `{` after `runAtomic(`",
//     which is the PARAMETER braces for `runAtomic(db, ({ x }) => …)` and the
//     OBJECT LITERAL for a concise body like attributeElectiveSubject.js's
//     `runAtomic(db, () => write('campers', id, { … }))`. It scanned the wrong
//     span and reported nothing. The scan is now the whole `runAtomic( … )`
//     call expression, found by paren matching, which contains the callback
//     whatever shape it takes.
//
// WHAT IT STILL DOES NOT CATCH, stated rather than implied:
//   - a `catch` inside a helper DEFINED IN ANOTHER FILE and called from a
//     runAtomic body (slotOccupants.js's clearSlotOccupant is such a helper);
//     only the calling file's own aliases are resolved.
//   - `runAtomic` itself invoked under an alias, or built indirectly.
//   - an alias assigned by destructuring or reassigned after declaration.
// It is a lexical scan over four directories, not a call-graph proof.
describe('no write path catches an appendOp throw inside a runAtomic body', () => {
  // Blank comments and string/template literals, PRESERVING LENGTH, so the
  // bracket matching below cannot be thrown off by a bracket inside a string
  // or a comment (this repo's comments are long and contain both).
  const blankLiterals = (src) => {
    const out = src.split('')
    let i = 0
    const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ' }
    while (i < src.length) {
      const c = src[i], d = src[i + 1]
      if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; blank(i, j); i = j; continue }
      if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; blank(i, j); i = j; continue }
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1
        while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1 }
        blank(i + 1, j); i = j + 1; continue
      }
      i += 1
    }
    return out.join('')
  }

  // End index of the bracket group opened by the first `open` at or after `from`.
  const groupEnd = (src, from, open, close) => {
    const at = src.indexOf(open, from)
    if (at < 0) return -1
    let depth = 0
    for (let i = at; i < src.length; i++) {
      if (src[i] === open) depth += 1
      else if (src[i] === close) { depth -= 1; if (depth === 0) return i }
    }
    return -1
  }

  // Identifiers in THIS file that reach appendOp/appendBulkReplaceOp — a
  // `const write = …appendOp…` binding, or a local `function remove(…)` whose
  // body calls one. Returns them as alternation-ready names.
  const aliasesIn = (src) => {
    const names = new Set()
    const base = /\b(?:appendOp|appendBulkReplaceOp)\b/
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
      // Initializer runs to the first `;` or newline seen at bracket depth 0.
      let i = m.index + m[0].length, depth = 0
      for (; i < src.length; i++) {
        const c = src[i]
        if ('([{'.includes(c)) depth += 1
        else if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1 }
        else if (depth === 0 && (c === ';' || c === '\n')) break
      }
      if (base.test(src.slice(m.index, i))) names.add(m[1])
    }
    for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const bodyEnd = groupEnd(src, m.index, '{', '}')
      if (bodyEnd > 0 && base.test(src.slice(m.index, bodyEnd))) names.add(m[1])
    }
    return [...names]
  }

  it('every runAtomic body lets an appendOp failure reach the boundary', async () => {
    const { readFileSync, readdirSync, existsSync } = await import('node:fs')
    const opsDir = new URL('.', import.meta.url).pathname
    const dirs = [opsDir, opsDir + '../automerge/', opsDir + '../sync/automerge/', opsDir + '../db/']

    const offenders = []
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.js') || file.includes('.test.')) continue
        const src = blankLiterals(readFileSync(dir + file, 'utf8'))
        if (!src.includes('runAtomic(')) continue
        const tokens = ['appendOp', 'appendBulkReplaceOp', ...aliasesIn(src)]
        const appends = new RegExp(`\\b(?:${tokens.join('|')})\\s*\\(`)
        for (let at = src.indexOf('runAtomic('); at >= 0; at = src.indexOf('runAtomic(', at + 1)) {
          // The WHOLE call expression — parens, not braces, so a destructured
          // parameter or a concise arrow body cannot mis-scope the scan.
          const end = groupEnd(src, at, '(', ')')
          if (end < 0) continue
          const call = src.slice(at, end)
          for (let t = call.indexOf('try'); t >= 0; t = call.indexOf('try', t + 1)) {
            if (/[A-Za-z0-9_$]/.test(call[t - 1] ?? '')) continue // e.g. `retry`
            const tEnd = groupEnd(call, t, '{', '}')
            if (tEnd < 0) continue
            if (appends.test(call.slice(t, tEnd))) {
              offenders.push(`${file}:${src.slice(0, at + t).split('\n').length}`)
            }
          }
        }
      }
    }
    expect(
      offenders,
      'an appendOp throw inside runAtomic must reach the boundary — catching it leaves an operations row with no projected row',
    ).toEqual([])
  })
})
