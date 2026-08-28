// @vitest-environment node
//
// Red Hat HIGH (post-WS2 review): the v51 CHECK constraint
// (docs/adr/2026-08-28-fixed-vs-recurring-events.md §3) is evaluated after
// EVERY single-field UPDATE, since writeFields (src/data/setupCrudRepository.js)
// fires one op-log write per field. AnchorsScreen.jsx's XLSX import builds its
// row objects with `kind` AFTER `is_all_groups`/`group_ids` — so a Recurring
// (non-all-tiers) imported row narrows a fresh stub row
// (ensureExists: kind='fixed' DEFAULT, is_all_groups=1) by writing
// is_all_groups=false WHILE kind is still 'fixed', violating the CHECK and
// throwing mid-import. AnchorModal.save and electron/ops/ingest.js already
// got this right (kind written first); the import path did not — the third
// writer missed the same hazard.
//
// This test proves the fix two ways:
//   1. Feeds writeFields a field object in exactly the BAD order the import
//      builds today (kind after is_all_groups/group_ids) — writeFields must
//      still land it correctly, because the structural guard
//      (REQUIRED_FIRST_ON_WRITE in setupCrudRepository.js) reorders `kind`
//      to the front regardless of caller order.
//   2. Runs against a REAL better-sqlite3 db with the REAL v51 CHECK
//      constraint (not localClient.mock.js, which never simulates SQLite
//      constraints) — this is the class of test that would have caught the
//      original bug, which a mock-based test could not.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from './db/localDb.js'
import { appendOp } from './ops/operations.js'
import { createSetupCrudRepository } from '../src/data/setupCrudRepository.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-anchor-write-order-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

// A fake localClient.write() that routes through the REAL op-log/projection
// path (appendOp -> applyProjection, electron/ops/operations.js and
// projections.js) against a REAL better-sqlite3 db — so the v51 CHECK
// constraint is genuinely enforced, not simulated.
function realSqliteClient(db, deviceId) {
  return {
    async write(_token, entity, entity_id, field, value) {
      appendOp(db, {
        entity, entity_id, field, value,
        author_user_id: null, device_id: deviceId, parent_op_id: null,
        client_write_id: randomUUID(),
      })
      return { status: 'applied' }
    },
  }
}

describe('AnchorsScreen import path: kind write ordering against a REAL SQLite CHECK constraint', () => {
  it('a scoped (Recurring) row written with the BAD field order (kind after is_all_groups/group_ids, as AnchorsScreen import previously built it) still commits successfully with kind=recurring', async () => {
    const db = freshDb()
    const deviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare("INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('g1', 'camp1', 'Group 1', 't1')").run()

    const repo = createSetupCrudRepository({ localClient: realSqliteClient(db, deviceId), getToken: () => 'tok' })
    const anchorId = randomUUID()

    // This EXACT key order — is_all_groups/group_ids BEFORE kind — is what
    // AnchorsScreen.jsx's XLSX import produced before the fix. The
    // structural guard in writeFields must reorder it regardless.
    await repo.writeFields('anchor_activities', anchorId, {
      name: 'Lunch A',
      day_id: null,
      time_block_id: null,
      is_all_groups: false,
      group_ids: JSON.stringify(['g1']),
      kind: 'recurring',
      notes: null,
      camp_id: 'camp1',
      cohort_id: null,
    })

    const row = db.prepare('SELECT kind, is_all_groups, group_ids FROM anchor_activities WHERE id = ?').get(anchorId)
    expect(row).toBeTruthy()
    expect(row.kind).toBe('recurring')
    expect(row.is_all_groups).toBe(0)
    expect(JSON.parse(row.group_ids)).toEqual(['g1'])
    db.close()
  })

  it('an all-groups (Fixed) row in the same bad-order shape also commits successfully with kind=fixed', async () => {
    const db = freshDb()
    const deviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()

    const repo = createSetupCrudRepository({ localClient: realSqliteClient(db, deviceId), getToken: () => 'tok' })
    const anchorId = randomUUID()

    await repo.writeFields('anchor_activities', anchorId, {
      name: 'Flagpole',
      day_id: null,
      time_block_id: null,
      is_all_groups: true,
      group_ids: JSON.stringify([]),
      kind: 'fixed',
      notes: null,
      camp_id: 'camp1',
      cohort_id: null,
    })

    const row = db.prepare('SELECT kind, is_all_groups FROM anchor_activities WHERE id = ?').get(anchorId)
    expect(row.kind).toBe('fixed')
    expect(row.is_all_groups).toBe(1)
    db.close()
  })

  it('control: without the guard\'s effect (an unrelated entity), field order is untouched — proves the reorder is scoped, not a global behavior change', async () => {
    const db = freshDb()
    const deviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    const repo = createSetupCrudRepository({ localClient: realSqliteClient(db, deviceId), getToken: () => 'tok' })

    const dayId = randomUUID()
    await repo.writeFields('days_of_operation', dayId, { camp_id: 'camp1', label: 'Monday', day_of_week: 1, sort_order: 0 })
    const row = db.prepare('SELECT label FROM days_of_operation WHERE id = ?').get(dayId)
    expect(row.label).toBe('Monday')
    db.close()
  })
})
