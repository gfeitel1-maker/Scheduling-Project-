// Open a saved camp, step 1: the file is a trust boundary (docs/adr/2026-10-13-whole-camp-file-save-and-open.md
// section 5, org-interface-contracts). It arrives from disk, possibly from someone else, and nothing in it is trusted:
// no write happens until every check here has passed, and the checks never evaluate anything.
//
// Returns { ok: true, file } or { ok: false, reason, detail } with `reason` from the fixed list below and `detail`
// naming at most an entity, a field, a count or an index. Never a path, never a value out of the file.
//
// The size cap is checked on the BYTE LENGTH before any decode or JSON.parse. A `__proto__`, `constructor` or
// `prototype` key anywhere (including inside the JSON text fields) rejects the file. Ids are only ever bound
// parameters or Map keys downstream, never paths or object keys; control characters are rejected and nothing else is,
// because a location id legitimately embeds the director's own name for the place (`location:<camp>:<name>`).

import { PROJECTIONS } from '../projections.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { MAX_BULK_REPLACE_ROWS } from '../campScopedEntities.js'
import { MAX_FIELD_VALUE_LENGTH } from '../fieldLengthCap.js'
import {
  CAMP_FILE_CAPS,
  CAMP_FILE_FORMAT,
  CAMP_FILE_VERSION,
  EXPORTED_ENTITIES,
  LEARNED_TABLES,
  LEARNED_REQUIRED,
  INTEGER_FIELDS,
  MIXED_INTEGER_FIELDS,
  REQUIRED_FIELDS,
  REFERENCE_FIELDS,
  REFERENCE_LIST_FIELDS,
  fileFieldsOf,
} from './campFileScope.js'

export const REJECTION_REASONS = Object.freeze([
  'not_a_camp_file',
  'too_large',
  'newer_version',
  'unknown_entity',
  'unknown_field',
  'bad_type',
  'dangling_reference',
  'count_mismatch',
  'camp_not_empty',
  'load_incomplete',
])

const reject = (reason, detail = {}) => ({ ok: false, reason, detail })

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function hasControlCharacter(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isValidId = (v, caps) => typeof v === 'string' && v.length >= 1 && v.length <= caps.MAX_ID_LENGTH && !hasControlCharacter(v) && !FORBIDDEN_KEYS.has(v)

const TOP_LEVEL_KEYS = new Set(['format', 'version', 'exportedAt', 'appVersion', 'schemaVersion', 'camp', 'entities', 'counts', 'learned'])

function findForbiddenKey(root) {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const item of node) if (item !== null && typeof item === 'object') stack.push(item)
    } else {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(key)) return key
        const v = node[key]
        if (v !== null && typeof v === 'object') stack.push(v)
      }
    }
  }
  return null
}

// A JSON text field: parse it and apply the same forbidden-key walk. Returns { value } or { error: 'bad_type'|'unknown_field' }.
function parseJsonText(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { error: 'bad_type' }
  }
  if (value !== null && typeof value === 'object' && findForbiddenKey(value) !== null) return { error: 'unknown_field' }
  return { value }
}

function entitySpec(entity) {
  const fields = fileFieldsOf(entity)
  const maxLen = {}
  for (const f of fields) maxLen[f] = MAX_FIELD_VALUE_LENGTH[entity]?.[f] ?? null
  return {
    allowed: new Set(['id', ...fields]),
    fields,
    ints: new Set(INTEGER_FIELDS[entity] ?? []),
    mixed: new Set(MIXED_INTEGER_FIELDS[entity] ?? []),
    required: REQUIRED_FIELDS[entity] ?? [],
    refs: Object.entries(REFERENCE_FIELDS[entity] ?? {}),
    lists: Object.entries(REFERENCE_LIST_FIELDS[entity] ?? {}),
    maxLen,
  }
}
const SPECS = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, entitySpec(e)]))

function decode(input) {
  if (typeof input === 'string') return input
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return null
  }
}

export function validateCampFile(input, { caps: capOverrides } = {}) {
  const caps = { ...CAMP_FILE_CAPS, ...capOverrides }
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input?.byteLength
  if (!Number.isFinite(bytes)) return reject('not_a_camp_file')
  if (bytes > caps.MAX_FILE_BYTES) return reject('too_large', { bytes })

  let text = decode(input)
  if (text === null) return reject('not_a_camp_file')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return reject('not_a_camp_file')
  }
  return validateParsedCampFile(parsed, { caps: capOverrides })
}

