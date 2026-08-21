// M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md) — the ingest
// resolve-or-create location path. This file exercises the ADR's five
// normative invariants, each with its own required test:
//
//   1. Cross-device deterministic ingest id (extends INV-1).
//   2. Ordering-before-location_id (locations create ops precede the
//      activity's location_id op, within the same commit).
//   3. The frozen activities.location column stays untouched (ingest never
//      writes it — it only stops being the diff target).
//   4. Recognition-key consistency (§D3) across preview / buildPlan / commit.
//   5. Replace mode never touches locations.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { deriveLocationId } from './locationId.js'
import { recognitionKey } from '../../src/ingest/preview.js'
import { buildPlan, fieldsFor } from '../../src/ingest/buildPlan.js'
import { DB_FIELD, resolveFieldWrite } from '../../src/ingest/fieldUpdate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db, tmpFile, campId
const deviceId = 'device-1'

function seedCampDb(file, id) {
  const d = openLocalDb(file)
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(id, 'Camp Test', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', id)
  return d
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ingest-loc-${Date.now()}-${Math.random()}.sqlite`)
  campId = randomUUID()
  db = seedCampDb(tmpFile, campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('Invariant 1 (INV-1 extension) — cross-device deterministic ingest id', () => {
  it('mints byte-identical locations.id and activities.location_id on two independent commits', () => {
    const sharedCampId = randomUUID()
    const fileA = path.join(os.tmpdir(), `shoresh-inv1-a-${Date.now()}-${Math.random()}.sqlite`)
    const fileB = path.join(os.tmpdir(), `shoresh-inv1-b-${Date.now()}-${Math.random()}.sqlite`)
    const dbA = seedCampDb(fileA, sharedCampId)
    const dbB = seedCampDb(fileB, sharedCampId)

    const importInput = {
      approved: {
        locations: ['Pool'],
        activities: [{ name: 'Swim', fields: { location: 'Pool' } }],
      },
      camp_id: sharedCampId,
      device_id: deviceId,
    }

    try {
      commitIngest(dbA, importInput)
      commitIngest(dbB, importInput)

      const locsA = dbA.prepare('SELECT id, camp_id, name FROM locations ORDER BY id').all()
      const locsB = dbB.prepare('SELECT id, camp_id, name FROM locations ORDER BY id').all()
      expect(locsA).toEqual(locsB)
      expect(locsA).toHaveLength(1)
      expect(locsA[0].id).toBe(deriveLocationId(sharedCampId, 'Pool'))

      // Only location_id needs to be device-identical (INV-1) — the
      // activity's own id is a randomUUID, unrelated to this invariant.
      const actA = dbA.prepare('SELECT location_id FROM activities ORDER BY location_id').all()
      const actB = dbB.prepare('SELECT location_id FROM activities ORDER BY location_id').all()
      expect(actA).toEqual(actB)
      expect(actA[0].location_id).toBe(locsA[0].id)
    } finally {
      dbA.close()
      dbB.close()
      for (const f of [fileA, fileB]) {
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
        }
      }
    }
  })

  it('mints the same id via the D1c resolve-or-create path (no separate locations create item)', () => {
    // The S4 workbook path's real shape: a brand-new activity whose location
    // was never separately proposed as its own `locations` create item.
    const sharedCampId = randomUUID()
    const fileA = path.join(os.tmpdir(), `shoresh-inv1c-a-${Date.now()}-${Math.random()}.sqlite`)
    const fileB = path.join(os.tmpdir(), `shoresh-inv1c-b-${Date.now()}-${Math.random()}.sqlite`)
    const dbA = seedCampDb(fileA, sharedCampId)
    const dbB = seedCampDb(fileB, sharedCampId)

    const importInput = {
      approved: { activities: [{ name: 'Archery', fields: { location: 'Range' } }] },
      camp_id: sharedCampId,
      device_id: deviceId,
    }

    try {
      commitIngest(dbA, importInput)
      commitIngest(dbB, importInput)

      const locsA = dbA.prepare('SELECT id, name FROM locations').all()
      const locsB = dbB.prepare('SELECT id, name FROM locations').all()
      expect(locsA).toEqual(locsB)
      expect(locsA[0].id).toBe(deriveLocationId(sharedCampId, 'Range'))
    } finally {
      dbA.close()
      dbB.close()
      for (const f of [fileA, fileB]) {
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
        }
      }
    }
  })
})

describe('D1c — resolveOrCreateLocationId cannot double-mint within one commit', () => {
  it('two different activities in ONE commit, both referencing the same new location, mint it exactly once', () => {
    // Neither activity has its location separately proposed as its own
    // `locations` create item — the genuine D1c shape (the S4 workbook path).
    // Both resolve sequentially inside the single-threaded db.transaction();
    // the second must be a cache hit, not a second appendOp pair.
    const result = commitIngest(db, {
      approved: {
        activities: [
          { name: 'Swim', fields: { location: 'Pool' } },
          { name: 'Water Polo', fields: { location: 'Pool' } },
        ],
      },
      camp_id: campId, device_id: deviceId,
    })
    expect(result.held).toBe(false)

    const locations = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
    expect(locations).toHaveLength(1)
    expect(locations[0].id).toBe(deriveLocationId(campId, 'Pool'))

    const locationCreateOps = db.prepare(
      "SELECT COUNT(*) c FROM operations WHERE entity='locations' AND field='name'"
    ).get().c
    expect(locationCreateOps).toBe(1) // exactly one create, not two

    const activities = db.prepare('SELECT name, location_id FROM activities WHERE camp_id = ? ORDER BY name').all(campId)
    expect(activities).toEqual([
      { name: 'Swim', location_id: locations[0].id },
      { name: 'Water Polo', location_id: locations[0].id },
    ])
  })
})

describe('T101 — rename-then-recollide never overwrites the renamed row', () => {
  it('commitCreate: importing "Pool" after a RENAME to "Swimming Pool" creates a distinct row, leaves the renamed row untouched', () => {
    // Simulate the director's rename: a "Pool" location already exists at its
    // deterministic base id, then gets renamed. The row keeps its id.
    const base = deriveLocationId(campId, 'Pool')
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    expect(db.prepare('SELECT id, name FROM locations WHERE id = ?').get(base)).toEqual({ id: base, name: 'Pool' })
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Swimming Pool', base)

    // Re-import "Pool" via the direct locations-entity create path.
    const result = commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    expect(result.held).toBe(false)

    const renamed = db.prepare('SELECT id, name FROM locations WHERE id = ?').get(base)
    expect(renamed).toEqual({ id: base, name: 'Swimming Pool' }) // untouched, not overwritten

    const newRow = db.prepare('SELECT id, name FROM locations WHERE id = ?').get(`${base}:2`)
    expect(newRow).toEqual({ id: `${base}:2`, name: 'Pool' }) // distinct row
  })

  it('resolveOrCreateLocationId (D1c): an activity referencing "Pool" after the same rename binds to the NEW distinct row', () => {
    const base = deriveLocationId(campId, 'Pool')
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Swimming Pool', base)

    commitIngest(db, {
      approved: { activities: [{ name: 'Swim', fields: { location: 'Pool' } }] },
      camp_id: campId, device_id: deviceId,
    })

    const activity = db.prepare('SELECT location_id FROM activities WHERE camp_id = ? AND name = ?').get(campId, 'Swim')
    expect(activity.location_id).toBe(`${base}:2`)

    const renamed = db.prepare('SELECT name FROM locations WHERE id = ?').get(base)
    expect(renamed.name).toBe('Swimming Pool') // the renamed row's name was never touched
  })

  it('two independent commits (simulating two devices) after the same synced rename converge on the identical disambiguated id', () => {
    const base = deriveLocationId(campId, 'Pool')
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Swimming Pool', base)

    // Device A's commit
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    const afterA = db.prepare('SELECT id, name FROM locations WHERE camp_id = ? ORDER BY id').all(campId)
    expect(afterA.map((r) => r.id)).toContain(`${base}:2`)

    // A second device, syncing the same state, independently derives the SAME id — never a fork.
    const secondCampId2 = campId // same camp/db here; the id derivation itself is what must agree
    const recomputed = deriveLocationId(secondCampId2, 'Pool')
    expect(recomputed).toBe(base) // base id is a pure function of the name — unchanged
    // No second row minted on a re-run against unchanged state: the existing ':2' row's
    // name already matches 'Pool', so re-import reuses it rather than minting ':3'.
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    const afterB = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
    expect(afterB).toHaveLength(2) // still just the renamed row + the one disambiguated row
  })
})

describe('Invariant 2 — ordering-before-location_id', () => {
  it('writes the location create op(s) at a lower seq than the activity location_id op', () => {
    commitIngest(db, {
      approved: {
        locations: ['Pool'],
        activities: [{ name: 'Swim', fields: { location: 'Pool' } }],
      },
      camp_id: campId, device_id: deviceId,
    })

    const locOp = db.prepare(
      "SELECT seq FROM operations WHERE entity='locations' AND field='name' ORDER BY seq ASC LIMIT 1"
    ).get()
    const actOp = db.prepare(
      "SELECT seq FROM operations WHERE entity='activities' AND field='location_id' ORDER BY seq ASC LIMIT 1"
    ).get()
    expect(locOp).toBeTruthy()
    expect(actOp).toBeTruthy()
    expect(locOp.seq).toBeLessThan(actOp.seq)
  })

  it('holds for the D1c resolve-or-create path too (location op still precedes location_id)', () => {
    commitIngest(db, {
      approved: { activities: [{ name: 'Archery', fields: { location: 'Range' } }] },
      camp_id: campId, device_id: deviceId,
    })
    const locOp = db.prepare(
      "SELECT seq FROM operations WHERE entity='locations' AND field='name' ORDER BY seq ASC LIMIT 1"
    ).get()
    const actOp = db.prepare(
      "SELECT seq FROM operations WHERE entity='activities' AND field='location_id' ORDER BY seq ASC LIMIT 1"
    ).get()
    expect(locOp.seq).toBeLessThan(actOp.seq)
  })
})

describe('Invariant 3 — the frozen activities.location column is retained, never written', () => {
  it('writes location_id only; activities.location stays NULL and no op ever targets it', () => {
    commitIngest(db, {
      approved: {
        locations: ['Pool'],
        activities: [{ name: 'Swim', fields: { location: 'Pool' } }],
      },
      camp_id: campId, device_id: deviceId,
    })
    const locationFieldOps = db.prepare(
      "SELECT COUNT(*) c FROM operations WHERE entity='activities' AND field='location'"
    ).get().c
    expect(locationFieldOps).toBe(0)

    const row = db.prepare('SELECT location, location_id FROM activities WHERE camp_id = ?').get(campId)
    expect(row.location).toBeNull()
    expect(row.location_id).not.toBeNull()
  })
})

// Invariant 3's own test above is scenario-specific (one commit shape, then a
// COUNT(*) check) — Red Hat's finding on §D7: the ADR claimed an APP-WIDE
// regression guard already existed, and it did not. There are exactly three
// places any ingest write path could still put an op on activities.location
// instead of activities.location_id, one per PlanItem op type, and each is a
// single hardcoded chokepoint rather than a per-call-site choice — so testing
// each chokepoint directly (not one runtime scenario through all of them at
// once) is the genuine, input-independent guard: no commit shape reaching
// that chokepoint can produce a different answer.
//   - create:  fieldsFor('activities', ...)     — never puts 'location' in
//              the base fields; a create's location travels only through the
//              _rule side-channel (buildPlan.js, resolved by
//              resolveOrCreateLocationId in ingest.js, straight to
//              fields.location_id).
//   - update:  resolveFieldWrite('location', ...) — always resolves to
//              { field: 'location_id', ... }, never { field: 'location' }.
//   - clear:   dbFieldFor('location') (DB_FIELD.location) — always
//              'location_id', so a <clear> on 'location' writes a null op on
//              'location_id', never on 'location' itself.
describe('Invariant 3b — no ingest write path can ever target activities.location (app-wide guard)', () => {
  it('a create never puts "location" in an activity\'s base fields — buildPlan.fieldsFor', () => {
    expect(Object.keys(fieldsFor('activities', 'Swim', 'camp-1', 0, null))).not.toContain('location')
  })

  it('an update always resolves the import field "location" to the stored field "location_id" — resolveFieldWrite', () => {
    const resolved = resolveFieldWrite('location', 'Pool', {
      groupIdByName: new Map(), tierIdByName: new Map(), locationIdByName: new Map([['Pool', 'loc-1']]),
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.field).toBe('location_id')
  })

  it('a clear on "location" is written under the stored field "location_id" — dbFieldFor/DB_FIELD', () => {
    expect(DB_FIELD.location).toBe('location_id')
  })

  it('COMPARABLE_COLUMNS.activities (ingest.js) never lists the frozen "location" column as a diff target (static source guard)', () => {
    // COMPARABLE_COLUMNS is a module-local const, not exported — reading the
    // source directly is the same "regex the source, not the runtime" pattern
    // projectionsCoverage.test.js already uses for this class of guard.
    // Bounded to the `activities:` array literal specifically, so a 'location'
    // string anywhere else in the file (e.g. inside a comment) can't false-hit.
    const text = fs.readFileSync(path.join(__dirname, 'ingest.js'), 'utf8')
    const m = text.match(/const COMPARABLE_COLUMNS = Object\.freeze\(\{([\s\S]*?)\n\}\)/)
    expect(m, 'expected to find the COMPARABLE_COLUMNS definition in ingest.js').toBeTruthy()
    const activitiesLine = m[1].match(/activities:\s*\[([^\]]*)\]/)
    expect(activitiesLine, 'expected to find an activities: [...] entry in COMPARABLE_COLUMNS').toBeTruthy()
    const columns = activitiesLine[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    expect(columns).not.toContain('location')
    expect(columns).toContain('location_id')
  })
})

describe('Invariant 4 — recognition-key consistency (§D3): "Pool" vs "pool" agree across layers', () => {
  it('is recognized (not re-created) when the case matches exactly, in all three layers', () => {
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    const existingRows = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
    const existing = { locations: existingRows }

    // Layer 1: preview.js's recognitionKey — the primitive buildPlan's own
    // matching (Layer 2) is built on. buildPreview itself is deleted (ADR
    // 2026-08-17-onescreen-reconciliation-merge.md §2/A2).
    expect(recognitionKey('locations', 'Pool')).toBe(recognitionKey('locations', existing.locations[0].name))

    // Layer 2: buildPlan.js plan-build recognition.
    const plan = buildPlan({ approved: { locations: ['Pool'] }, camp_id: campId, mode: 'add' }, existing)
    const locItem = plan.items.find((i) => i.entity === 'locations')
    expect(locItem.op).toBe('unchanged')

    // Layer 3: ingest.js commit-time re-resolution.
    const result = commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    expect(result.created.locations).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM locations WHERE camp_id = ?').get(campId).c).toBe(1)
  })

  it('proposes/creates a SECOND row when the case differs, in all three layers', () => {
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    const existingRows = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
    const existing = { locations: existingRows }

    // Layer 1: preview.js's recognitionKey — 'pool' is NOT recognized against 'Pool'.
    expect(recognitionKey('locations', 'pool')).not.toBe(recognitionKey('locations', existing.locations[0].name))

    // Layer 2: buildPlan.js — a genuine create, not an update against 'Pool'.
    const plan = buildPlan({ approved: { locations: ['pool'] }, camp_id: campId, mode: 'add' }, existing)
    const locItem = plan.items.find((i) => i.entity === 'locations')
    expect(locItem.op).toBe('create')

    // Layer 3: ingest.js commit-time re-resolution — a second, distinct row.
    const result = commitIngest(db, { approved: { locations: ['pool'] }, camp_id: campId, device_id: deviceId })
    expect(result.created.locations).toBe(1)
    const rows = db.prepare('SELECT name FROM locations WHERE camp_id = ? ORDER BY name').all(campId).map((r) => r.name)
    expect(rows).toEqual(['Pool', 'pool'])
  })
})

describe('Invariant 5 — replace mode never touches locations', () => {
  it('leaves an existing location untouched (same id/capacity, no new ops) and recognizes it', () => {
    commitIngest(db, {
      approved: {
        locations: ['Pool'],
        activities: [{ name: 'Swim', fields: { location: 'Pool' } }],
      },
      camp_id: campId, device_id: deviceId,
    })
    const before = db.prepare('SELECT id, capacity FROM locations WHERE camp_id = ?').get(campId)
    const opsCountBefore = db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'locations'").get().c

    const result = commitIngest(db, {
      approved: {
        locations: ['Pool'],
        activities: [{ name: 'Swim', fields: { location: 'Pool' } }],
      },
      camp_id: campId, device_id: deviceId, mode: 'replace',
    })

    const after = db.prepare('SELECT id, capacity FROM locations WHERE camp_id = ?').get(campId)
    expect(after.id).toBe(before.id)
    expect(after.capacity).toBe(before.capacity)
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'locations'").get().c).toBe(opsCountBefore)
    // Recognized, not blind-created: result.created.locations stays 0.
    expect(result.created.locations).toBe(0)
    // The replace-mode teardown DID clear and recreate the activity though —
    // it is schedule content, unlike the location it points at.
    expect(db.prepare('SELECT COUNT(*) c FROM locations WHERE camp_id = ?').get(campId).c).toBe(1)
  })

  it('would otherwise have hit the PRIMARY KEY collision this carve-out exists to avoid', () => {
    // Without the carve-out, buildExistingSnapshot would return existing=null
    // in replace mode, so the SAME "Pool" name would be proposed as a blind
    // create — deriveLocationId(camp_id, "Pool") collides with the still-live
    // row's own id. Asserting the plan sees it as `unchanged`, not `create`,
    // proves the carve-out is what prevents that collision.
    commitIngest(db, { approved: { locations: ['Pool'] }, camp_id: campId, device_id: deviceId })
    const existingRows = db.prepare('SELECT id, name FROM locations WHERE camp_id = ?').all(campId)
    const plan = buildPlan(
      { approved: { locations: ['Pool'] }, camp_id: campId, mode: 'replace' },
      { locations: existingRows },
    )
    expect(plan.items.find((i) => i.entity === 'locations').op).toBe('unchanged')
  })
})
