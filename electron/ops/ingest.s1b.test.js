// S1b — the confirmed-alias tier wired end to end through commitIngest, and
// the trash/restore alias lifecycle. docs/adr/2026-08-09-s1b-host-local-aliases.md
//
// buildPlan.aliasTier.test.js covers the pure tier logic directly; this file
// covers the host-local read (listAliasMap inside buildExistingSnapshot) and
// commitPlan's alias_divergence held-not-thrown handling, against a real db.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'
import { confirmAlias } from './confirmAlias.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-s1b-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function makeGroup(name) {
  const id = randomUUID()
  db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run(id, campId, name, 'all')
  return id
}

describe('S1b: confirmed_alias resolves through a real import', () => {
  it('a re-imported label with a confirmed alias and no exact-name match commits as unchanged (zero new rows)', () => {
    const groupId = makeGroup('Bunk One')
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId, confirmed_by: 'u1' })

    const result = commitIngest(db, {
      approved: { groups: ['Cabin 1'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })

    expect(result.held).toBe(false)
    expect(result.created.groups).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ?').get(campId).c).toBe(1)
  })

  it('a label with no alias and no exact match still creates normally (alias support does not change the baseline path)', () => {
    const result = commitIngest(db, {
      approved: { groups: ['Brand New Bunk'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })
    expect(result.held).toBe(false)
    expect(result.created.groups).toBe(1)
  })
})

describe('S1b: alias_divergence is held, never thrown', () => {
  it('holds the whole import when the alias points to A but a live different-entity exact-name match B exists', () => {
    const groupA = makeGroup('Original Name')
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupA, confirmed_by: 'u1' })
    // The world changed: a peer/human created a group whose live name now
    // EXACTLY matches the label the alias was confirmed for, but it's a
    // different row.
    makeGroup('Cabin 1')

    expect(() => commitIngest(db, {
      approved: { groups: ['Cabin 1'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })).not.toThrow()

    const result = commitIngest(db, {
      approved: { groups: ['Cabin 1'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })
    expect(result.held).toBe(true)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].reason).toBe('alias_divergence')
    // Held means nothing was written — no third group created.
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ?').get(campId).c).toBe(2)
  })
})

describe('S1b: trash/restore alias lifecycle', () => {
  it('an alias whose target is Trashed does not fire (falls through to create)', () => {
    const groupId = makeGroup('Bunk One')
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId, confirmed_by: 'u1' })

    // Trash the target: physically remove it from the projected table, the
    // same state a real delete op leaves it in.
    db.prepare('DELETE FROM groups WHERE id = ?').run(groupId)

    const result = commitIngest(db, {
      approved: { groups: ['Cabin 1'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })
    expect(result.held).toBe(false)
    // No live exact-name match and no live alias target -> a fresh create.
    expect(result.created.groups).toBe(1)
  })

  it('restoring the target makes the alias fire again with no re-confirmation', () => {
    const groupId = makeGroup('Bunk One')
    confirmAlias(db, { camp_id: campId, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId, confirmed_by: 'u1' })

    db.prepare('DELETE FROM groups WHERE id = ?').run(groupId)
    // Restore: re-insert the same live row (liveness is derived at read time,
    // never cached on the alias row).
    db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk One', 'all')

    const result = commitIngest(db, {
      approved: { groups: ['Cabin 1'] },
      camp_id: campId,
      author_user_id: 'u1',
      device_id: deviceId,
    })
    expect(result.held).toBe(false)
    expect(result.created.groups).toBe(0) // resolved via the alias again, not re-created
    expect(db.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ?').get(campId).c).toBe(1)
  })
})
