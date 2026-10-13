// @vitest-environment node
//
// The file is a trust boundary (ADR section 5): one test per rejection reason, plus the hostile shapes the ADR
// names (prototype pollution, cap + 1 byte, dangling reference, a users entity, a newer schema, a count mismatch).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { setUserDataDirGetter, resetForTests } from '../../sync/automerge/liveDoc.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { MAX_BULK_REPLACE_ROWS } from '../campScopedEntities.js'
import { exportCampFile, serializeCampFile } from './exportCampFile.js'
import { validateCampFile, REJECTION_REASONS } from './validateCampFile.js'
import { CAMP_FILE_CAPS } from './campFileScope.js'
import { makeFreshCamp, buildFixtureCamp } from './campFileTestSupport.js'

let base
let baseText
let dir

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-campfile-validate-'))
  setUserDataDirGetter(() => dir)
  const { db } = openTemplatedDb()
  const camp = makeFreshCamp(db, { name: 'Camp Validate' })
  buildFixtureCamp(db, camp)
  base = exportCampFile(db, camp.campId)
  baseText = serializeCampFile(base)
  db.close()
})
afterAll(() => {
  resetForTests()
  cleanupTemplatedDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

const clone = () => JSON.parse(baseText)
// Rebuild the counts after a deliberate row change, so a test trips ONLY the check it is about.
function recount(file) {
  for (const e of Object.keys(file.entities)) file.counts[e] = file.entities[e].length
  return file
}
const check = (mutate, options) => {
  const file = clone()
  const out = mutate(file) ?? file
  return validateCampFile(JSON.stringify(out), options)
}
const rejected = (result, reason) => {
  expect(result.ok).toBe(false)
  expect(result.reason).toBe(reason)
  expect(REJECTION_REASONS).toContain(result.reason)
  expect(typeof result.detail).toBe('object')
  return result.detail
}

describe('a good file', () => {
  it('validates, and hands back the parsed file unchanged', () => {
    const result = validateCampFile(baseText)
    expect(result.ok).toBe(true)
    expect(result.file).toEqual(base)
  })

  it('accepts bytes, a Uint8Array and a leading byte-order mark', () => {
    expect(validateCampFile(Buffer.from(baseText, 'utf8')).ok).toBe(true)
    expect(validateCampFile(new Uint8Array(Buffer.from(baseText, 'utf8'))).ok).toBe(true)
    expect(validateCampFile(String.fromCharCode(0xfeff) + baseText).ok).toBe(true)
  })

  it('accepts an older schema version when every field still maps', () => {
    expect(check((f) => { f.schemaVersion = 1 }).ok).toBe(true)
  })

  it('accepts a camp with no rows at all', () => {
    const empty = clone()
    for (const e of Object.keys(empty.entities)) empty.entities[e] = []
    for (const t of Object.keys(empty.learned.tables)) empty.learned.tables[t] = []
    for (const t of Object.keys(empty.learned.counts)) empty.learned.counts[t] = 0
    expect(validateCampFile(JSON.stringify(recount(empty))).ok).toBe(true)
  })
})

describe('not_a_camp_file', () => {
  it('rejects text that is not JSON', () => {
    rejected(validateCampFile('this is not json'), 'not_a_camp_file')
    rejected(validateCampFile(''), 'not_a_camp_file')
  })
  it('rejects bytes that are not UTF-8', () => {
    rejected(validateCampFile(new Uint8Array([0xff, 0xfe, 0xfd, 0x7b])), 'not_a_camp_file')
  })
  it('rejects JSON that is not an object, or that has another format name', () => {
    rejected(validateCampFile('[1,2,3]'), 'not_a_camp_file')
    rejected(validateCampFile('null'), 'not_a_camp_file')
    rejected(check((f) => { f.format = 'something-else' }), 'not_a_camp_file')
    rejected(check((f) => { delete f.format }), 'not_a_camp_file')
  })
  it('rejects an unsupported older file version', () => {
    rejected(check((f) => { f.version = 0 }), 'not_a_camp_file')
  })
})

describe('too_large', () => {
  it('rejects cap + 1 byte on the byte length, before any JSON.parse', () => {
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const detail = rejected(validateCampFile(Buffer.alloc(CAMP_FILE_CAPS.MAX_FILE_BYTES + 1, 0x20)), 'too_large')
      expect(detail.bytes).toBe(CAMP_FILE_CAPS.MAX_FILE_BYTES + 1)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
  it('accepts exactly the cap on size alone (the rejection then comes from the content, not the size)', () => {
    const result = validateCampFile(Buffer.alloc(CAMP_FILE_CAPS.MAX_FILE_BYTES, 0x20))
    expect(result.reason).toBe('not_a_camp_file')
  })
  it('rejects more rows than the per-entity cap, naming the entity', () => {
    const detail = rejected(check(() => {}, { caps: { MAX_ROWS_PER_ENTITY: 1 } }), 'too_large')
    expect(detail.entity).toBeTruthy()
  })
  it('rejects more rows than the total cap', () => {
    const detail = rejected(check(() => {}, { caps: { MAX_ROWS_TOTAL: 10 } }), 'too_large')
    expect(detail.count).toBeGreaterThan(10)
  })
  it('rejects more slots in one template than a bulk replace can carry', () => {
    const file = clone()
    const tpl = file.entities.template_slots[0].template_id
    const proto = file.entities.template_slots[0]
    file.entities.template_slots = Array.from({ length: MAX_BULK_REPLACE_ROWS + 1 }, (_, i) => ({ ...proto, id: `slot-${i}` }))
    const detail = rejected(validateCampFile(JSON.stringify(recount(file))), 'too_large')
    expect(detail).toMatchObject({ entity: 'template_slots' })
    expect(tpl).toBeTruthy()
  })
})

describe('newer_version', () => {
  it('rejects a file version above the one this app reads', () => {
    rejected(check((f) => { f.version = 2 }), 'newer_version')
  })
  it('rejects a schemaVersion newer than the running app', () => {
    const detail = rejected(check((f) => { f.schemaVersion = CURRENT_SCHEMA_VERSION + 1 }), 'newer_version')
    expect(detail.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1)
  })
})

describe('unknown_entity', () => {
  it.each(['users', 'tombstones', 'camp_authority_log', 'device_roster', 'conflicts', 'campers', 'camper_identity_keys', 'elective_assignment_runs', 'elective_assignments', 'camps', 'operations'])(
    'rejects a file carrying a %s entity outright',
    (name) => {
      const detail = rejected(check((f) => { f.entities[name] = [{ id: 'u1', name: 'Mallory', role: 'admin' }]; f.counts[name] = 1 }), 'unknown_entity')
      expect(detail.entity).toBe(name)
    }
  )
  it('rejects a learned table that is not one of the seven', () => {
    const detail = rejected(check((f) => { f.learned.tables.users = []; f.learned.counts.users = 0 }), 'unknown_entity')
    expect(detail.entity).toBe('users')
  })
})

describe('unknown_field', () => {
  it('rejects a row field outside the entity projection, and does not ignore it', () => {
    const detail = rejected(check((f) => { f.entities.groups[0].pin_hash = 'x' }), 'unknown_field')
    expect(detail).toMatchObject({ entity: 'groups', field: 'pin_hash' })
  })
  it('rejects camp_id on a row: the loader supplies the camp, the file never names one', () => {
    rejected(check((f) => { f.entities.groups[0].camp_id = 'someone-elses-camp' }), 'unknown_field')
  })
  it('rejects a stamped user column on a remembered answer', () => {
    rejected(check((f) => { f.entities.camp_seedlings[0].confirmed_by = 'u1' }), 'unknown_field')
  })
  it('rejects an extra column in a learned row, including camp_id and the stamped user columns', () => {
    rejected(check((f) => { f.learned.tables.source_aliases[0].camp_id = 'x' }), 'unknown_field')
    rejected(check((f) => { f.learned.tables.source_aliases[0].confirmed_by = 'x' }), 'unknown_field')
  })
  it('rejects an unknown envelope key, and an unknown key inside camp', () => {
    rejected(check((f) => { f.secrets = {} }), 'unknown_field')
    rejected(check((f) => { f.camp.signing_secret = 'x' }), 'unknown_field')
  })
  it('rejects a __proto__ key anywhere, and does not pollute Object.prototype', () => {
    const text = baseText.replace('"entities":{', '"entities":{"__proto__":{"polluted":true},')
    const detail = rejected(validateCampFile(text), 'unknown_field')
    expect(detail.field).toBe('__proto__')
    expect({}.polluted).toBeUndefined()
    expect(Object.prototype.polluted).toBeUndefined()
  })
  it('rejects a __proto__ or constructor key inside a row, and inside a JSON text field', () => {
    const inRow = baseText.replace('"name":"Bunk 1"', '"name":"Bunk 1","__proto__":{"isAdmin":true}')
    expect(inRow).not.toBe(baseText)
    rejected(validateCampFile(inRow), 'unknown_field')
    rejected(check((f) => { f.entities.groups[0].constructor = { prototype: { x: 1 } } }), 'unknown_field')
    rejected(check((f) => { f.entities.camp_seedlings[0].payload = '{"__proto__":{"x":1}}' }), 'unknown_field')
    rejected(check((f) => { f.entities.schedule_snapshots[0].slots = '[{"constructor":{"x":1}}]' }), 'unknown_field')
    expect({}.x).toBeUndefined()
  })
})

describe('bad_type', () => {
  it('rejects a string where an integer belongs, and an integer where text belongs', () => {
    const d1 = rejected(check((f) => { f.entities.locations[0].capacity = 'many' }), 'bad_type')
    expect(d1).toMatchObject({ entity: 'locations', field: 'capacity' })
    rejected(check((f) => { f.entities.locations[0].capacity = 1.5 }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].name = 12 }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].name = { first: 'x' } }), 'bad_type')
  })
  it('rejects a missing or non-string id', () => {
    rejected(check((f) => { delete f.entities.groups[0].id }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].id = 7 }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].id = '' }), 'bad_type')
  })
  it('rejects an id with control characters, one that is too long, and the prototype names', () => {
    rejected(check((f) => { f.entities.groups[0].id = 'a\nb' }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].id = 'x'.repeat(CAMP_FILE_CAPS.MAX_ID_LENGTH + 1) }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].id = '__proto__' }), 'bad_type')
    rejected(check((f) => { f.entities.groups[0].id = 'constructor' }), 'bad_type')
  })
  it('rejects a missing required field, and text over its length cap', () => {
    const detail = rejected(check((f) => { delete f.entities.groups[0].name }), 'bad_type')
    expect(detail).toMatchObject({ entity: 'groups', field: 'name' })
    rejected(check((f) => { f.entities.groups[0].name = null }), 'bad_type')
    rejected(check((f) => { f.entities.activities[0].notes = 'x'.repeat(CAMP_FILE_CAPS.MAX_TEXT_LENGTH + 1) }), 'bad_type')
    rejected(check((f) => { f.entities.camp_maps[0].image_data = 'x'.repeat(1_400_001) }), 'bad_type')
  })
  it('rejects a duplicate id inside one entity', () => {
    const detail = rejected(check((f) => { f.entities.groups.push({ ...f.entities.groups[0] }) ; recount(f) }), 'bad_type')
    expect(detail).toMatchObject({ entity: 'groups', problem: 'duplicate_id' })
  })
  it('rejects two days on one weekday, and two cohorts with one name (the keys opening a file adopts rows by)', () => {
    rejected(check((f) => { f.entities.days_of_operation[1].day_of_week = f.entities.days_of_operation[0].day_of_week }), 'bad_type')
    rejected(check((f) => { f.entities.cohorts.push({ ...f.entities.cohorts[0], id: 'another-cohort' }); recount(f) }), 'bad_type')
  })
  it('rejects JSON text fields that are not the JSON they must be', () => {
    rejected(check((f) => { f.entities.camp_seedlings[0].payload = 'not json' }), 'bad_type')
    rejected(check((f) => { f.entities.camp_seedlings[0].payload = '[1]' }), 'bad_type')
    rejected(check((f) => { f.entities.schedule_snapshots[0].slots = '{"a":1}' }), 'bad_type')
    rejected(check((f) => { f.entities.schedule_snapshots[0].slots = '[1,2]' }), 'bad_type')
    rejected(check((f) => { f.entities.activities[0].eligible_group_ids = '{"a":1}' }), 'bad_type')
    rejected(check((f) => { f.entities.activities[0].eligible_group_ids = '[1,2]' }), 'bad_type')
  })
  it('rejects a camp with no usable name', () => {
    rejected(check((f) => { f.camp = {} }), 'bad_type')
    rejected(check((f) => { f.camp.name = 5 }), 'bad_type')
    rejected(check((f) => { delete f.camp }), 'bad_type')
  })
  it('rejects exportedAt or schemaVersion of the wrong type', () => {
    rejected(check((f) => { f.exportedAt = 5 }), 'bad_type')
    rejected(check((f) => { f.schemaVersion = '98' }), 'bad_type')
    rejected(check((f) => { f.entities.groups = 'nope' }), 'bad_type')
  })
})