// The structural half, for a caller that already holds the parsed object (the loader re-checks what it is handed).
export function validateParsedCampFile(file, { caps: capOverrides } = {}) {
  const caps = { ...CAMP_FILE_CAPS, ...capOverrides }
  if (!isPlainObject(file)) return reject('not_a_camp_file')

  const forbidden = findForbiddenKey(file)
  if (forbidden !== null) return reject('unknown_field', { field: forbidden })

  if (file.format !== CAMP_FILE_FORMAT) return reject('not_a_camp_file')
  if (!Number.isSafeInteger(file.version)) return reject('not_a_camp_file')
  if (file.version > CAMP_FILE_VERSION) return reject('newer_version', { version: file.version })
  if (file.version !== CAMP_FILE_VERSION) return reject('not_a_camp_file')
  if (!Number.isSafeInteger(file.schemaVersion) || file.schemaVersion < 1) return reject('bad_type', { field: 'schemaVersion' })
  if (file.schemaVersion > CURRENT_SCHEMA_VERSION) return reject('newer_version', { schemaVersion: file.schemaVersion })

  for (const key of Object.keys(file)) if (!TOP_LEVEL_KEYS.has(key)) return reject('unknown_field', { field: key })
  if (typeof file.exportedAt !== 'string' || file.exportedAt.length > 64) return reject('bad_type', { field: 'exportedAt' })
  if (file.appVersion !== undefined && file.appVersion !== null && (typeof file.appVersion !== 'string' || file.appVersion.length > 64)) {
    return reject('bad_type', { field: 'appVersion' })
  }

  if (!isPlainObject(file.camp)) return reject('bad_type', { field: 'camp' })
  for (const key of Object.keys(file.camp)) if (key !== 'name') return reject('unknown_field', { entity: 'camp', field: key })
  if (typeof file.camp.name !== 'string' || file.camp.name.length > caps.MAX_CAMP_NAME_LENGTH) return reject('bad_type', { entity: 'camp', field: 'name' })

  if (!isPlainObject(file.entities)) return reject('bad_type', { field: 'entities' })
  let total = 0
  for (const [entity, rows] of Object.entries(file.entities)) {
    if (!(entity in SPECS)) return reject('unknown_entity', { entity })
    if (!Array.isArray(rows)) return reject('bad_type', { entity })
    if (rows.length > caps.MAX_ROWS_PER_ENTITY) return reject('too_large', { entity, count: rows.length })
    total += rows.length
  }
  const learnedTables = file.learned?.tables
  if (!isPlainObject(file.learned)) return reject('bad_type', { field: 'learned' })
  for (const key of Object.keys(file.learned)) if (key !== 'tables' && key !== 'counts') return reject('unknown_field', { entity: 'learned', field: key })
  if (!isPlainObject(learnedTables)) return reject('bad_type', { entity: 'learned', field: 'tables' })
  for (const [table, rows] of Object.entries(learnedTables)) {
    if (!(table in LEARNED_TABLES)) return reject('unknown_entity', { entity: table })
    if (!Array.isArray(rows)) return reject('bad_type', { entity: table })
    if (rows.length > caps.MAX_ROWS_PER_ENTITY) return reject('too_large', { entity: table, count: rows.length })
    total += rows.length
  }
  if (total > caps.MAX_ROWS_TOTAL) return reject('too_large', { count: total })

  const idSets = {}
  for (const entity of EXPORTED_ENTITIES) {
    const spec = SPECS[entity]
    const rows = file.entities[entity] ?? []
    const seen = new Set()
    const perTemplate = entity === 'template_slots' ? new Map() : null
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!isPlainObject(row)) return reject('bad_type', { entity, index })
      for (const key of Object.keys(row)) if (!spec.allowed.has(key)) return reject('unknown_field', { entity, field: key })
      if (!isValidId(row.id, caps)) return reject('bad_type', { entity, field: 'id', index })
      if (seen.has(row.id)) return reject('bad_type', { entity, problem: 'duplicate_id', index })
      seen.add(row.id)
      for (const f of spec.required) {
        if (row[f] === undefined || row[f] === null) return reject('bad_type', { entity, field: f, index })
      }
      for (const f of spec.fields) {
        const v = row[f]
        if (v === undefined || v === null) continue
        if (spec.ints.has(f) && !(spec.mixed.has(f) && typeof v === 'string' && v.length <= 64)) {
          if (!Number.isSafeInteger(v)) return reject('bad_type', { entity, field: f, index })
        } else {
          if (typeof v !== 'string') return reject('bad_type', { entity, field: f, index })
          const max = spec.maxLen[f] ?? (entity === 'schedule_snapshots' && f === 'slots' ? caps.MAX_SNAPSHOT_SLOTS_LENGTH : caps.MAX_TEXT_LENGTH)
          if (v.length > max) return reject('bad_type', { entity, field: f, index, problem: 'too_long' })
        }
      }
      if (entity === 'schedule_snapshots' && row.slots != null) {
        const slots = parseJsonText(row.slots)
        if (slots.error) return reject(slots.error, { entity, field: 'slots', index })
        if (!Array.isArray(slots.value) || slots.value.length > caps.MAX_SNAPSHOT_SLOTS || !slots.value.every(isPlainObject)) {
          return reject('bad_type', { entity, field: 'slots', index })
        }
      }
      if (entity === 'camp_seedlings') {
        const payload = parseJsonText(row.payload)
        if (payload.error) return reject(payload.error, { entity, field: 'payload', index })
        if (!isPlainObject(payload.value)) return reject('bad_type', { entity, field: 'payload', index })
      }
      for (const [f] of spec.lists) {
        if (row[f] == null) continue
        const list = parseJsonText(row[f])
        if (list.error) return reject(list.error, { entity, field: f, index })
        if (!Array.isArray(list.value) || !list.value.every((x) => typeof x === 'string')) return reject('bad_type', { entity, field: f, index })
      }
      if (perTemplate) {
        const n = (perTemplate.get(row.template_id) ?? 0) + 1
        if (n > MAX_BULK_REPLACE_ROWS) return reject('too_large', { entity, field: 'template_id', count: n })
        perTemplate.set(row.template_id, n)
      }
    }
    idSets[entity] = seen
  }

  // The natural keys opening a file adopts a fresh camp's own rows by: unique in the file or the adoption is ambiguous.
  for (const [entity, key] of [['days_of_operation', 'day_of_week'], ['cohorts', 'name']]) {
    const seen = new Set()
    for (const row of file.entities[entity] ?? []) {
      const k = row[key]
      if (k == null) continue
      if (seen.has(k)) return reject('bad_type', { entity, field: key, problem: 'duplicate_key' })
      seen.add(k)
    }
  }

  if (!isPlainObject(file.counts)) return reject('count_mismatch', {})
  for (const key of Object.keys(file.counts)) {
    if (!(key in SPECS)) return reject('count_mismatch', { entity: key })
  }
  for (const entity of EXPORTED_ENTITIES) {
    const expected = file.counts[entity]
    const actual = (file.entities[entity] ?? []).length
    if (expected !== actual) return reject('count_mismatch', { entity, count: actual })
  }

  for (const entity of EXPORTED_ENTITIES) {
    const spec = SPECS[entity]
    for (const row of file.entities[entity] ?? []) {
      for (const [f, target] of spec.refs) {
        const v = row[f]
        if (v === undefined || v === null) continue
        if (typeof v !== 'string' || !idSets[target].has(v)) return reject('dangling_reference', { entity, field: f })
      }
      for (const [f, target] of spec.lists) {
        if (row[f] == null) continue
        for (const id of JSON.parse(row[f])) if (!idSets[target].has(id)) return reject('dangling_reference', { entity, field: f })
      }
    }
  }

  const learnedCounts = file.learned.counts
  if (!isPlainObject(learnedCounts)) return reject('count_mismatch', { entity: 'learned' })
  for (const key of Object.keys(learnedCounts)) if (!(key in LEARNED_TABLES)) return reject('count_mismatch', { entity: key })
  for (const [table, spec] of Object.entries(LEARNED_TABLES)) {
    const rows = learnedTables[table] ?? []
    const allowed = new Set(spec.columns)
    const seen = new Set()
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!isPlainObject(row)) return reject('bad_type', { entity: table, index })
      for (const key of Object.keys(row)) if (!allowed.has(key)) return reject('unknown_field', { entity: table, field: key })
      if (!isValidId(row.id, caps)) return reject('bad_type', { entity: table, field: 'id', index })
      if (seen.has(row.id)) return reject('bad_type', { entity: table, problem: 'duplicate_id', index })
      seen.add(row.id)
      for (const f of LEARNED_REQUIRED[table] ?? []) if (row[f] === undefined || row[f] === null) return reject('bad_type', { entity: table, field: f, index })
      for (const f of spec.columns) {
        const v = row[f]
        if (v === undefined || v === null) continue
        if (typeof v !== 'string' || v.length > caps.MAX_TEXT_LENGTH) return reject('bad_type', { entity: table, field: f, index })
      }
    }
    if ((learnedCounts[table] ?? 0) !== rows.length) return reject('count_mismatch', { entity: table, count: rows.length })
  }

  return { ok: true, file }
}
