// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import {
  appendOp,
  appendBulkReplaceOp,
  applyBulkReplaceProjection,
  latestOp,
  detectConflict,
  detectUniqueFieldCollision,
  recordConflict,
  listPendingConflicts,
  DELETE_FIELD,
  MAX_FIELD_VALUE_LENGTH,
} from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ops-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('appendOp', () => {
  it('inserts an op and it is retrievable via latestOp', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: 'activity-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.id).toBeTruthy()
    expect(op.seq).toBeTruthy()
    expect(op.timestamp).toBeTruthy()

    const found = latestOp(db, 'template_slots', 'slot-1', 'activity_id')
    expect(found).toBeTruthy()
    expect(found.id).toBe(op.id)
    expect(found.seq).toBe(op.seq)
  })

  it('works when author_user_id is null (system-attributed op)', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-2',
      field: 'activity_id',
      value: 'activity-2',
      author_user_id: null,
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.author_user_id).toBeNull()
    const found = latestOp(db, 'template_slots', 'slot-2', 'activity_id')
    expect(found.id).toBe(op.id)
    expect(found.author_user_id).toBeNull()
  })
})

describe('appendOp projection', () => {
  it('updates the real users row when entity is users', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'name',
      value: 'Alicia',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alicia')
  })
})

// Regression suite for the caller/serialization boundary defect: appendOp
// binds `value` straight into the operations INSERT, so a plain JS object
// (ScheduleScreen's `flags`) was interpreted by better-sqlite3 as NAMED
// PARAMETERS ("Too few parameter values were provided") and a boolean
// (is_released / is_span_head) was rejected outright ("SQLite3 can only bind
// numbers, strings, bigints, buffers, and null"). Both threw BEFORE
// applyProjection ran, so the write never reached the row, the renderer's
// optimistic setSlots + undo-point push were skipped, and the user saw
// "Failed to place activity". Coercion lives in appendOp (not at the call
// sites, not in the renderer) so every current and future caller is covered.
describe('appendOp value coercion', () => {
  // Mirrors normalizeSlots() in src/screens/ScheduleScreen.jsx — the single
  // read boundary that turns the stored `flags` TEXT back into an object.
  // Duplicated here rather than imported so this node-environment test does
  // not pull in a JSX screen module.
  function normalizeFlags(storedValue) {
    if (typeof storedValue !== 'string') return storedValue || {}
    try {
      return storedValue ? JSON.parse(storedValue) : {}
    } catch {
      return {}
    }
  }

  function writeSlot(field, value) {
    return appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-coerce',
      field,
      value,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
  }

  function readSlot() {
    return db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-coerce')
  }

  beforeEach(() => {
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
      'tmpl-1',
      'camp-1',
      'Master Template'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(
      'act-bb',
      'camp-1',
      'Basketball'
    )
    // The row bulk_replace would already have created — every writeFields()
    // call in ScheduleScreen updates an existing generated slot.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, day_id, time_block_id) VALUES (?, ?, ?, ?)'
    ).run('slot-coerce', 'tmpl-1', 'day-1', 'block-1')
  })

  it('applies an object value (flags) as JSON instead of throwing "Too few parameter values were provided"', () => {
    // The exact two-field sequence placeActivityManual writes. Before the fix
    // activity_id landed and flags threw, leaving flags NULL and aborting the
    // caller mid-way.
    const errors = []
    for (const [field, value] of Object.entries({
      activity_id: 'act-bb',
      flags: { UNFILLABLE: true },
    })) {
      try {
        writeSlot(field, value)
      } catch (e) {
        errors.push(`${field}: ${e.message}`)
      }
    }

    expect(errors).toEqual([])
    const row = readSlot()
    expect(row.activity_id).toBe('act-bb')
    expect(row.flags).toBe('{"UNFILLABLE":true}')
  })

  it('applies boolean values as SQLite integers instead of throwing "SQLite3 can only bind..."', () => {
    const errors = []
    for (const [field, value] of Object.entries({ is_released: true, is_span_head: false })) {
      try {
        writeSlot(field, value)
      } catch (e) {
        errors.push(`${field}: ${e.message}`)
      }
    }

    expect(errors).toEqual([])
    const row = readSlot()
    expect(row.is_released).toBe(1)
    expect(row.is_span_head).toBe(0)
  })

  it('stores the coerced scalar in the op-log too, so a replaying peer applies the same value', () => {
    writeSlot('flags', { UNDERSERVED: true })
    writeSlot('is_span_head', false)
    writeSlot('is_released', true)

    expect(latestOp(db, 'template_slots', 'slot-coerce', 'flags').value).toBe('{"UNDERSERVED":true}')
    // '0'/'1', not 0/1: operations.value is a TEXT column and better-sqlite3
    // binds every JS number as a REAL, so the number 0 would be logged as
    // '0.0'. See coerceOpValue's comment in operations.js.
    expect(latestOp(db, 'template_slots', 'slot-coerce', 'is_span_head').value).toBe('0')
    expect(latestOp(db, 'template_slots', 'slot-coerce', 'is_released').value).toBe('1')
  })

  it('round-trips flags write -> read back to a usable object for the renderer', () => {
    const flags = { UNFILLABLE: true, expanded: { displacedActivityId: 'act-bb', from_block: 'block-2' } }
    writeSlot('flags', flags)

    expect(normalizeFlags(readSlot().flags)).toEqual(flags)

    // The empty-object case ScheduleScreen writes on every clear/swap.
    writeSlot('flags', {})
    expect(normalizeFlags(readSlot().flags)).toEqual({})
  })

  it('stores flags and boolean columns in the SAME shape bulk_replace does', () => {
    // bulk_replace rows must be string-or-null (validateBulkReplaceRows), so
    // placeAnchors/generate build '1'/'0' strings and JSON.stringify'd flags.
    // The INTEGER column affinity on is_anchor/is_span_head/is_released means
    // those strings land as integers — identical to coercing booleans to 1/0.
    appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'tmpl-1',
      rows: [
        {
          id: 'slot-bulk',
          template_id: 'tmpl-1',
          day_id: 'day-1',
          time_block_id: 'block-1',
          is_anchor: '0',
          is_span_head: '1',
          flags: JSON.stringify({ UNFILLABLE: true }),
        },
      ],
      author_user_id: 'user-1',
      device_id: 'device-1',
    })

    // bulk_replace deleted every row in the template scope, so recreate the
    // field-level target and write the equivalent values through appendOp.
    db.prepare(
      'INSERT INTO template_slots (id, template_id, day_id, time_block_id) VALUES (?, ?, ?, ?)'
    ).run('slot-coerce', 'tmpl-1', 'day-1', 'block-1')
    writeSlot('is_anchor', false)
    writeSlot('is_span_head', true)
    writeSlot('flags', { UNFILLABLE: true })

    const types = (id) =>
      db
        .prepare(
          'SELECT typeof(is_anchor) AS is_anchor, typeof(is_span_head) AS is_span_head, typeof(flags) AS flags FROM template_slots WHERE id = ?'
        )
        .get(id)

    const bulkRow = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-bulk')
    const opRow = readSlot()

    expect(types('slot-coerce')).toEqual(types('slot-bulk'))
    expect(opRow.is_anchor).toBe(bulkRow.is_anchor)
    expect(opRow.is_span_head).toBe(bulkRow.is_span_head)
    expect(opRow.flags).toBe(bulkRow.flags)
  })

  it('stores an array value as JSON (same rule as an object)', () => {
    appendOp(db, {
      entity: 'activities',
      entity_id: 'act-bb',
      field: 'eligible_tier_ids',
      value: ['tier-1', 'tier-2'],
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT eligible_tier_ids FROM activities WHERE id = ?').get('act-bb')
    expect(row.eligible_tier_ids).toBe('["tier-1","tier-2"]')
    expect(JSON.parse(row.eligible_tier_ids)).toEqual(['tier-1', 'tier-2'])
  })

  it('leaves null, strings and numbers untouched', () => {
    writeSlot('flags', null)
    expect(readSlot().flags).toBeNull()

    writeSlot('activity_id', 'act-bb')
    expect(readSlot().activity_id).toBe('act-bb')

    writeSlot('is_span_head', 1)
    expect(readSlot().is_span_head).toBe(1)

    writeSlot('activity_id', null)
    expect(readSlot().activity_id).toBeNull()
  })
})

