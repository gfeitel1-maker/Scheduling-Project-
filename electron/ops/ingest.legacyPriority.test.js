// C2b — listLegacyPriorityActivities, the impure assembly helper that finds
// activities whose CURRENT priority was last written with source='import'.
// docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md (C2b) +
// docs/adr/2026-08-10-legacy-import-priority-backfill.md (why auto-clear was
// rejected — this helper feeds the review-surfacing decision, never a clear).
//
// Reuses lastKnownFieldSources (electron/ops/restore.js) rather than building
// a parallel provenance system. Per S2a: a priority field whose last op has
// no recorded source maps to human-protected (deliberate over-protection) —
// so NULL/absent source must be EXCLUDED here, same as an explicit 'human'.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { listLegacyPriorityActivities } from './ingest.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-lp-${Date.now()}-${Math.random()}.sqlite`)
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

function insertActivity(id, name, priority) {
  db.prepare(
    'INSERT INTO activities (id, camp_id, name, priority) VALUES (?, ?, ?, ?)',
  ).run(id, campId, name, priority)
}

// Writes an operations row directly (bypassing appendOp's seq/id plumbing
// isn't needed — appendOp is the normal writer, but for this fixture we only
// need a row lastKnownFieldSources can read: entity/entity_id/field/source,
// ordered by seq).
function writeOp(entity_id, field, value, source) {
  db.prepare(
    `INSERT INTO operations (id, entity, entity_id, field, value, source, device_id, timestamp, client_write_id)
     VALUES (?, 'activities', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), entity_id, field, value, source, deviceId, new Date().toISOString(), randomUUID())
}

describe('listLegacyPriorityActivities', () => {
  it('includes an activity whose priority was last written with source=import', () => {
    insertActivity('act-import', 'Swimming', 1)
    writeOp('act-import', 'priority', 1, 'import')

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([{ entity_id: 'act-import', name: 'Swimming' }])
  })

  it('excludes an activity whose priority was last written with source=human', () => {
    insertActivity('act-human', 'Archery', 1)
    writeOp('act-human', 'priority', 1, 'human')

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([])
  })

  it('excludes an activity whose priority op has NULL/no recorded source', () => {
    insertActivity('act-null', 'Canoe', 1)
    writeOp('act-null', 'priority', 1, null)

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([])
  })

  it('excludes an activity with priority IS NULL (not a candidate at all)', () => {
    insertActivity('act-none', 'Kayak', null)

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([])
  })

  it('returns exactly the import-sourced non-null set across a mixed table', () => {
    insertActivity('act-import', 'Swimming', 1)
    writeOp('act-import', 'priority', 1, 'import')

    insertActivity('act-human', 'Archery', 1)
    writeOp('act-human', 'priority', 1, 'human')

    insertActivity('act-null', 'Canoe', 1)
    writeOp('act-null', 'priority', 1, null)

    insertActivity('act-none', 'Kayak', null)

    insertActivity('act-import-2', 'Sailing', 0)
    writeOp('act-import-2', 'priority', 0, 'import')

    const result = listLegacyPriorityActivities(db, campId)

    expect(result.sort((a, b) => a.entity_id.localeCompare(b.entity_id))).toEqual([
      { entity_id: 'act-import', name: 'Swimming' },
      { entity_id: 'act-import-2', name: 'Sailing' },
    ])
  })

  it('a later human write overrides an earlier import write — excluded (last-write-wins)', () => {
    insertActivity('act-1', 'Swimming', 1)
    writeOp('act-1', 'priority', 1, 'import')
    writeOp('act-1', 'priority', 1, 'human')

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([])
  })

  it('returns rows in a deterministic name-then-id order regardless of insertion order', () => {
    insertActivity('act-z', 'Zipline', 1)
    writeOp('act-z', 'priority', 1, 'import')

    insertActivity('act-a', 'Archery', 1)
    writeOp('act-a', 'priority', 1, 'import')

    const result = listLegacyPriorityActivities(db, campId)

    expect(result).toEqual([
      { entity_id: 'act-a', name: 'Archery' },
      { entity_id: 'act-z', name: 'Zipline' },
    ])
  })
})
