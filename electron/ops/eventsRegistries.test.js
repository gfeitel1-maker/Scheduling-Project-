// @vitest-environment node
//
// Per-family completeness guard for the events family (`events` +
// `event_time_blocks` / `event_groups` / `event_slots`,
// docs/adr/2026-08-22-events-overlay-placement.md and
// docs/adr/2026-08-22-event-internal-subschedule.md). Mirrors
// electron/ops/electivesRegistries.test.js and specialDaysRegistries.test.js in
// shape, with one addition those files do not have and this family needs:
//
//   The family MEMBERSHIP is derived from the live schema (sqlite_master on a
//   freshly opened db, so migration-added tables count too), not hand-listed.
//   Every other assertion loops over that derived set. A fifth event sub-table
//   — `event_attachments`, say — therefore fails this file the moment it exists
//   in the schema, and keeps failing until it is registered in ALL of the
//   silent-failure registries below, not just some of them. That partial
//   registration is exactly the T88 bug class: a table registered on one side of
//   sync but not the other drops rows with no other test failing.
//
// Registries covered (an omission in any one of these is silent in production):
//   PROJECTIONS              — omission => writes append to the op log and are
//                              discarded without error
//   DIRECT_CAMP_ENTITIES /
//   PARENT_SCOPED_ENTITIES   — omission => list() and the full_sync send side
//                              never ship the table
//   DOMAIN_SNAPSHOT_ORDER +
//   DOMAIN_TABLE_COLUMNS     — omission => first-pairing Clients never receive
//                              the rows (the second is a private const in
//                              syncClient.js, so it is read from source, as
//                              electivesRegistries.test.js does)
//   permissions.ENTITIES     — omission => silently admin-only
//   RESTORE_DECISIONS        — omission => build-time failure on an unlisted
//                              projection (restated here per family convention)
//   MOCK_WRITE_ALLOWLIST     — omission => the write is dropped under
//                              `npm run dev`, so dev-mode diverges from Electron
//   deleteEvent cascade      — omission => a child table's rows survive their
//                              parent event's deletion as orphans
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS } from './projections.js'
import {
  DIRECT_CAMP_ENTITIES,
  PARENT_SCOPED_ENTITIES,
  DOMAIN_SNAPSHOT_ORDER,
} from './campScopedEntities.js'
import { RESTORE_DECISIONS } from './restore.js'
import { ENTITIES } from '../auth/permissions.js'
import { MOCK_WRITE_ALLOWLIST } from '../../src/localClient.mock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The parent, and the children whose registration differs from it (parent-scoped
// rather than camp-scoped). Kept as literals so the derived-set assertion below
// has something to compare AGAINST — this is the line a developer adding a fifth
// event table must edit, and editing it is what forces them past every other
// assertion in this file.
const EVENT_PARENT = 'events'
const EVENT_CHILDREN = ['event_time_blocks', 'event_groups', 'event_slots']
const EVENT_FAMILY = [EVENT_PARENT, ...EVENT_CHILDREN]

let tmpFile
let schemaTables