describe('appendOp field allowlist + transaction', () => {
  it('throws for a field not in the allowlist and does not insert an operations row', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    expect(() =>
      appendOp(db, {
        entity: 'users',
        entity_id: 'user-1',
        field: 'not_a_real_field',
        value: 'x',
        author_user_id: 'user-1',
        device_id: 'device-1',
        parent_op_id: null,
      })
    ).toThrow()

    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBe(before)

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alice')
  })

  it('creates a brand-new users row via ensureExists when appending the first op for that entity_id', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'brand-new-user',
      field: 'name',
      value: 'Fresh',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('brand-new-user')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Fresh')
    expect(row.role).toBe('staff')
  })

  it('records the op but does not apply a camp_id write that does not match this device\'s camp (Red Hat round 1: same non-throwing contract as applyProjection, since appendOp is also used by the Host to apply a remote Client\'s submitted op — see operations.js)', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    const op = appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'camp_id',
      value: 'some-other-camp',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op).toBeTruthy()
    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBe(before + 1)

    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('user-1')
    expect(row.camp_id).toBe('camp-1')
  })

  it('applies normally when a local camp_id write matches this device\'s own camp', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'camp_id',
      value: 'camp-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('user-1')
    expect(row.camp_id).toBe('camp-1')
  })
})

