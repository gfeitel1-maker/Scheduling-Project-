// Save whole camp, main-process half (docs/adr/2026-10-13-whole-camp-file-save-and-open.md section 1/4/5).
// Pure data out: this reads SQLite and returns the envelope. The caller serializes it and writes the file
// (temp file then rename is the IPC layer's job, phase 2).
//
// WHAT LEAVES: only the fields campFileScope.js names, read through an explicit allowlist, never "all columns". A
// new secret column cannot ride out by accident; the guard test fails on a field this list does not account for.
//
// WHAT IS REPAIRED ON THE WAY OUT: a soft reference whose target is not in the camp (a deleted row nothing cascaded
// onto) would make the file fail its own closed-reference check on the way back in, which is the worst moment to find
// out. So a dangling nullable reference is written as null, a dangling id in a JSON list is dropped, and a row whose
// required reference dangles is left out (and anything that depended on it, to a fixed point). Nothing is silent:
// the counts go to `options.report` for the caller to surface.

import { PROJECTIONS } from '../projections.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import {
  CAMP_FILE_FORMAT,
  CAMP_FILE_VERSION,
  EXPORTED_ENTITIES,
  LEARNED_TABLES,
  INTEGER_FIELDS,
  MIXED_INTEGER_FIELDS,
  REFERENCE_FIELDS,
  REFERENCE_LIST_FIELDS,
  REQUIRED_FIELDS,
  fileFieldsOf,
} from './campFileScope.js'

export function serializeCampFile(file) {
  return JSON.stringify(file)
}

function normalizeScalar(entity, field, value, report) {
  if (value === null || value === undefined) return null
  if ((INTEGER_FIELDS[entity] ?? []).includes(field)) {
    if (Number.isSafeInteger(value)) return value
    if (typeof value === 'string' && (MIXED_INTEGER_FIELDS[entity] ?? []).includes(field)) return value
    report.coercedValues += 1
    return null
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  report.coercedValues += 1
  return null
}

function readEntityRows(db, entity, report) {
  const { table, key } = PROJECTIONS[entity]
  const fields = fileFieldsOf(entity)
  const select = db.prepare(`SELECT ${key}, ${fields.join(', ')} FROM ${table} ORDER BY ${key}`)
  return select.all().map((raw) => {
    const row = { id: raw[key] }
    for (const f of fields) row[f] = normalizeScalar(entity, f, raw[f], report)
    return row
  })
}

function parseIdList(text) {
  if (typeof text !== 'string') return null
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null
  } catch {
    return null
  }
}

// Mutates `entities` to a fixed point where every reference resolves inside it.
function closeReferences(entities, report) {
  const idSets = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, new Set(entities[e].map((r) => r.id))]))
  let changed = true
  while (changed) {
    changed = false
    for (const entity of EXPORTED_ENTITIES) {
      const refs = REFERENCE_FIELDS[entity] ?? {}
      const lists = REFERENCE_LIST_FIELDS[entity] ?? {}
      const required = new Set(REQUIRED_FIELDS[entity] ?? [])
      const kept = []
      for (const row of entities[entity]) {
        let drop = false
        for (const [field, target] of Object.entries(refs)) {
          const v = row[field]
          if (v === null) continue
          if (typeof v === 'string' && v !== '' && idSets[target].has(v)) continue
          if (required.has(field)) { drop = true; break }
          row[field] = null
          report.nulledReferences += 1
        }
        if (drop) {
          idSets[entity].delete(row.id)
          report.droppedRows += 1
          changed = true
          continue
        }
        for (const [field, target] of Object.entries(lists)) {
          if (row[field] === null) continue
          const ids = parseIdList(row[field])
          if (ids === null) {
            row[field] = null
            report.nulledReferences += 1
            continue
          }
          const live = ids.filter((id) => idSets[target].has(id))
          if (live.length !== ids.length) report.nulledReferences += ids.length - live.length
          row[field] = JSON.stringify(live)
        }
        kept.push(row)
      }
      entities[entity] = kept
    }
  }
}

function readLearned(db, campId) {
  const tables = {}
  const counts = {}
  for (const [table, spec] of Object.entries(LEARNED_TABLES)) {
    const rows = db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${table} WHERE camp_id = ? ORDER BY id`).all(campId)
    tables[table] = rows.map((raw) => Object.fromEntries(spec.columns.map((c) => [c, raw[c] === undefined || raw[c] === null ? null : String(raw[c])])))
    counts[table] = tables[table].length
  }
  return { tables, counts }
}

export function exportCampFile(db, campId, { appVersion = null, now = () => new Date().toISOString(), report = {} } = {}) {
  const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
  if (!camp || camp.id !== campId) throw new Error('exportCampFile: campId does not match the camp on this device')
  Object.assign(report, { nulledReferences: 0, droppedRows: 0, coercedValues: 0 })

  const entities = {}
  for (const entity of EXPORTED_ENTITIES) entities[entity] = readEntityRows(db, entity, report)
  closeReferences(entities, report)

  const counts = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, entities[e].length]))
  return {
    format: CAMP_FILE_FORMAT,
    version: CAMP_FILE_VERSION,
    exportedAt: now(),
    appVersion,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    camp: { name: camp.name },
    entities,
    counts,
    learned: readLearned(db, campId),
  }
}
