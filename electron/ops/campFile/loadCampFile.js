// Open a saved camp, main-process half (docs/adr/2026-10-13-whole-camp-file-save-and-open.md sections 2 and 3).
// Replays a validated file into a camp that was just bootstrapped and is still empty, through the same write
// primitives a human edit uses (appendOp, appendBulkReplaceOp), so the Automerge document and SQLite agree by
// construction. Nothing from the file touches identity or authority: the camp, its keys, its admin and its device
// are the ones bootstrapCamp already made.
//
// ORDER OF WORK
//   1. validate (again: this function trusts nothing it was handed), check the camp is fresh, plan every id.
//   2. set the "load incomplete" marker. It lives OUTSIDE the transaction below, so a rollback cannot erase it.
//   3. one runAtomic boundary: SQLite transaction + deferred document writes. Any throw rolls SQLite back and the
//      document is never written. The marker stays set and the result is { ok:false, reason:'load_incomplete' }.
//   4. audit event, clear the marker.
//
// IDS. Random UUIDs are kept verbatim. An id that embeds the camp id (directly, or through a parent id) is
// re-derived for the new camp by DECODING it (never a substring replace of the camp id: the elective ids are
// length-prefixed). The old-to-new map is built for every entity in apply order before anything is written; a fresh
// camp's own rows (weekday rows by day of week, the Main cohort by its derived id, a default week and its template pair) are ADOPTED
// instead of duplicated. Every reference field, every id inside a JSON list, the ids inside saved versions and the
// ids inside remembered answers go through the same map.
//
// WHERE THIS DEVIATES FROM THE ADR (see the report): the file carries neither camp_id nor user ids, so the old camp id
// is recovered by decoding the ids themselves; remembered answers are stamped with the opening director; saved-version
// slots naming rows that were already gone in the saved camp are kept as they were, because restore re-binds or skips
// them by name and the file is a faithful copy of the camp, not a cleaned one.

import { createHash } from 'node:crypto'
import {
  appendOp as realAppendOp,
  appendBulkReplaceOp as realAppendBulkReplaceOp,
  runAtomic,
  DELETE_FIELD,
  UNIQUE_FIELD_ENTITIES,
  detectUniqueFieldCollision,
} from '../operations.js'
import { unsharedWriteCount } from '../documentWriteFailures.js'
import { recordAuditEvent } from '../../audit/auditLog.js'
import { PROJECTIONS } from '../projections.js'
import {
  EXPORTED_ENTITIES,
  LEARNED_TABLES,
  LOADER_SUPPLIED_FIELDS,
  STAMPED_FIELDS,
  REFERENCE_FIELDS,
  REFERENCE_LIST_FIELDS,
  fileFieldsOf,
} from './campFileScope.js'
import { validateParsedCampFile } from './validateCampFile.js'

const MARKER_ENTITY = 'camp_file_load'
const MARKER_FIELD = 'incomplete'

// Rows a freshly bootstrapped camp may already own, per exported entity. Everything else must be empty.
const FRESH_CAMP_ALLOWANCE = { days_of_operation: Infinity, cohorts: 1, schedule_weeks: 1, schedule_templates: 2 }
// Entities whose rows are not in the file but whose presence means the camp is not empty.
const PERSONAL_DATA_TABLES = ['campers', 'camper_identity_keys', 'elective_assignment_runs']
const HARD_UNIQUE_ENTITIES = new Set(['locations', 'elective_sets', 'events', 'activities', 'days_of_operation'])
// A composed id may embed any changed id except these: a location's name or a remembered answer's key can contain
// anything, so scanning for ids inside them would be unsafe, and no composed id embeds either.
const NOT_EMBEDDED_IN_COMPOSED_IDS = new Set(['locations', 'camp_seedlings'])

export function readLoadIncomplete(db) {
  const row = db.prepare('SELECT entity_id AS loadId, acquired_at AS since FROM locks WHERE entity = ? AND field = ? LIMIT 1').get(MARKER_ENTITY, MARKER_FIELD)
  return row ?? null
}

