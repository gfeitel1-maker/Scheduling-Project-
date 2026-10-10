// @vitest-environment node
// Owner, 2026-10-10: the Activities "needs a look" dots must clear once the director has looked.
// The screen derives each field's tier from the latest op's source (main.js
// listImportEvidenceHandler -> lastKnownFieldSources): 'import' needs a look, null (a director's
// write) is confirmed. Confirm, "Looks right" and saving the activity all write with no source, so
// this pins that such a write clears the field, that it clears even when the value is unchanged,
// and that a later re-import raises it again (by design).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { lastKnownFieldSources } from './restore.js'

let db, file
beforeEach(() => {
  file = path.join(os.tmpdir(), `provenance-clears-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
  appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Archery', device_id: 'device-1' })
  appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'min_per_week', value: 2, device_id: 'device-1', source: 'import' })
})
afterEach(() => {
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.unlinkSync(file + s)
})

const source = () => lastKnownFieldSources(db, 'activities', 'act-1').get('min_per_week')

describe('a director write clears an imported field', () => {
  it('an imported field reads as import-sourced', () => {
    expect(source()).toBe('import')
  })

  it('writing the same value with no source (Confirm / Looks right / save unchanged) clears it', () => {
    appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'min_per_week', value: 2, device_id: 'device-1' })
    expect(source()).toBeNull()
  })

  it('a later re-import raises it again', () => {
    appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'min_per_week', value: 2, device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'min_per_week', value: 3, device_id: 'device-1', source: 'import' })
    expect(source()).toBe('import')
  })
})