describe('dangling_reference', () => {
  it('rejects a reference to an id not in the file, naming the entity and field', () => {
    const detail = rejected(check((f) => { f.entities.groups[0].tier_id = 'tier-that-is-not-here' }), 'dangling_reference')
    expect(detail).toMatchObject({ entity: 'groups', field: 'tier_id' })
  })
  it('rejects a dangling required reference, in a child row', () => {
    const detail = rejected(check((f) => { f.entities.special_day_slots[0].group_id = 'nope' }), 'dangling_reference')
    expect(detail).toMatchObject({ entity: 'special_day_slots', field: 'group_id' })
    rejected(check((f) => { f.entities.template_slots[0].template_id = 'nope' }), 'dangling_reference')
    rejected(check((f) => { f.entities.week_activity_exclusions[0].activity_id = 'nope' }), 'dangling_reference')
  })
  it('rejects a dangling id inside a JSON list of ids', () => {
    const detail = rejected(check((f) => { f.entities.activities.find((a) => a.eligible_group_ids).eligible_group_ids = '["nope"]' }), 'dangling_reference')
    expect(detail.field).toBe('eligible_group_ids')
    rejected(check((f) => { f.entities.fixed_events.find((e) => e.unit_ids && e.unit_ids !== '[]').unit_ids = '["nope"]' }), 'dangling_reference')
  })
  it('rejects a reference that points at an id of the wrong entity', () => {
    rejected(check((f) => { f.entities.groups[0].tier_id = f.entities.groups[1].id }), 'dangling_reference')
  })
  it('treats the learned tables references as soft: a stale id is kept, not rejected', () => {
    expect(check((f) => { f.learned.tables.source_aliases[0].entity_id = 'a-row-deleted-long-ago' }).ok).toBe(true)
  })
})

