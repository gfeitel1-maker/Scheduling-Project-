// @vitest-environment node
//
// T105 §3 — the multi-device interleave test the T111 design doc explicitly
// could not write (scoped to T105's write path). Follows T111's own
// multi-device interleave test shape: direct applyProjection calls against a
// shared test db, no real transport.
import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { applyProjection } from './projections.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let tmpFile
let db

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('grp-1', 'camp-1', 'Bunk 1')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id, is_span_head) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('head-1', 'tpl-1', 'grp-1', 'day-1', 'block-1', 'act-1', '1')
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id, is_span_head) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('tail-1', 'tpl-1', 'grp-1', 'day-1', 'block-2', 'act-1', '0')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function getRow(id) {
  return db.prepare('SELECT * FROM template_slots WHERE id = ?').get(id)
}

describe('span-head -> elective conversion — multi-device interleave (T105 §3)', () => {
  it('two devices converting the same span head to DIFFERENT electives concurrently never leave an orphaned tail with a live head', () => {
    // Device A: converts head to elective set-A, releases the tail — the
    // field ops createElectiveFromCell would actually produce (head.
    // activity_id=null, head.elective_set_id=set-A, tail.activity_id=null,
    // tail.is_span_head=true), interleaved at arrival-seq granularity with...
    // Device B: independently also converts the SAME head to set-B, racing A.
    const interleavedOps = [
      { entity: 'template_slots', entity_id: 'head-1', field: 'activity_id', value: null },        // A seq1
      { entity: 'template_slots', entity_id: 'tail-1', field: 'activity_id', value: null },         // B's tail-release seq2
      { entity: 'template_slots', entity_id: 'tail-1', field: 'is_span_head', value: 1 },           // B seq3
      { entity: 'template_slots', entity_id: 'head-1', field: 'elective_set_id', value: 'set-B' },  // B seq4
      { entity: 'template_slots', entity_id: 'tail-1', field: 'activity_id', value: null },         // A's tail-release seq5 (redundant, already null)
      { entity: 'template_slots', entity_id: 'tail-1', field: 'is_span_head', value: 1 },           // A seq6 (redundant, already true)
      { entity: 'template_slots', entity_id: 'head-1', field: 'elective_set_id', value: 'set-A' },  // A seq7
    ]
    for (const op of interleavedOps) applyProjection(db, op)

    const head = getRow('head-1')
    const tail = getRow('tail-1')

    // Invariant this test protects: the tail is NEVER left owning an
    // activity_id while the head is not an activity head — i.e. no orphaned
    // tail, regardless of which device's elective "wins" the head (T111's
    // MUTUALLY_EXCLUSIVE_FIELDS already guarantees the head itself is
    // single-kind; this test is about the head/tail RELATIONSHIP, which T111
    // explicitly does not know about).
    expect(tail.activity_id).toBeNull()
    expect(Boolean(tail.is_span_head)).toBe(true)
    expect(head.activity_id).toBeNull()
    expect(head.elective_set_id).toBe('set-A') // higher-seq setter wins, standard LWW
  })

  it('releasing the same tail twice (idempotent) never re-orphans it regardless of order', () => {
    const ops = [
      { entity: 'template_slots', entity_id: 'tail-1', field: 'activity_id', value: null },
      { entity: 'template_slots', entity_id: 'tail-1', field: 'is_span_head', value: 1 },
      { entity: 'template_slots', entity_id: 'head-1', field: 'activity_id', value: null },
      { entity: 'template_slots', entity_id: 'head-1', field: 'elective_set_id', value: 'set-A' },
      // A second, later release of the SAME tail (e.g. a retried write) —
      // must remain a no-op, not resurrect a stale activity_id.
      { entity: 'template_slots', entity_id: 'tail-1', field: 'activity_id', value: null },
      { entity: 'template_slots', entity_id: 'tail-1', field: 'is_span_head', value: 1 },
    ]
    for (const op of ops) applyProjection(db, op)

    expect(getRow('tail-1').activity_id).toBeNull()
    expect(Boolean(getRow('tail-1').is_span_head)).toBe(true)
    expect(getRow('head-1').elective_set_id).toBe('set-A')
  })
})