export function setMarker(db, loadId, deviceId) {
  db.prepare('DELETE FROM locks WHERE entity = ?').run(MARKER_ENTITY)
  db.prepare('INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at) VALUES (?, ?, ?, ?, ?)')
    .run(MARKER_ENTITY, loadId, MARKER_FIELD, deviceId, new Date().toISOString())
}

export function clearMarker(db) {
  db.prepare('DELETE FROM locks WHERE entity = ?').run(MARKER_ENTITY)
}

const reject = (reason, detail = {}) => ({ ok: false, reason, detail })

// ---- id derivation -------------------------------------------------------------------------------------------------

function decodeJoin(s) {
  const comps = []
  let i = 0
  while (i < s.length) {
    const dot = s.indexOf('.', i)
    if (dot < 0) return null
    const lenText = s.slice(i, dot)
    if (!/^\d+$/.test(lenText)) return null
    const start = dot + 1
    const end = start + Number(lenText)
    if (end > s.length) return null
    comps.push(s.slice(start, end))
    i = end
  }
  return comps
}
const encodeJoin = (comps) => comps.map((c) => `${c.length}.${c}`).join('')

const CAMP_FIRST_JOINS = ['es1:', 'sd1:', 'sda1:', 'seed1:']
const PARENT_JOINS = ['sdtb1:', 'sds1:', 'sdp1:']
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function createIdRewriter(newCampId) {
  const all = new Map() // every old id -> its new id, across entities
  const composedChanged = new Map() // changed ids a composed id may embed
  let composedRegex = null
  let composedRegexSize = -1

  const buildComposedRegex = () => {
    if (composedChanged.size === composedRegexSize) return
    composedRegexSize = composedChanged.size
    if (composedChanged.size === 0) { composedRegex = null; return }
    const keys = [...composedChanged.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
    composedRegex = new RegExp(`(?<![A-Za-z0-9_.-])(?:${keys.join('|')})(?![A-Za-z0-9_.-])`, 'g')
  }

  // A composed id (`elective-import:<set>:<activity>`, `<bundle>:<block>`, `schedule-template:<week>:manual`, ...)
  // embeds other ids whole. Replace exactly the embedded ids that changed; a random uuid contains none.
  const replaceEmbedded = (id) => {
    if (!id.includes(':')) return id
    buildComposedRegex()
    return composedRegex ? id.replace(composedRegex, (m) => composedChanged.get(m)) : id
  }

  const remap = (id) => {
    let m
    if (id.startsWith('day:') && (m = /^day:([^:]+):(-?\d+)$/.exec(id))) return `day:${newCampId}:${m[2]}`
    if (id.startsWith('cohort:') && (m = /^cohort:([^:]+):main$/.exec(id))) return `cohort:${newCampId}:main`
    if (id.startsWith('schedule-week:') && (m = /^schedule-week:([^:]+):(\d+)$/.exec(id))) return `schedule-week:${newCampId}:${m[2]}`
    if (id.startsWith('location:') && (m = /^location:([^:]+):([\s\S]+)$/.exec(id))) return `location:${newCampId}:${m[2]}`
    const campFirst = CAMP_FIRST_JOINS.find((p) => id.startsWith(p))
    if (campFirst) {
      const comps = decodeJoin(id.slice(campFirst.length))
      if (comps && comps.length >= 2) return campFirst + encodeJoin([newCampId, ...comps.slice(1)])
    }
    const parentJoin = PARENT_JOINS.find((p) => id.startsWith(p))
    if (parentJoin) {
      const comps = decodeJoin(id.slice(parentJoin.length))
      if (comps) return parentJoin + encodeJoin(comps.map((c) => all.get(c) ?? c))
    }
    return replaceEmbedded(id)
  }

  const record = (entity, oldId, newId) => {
    all.set(oldId, newId)
    if (oldId !== newId && !NOT_EMBEDDED_IN_COMPOSED_IDS.has(entity)) composedChanged.set(oldId, newId)
  }

  return { remap, record, all }
}

// ---- the plan ------------------------------------------------------------------------------------------------------

function readExisting(db) {
  const sortedWeeks = db.prepare('SELECT id, sort_order FROM schedule_weeks ORDER BY sort_order, id').all()
  return {
    days: new Map(db.prepare('SELECT id, day_of_week FROM days_of_operation WHERE day_of_week IS NOT NULL').all().map((r) => [r.day_of_week, r.id])),
    dayIds: new Set(db.prepare('SELECT id FROM days_of_operation').all().map((r) => r.id)),
    cohortIds: new Set(db.prepare('SELECT id FROM cohorts').all().map((r) => r.id)),
    weeks: sortedWeeks.map((r) => r.id),
    templates: new Map(db.prepare('SELECT id, week_id, kind FROM schedule_templates').all().map((r) => [`${r.week_id}|${r.kind}`, r.id])),
    templateIds: new Set(db.prepare('SELECT id FROM schedule_templates').all().map((r) => r.id)),
  }
}

// Weeks pair with the fresh camp's own by ordinal, but a file week whose re-derived id IS an existing week is that week.
function planWeekAdoption(fileWeeks, existing, rewriter) {
  const adopted = new Map()
  const taken = new Set()
  const sorted = [...fileWeeks].sort((a, b) => (Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)) || (a.id < b.id ? -1 : 1))
  for (const w of sorted) {
    const candidate = rewriter.remap(w.id)
    if (existing.weeks.includes(candidate) && !taken.has(candidate)) { adopted.set(w.id, candidate); taken.add(candidate) }
  }
  const free = existing.weeks.filter((id) => !taken.has(id))
  for (const w of sorted) {
    if (adopted.has(w.id)) continue
    if (free.length === 0) break
    adopted.set(w.id, free.shift())
  }
  return adopted
}

