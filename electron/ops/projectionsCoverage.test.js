// @vitest-environment node
//
// Guards the bug class that shipped commit 9f4b178: a mutation whose entity
// or field is missing from PROJECTIONS is appended to the operations op-log
// successfully and then SILENTLY NEVER MATERIALIZES (applyProjection's
// `if (!projection) return` / `if (!projection.fields.includes(op.field)) return`
// are silent no-ops by design for genuinely-unregistered writers, which makes
// them indistinguishable from a real gap unless something else checks).
//
// Two assertion sets:
//   1. Every entity/field the renderer (src/) actually writes via
//      localClient.write()/writeFields() must be registered in PROJECTIONS.
//      Side A (what's writable) is a static regex scan of src/; Side B (what's
//      projected) is PROJECTIONS itself. These are independent sources — see
//      the module comment below for why electron/ code cannot serve as
//      the independent side.
//   2. Every column PROJECTIONS's tables actually have (per a real migrated
//      DB, not the stale schema.sql) is accounted for: either registered as
//      writable, or explicitly exempted with a reason.
//
// ANTI-VACUITY FLOORS (read this before touching the floors below):
// A regex scanner has exactly one failure mode that matters more than any
// bug it catches: it can silently stop matching (a reformatted call site, a
// renamed wrapper, a broken glob) and this whole file keeps passing green
// while checking nothing. That is worse than no guard, because it *looks*
// like a guard. The floor assertions below (files scanned, entities found,
// (entity,field) pairs found, and a hardcoded canary set including the
// historical activities.is_locked incident) exist purely to make that
// failure mode loud. Do not remove or weaken them to make a refactor easier
// — fix the scanner instead.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS } from './projections.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..', '..')
const SRC_DIR = path.join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Generic bracket-balanced parsing helpers (no AST — regex plus manual
// paren/brace matching, per the Governor's ruling). Kept local to this file;
// one caller, no reason to extract a module.
// ---------------------------------------------------------------------------

function findMatchingClose(text, openIdx) {
  const openCh = text[openIdx]
  const closeCh = { '{': '}', '(': ')', '[': ']' }[openCh]
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Splits text at top-level commas, respecting nested {}/[]/() and strings.
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i
      cur += ch
      j++
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') {
          cur += text[j]
          j++
        }
        cur += text[j]
        j++
      }
      cur += text[j]
      i = j
      continue
    }
    if ('{[('.includes(ch)) depth++
    if ('}])'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

// Given the inner text of an object literal, returns its top-level keys and
// whether it contains an unresolvable spread (`...rest`).
function parseObjectKeys(innerText) {
  const entries = splitTopLevel(innerText)
  const keys = []
  let hasSpread = false
  for (const raw of entries) {
    const e = raw.trim()
    if (!e) continue
    if (e.startsWith('...')) {
      hasSpread = true
      continue
    }
    const m = e.match(/^([a-zA-Z_$][\w$]*)\s*(:|,|$)/)
    if (m) keys.push(m[1])
  }
  return { keys, hasSpread }
}

// Finds every call to a callee matched by `calleeRegex` (which must match
// through the opening `(`) and returns {index, argsText} for each, with
// argsText being the balanced content between the parens.
function findCallArgs(text, calleeRegex) {
  const results = []
  const re = new RegExp(calleeRegex.source, calleeRegex.flags.includes('g') ? calleeRegex.flags : calleeRegex.flags + 'g')
  let m
  while ((m = re.exec(text))) {
    const openIdx = m.index + m[0].length - 1
    const closeIdx = findMatchingClose(text, openIdx)
    if (closeIdx === -1) continue
    results.push({ index: m.index, matchText: m[0], argsText: text.slice(openIdx + 1, closeIdx) })
  }
  return results
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(p, out)
    } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Hand-maintained: call sites where a `writeFields(id, { ...spread, ... })`
// object literal contains a spread the scanner cannot resolve. Each entry's
// `fields` must be a superset of every literal key the scanner CAN see at
// that file's spread call sites, so a call site gaining a new literal field
// goes red instead of silently going stale.
// ---------------------------------------------------------------------------
const UNRESOLVED_SPREAD_SOURCES = [
  {
    file: 'src/screens/ActivitiesScreen.jsx',
    entity: 'activities',
    // Human-verified: `rest` at saveActivity()'s two `writeFields(id, { name,
    // ...rest })` call sites is `fields` as received from ActivityModal.save()
    // (the `record` object built in ActivityModal, ~lines 80-90) minus `name`.
    // is_locked is deliberately NOT in this list: ActivityModal has no
    // is_locked control — it is written only via
    // repo.writeActivityFields(activityId, { is_locked: true }) in
    // src/screens/schedule/useSlotMutations.js, a separate resolvable path.
    fields: [
      'name',
      'camp_id',
      'location',
      'is_outdoor',
      'max_groups_per_slot',
      'min_per_week',
      'max_per_week',
      'span_blocks',
      'same_tier_only',
      'priority',
      'eligible_tier_ids',
      'eligible_group_ids',
      'prefer_before_day',
      'prefer_before_day_min',
      'weather_alternative_id',
      'notes',
    ],
  },
  {
    file: 'src/screens/AnchorsScreen.jsx',
    entity: 'anchor_activities',
    // Human-verified: `base` (saveAnchor(), `fields` from AnchorModal.save()
    // minus `selectedDays`) and `record` (import path, `row` minus
    // warning/_dayLabel/_blockName/_tierNames).
    fields: ['name', 'is_all_groups', 'group_ids', 'time_block_id', 'notes', 'day_id', 'camp_id', 'cohort_id'],
  },
]

// ---------------------------------------------------------------------------
// Assertion-set-2: legitimate PROJECTIONS omissions vs the live (migrated)
// schema. electron/db/schema.sql is proven stale (see brief) so this is
// checked against a real openLocalDb() database, not the .sql file.
// ---------------------------------------------------------------------------
const PROJECTION_FIELD_EXCEPTIONS = {
  camps: [
    {
      column: 'signing_secret',
      reason:
        "Ed25519 private key material for the Host's signing identity — lives only on the Host device, never replicated, and must never become a renderer-writable field (see CLAUDE.md's Auth section).",
    },
    {
      column: 'signing_public_key',
      reason:
        'Replicated read-only alongside camp bootstrap/pairing so Clients can verify camp tokens; set by host key generation, never by a renderer write.',
    },
  ],
  anchor_activities: [
    {
      column: 'unit_id',
      reason:
        'Dead pre-rename column from an early schema (superseded by time_block_id). Verified via grep: no code under src/ or electron/ reads or writes anchor_activities.unit_id (electron/sync/syncClient.js only replicates its raw value, never sets it).',
    },
    {
      column: 'span_blocks',
      reason:
        'Dead column, same era as anchor_activities.unit_id above — never read or written anywhere under src/ or electron/ besides raw replication in syncClient.js.',
    },
  ],
  conflicts: [
    { column: 'entity', reason: 'Written only by raw SQL in recordConflict() (electron/ops/operations.js), never via appendOp/PROJECTIONS.' },
    { column: 'entity_id', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'field', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'incoming_op', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'existing_op', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'existing_op_id', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'created_at', reason: 'Same as `entity` above — raw-SQL-only column on a non-appendOp table.' },
    { column: 'resolved_at', reason: 'Set only by resolveConflict()\'s raw SQL (electron/auth or sync layer), never via appendOp.' },
  ],
}

// ---------------------------------------------------------------------------
// The scanner itself.
// ---------------------------------------------------------------------------

let scanResult

beforeAll(() => {
  const files = walkFiles(SRC_DIR)

  const foundEntities = new Set()
  const foundPairs = new Set() // "entity.field"
  const spreadHits = [] // { file, entity }
  const canaryHits = new Set() // "entity.field" seen via a resolvable path
  // Keys resolved directly at a writeFields(...) call site in a given file
  // (NOT via the repo.<method>() indirection) — scoped per file/entity so the
  // UNRESOLVED_SPREAD_SOURCES superset check only compares a spread call
  // site's own file against literal keys visible AT THAT FILE, not every
  // literal key found anywhere in the codebase for the same entity.
  const directFieldsByFileEntity = new Map() // "file::entity" -> Set<field>

  function addPair(entity, field) {
    foundEntities.add(entity)
    foundPairs.add(`${entity}.${field}`)
  }

  function addDirectField(file, entity, field) {
    const key = `${file}::${entity}`
    if (!directFieldsByFileEntity.has(key)) directFieldsByFileEntity.set(key, new Set())
    directFieldsByFileEntity.get(key).add(field)
  }

  // Pass 1: build scheduleRepository.js's exported-method -> entity map, so
  // calls like `repo.writeActivityFields(id, { is_locked: true })` elsewhere
  // in src/ (the actual site of the activities.is_locked historical bug) can
  // be resolved. scheduleRepository.js's own writeFields('entity', id, fields)
  // call sites are scanned like any other file below (pass 2/3); this pass
  // only captures the *wrapper method name* -> entity association.
  const repoMethodEntity = {}
  const scheduleRepoFile = files.find((f) => f.endsWith('src/data/scheduleRepository.js') || f.endsWith(path.join('data', 'scheduleRepository.js')))
  if (scheduleRepoFile) {
    const text = fs.readFileSync(scheduleRepoFile, 'utf8')
    // Only treat a method as a resolvable pass-through wrapper when its body is
    // LITERALLY `await writeFields('entity', <id>, fields)` — the whole,
    // untransformed `fields` parameter forwarded as-is. Methods like
    // createWeek()/createScheduleTemplate() build a NEW object from named
    // params (`{ camp_id: campId, ... }`) and must NOT be resolved this way —
    // their caller's object literal keys (e.g. `campId`) are not the real
    // written field names (e.g. `camp_id`); those are already captured
    // directly from this file's own literal writeFields(...) calls below.
    for (const m of text.matchAll(/(\w+)\s*\([^)]*\)\s*\{\s*await writeFields\(\s*'([a-zA-Z_]+)'\s*,\s*\w+\s*,\s*fields\s*\)\s*\}/g)) {
      repoMethodEntity[m[1]] = m[2]
    }
  }

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const rel = path.relative(REPO_ROOT, file)

    // (a) Fully-literal direct calls: localClient.write(token, 'entity', id, 'field', value)
    for (const m of text.matchAll(/localClient\.write\(\s*token\s*,\s*'([a-zA-Z_]+)'\s*,[^,]*,\s*'([a-zA-Z_]+)'/g)) {
      addPair(m[1], m[2])
      if (m[1] === 'activities' && m[2] === 'is_locked') canaryHits.add('activities.is_locked')
      canaryHits.add(`${m[1]}.${m[2]}`)
    }

    // (b) Locally-defined `writeFields` wrapper: either
    //       writeFields(id, fields)              -- entity fixed in the body
    //     or
    //       writeFields(entity, id, fields)       -- entity is per-call literal
    const defMatch = text.match(/(?:async\s+)?function\s+writeFields\s*\(([^)]*)\)\s*\{/)
    let wrapperArity = null
    let wrapperEntity = null
    let defCallIndex = -1
    if (defMatch) {
      const params = defMatch[1].split(',').map((s) => s.trim())
      defCallIndex = text.indexOf('writeFields(', defMatch.index)
      if (params.length === 2 && params[0] === 'id' && params[1] === 'fields') {
        wrapperArity = 2
        const entMatch = text.slice(defMatch.index).match(/localClient\.write\(\s*token\s*,\s*'([a-zA-Z_]+)'/)
        if (entMatch) wrapperEntity = entMatch[1]
      } else if (params.length === 3) {
        wrapperArity = 3
      }
    }

    if (wrapperArity === 2 && wrapperEntity) {
      foundEntities.add(wrapperEntity)
      for (const call of findCallArgs(text, /\bwriteFields\(/)) {
        if (call.index === defCallIndex) continue
        const args = splitTopLevel(call.argsText)
        const fieldsArg = args[args.length - 1]?.trim()
        if (!fieldsArg || !fieldsArg.startsWith('{')) continue
        const closeIdx = findMatchingClose(fieldsArg, 0)
        const inner = fieldsArg.slice(1, closeIdx === -1 ? undefined : closeIdx)
        const { keys, hasSpread } = parseObjectKeys(inner)
        for (const k of keys) {
          addPair(wrapperEntity, k)
          addDirectField(rel, wrapperEntity, k)
          if (`${wrapperEntity}.${k}` === 'activities.is_locked') canaryHits.add('activities.is_locked')
        }
        if (hasSpread) spreadHits.push({ file: rel, entity: wrapperEntity })
      }
    }

    if (wrapperArity === 3) {
      for (const call of findCallArgs(text, /\bwriteFields\(/)) {
        if (call.index === defCallIndex) continue
        const args = splitTopLevel(call.argsText)
        const entityArg = args[0]?.trim()
        const entMatch = entityArg?.match(/^'([a-zA-Z_]+)'$/)
        if (!entMatch) continue
        const entity = entMatch[1]
        foundEntities.add(entity)
        const fieldsArg = args[args.length - 1]?.trim()
        if (!fieldsArg || !fieldsArg.startsWith('{')) continue
        const closeIdx = findMatchingClose(fieldsArg, 0)
        const inner = fieldsArg.slice(1, closeIdx === -1 ? undefined : closeIdx)
        const { keys, hasSpread } = parseObjectKeys(inner)
        for (const k of keys) {
          addPair(entity, k)
          addDirectField(rel, entity, k)
        }
        if (hasSpread) spreadHits.push({ file: rel, entity })
      }
    }

    // (c) `repo.<wrapperMethod>(id, { ...fields })` — resolves the
    // scheduleRepository indirection (e.g. activities.is_locked, the
    // historical incident, is written this way from useSlotMutations.js).
    for (const call of findCallArgs(text, /\brepo\.(\w+)\(/)) {
      const methodName = call.matchText.match(/\brepo\.(\w+)\(/)[1]
      const entity = repoMethodEntity[methodName]
      if (!entity) continue
      foundEntities.add(entity)
      const args = splitTopLevel(call.argsText)
      const fieldsArg = [...args].reverse().find((a) => a.trim().startsWith('{'))
      if (!fieldsArg) continue
      const trimmed = fieldsArg.trim()
      const closeIdx = findMatchingClose(trimmed, 0)
      const inner = trimmed.slice(1, closeIdx === -1 ? undefined : closeIdx)
      const { keys, hasSpread } = parseObjectKeys(inner)
      for (const k of keys) {
        addPair(entity, k)
        if (`${entity}.${k}` === 'activities.is_locked') canaryHits.add('activities.is_locked')
      }
      if (hasSpread) spreadHits.push({ file: rel, entity })
    }
  }

  scanResult = { filesScanned: files.length, foundEntities, foundPairs, spreadHits, canaryHits, directFieldsByFileEntity }
})

// ---------------------------------------------------------------------------
// Anti-vacuity floors
// ---------------------------------------------------------------------------
describe('scanner anti-vacuity floors', () => {
  it('scanned a non-trivial number of files (glob/walk sanity)', () => {
    // src/ has ~86 non-test .js/.jsx files as of writing; 40 is comfortably
    // below that so a broken glob (e.g. an empty result, or matching only
    // one subdirectory) fails loudly without being brittle to file count churn.
    expect(scanResult.filesScanned).toBeGreaterThan(40)
  })

  it('found at least a floor number of distinct writable entities', () => {
    // Observed: 17 distinct entities are actually written from src/. Floor
    // set to 12 — well above "the scanner matched almost nothing" but below
    // the observed count so legitimate future removals don't flake this.
    expect(scanResult.foundEntities.size).toBeGreaterThanOrEqual(12)
  })

  it('found at least a floor number of distinct (entity, field) pairs', () => {
    // Observed: 82 distinct entity.field pairs. Floor set to 55, same margin
    // logic as the entity floor above.
    expect(scanResult.foundPairs.size).toBeGreaterThanOrEqual(55)
  })

  it('finds the known-present canary pairs, including the activities.is_locked historical incident', () => {
    // If the scanner can no longer see these, it is broken regardless of
    // whether every other assertion in this file passes.
    const canaries = [
      'activities.is_locked', // commit 9f4b178 — the actual historical incident
      'camps.name', // CampScreen.jsx, direct fully-literal localClient.write call
      'groups.name', // GroupsScreen.jsx, local 2-arg writeFields wrapper
    ]
    for (const c of canaries) {
      expect(scanResult.foundPairs.has(c), `expected scanner to find canary pair '${c}'`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Assertion set 1: renderer-writable surface vs PROJECTIONS
// ---------------------------------------------------------------------------
describe('renderer-writable surface is fully registered in PROJECTIONS', () => {
  it('every written entity is registered in PROJECTIONS', () => {
    const missing = [...scanResult.foundEntities].filter((e) => !(e in PROJECTIONS))
    for (const entity of missing) {
      expect.fail(
        `Entity '${entity}' is written via localClient.write()/writeFields() but is not registered in PROJECTIONS — this write will be silently discarded by applyProjection. Register it in electron/ops/projections.js.`
      )
    }
    expect(missing).toEqual([])
  })

  it('every written field is registered in PROJECTIONS[entity].fields', () => {
    const missing = []
    for (const pair of scanResult.foundPairs) {
      const [entity, field] = pair.split(/\.(.+)/)
      const projection = PROJECTIONS[entity]
      if (!projection) continue // reported by the entity-coverage test above
      if (!projection.fields.includes(field)) missing.push(pair)
    }
    for (const pair of missing) {
      const [entity, field] = pair.split(/\.(.+)/)
      expect.fail(
        `Field '${entity}.${field}' is written but is not in PROJECTIONS['${entity}'].fields — appendOp() will throw 'field not allowed for entity' for this write. Add '${field}' to electron/ops/projections.js.`
      )
    }
    expect(missing).toEqual([])
  })

  it('every unresolved-spread call site has a hand-verified UNRESOLVED_SPREAD_SOURCES entry', () => {
    const uniqueHits = [...new Set(scanResult.spreadHits.map((h) => `${h.file}::${h.entity}`))]
    for (const key of uniqueHits) {
      const [file, entity] = key.split('::')
      const entry = UNRESOLVED_SPREAD_SOURCES.find((e) => e.file === file && e.entity === entity)
      expect(entry, `expected an UNRESOLVED_SPREAD_SOURCES entry for ${file} / ${entity}`).toBeTruthy()
    }
  })

  it('every UNRESOLVED_SPREAD_SOURCES entry still corresponds to an actual unresolved spread', () => {
    const uniqueHits = new Set(scanResult.spreadHits.map((h) => `${h.file}::${h.entity}`))
    for (const entry of UNRESOLVED_SPREAD_SOURCES) {
      expect(
        uniqueHits.has(`${entry.file}::${entry.entity}`),
        `UNRESOLVED_SPREAD_SOURCES entry for ${entry.file} / ${entry.entity} no longer matches any spread the scanner found — remove it or update the file/entity.`
      ).toBe(true)
    }
  })

  it('every UNRESOLVED_SPREAD_SOURCES entry field list is a superset of resolvable literal keys, and every declared field is registered in PROJECTIONS', () => {
    for (const entry of UNRESOLVED_SPREAD_SOURCES) {
      const literalKeysForEntity = [...(scanResult.directFieldsByFileEntity.get(`${entry.file}::${entry.entity}`) || [])]
      for (const key of literalKeysForEntity) {
        expect(
          entry.fields.includes(key),
          `UNRESOLVED_SPREAD_SOURCES entry for ${entry.file} / ${entry.entity} is missing literal key '${key}' that the scanner can now resolve directly — the entry has gone stale.`
        ).toBe(true)
      }
      const projection = PROJECTIONS[entry.entity]
      for (const field of entry.fields) {
        expect(
          projection && projection.fields.includes(field),
          `UNRESOLVED_SPREAD_SOURCES field '${entry.entity}.${field}' (declared for ${entry.file}) is not registered in PROJECTIONS — register it in electron/ops/projections.js.`
        ).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Assertion set 2: PROJECTIONS vs the live schema
// ---------------------------------------------------------------------------
describe('PROJECTIONS fields vs the live migrated schema', () => {
  let db
  let tmpFile

  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), `shoresh-projections-coverage-${Date.now()}-${Math.random()}.sqlite`)
    db = openLocalDb(tmpFile)
  })

  it('every non-key, non-exempt column of every PROJECTIONS table is a registered field', () => {
    const problems = []
    for (const [entity, projection] of Object.entries(PROJECTIONS)) {
      const columns = db.prepare(`PRAGMA table_info(${projection.table})`).all().map((c) => c.name)
      const exceptions = (PROJECTION_FIELD_EXCEPTIONS[entity] || []).map((e) => e.column)
      for (const col of columns) {
        if (col === projection.key) continue
        if (projection.fields.includes(col)) continue
        if (exceptions.includes(col)) continue
        problems.push(
          `Table '${projection.table}' has column '${col}' which is neither in PROJECTIONS['${entity}'].fields nor in PROJECTION_FIELD_EXCEPTIONS['${entity}'] — decide whether it's writable (register it) or exempt (add it to PROJECTION_FIELD_EXCEPTIONS with a reason).`
        )
      }
    }
    expect(problems).toEqual([])
  })

  it('every PROJECTION_FIELD_EXCEPTIONS column still exists on its table', () => {
    const problems = []
    for (const [entity, exceptions] of Object.entries(PROJECTION_FIELD_EXCEPTIONS)) {
      const projection = PROJECTIONS[entity]
      if (!projection) {
        problems.push(`PROJECTION_FIELD_EXCEPTIONS['${entity}'] refers to an entity not in PROJECTIONS.`)
        continue
      }
      const columns = db.prepare(`PRAGMA table_info(${projection.table})`).all().map((c) => c.name)
      for (const { column } of exceptions) {
        if (!columns.includes(column)) {
          problems.push(
            `PROJECTION_FIELD_EXCEPTIONS['${entity}'] lists column '${column}' which no longer exists on table '${projection.table}' — remove or update this exception.`
          )
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('every exception entry carries a non-empty reason', () => {
    for (const [entity, exceptions] of Object.entries(PROJECTION_FIELD_EXCEPTIONS)) {
      for (const { column, reason } of exceptions) {
        expect(reason && reason.trim().length > 10, `${entity}.${column} needs a real reason`).toBe(true)
      }
    }
  })
})