// M6 (D2, docs/adr/2026-08-16-locations-optional-map.md): the size guard on
// operations.value. `appendOp` is the single choke point both the local
// write() path and the Host's handleSubmitOp (a remote Client's WS
// submission) go through — this is the AUTHORITATIVE gate, not a convenience
// check, so the fail-first evidence here matters more than the happy path:
// the write must be rejected BEFORE any row is written, on both paths.
describe('appendOp size guard (MAX_FIELD_VALUE_LENGTH, D2)', () => {
  it('registers exactly the one entity/field this codebase needs it for', () => {
    expect(MAX_FIELD_VALUE_LENGTH).toEqual({ camp_maps: { image_data: 1_400_000 } })
  })

  it('rejects an oversized camp_maps.image_data write and inserts NO operations row (fail-first, before the transaction opens)', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    const oversized = 'a'.repeat(MAX_FIELD_VALUE_LENGTH.camp_maps.image_data + 1)

    expect(() =>
      appendOp(db, {
        entity: 'camp_maps',
        entity_id: 'camp-1',
        field: 'image_data',
        value: oversized,
        author_user_id: 'user-1',
        device_id: 'device-1',
        parent_op_id: null,
      })
    ).toThrow(/exceeds MAX_FIELD_VALUE_LENGTH/)

    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBe(before)
    // No camp_maps row was ever created via ensureExists either — the throw
    // happens before appendOp's transaction (which runs ensureExists) opens.
    expect(db.prepare('SELECT COUNT(*) c FROM camp_maps WHERE id = ?').get('camp-1').c).toBe(0)
  })

  it('accepts a camp_maps.image_data write exactly at the limit', () => {
    const atLimit = 'a'.repeat(MAX_FIELD_VALUE_LENGTH.camp_maps.image_data)
    const op = appendOp(db, {
      entity: 'camp_maps',
      entity_id: 'camp-1',
      field: 'image_data',
      value: atLimit,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(op).toBeTruthy()
    const row = db.prepare('SELECT image_data FROM camp_maps WHERE id = ?').get('camp-1')
    expect(row.image_data).toBe(atLimit)
  })

  it('accepts a small camp_maps.image_data write (happy path, well under the cap)', () => {
    const op = appendOp(db, {
      entity: 'camp_maps',
      entity_id: 'camp-1',
      field: 'image_data',
      value: 'small-base64-stub',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(op).toBeTruthy()
    const row = db.prepare('SELECT image_data FROM camp_maps WHERE id = ?').get('camp-1')
    expect(row.image_data).toBe('small-base64-stub')
  })

  it('does not cap an unregistered entity/field — the guard is scoped, not generic', () => {
    // A long users.name is unusual but not the concern this guard exists for
    // (every other field is small by construction, per D2's rationale) — it
    // must not be silently capped by a blanket rule.
    const longName = 'x'.repeat(2_000_000)
    const op = appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'name',
      value: longName,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(op).toBeTruthy()
    expect(db.prepare('SELECT name FROM users WHERE id = ?').get('user-1').name).toBe(longName)
  })

  it('is enforced on the Host handleSubmitOp path exactly like the local write() path — both call the same appendOp choke point', () => {
    // syncServer.js's handleSubmitOp calls appendOp(db, incomingOp) directly
    // with no additional size check of its own (electron/sync/syncServer.js
    // ~:624) — confirmed by reading the source, asserted here as a structural
    // fact so a future refactor that adds a SEPARATE, divergent check on that
    // path (rather than relying on the shared appendOp gate) fails loudly.
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'sync', 'syncServer.js'), 'utf8')
    expect(src).toMatch(/const op = appendOp\(db, incomingOp\)/)
  })
})

describe('appendOp DELETE_FIELD sentinel', () => {
  it('is accepted (not rejected by the fields allowlist) for a registered projection entity, and applies as a real row delete', () => {
    // Uses this device's real camp ('camp-1', inserted in beforeEach) rather
    // than a second fabricated camps row — since the camp_id projection
    // guard (see projections.js) now rejects any camp_id write that doesn't
    // match this device's own single camp row, and a rejected write no
    // longer creates the row via ensureExists at all (see the guard's
    // ordering ahead of ensureExists), which is unrelated to what this test
    // is actually checking (DELETE_FIELD sentinel behavior).
    appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-to-delete',
      field: 'camp_id',
      value: 'camp-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-to-delete')).toBeTruthy()

    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    const op = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-to-delete',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    expect(op.field).toBe('__deleted__')
    expect(after).toBe(before + 1)
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-to-delete')).toBeUndefined()
  })
})