function planIds(entities, existing, newCampId) {
  const rewriter = createIdRewriter(newCampId)
  const maps = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, new Map()]))
  const adoptedExisting = { days_of_operation: new Set(), cohorts: new Set() }
  const weekAdoption = planWeekAdoption(entities.schedule_weeks, existing, rewriter)

  for (const entity of EXPORTED_ENTITIES) {
    const claimed = new Set()
    for (const row of entities[entity]) {
      let next = null
      if (entity === 'days_of_operation' && row.day_of_week != null) next = existing.days.get(row.day_of_week) ?? null
      else if (entity === 'schedule_weeks') next = weekAdoption.get(row.id) ?? null
      else if (entity === 'schedule_templates' && row.week_id != null) {
        const week = maps.schedule_weeks.get(row.week_id)
        next = existing.templates.get(`${week}|${row.kind}`) ?? null
      }
      if (next === null) next = rewriter.remap(row.id)
      if (claimed.has(next)) return { error: { entity, problem: 'id_collision' } }
      claimed.add(next)
      maps[entity].set(row.id, next)
      rewriter.record(entity, row.id, next)
      if (adoptedExisting[entity]) adoptedExisting[entity].add(next)
    }
    // An id this entity's fresh rows already own that no file row claimed is not a collision: it stays, and is
    // removed below only for the two entities whose bootstrap rows the file replaces.
  }
  return { maps, rewriter, adoptedExisting }
}

// ---- rewriting values ----------------------------------------------------------------------------------------------

const SNAPSHOT_SLOT_ID_KEYS = {
  group_id: 'groups', day_id: 'days_of_operation', time_block_id: 'time_blocks', activity_id: 'activities',
  fixed_event_id: 'fixed_events', event_id: 'events', elective_set_id: 'elective_sets',
}

function rewriteSnapshotSlots(text, maps) {
  const slots = JSON.parse(text)
  return JSON.stringify(slots.map((slot) => {
    const out = { ...slot }
    for (const [key, target] of Object.entries(SNAPSHOT_SLOT_ID_KEYS)) {
      if (typeof out[key] === 'string') out[key] = maps[target].get(out[key]) ?? out[key]
    }
    return out
  }))
}

const coverDigest = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 12)

