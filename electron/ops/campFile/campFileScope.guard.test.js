// @vitest-environment node
//
// The scope guard (ADR docs/adr/2026-10-13-whole-camp-file-save-and-open.md section 4/5): every SQLite
// table is EITHER exported, learned, or on the exclusion list with a reason, so a future table cannot be
// silently left out or silently leaked; the hand-kept per-field specs (types, required, references) are
// compared against the real schema so they cannot drift from it.
import { describe, it, expect, afterAll } from 'vitest'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { PROJECTIONS } from '../projections.js'
import {
  EXPORTED_ENTITIES,
  EXCLUDED_ENTITIES,
  EXCLUDED_TABLES,
  LEARNED_TABLES,
  LEARNED_REQUIRED,
  CAMPS_EXPORTED_FIELDS,
  LOADER_SUPPLIED_FIELDS,
  STAMPED_FIELDS,
  INTEGER_FIELDS,
  MIXED_INTEGER_FIELDS,
  REQUIRED_FIELDS,
  REFERENCE_FIELDS,
  REFERENCE_LIST_FIELDS,
  NON_REFERENCE_ID_FIELDS,
  SECRET_LOOKING_FIELD_ALLOWLIST,
  fileFieldsOf,
  exportedTableNames,
} from './campFileScope.js'

afterAll(() => cleanupTemplatedDbs())

const SECRET_NAME = /secret|pin|token|key|salt|hash/i

function schema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
  return { tables, info: (t) => db.prepare(`PRAGMA table_info(${t})`).all(), fks: (t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all() }
}

describe('every table is exported, learned, excluded, or camps', () => {
  it('has no table that is none of those, and no table in two buckets', () => {
    const { db } = openTemplatedDb()
    const { tables } = schema(db)
    const exported = new Set(exportedTableNames())
    const learned = new Set(Object.keys(LEARNED_TABLES))
    const excluded = new Set(Object.keys(EXCLUDED_TABLES))
    const uncovered = tables.filter((t) => t !== 'camps' && !exported.has(t) && !learned.has(t) && !excluded.has(t))
    expect(uncovered).toEqual([])
    const buckets = [...exported, ...learned, ...excluded, 'camps']
    expect(buckets.length).toBe(new Set(buckets).size)
    for (const t of [...exported, ...learned, ...excluded]) expect(tables).toContain(t)
  })

  it('accounts for every PROJECTIONS entity as exported, excluded or camps', () => {
    for (const e of Object.keys(PROJECTIONS)) {
      const known = EXPORTED_ENTITIES.includes(e) || e in EXCLUDED_ENTITIES || e === 'camps'
      expect({ e, known }).toEqual({ e, known: true })
    }
    for (const e of EXPORTED_ENTITIES) expect(PROJECTIONS[e]).toBeTruthy()
  })

  it('excludes campers, their identity keys, the elective assignment-run family, users, tombstones and conflicts', () => {
    for (const e of [
      'campers', 'camper_identity_keys', 'elective_assignment_runs', 'elective_occurrences', 'elective_choices',
      'elective_choice_offerings', 'elective_preferences', 'elective_assignments', 'elective_run_outer_snapshots',
      'elective_run_findings', 'users', 'tombstones', 'conflicts',
    ]) {
      expect(EXCLUDED_ENTITIES[e]).toBeTruthy()
      expect(EXPORTED_ENTITIES).not.toContain(e)
    }
  })

  it('exports schedule_snapshots and template_slots after their parent template', () => {
    const idx = (e) => EXPORTED_ENTITIES.indexOf(e)
    expect(idx('schedule_templates')).toBeGreaterThan(-1)
    expect(idx('schedule_snapshots')).toBeGreaterThan(idx('schedule_templates'))
    expect(idx('template_slots')).toBeGreaterThan(idx('schedule_templates'))
  })
})

describe('no secret-looking field leaves the building', () => {
  it('no exported or learned field name matches the secret pattern except the listed lookup keys', () => {
    const offenders = []
    for (const e of EXPORTED_ENTITIES) for (const f of fileFieldsOf(e)) if (SECRET_NAME.test(f) && !SECRET_LOOKING_FIELD_ALLOWLIST[`${e}.${f}`]) offenders.push(`${e}.${f}`)
    for (const [t, spec] of Object.entries(LEARNED_TABLES)) for (const f of spec.columns) if (SECRET_NAME.test(f) && !SECRET_LOOKING_FIELD_ALLOWLIST[`${t}.${f}`]) offenders.push(`${t}.${f}`)
    expect(offenders).toEqual([])
  })

  it('every allowlisted secret-looking field exists, still matches the pattern, and carries a reason', () => {
    const all = new Set([
      ...EXPORTED_ENTITIES.flatMap((e) => fileFieldsOf(e).map((f) => `${e}.${f}`)),
      ...Object.entries(LEARNED_TABLES).flatMap(([t, s]) => s.columns.map((f) => `${t}.${f}`)),
    ])
    for (const [name, reason] of Object.entries(SECRET_LOOKING_FIELD_ALLOWLIST)) {
      expect(all.has(name)).toBe(true)
      expect(SECRET_NAME.test(name.split('.')[1])).toBe(true)
      expect(reason.length).toBeGreaterThan(10)
    }
  })

  it('camps contributes only its name', () => {
    expect(CAMPS_EXPORTED_FIELDS).toEqual(['name'])
    expect(PROJECTIONS.camps.fields).toEqual(['name'])
    for (const e of EXPORTED_ENTITIES) expect(e).not.toBe('camps')
  })

  it('carries no user, session, signing or authority column in any exported row', () => {
    const { db } = openTemplatedDb()
    const { info } = schema(db)
    const banned = /^(pin_hash|pin_salt|auth_sig|cred_version|signing_secret|signing_public_key|private_key|role)$/
    for (const e of EXPORTED_ENTITIES) {
      for (const f of fileFieldsOf(e)) expect({ e, f, banned: banned.test(f) }).toEqual({ e, f, banned: false })
    }
    for (const t of exportedTableNames()) expect(info(t).length).toBeGreaterThan(0)
  })
})