describe('latestOp', () => {
  it('orders by seq, not timestamp, returning the most recently appended op', () => {
    const op1 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const op2 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: op1.id,
    })

    const found = latestOp(db, 'template_slots', 'slot-3', 'activity_id')
    expect(found.id).toBe(op2.id)
    expect(found.seq).toBeGreaterThan(op1.seq)
  })

  it('returns undefined when there is no op for the entity/entity_id/field', () => {
    const found = latestOp(db, 'template_slots', 'nonexistent-slot', 'activity_id')
    expect(found).toBeUndefined()
  })
})

describe('detectConflict', () => {
  it('reports no conflict when incoming op parent_op_id matches the current latest op id', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v2',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(false)
  })

  it('reports a conflict when two ops diverge from the same parent', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const appliedOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v3',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(appliedOp.id)
  })
})

// D2 (docs/adr/2026-08-15-locations-concurrent-create-collision.md): the
// app-level UNIQUE(camp_id, name) collision check detectConflict cannot
// express, because it spans two DIFFERENT entity_ids rather than one.
describe('detectUniqueFieldCollision (D2 — locations UNIQUE(camp_id, name))', () => {
  it('reports no collision when the incoming name differs from every existing location', () => {
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-pool',
      field: 'name',
      value: 'Pool',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const result = detectUniqueFieldCollision(db, {
      entity: 'locations',
      entity_id: 'loc-gym',
      field: 'name',
      value: 'Gym',
    })
    expect(result).toBeNull()
  })

  it('detects a collision against a DIFFERENT entity_id already holding that name (the concurrent-create race)', () => {
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-pool',
      field: 'name',
      value: 'Pool',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    // A second device concurrently creating a location named "Pool" mints a
    // DIFFERENT entity_id for the same name — this is the exact race D1
    // rejects rather than silently orphaning or merging.
    const result = detectUniqueFieldCollision(db, {
      entity: 'locations',
      entity_id: 'loc-pool-2',
      field: 'name',
      value: 'Pool',
    })
    expect(result).toBeTruthy()
    expect(result.id).toBe('loc-pool')
    expect(result.name).toBe('Pool')
  })

  it('does NOT flag a no-op rewrite of a row to its own current name (id != ? exclusion)', () => {
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-pool',
      field: 'name',
      value: 'Pool',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const result = detectUniqueFieldCollision(db, {
      entity: 'locations',
      entity_id: 'loc-pool',
      field: 'name',
      value: 'Pool',
    })
    expect(result).toBeNull()
  })

  it('rejects a RENAME of an existing row into another existing row\'s name (rename-into-collision, not just create)', () => {
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-a',
      field: 'name',
      value: 'Pool',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-b',
      field: 'name',
      value: 'Gym',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    // Director renames "Gym" (loc-b) to "Pool" — loc-a's existing name.
    const result = detectUniqueFieldCollision(db, {
      entity: 'locations',
      entity_id: 'loc-b',
      field: 'name',
      value: 'Pool',
    })
    expect(result).toBeTruthy()
    expect(result.id).toBe('loc-a')
  })

  it('detects a collision for events UNIQUE(camp_id, name) — same cross-device same-named-create race', () => {
    appendOp(db, {
      entity: 'events',
      entity_id: 'event-a',
      field: 'name',
      value: 'Color War',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const result = detectUniqueFieldCollision(db, {
      entity: 'events',
      entity_id: 'event-b',
      field: 'name',
      value: 'Color War',
    })
    expect(result).toBeTruthy()
    expect(result.id).toBe('event-a')
  })

  it('detects a collision for activities UNIQUE(camp_id, name) — the two-rows-split prerequisite race', () => {
    appendOp(db, {
      entity: 'activities',
      entity_id: 'activity-a',
      field: 'name',
      value: 'Swim',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    // A second device concurrently creating an activity named "Swim" (e.g.
    // via import, manual add, or an electives create-new) mints a DIFFERENT
    // entity_id for the same name — same race class as locations/events.
    const result = detectUniqueFieldCollision(db, {
      entity: 'activities',
      entity_id: 'activity-b',
      field: 'name',
      value: 'Swim',
    })
    expect(result).toBeTruthy()
    expect(result.id).toBe('activity-a')
  })

  it('is a no-op for an entity not registered in UNIQUE_FIELD_ENTITIES', () => {
    const result = detectUniqueFieldCollision(db, {
      entity: 'groups',
      entity_id: 'group-1',
      field: 'name',
      value: 'Anything',
    })
    expect(result).toBeNull()
  })

  it('is a no-op for a field other than the registered unique field', () => {
    appendOp(db, {
      entity: 'locations',
      entity_id: 'loc-pool',
      field: 'name',
      value: 'Pool',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const result = detectUniqueFieldCollision(db, {
      entity: 'locations',
      entity_id: 'loc-pool-2',
      field: 'capacity',
      value: '4',
    })
    expect(result).toBeNull()
  })

  it('is a no-op for a null/empty value', () => {
    expect(
      detectUniqueFieldCollision(db, { entity: 'locations', entity_id: 'loc-x', field: 'name', value: null })
    ).toBeNull()
    expect(
      detectUniqueFieldCollision(db, { entity: 'locations', entity_id: 'loc-x', field: 'name', value: '' })
    ).toBeNull()
  })
})

describe('detectConflict: DELETE_FIELD vs. concurrent field-edit (Round 2 Security MEDIUM #2)', () => {
  it('reports a conflict when an incoming delete races a concurrent field-edit op it never observed', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    const createOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: 'camp_id',
      value: 'camp-2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    // A concurrent field edit lands after the delete's snapshot (createOp).
    const editOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: 'name',
      value: 'Renamed',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingDelete = {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: DELETE_FIELD,
      value: 1,
      parent_op_id: createOp.id, // stale — never saw editOp
    }

    const result = detectConflict(db, incomingDelete)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(editOp.id)
  })

  it('reports a conflict when an incoming field-edit races a concurrent delete it never observed', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-3', 'Camp Three')
    const createOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: 'camp_id',
      value: 'camp-3',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const deleteOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingEdit = {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: 'name',
      value: 'Should not resurrect the row',
      parent_op_id: createOp.id, // stale — never saw deleteOp
    }

    const result = detectConflict(db, incomingEdit)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(deleteOp.id)
  })

  it('does not conflict when the field-edit correctly cites the delete as its parent (deliberate resurrect/recreate)', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-4', 'Camp Four')
    const deleteOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-3',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingEdit = {
      entity: 'cohorts',
      entity_id: 'cohort-race-3',
      field: 'name',
      value: 'Recreated',
      parent_op_id: deleteOp.id,
    }

    const result = detectConflict(db, incomingEdit)
    expect(result.conflict).toBe(false)
  })
})

describe('recordConflict + listPendingConflicts (Task 10 round 3, Fix 3: conflict rehydration)', () => {
  it('(a) a conflict that arose before "restart" and was never resolved IS present in the rehydrated list', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })
    const incomingOp = {
      id: 'incoming-op-id',
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v3',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: parentOp.id,
    }

    recordConflict(db, { incomingOp, existingOp })

    // Simulate a restart: a fresh call against the same db, no in-memory
    // broadcast state at all — this is exactly what usePendingConflicts'
    // mount-time fetch relies on.
    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].type).toBe('op_conflict')
    expect(pending[0].existingOp.id).toBe(existingOp.id)
    expect(pending[0].incomingOp.id).toBe('incoming-op-id')
  })

  it('(b) a conflict that was fully resolved before "restart" is NOT present in the rehydrated list', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })
    const incomingOp = {
      id: 'incoming-op-id-2',
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v3',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: parentOp.id,
    }

    recordConflict(db, { incomingOp, existingOp })

    // Resolve exactly like main.js's resolveConflict() does: a new op whose
    // parent_op_id is the existingOp's id, regardless of which side was kept.
    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v3-kept',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: existingOp.id,
    })

    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(0)
  })

  it('lazily marks a now-resolved row resolved_at so repeated calls stay cheap', () => {
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const incomingOp = {
      id: 'incoming-op-id-3',
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v2',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: null,
    }
    const conflictId = recordConflict(db, { incomingOp, existingOp })

    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v2-kept',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: existingOp.id,
    })

    listPendingConflicts(db)
    const row = db.prepare('SELECT resolved_at FROM conflicts WHERE id = ?').get(conflictId)
    expect(row.resolved_at).toBeTruthy()
  })

  it('multiple distinct unresolved conflicts on different keys are all returned', () => {
    const existingOpA = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-13',
      field: 'activity_id',
      value: 'a1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOpB = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-14',
      field: 'activity_id',
      value: 'b1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    recordConflict(db, {
      incomingOp: { id: 'ia', entity: 'template_slots', entity_id: 'slot-13', field: 'activity_id', value: 'a2', device_id: 'device-2', timestamp: new Date().toISOString(), parent_op_id: null },
      existingOp: existingOpA,
    })
    recordConflict(db, {
      incomingOp: { id: 'ib', entity: 'template_slots', entity_id: 'slot-14', field: 'activity_id', value: 'b2', device_id: 'device-2', timestamp: new Date().toISOString(), parent_op_id: null },
      existingOp: existingOpB,
    })

    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(2)
  })
})

