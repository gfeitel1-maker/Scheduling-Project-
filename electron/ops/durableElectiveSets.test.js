// @vitest-environment node
//
// T103 (docs/adr/2026-08-20-electives-authoring.md D2;
// docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md D3): the
// load-bearing invariant a one-off/scoped elective set must never appear in
// a durable reuse listing. This is the query every reuse surface (palette,
// management-list, Roots Context inventory) must call — a caller that
// forgets to filter is_reusable is exactly the census-pollution failure mode
// the foundational ADR names.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { listDurableElectiveSets } from './durableElectiveSets.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-durable-electives-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const write = (entity, entity_id, field, value) =>
  appendOp(db, { entity, entity_id, field, value, author_user_id: 'user-1', device_id: 'device-1' })

describe('listDurableElectiveSets', () => {
  it('a non-reusable (tier a/b) set never appears in the durable listing — the load-bearing invariant', () => {
    write('elective_sets', 'es-durable', 'name', 'Afternoon Chugim')
    write('elective_sets', 'es-oneoff', 'name', 'Rainy Day Fill-In')
    write('elective_sets', 'es-oneoff', 'is_reusable', 0)

    const rows = listDurableElectiveSets(db, 'camp-1')
    expect(rows.map((r) => r.id)).toEqual(['es-durable'])
    expect(rows.some((r) => r.id === 'es-oneoff')).toBe(false)
  })

  it('a new set defaults to reusable and appears in the durable listing without any extra write', () => {
    write('elective_sets', 'es-1', 'name', 'Standing Electives')
    const rows = listDurableElectiveSets(db, 'camp-1')
    expect(rows.map((r) => r.id)).toEqual(['es-1'])
  })

  it('demoting a previously-durable set to one-off removes it from the listing', () => {
    write('elective_sets', 'es-1', 'name', 'Was Durable')
    expect(listDurableElectiveSets(db, 'camp-1').map((r) => r.id)).toEqual(['es-1'])

    write('elective_sets', 'es-1', 'is_reusable', 0)
    expect(listDurableElectiveSets(db, 'camp-1')).toEqual([])
  })

  it('promoting a one-off set back to reusable restores it to the listing', () => {
    write('elective_sets', 'es-1', 'name', 'Was One-Off')
    write('elective_sets', 'es-1', 'is_reusable', 0)
    expect(listDurableElectiveSets(db, 'camp-1')).toEqual([])

    write('elective_sets', 'es-1', 'is_reusable', 1)
    expect(listDurableElectiveSets(db, 'camp-1').map((r) => r.id)).toEqual(['es-1'])
  })

  it('is camp-scoped — never leaks another camp\'s sets', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    write('elective_sets', 'es-1', 'name', 'Camp One Set')
    // Directly seed a camp-2 row (no second full user/session setup needed for this check).
    db.prepare("INSERT INTO elective_sets (id, camp_id, name, is_reusable) VALUES ('es-2', 'camp-2', 'Camp Two Set', 1)").run()

    expect(listDurableElectiveSets(db, 'camp-1').map((r) => r.id)).toEqual(['es-1'])
    expect(listDurableElectiveSets(db, 'camp-2').map((r) => r.id)).toEqual(['es-2'])
  })
})