describe('the field specs match the real schema', () => {
  it('every declared projection field is in the file, loader-supplied or stamped', () => {
    for (const e of EXPORTED_ENTITIES) {
      const declared = PROJECTIONS[e].fields
      const accounted = new Set([...fileFieldsOf(e), ...(LOADER_SUPPLIED_FIELDS[e] ?? []), ...(STAMPED_FIELDS[e] ?? [])])
      expect({ e, missing: declared.filter((f) => !accounted.has(f)) }).toEqual({ e, missing: [] })
      expect({ e, extra: [...accounted].filter((f) => !declared.includes(f)) }).toEqual({ e, extra: [] })
    }
  })

  it('INTEGER_FIELDS lists exactly the INTEGER columns among the file fields', () => {
    const { db } = openTemplatedDb()
    const { info } = schema(db)
    for (const e of EXPORTED_ENTITIES) {
      const cols = info(PROJECTIONS[e].table)
      const ints = fileFieldsOf(e).filter((f) => cols.find((c) => c.name === f).type === 'INTEGER')
      expect({ e, ints: [...(INTEGER_FIELDS[e] ?? [])].sort() }).toEqual({ e, ints: ints.sort() })
    }
  })

  it('MIXED_INTEGER_FIELDS names only INTEGER columns', () => {
    for (const [e, fields] of Object.entries(MIXED_INTEGER_FIELDS)) for (const f of fields) expect(INTEGER_FIELDS[e]).toContain(f)
  })

  it('REQUIRED_FIELDS lists exactly the NOT NULL, no-default columns among the file fields', () => {
    const { db } = openTemplatedDb()
    const { info } = schema(db)
    for (const e of EXPORTED_ENTITIES) {
      const cols = info(PROJECTIONS[e].table)
      const required = fileFieldsOf(e).filter((f) => {
        const c = cols.find((x) => x.name === f)
        return c.notnull && c.dflt_value == null
      })
      expect({ e, required: [...(REQUIRED_FIELDS[e] ?? [])].sort() }).toEqual({ e, required: required.sort() })
    }
  })

  it('every real foreign key between exported tables is a declared reference to the same entity', () => {
    const { db } = openTemplatedDb()
    const { fks } = schema(db)
    const entityOfTable = Object.fromEntries(EXPORTED_ENTITIES.map((e) => [PROJECTIONS[e].table, e]))
    for (const e of EXPORTED_ENTITIES) {
      for (const fk of fks(PROJECTIONS[e].table)) {
        if (fk.table === 'camps') continue
        const target = entityOfTable[fk.table]
        expect({ e, col: fk.from, target }).toEqual({ e, col: fk.from, target: REFERENCE_FIELDS[e]?.[fk.from] })
      }
    }
  })

  it('every *_id field of an exported entity is a declared reference or explicitly not one, and every *_ids field is a declared list', () => {
    for (const e of EXPORTED_ENTITIES) {
      for (const f of fileFieldsOf(e)) {
        if (f.endsWith('_ids')) {
          expect({ e, f, listed: Boolean(REFERENCE_LIST_FIELDS[e]?.[f]) }).toEqual({ e, f, listed: true })
        } else if (f.endsWith('_id')) {
          const listed = Boolean(REFERENCE_FIELDS[e]?.[f]) || Boolean(NON_REFERENCE_ID_FIELDS[`${e}.${f}`])
          expect({ e, f, listed }).toEqual({ e, f, listed: true })
        }
      }
    }
  })

  it('every declared reference targets an exported entity and names a real field', () => {
    for (const spec of [REFERENCE_FIELDS, REFERENCE_LIST_FIELDS]) {
      for (const [e, fields] of Object.entries(spec)) {
        expect(EXPORTED_ENTITIES).toContain(e)
        for (const [f, target] of Object.entries(fields)) {
          expect(fileFieldsOf(e)).toContain(f)
          expect(EXPORTED_ENTITIES).toContain(target)
        }
      }
    }
  })

  it('the learned tables list exactly their real columns, minus camp_id and the stamped user columns', () => {
    const { db } = openTemplatedDb()
    const { info } = schema(db)
    expect(Object.keys(LEARNED_TABLES).sort()).toEqual([
      'compound_cell_decisions', 'declined_two_row_splits', 'import_decisions', 'import_evidence',
      'location_word_decisions', 'open_reconciliation_decisions', 'source_aliases',
    ])
    for (const [t, spec] of Object.entries(LEARNED_TABLES)) {
      const real = info(t).map((c) => c.name).filter((c) => c !== 'camp_id' && !spec.stamped.includes(c))
      expect({ t, columns: [...spec.columns].sort() }).toEqual({ t, columns: real.sort() })
      const ints = info(t).filter((c) => spec.columns.includes(c.name) && c.type === 'INTEGER').map((c) => c.name)
      expect({ t, ints: [...(spec.integers ?? [])].sort() }).toEqual({ t, ints: ints.sort() })
      const required = info(t).filter((c) => spec.columns.includes(c.name) && c.name !== 'id' && c.notnull && c.dflt_value == null).map((c) => c.name)
      expect({ t, required: [...(LEARNED_REQUIRED[t] ?? [])].sort() }).toEqual({ t, required: required.sort() })
    }
  })
})