beforeAll(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-events-registries-${Date.now()}-${Math.random()}.sqlite`)
  const db = openLocalDb(tmpFile)
  schemaTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name)
  db.close()
})

afterAll(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('events family — membership is complete', () => {
  it('the schema contains exactly the event tables this file registers', () => {
    const inSchema = schemaTables.filter((t) => /^event(s$|_)/.test(t)).sort()
    expect(
      inSchema,
      'A table in the events family exists in the schema but is not covered by this guard. ' +
        'Add it to EVENT_CHILDREN here, then make the rest of this file pass — that means ' +
        'registering it in PROJECTIONS, PARENT_SCOPED_ENTITIES, DOMAIN_SNAPSHOT_ORDER, ' +
        "syncClient.js's DOMAIN_TABLE_COLUMNS, permissions.ENTITIES, RESTORE_DECISIONS, " +
        "MOCK_WRITE_ALLOWLIST, and deleteEvent.js's cascade."
    ).toEqual([...EVENT_FAMILY].sort())
  })
})

describe('events family — every member is in every registry', () => {
  it.each(EVENT_FAMILY)('%s is a projected entity (writes materialize)', (table) => {
    expect(PROJECTIONS[table], `PROJECTIONS is missing '${table}'`).toBeTruthy()
    expect(PROJECTIONS[table].table).toBe(table)
    expect(Array.isArray(PROJECTIONS[table].fields)).toBe(true)
    expect(PROJECTIONS[table].fields.length).toBeGreaterThan(0)
  })

  it.each(EVENT_FAMILY)('%s is in the first-pairing snapshot order', (table) => {
    expect(DOMAIN_SNAPSHOT_ORDER, `DOMAIN_SNAPSHOT_ORDER is missing '${table}'`).toContain(table)
  })

  it.each(EVENT_FAMILY)("%s has a column list in syncClient.js's DOMAIN_TABLE_COLUMNS", (table) => {
    // Private const — read from source, same technique as
    // electivesRegistries.test.js. (assertColumnCoverage in syncClient.js
    // already hard-fails at import time on a missing entry; this pins WHICH
    // columns, so a column added to the projection but not the manifest is
    // caught too.)
    const src = fs.readFileSync(path.join(__dirname, '../sync/syncClient.js'), 'utf8')
    const match = new RegExp(`\\n\\s*${table}: \\[([^\\]]*)\\]`).exec(src)
    expect(match, `syncClient.js DOMAIN_TABLE_COLUMNS is missing '${table}'`).toBeTruthy()
    const columns = match[1]
      .split(',')
      .map((c) => c.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(columns, `${table} snapshot columns must lead with 'id'`).toContain('id')
    expect(
      columns,
      `${table} snapshot columns must cover every projected field, or first-pairing Clients receive partial rows`
    ).toEqual(expect.arrayContaining(PROJECTIONS[table].fields))
  })

  it.each(EVENT_FAMILY)('%s is in permissions.ENTITIES (not silently admin-only)', (table) => {
    expect(ENTITIES, `permissions.ENTITIES is missing '${table}'`).toContain(table)
  })

  it.each(EVENT_FAMILY)('%s has a restore decision', (table) => {
    expect(RESTORE_DECISIONS[table], `RESTORE_DECISIONS is missing '${table}'`).toBeDefined()
  })

  it.each(EVENT_FAMILY)('%s has a mock write allowlist matching its projection fields', (table) => {
    expect(
      MOCK_WRITE_ALLOWLIST[table],
      `MOCK_WRITE_ALLOWLIST is missing '${table}' — dev-mode (npm run dev) would drop the write`
    ).toEqual(PROJECTIONS[table].fields)
  })
})

describe('events family — scoping is registered on the right side', () => {
  it('the parent is direct camp-scoped', () => {
    expect(DIRECT_CAMP_ENTITIES.has(EVENT_PARENT)).toBe(true)
    expect(PARENT_SCOPED_ENTITIES[EVENT_PARENT]).toBeUndefined()
  })

  it.each(EVENT_CHILDREN)('%s is parent-scoped by event_id, not camp-scoped', (table) => {
    expect(PARENT_SCOPED_ENTITIES[table], `PARENT_SCOPED_ENTITIES is missing '${table}'`).toEqual({
      table,
      parentTable: 'events',
      parentKey: 'event_id',
    })
    expect(DIRECT_CAMP_ENTITIES.has(table)).toBe(false)
  })

  it('every child is ordered after its parent in the first-pairing snapshot (FK safety)', () => {
    const parentIdx = DOMAIN_SNAPSHOT_ORDER.indexOf(EVENT_PARENT)
    expect(parentIdx).toBeGreaterThanOrEqual(0)
    for (const child of EVENT_CHILDREN) {
      expect(DOMAIN_SNAPSHOT_ORDER.indexOf(child), `${child} must follow events`).toBeGreaterThan(
        parentIdx
      )
    }
  })
})

describe('events family — delete cascade covers every child', () => {
  it.each(EVENT_CHILDREN)('deleteEvent.js deletes %s rows scoped to the event', (table) => {
    const src = fs.readFileSync(path.join(__dirname, 'deleteEvent.js'), 'utf8')
    expect(
      src,
      `deleteEvent.js never reads '${table}' — deleting an event would orphan its rows`
    ).toMatch(new RegExp(`SELECT id FROM ${table} WHERE event_id`))
  })
})