describe('count_mismatch', () => {
  it('rejects counts that do not match the rows', () => {
    const detail = rejected(check((f) => { f.counts.groups += 1 }), 'count_mismatch')
    expect(detail.entity).toBe('groups')
  })
  it('rejects a truncated file: rows missing against the recorded counts', () => {
    rejected(check((f) => { f.entities.activities.pop() }), 'count_mismatch')
  })
  it('rejects a missing counts object, and counts for an entity that is not present', () => {
    rejected(check((f) => { delete f.counts }), 'count_mismatch')
    rejected(check((f) => { f.counts.events_extra = 1 }), 'count_mismatch')
  })
  it('rejects mismatched learned counts', () => {
    const detail = rejected(check((f) => { f.learned.counts.source_aliases += 1 }), 'count_mismatch')
    expect(detail.entity).toBe('source_aliases')
  })
})

describe('the reasons the loader owns', () => {
  it('lists the fixed reason codes, camp_not_empty and load_incomplete included', () => {
    expect([...REJECTION_REASONS].sort()).toEqual([
      'camp_not_empty', 'count_mismatch', 'dangling_reference', 'load_incomplete', 'newer_version', 'not_a_camp_file',
      'too_large', 'unknown_entity', 'unknown_field',
    ].concat(['bad_type']).sort())
  })
})
