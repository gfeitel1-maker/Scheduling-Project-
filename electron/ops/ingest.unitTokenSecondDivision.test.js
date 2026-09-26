// T257 — the director picks the SECOND of two same-named divisions via the
// discriminated `_link_unit` token, and division evidence must still be
// written for it. This is finding 3 from the ticket: writeDivisionEvidence's
// 3rd arg (`writtenDivision`) is compared BY NAME against `support.division`
// — passing the token/id there instead of the resolved display name would
// silently stop evidence from ever being written, with no error anywhere.
// A test that only plants the dropdown-collapse defect (buildPlan/fieldUpdate
// tests) proves nothing about THIS failure mode, which is why it gets its
// own commit-level test.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp } from './operations.js'
import { commitPlan } from './ingest.js'

afterAll(() => {
  cleanupTemplatedDbs()
})
let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function seedTier(id, name) {
  appendOp(db, { entity: 'tiers', entity_id: id, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
  appendOp(db, { entity: 'tiers', entity_id: id, field: 'name', value: name, device_id: deviceId, source: 'import' })
}

const plan = (items) => ({
  plan_version: 1, camp_id: campId, cohort_id: null, base_generation: 0,
  sources: [{ source: 'import', family: 'schedule' }], mode: 'add', fixedEvents: [],
  unresolved: [], items: Array.isArray(items) ? items : [items],
})

const evidenceRow = (entityId) => db.prepare(
  "SELECT * FROM import_evidence WHERE entity_type = 'groups' AND entity_id = ? AND field = 'tier_id'"
).get(entityId)

describe('T257 finding 3 — division evidence survives an existing-tier TOKEN pick, including the second same-named tier', () => {
  it('picking the LOWER-id same-named tier by token still resolves and writes evidence', () => {
    const lowId = randomUUID()
    const highId = randomUUID()
    seedTier(lowId < highId ? lowId : highId, 'Bunk B') // seed order irrelevant to this test
    seedTier(lowId < highId ? highId : lowId, 'Bunk B')

    const res = commitPlan(db, plan(
      { op: 'create', entity: 'groups', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Chagalls', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Chagalls',
        _link_unit: { kind: 'existing', id: lowId, name: 'Bunk B' },
        _division_support: { division: 'Bunk B', basis: 'stem', members: ['Chagalls'] },
        _humanFields: ['tier_id'] },
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    const row = db.prepare('SELECT id, tier_id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Chagalls')
    expect(row.tier_id).toBe(lowId)
    const evidence = evidenceRow(row.id)
    expect(evidence).toBeTruthy()
    expect(JSON.parse(evidence.support).division).toBe('Bunk B')
  })

  it('picking the HIGHER-id same-named tier by token resolves to THAT id (not the lowest-id winner) AND still writes evidence', () => {
    const lowId = [randomUUID(), randomUUID()].sort()[0]
    const highId = [randomUUID(), randomUUID()].sort()[1]
    // Seed the low id FIRST so a name-only lookup (tierIdByName's
    // first-write-wins, T252) would resolve to it — the token must override
    // that by carrying the high id directly.
    seedTier(lowId, 'Bunk B')
    seedTier(highId, 'Bunk B')

    const res = commitPlan(db, plan(
      { op: 'create', entity: 'groups', entity_id: null,
        fields: { camp_id: { from: null, to: campId, source: 'import' }, name: { from: null, to: 'Chagalls', source: 'import' } },
        evidence: { tier: 'new' }, _name: 'Chagalls',
        _link_unit: { kind: 'existing', id: highId, name: 'Bunk B' },
        _division_support: { division: 'Bunk B', basis: 'stem', members: ['Chagalls'] },
        _humanFields: ['tier_id'] },
    ), { author_user_id: 'u1', device_id: deviceId })

    expect(res.held).toBe(false)
    const row = db.prepare('SELECT id, tier_id FROM groups WHERE camp_id = ? AND name = ?').get(campId, 'Chagalls')
    // The defect this ticket closes: reachable as the HIGH id, not silently
    // folded onto the low one a name lookup would have found instead.
    expect(row.tier_id).toBe(highId)
    expect(row.tier_id).not.toBe(lowId)
    const evidence = evidenceRow(row.id)
    expect(evidence).toBeTruthy()
    expect(JSON.parse(evidence.support).division).toBe('Bunk B')
  })
})
