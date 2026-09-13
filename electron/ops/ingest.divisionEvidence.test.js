import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'

// T114 follow-up — a division assignment must be auditable.
//
// Co-schedule rules record why they concluded what they did; divisions did not.
// A director shown "Kittah 1/2" and "Kittah 3/4" as two separate divisions had
// no way to find out whether that came from the names, from the grid, or from
// nowhere at all. The claim is evidenced per GROUP (field `tier_id`), because
// the question actually asked is "why is this bunk in this division?"

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-divev-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db?.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const group = (name) => db.prepare('SELECT * FROM groups WHERE camp_id = ? AND name = ?').get(campId, name)
const evidenceFor = (groupName) => {
  const g = group(groupName)
  const row = db.prepare(
    'SELECT * FROM import_evidence WHERE camp_id = ? AND entity_type = ? AND entity_id = ? AND field = ?'
  ).get(campId, 'groups', g.id, 'tier_id')
  return row ? { ...row, support: JSON.parse(row.support) } : null
}

const SUPPORT = {
  'Tzofim 1': {
    division: 'Tzofim', basis: 'name_stem', members: ['Tzofim 1', 'Tzofim 2'],
    stem: 'Tzofim', qualifier_stripped: false, anchors_excluded: ['Lunch'],
  },
  'Tzofim 2': {
    division: 'Tzofim', basis: 'name_stem', members: ['Tzofim 1', 'Tzofim 2'],
    stem: 'Tzofim', qualifier_stripped: false, anchors_excluded: ['Lunch'],
  },
}

const commit = (extra = {}) => commitIngest(db, {
  approved: { tiers: ['Tzofim'], groups: ['Tzofim 1', 'Tzofim 2'] },
  links: { groups: { 'Tzofim 1': 'Tzofim', 'Tzofim 2': 'Tzofim' } },
  divisionSupport: SUPPORT,
  camp_id: campId,
  device_id: deviceId,
  ...extra,
})

describe('division evidence', () => {
  it('writes evidence for each group placed into an inferred division', () => {
    commit()
    const e = evidenceFor('Tzofim 1')
    expect(e).toBeTruthy()
    expect(e.support.division).toBe('Tzofim')
    expect(e.support.basis).toBe('name_stem')
    expect(e.support.stem).toBe('Tzofim')
  })

  it('is tagged INFERRED — a division read off group names is never a sighting', () => {
    commit()
    expect(evidenceFor('Tzofim 1').tag).toBe('inferred')
  })

  it('carries the anchors that were excluded, which decide what the grid could show', () => {
    commit()
    expect(evidenceFor('Tzofim 1').support.anchors_excluded).toEqual(['Lunch'])
  })

  it('records a split so the director can see the names were overruled', () => {
    commitIngest(db, {
      approved: { tiers: ['Kittah 1'], groups: ['Kittah 1', 'Kittah 3'] },
      links: { groups: { 'Kittah 1': 'Kittah 1' } },
      divisionSupport: {
        'Kittah 1': {
          division: 'Kittah 1', basis: 'split_by_co_occurrence', names_proposed: 'Kittah',
          members: ['Kittah 1', 'Kittah 2'], stem: 'Kittah', qualifier_stripped: false, anchors_excluded: [],
        },
      },
      camp_id: campId, device_id: deviceId,
    })
    const e = evidenceFor('Kittah 1')
    expect(e.support.basis).toBe('split_by_co_occurrence')
    expect(e.support.names_proposed).toBe('Kittah')
  })

  it('writes NO evidence for a group whose division the file stated outright', () => {
    // A stated fact is not an inference and must not be dressed as one.
    commitIngest(db, {
      approved: { tiers: ['Tzofim'], groups: ['Tzofim 1'] },
      links: { groups: { 'Tzofim 1': 'Tzofim' } },
      camp_id: campId, device_id: deviceId,
    })
    expect(evidenceFor('Tzofim 1')).toBeNull()
  })

  it('writes no evidence when the unit never resolved to a real division', () => {
    // Evidence explaining a tier_id that was never written would describe
    // something the director cannot see.
    commitIngest(db, {
      approved: { groups: ['Tzofim 1'] },
      links: { groups: { 'Tzofim 1': 'Nonexistent Division' } },
      divisionSupport: SUPPORT,
      camp_id: campId, device_id: deviceId,
    })
    expect(group('Tzofim 1').tier_id).toBeNull()
    expect(evidenceFor('Tzofim 1')).toBeNull()
  })

  it('is latest-wins on re-import', () => {
    commit()
    commitIngest(db, {
      approved: { tiers: ['Tzofim'], groups: ['Tzofim 1', 'Tzofim 2'] },
      links: { groups: { 'Tzofim 1': 'Tzofim', 'Tzofim 2': 'Tzofim' } },
      divisionSupport: {
        ...SUPPORT,
        'Tzofim 1': { ...SUPPORT['Tzofim 1'], anchors_excluded: ['Lunch', 'Carpool'] },
      },
      camp_id: campId, device_id: deviceId,
    })
    const rows = db.prepare(
      'SELECT * FROM import_evidence WHERE camp_id = ? AND entity_type = ? AND field = ?'
    ).all(campId, 'groups', 'tier_id')
    expect(rows).toHaveLength(2)
    expect(evidenceFor('Tzofim 1').support.anchors_excluded).toEqual(['Lunch', 'Carpool'])
  })
})
