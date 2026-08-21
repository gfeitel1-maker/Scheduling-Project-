// @vitest-environment node
//
// INV-2 (docs/adr/2026-08-15-camp-locations-entity.md): restoring a pre-v32
// activity from Trash MUST re-resolve location_id from the frozen `location`
// string, by the same TRIM-only, case-sensitive key the v32 backfill used.
//
// A pre-v32 activity's location_id is a MIGRATION side effect that exists
// nowhere in the op log, so lastKnownFields cannot carry it. Without the
// re-resolution, a naive restore re-emits `location` (the frozen string) but
// leaves location_id NULL — silently un-binding the activity from its place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { restoreEntity } from './restore.js'
import { deriveLocationId } from './locationId.js'

const files = []
let db

beforeEach(() => {
  const file = path.join(os.tmpdir(), `shoresh-restore-loc-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device1', 'iPad')
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

const session = { author_user_id: null, device_id: 'device1' }
const write = (entity, id, field, value) =>
  appendOp(db, { entity, entity_id: id, field, value, ...session })

// A pre-v32 activity: op history has camp_id/name/location but NO location_id
// op (location_id was a migration side effect, never in the log).
function makePreV32Activity(id, location) {
  write('activities', id, 'camp_id', 'camp1')
  write('activities', id, 'name', id)
  write('activities', id, 'location', location)
}

// The v32 backfill inserts locations rows directly (no op).
function seedLocation(name) {
  const locId = deriveLocationId('camp1', name)
  db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(locId, 'camp1', name)
  return locId
}

describe('INV-2: restore re-resolves location_id from the frozen string', () => {
  it('re-binds a restored pre-v32 activity to its place', () => {
    const locId = seedLocation('Pool')
    makePreV32Activity('a1', 'Pool')
    // The live row was backfilled too — but a delete removes it; restore must
    // rebuild the binding without the log ever having carried it.
    db.prepare('UPDATE activities SET location_id = ? WHERE id = ?').run(locId, 'a1')
    write('activities', 'a1', DELETE_FIELD, 1)

    const result = restoreEntity(db, { entity: 'activities', entity_id: 'a1', ...session })
    expect(result.ok).toBe(true)

    const row = db.prepare('SELECT location, location_id FROM activities WHERE id = ?').get('a1')
    expect(row.location).toBe('Pool')
    expect(row.location_id).toBe(locId)
  })

  it('matches by the TRIM-only key — an untrimmed frozen string still binds', () => {
    const locId = seedLocation('Gym') // stored trimmed, as the backfill would
    makePreV32Activity('a2', '  Gym  ') // frozen string kept its spaces
    write('activities', 'a2', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a2', ...session })
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a2').location_id).toBe(locId)
  })

  it('is case-sensitive — pool does not bind to a Pool row', () => {
    seedLocation('Pool')
    makePreV32Activity('a3', 'pool')
    write('activities', 'a3', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a3', ...session })
    // No 'pool' row exists → left NULL, string preserved.
    const row = db.prepare('SELECT location, location_id FROM activities WHERE id = ?').get('a3')
    expect(row.location).toBe('pool')
    expect(row.location_id).toBeNull()
  })

  it('leaves location_id NULL when the place was deleted (frozen-column-only state)', () => {
    makePreV32Activity('a4', 'Archery Range') // no locations row for it
    write('activities', 'a4', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a4', ...session })
    const row = db.prepare('SELECT location, location_id FROM activities WHERE id = ?').get('a4')
    expect(row.location).toBe('Archery Range')
    expect(row.location_id).toBeNull()
  })

  it('does not re-resolve for an activity that never had a location', () => {
    write('activities', 'a5', 'camp_id', 'camp1')
    write('activities', 'a5', 'name', 'Rest')
    write('activities', 'a5', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a5', ...session })
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a5').location_id).toBeNull()
  })

  // T101 (docs/work/tickets/T101-locations-deterministic-id-rename-recollide.md):
  // the base id's row may have been RENAMED since this activity's location
  // string was frozen. Restore must not rebind to a mismatched-name row —
  // that would silently attach "Archery" to whatever now lives at the old id.
  it('T101: base id row was renamed away — does not rebind to the mismatched-name row, leaves location_id NULL', () => {
    const locId = seedLocation('Pool') // this row's id is deriveLocationId('camp1', 'Pool')
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Swimming Pool', locId) // renamed post-backfill
    makePreV32Activity('a6', 'Pool') // frozen string still says 'Pool'
    write('activities', 'a6', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a6', ...session })
    const row = db.prepare('SELECT location, location_id FROM activities WHERE id = ?').get('a6')
    expect(row.location).toBe('Pool')
    expect(row.location_id).toBeNull()
  })

  it('T101: rebinds to a disambiguated row whose name matches, when the base id was recollided', () => {
    const base = deriveLocationId('camp1', 'Pool')
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(base, 'camp1', 'Swimming Pool')
    db.prepare('INSERT INTO locations (id, camp_id, name, capacity) VALUES (?, ?, ?, 1)').run(`${base}:2`, 'camp1', 'Pool')
    makePreV32Activity('a7', 'Pool')
    write('activities', 'a7', DELETE_FIELD, 1)

    restoreEntity(db, { entity: 'activities', entity_id: 'a7', ...session })
    expect(db.prepare('SELECT location_id FROM activities WHERE id = ?').get('a7').location_id).toBe(`${base}:2`)
  })
})