// A remembered answer names entities (refs), other answers (supersedes, overrode) and, in a "forget", the answers it
// covers by a digest of their id. All of it must follow the ids to the new camp, or the answer silently stops applying.
function rewriteSeedlingPayload(text, rewriter, seedlingMap) {
  const payload = JSON.parse(text)
  const mapId = (id) => (typeof id === 'string' && !id.startsWith('alias:') ? rewriter.all.get(id) ?? id : id)
  for (const key of ['refs', 'supersedes', 'overrode']) {
    if (Array.isArray(payload[key])) payload[key] = payload[key].map(mapId)
  }
  if (Array.isArray(payload.covers)) {
    const byDigest = new Map([...seedlingMap.keys()].map((oldId) => [coverDigest(oldId), seedlingMap.get(oldId)]))
    payload.covers = payload.covers.map((d) => (byDigest.has(d) ? coverDigest(byDigest.get(d)) : d))
  }
  return JSON.stringify(payload)
}

// ---- the load ------------------------------------------------------------------------------------------------------

function checkFresh(db) {
  for (const entity of EXPORTED_ENTITIES) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${entityTable(entity)}`).get().n
    if (n > (FRESH_CAMP_ALLOWANCE[entity] ?? 0)) return { entity }
  }
  for (const table of PERSONAL_DATA_TABLES) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > 0) return { entity: table }
  }
  for (const table of Object.keys(LEARNED_TABLES)) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > 0) return { entity: table }
  }
  return null
}

const entityTable = (entity) => PROJECTIONS[entity].table

// `writers` is the test seam: the real write primitives by default; a test passes its own to fail a load midway.
export function loadCampFile(db, { file, campId, author_user_id, device_id, writers = {} } = {}) {
  const { appendOp = realAppendOp, appendBulkReplaceOp = realAppendBulkReplaceOp, afterEntities = null } = writers

  const checked = validateParsedCampFile(file)
  if (!checked.ok) return checked

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp || camp.id !== campId) throw new Error('loadCampFile: campId does not match the camp on this device')
  if (!author_user_id || !device_id) throw new Error('loadCampFile: author_user_id and device_id are required')

  const notFresh = checkFresh(db)
  if (notFresh) return reject('camp_not_empty', notFresh)

  const existing = readExisting(db)
  const entities = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [e, file.entities[e] ?? []]))
  const plan = planIds(entities, existing, campId)
  if (plan.error) return reject('bad_type', plan.error)
  const { maps, rewriter, adoptedExisting } = plan

  const loadId = createHash('sha256').update(JSON.stringify(file)).digest('hex').slice(0, 16)
  const cwid = (...parts) => `camp-load:${loadId}:${parts.join(':')}`
  const report = { deadSnapshotReferences: 0, deletedBootstrapRows: 0 }

  setMarker(db, loadId, device_id)
  try {
    const counts = {}
    const learnedCounts = {}
    const unsharedBefore = unsharedWriteCount(db)
    runAtomic(db, () => {
      db.pragma('defer_foreign_keys = ON')
      const write = (entity, id, field, value) => {
        if (HARD_UNIQUE_ENTITIES.has(entity) && UNIQUE_FIELD_ENTITIES[entity]?.field === field) {
          const collision = detectUniqueFieldCollision(db, { entity, entity_id: id, field, value })
          if (collision) throw new Error(`a ${entity} named the same already exists (unique_field collision)`)
        }
        appendOp(db, { entity, entity_id: id, field, value, author_user_id, device_id, client_write_id: cwid(entity, id, field), source: 'human' })
      }

      for (const [entity, keep] of [['days_of_operation', existing.dayIds], ['cohorts', existing.cohortIds]]) {
        if (entities[entity].length === 0) continue
        for (const id of keep) {
          if (adoptedExisting[entity].has(id)) continue
          write(entity, id, DELETE_FIELD, 1)
          report.deletedBootstrapRows += 1
        }
      }

      for (const entity of EXPORTED_ENTITIES) {
        const rows = entities[entity]
        counts[entity] = rows.length
        if (entity === 'template_slots') {
          writeTemplateSlots({ rows, maps, appendBulkReplaceOp, db, author_user_id, device_id, cwid })
          continue
        }
        const refs = REFERENCE_FIELDS[entity] ?? {}
        const lists = REFERENCE_LIST_FIELDS[entity] ?? {}
        const hasCamp = (LOADER_SUPPLIED_FIELDS[entity] ?? []).includes('camp_id')
        for (const row of rows) {
          const id = maps[entity].get(row.id)
          const fields = []
          if (hasCamp) fields.push(['camp_id', campId])
          for (const f of fileFieldsOf(entity)) {
            if (row[f] === undefined) continue
            let v = row[f]
            if (v !== null) {
              if (refs[f]) v = maps[refs[f]].get(v) ?? v
              else if (lists[f]) v = JSON.stringify(JSON.parse(v).map((x) => maps[lists[f]].get(x) ?? x))
              else if (entity === 'schedule_snapshots' && f === 'slots') v = rewriteSnapshotSlots(v, maps)
              else if (entity === 'camp_seedlings' && f === 'payload') v = rewriteSeedlingPayload(v, rewriter, maps.camp_seedlings)
            }
            fields.push([f, v])
          }
          for (const f of STAMPED_FIELDS[entity] ?? []) fields.push([f, author_user_id])
          fields.sort((a, b) => (a[0] === 'kind' ? -1 : b[0] === 'kind' ? 1 : 0))
          for (const [f, v] of fields) write(entity, id, f, v)
        }
      }

      afterEntities?.()
      writeLearnedTables({ db, file, campId, author_user_id, rewriter, maps, learnedCounts })
    })

    // runAtomic flushes the queued document writes AFTER the SQLite commit and contains their failures (it records
    // them and returns normally). A failed flush means the document is missing part of the camp, so this is not a
    // finished load: leave the marker set.
    if (unsharedWriteCount(db) > unsharedBefore) {
      return reject('load_incomplete', { message: 'part of the camp could not be written to the shared document' })
    }
    try {
      recordAuditEvent(db, {
        campId, actorUserId: author_user_id, deviceId: device_id, action: 'camp.loaded', targetType: 'camp', targetId: campId,
        outcome: 'allow', metadata: { loadId, counts, learned: learnedCounts },
      })
    } catch { /* an audit failure must not turn a finished load into a failed one */ }
    clearMarker(db)
    return { ok: true, loadId, counts, learnedCounts, report }
  } catch (err) {
    return reject('load_incomplete', { message: String(err?.message ?? err) })
  }
}

function writeTemplateSlots({ rows, maps, appendBulkReplaceOp, db, author_user_id, device_id, cwid }) {
  const byTemplate = new Map()
  for (const row of rows) {
    const templateId = maps.schedule_templates.get(row.template_id)
    const out = { id: maps.template_slots.get(row.id), template_id: templateId }
    for (const [f, target] of Object.entries(REFERENCE_FIELDS.template_slots)) {
      if (f === 'template_id' || row[f] == null) continue
      out[f] = maps[target].get(row[f]) ?? row[f]
    }
    for (const f of fileFieldsOf('template_slots')) {
      if (f in out || row[f] === undefined) continue
      out[f] = row[f]
    }
    for (const [k, v] of Object.entries(out)) out[k] = v === null || v === undefined ? null : String(v)
    if (!byTemplate.has(templateId)) byTemplate.set(templateId, [])
    byTemplate.get(templateId).push(out)
  }
  for (const [templateId, slots] of byTemplate) {
    appendBulkReplaceOp(db, { entity: 'template_slots', scope_id: templateId, rows: slots, author_user_id, device_id, client_write_id: cwid('template_slots', templateId) })
  }
}

// The seven learned tables are host-local (never in the document), so they are written the way a host handoff writes
// them: replace the camp's rows wholesale, camp id rewritten FIRST rather than the handoff's own camp check relaxed.
function writeLearnedTables({ db, file, campId, author_user_id, rewriter, maps, learnedCounts }) {
  for (const [table, spec] of Object.entries(LEARNED_TABLES)) {
    db.prepare(`DELETE FROM ${table} WHERE camp_id = ?`).run(campId)
    const columns = ['camp_id', ...spec.columns, ...spec.stamped]
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    const rows = file.learned.tables[table] ?? []
    for (const row of rows) {
      const values = spec.columns.map((c) => {
        const v = row[c] ?? null
        if (v === null || c === 'id') return v
        const target = spec.refs[c]
        if (!target) return v
        return target === '*' ? rewriter.all.get(v) ?? v : maps[target].get(v) ?? v
      })
      insert.run(campId, ...values, ...spec.stamped.map(() => author_user_id))
    }
    learnedCounts[table] = rows.length
  }
}