// T111 — bulkReplace sanitizer coverage.
// docs/work/specs/2026-08-20-elective-cell-atomic-content-design.md
//
// bulkReplace never goes through applyProjection/the per-field eviction
// step, so it is a second, independent write path for template_slots that
// needs its own guard against a both-non-null row (e.g. a stale
// pre-fix-shipped snapshot, or a future row-construction bug on the
// generation/snapshot path).
describe('bulkReplace mutual-exclusion sanitizer (T111)', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
      'tmpl-1',
      'camp-1',
      'Week 1'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('act-1', 'camp-1', 'Swim')
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(
      'set-1',
      'camp-1',
      'Afternoon Chugim'
    )
  })

  // 3a: the write-side sanitizer must clean BOTH the inserted row AND the
  // serialized operations.value JSON — sanitizing only inside the insert
  // loop would leave the persisted/broadcast payload carrying the raw
  // both-non-null row even though the materialized row is clean. This is
  // the test that would fail under a "sanitize inside the loop only" fix.
  it('3a: appendBulkReplaceOp sanitizes both the inserted row and the serialized op-log payload', () => {
    const op = appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'tmpl-1',
      rows: [
        {
          id: 'slot-both',
          template_id: 'tmpl-1',
          day_id: 'day-1',
          time_block_id: 'block-1',
          activity_id: 'act-1',
          elective_set_id: 'set-1',
        },
      ],
      author_user_id: 'user-1',
      device_id: 'device-1',
    })

    const insertedRow = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-both')
    expect(insertedRow.activity_id).toBe('act-1')
    expect(insertedRow.elective_set_id).toBeNull()

    const persistedRows = JSON.parse(op.value)
    expect(persistedRows).toHaveLength(1)
    expect(persistedRows[0].activity_id).toBe('act-1')
    expect(persistedRows[0].elective_set_id).toBeNull()
  })

  // 3b: the replay-side sanitizer is a real backstop, not merely relying on
  // every writer being patched — simulate a raw op.value JSON string
  // (as a pre-fix snapshot's stored payload would look) that itself
  // contains a both-non-null row.
  it('3b: applyBulkReplaceProjection sanitizes a both-non-null row from raw, unsanitized op.value JSON', () => {
    const malformedValue = JSON.stringify([
      {
        id: 'slot-replay',
        template_id: 'tmpl-1',
        day_id: 'day-1',
        time_block_id: 'block-1',
        activity_id: 'act-1',
        elective_set_id: 'set-1',
      },
    ])

    applyBulkReplaceProjection(db, {
      entity: 'template_slots',
      entity_id: 'tmpl-1',
      value: malformedValue,
    })

    const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-replay')
    expect(row.activity_id).toBe('act-1')
    expect(row.elective_set_id).toBeNull()
  })

})
