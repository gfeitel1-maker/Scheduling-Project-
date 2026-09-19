// @vitest-environment node
//
// T202 follow-up (drift surface). The set of non-document-replicated, host-only tables a camper
// purge wipes was narrated by hand in three places that had no mechanism keeping them in sync:
//   1. PURGE_NOT_RECOVERABLE_NOTICE          (hostKeyPreservation.js)  — user-facing notice
//   2. the step-5 "BLAST RADIUS" header comment (purgeSupportCommand.js) — code comment
//   3. SECURITY.md's "Camper-record purge"    section                   — security doc
// purgeCollateral.js makes that categorization a SINGLE exported value. This test pins it to the
// authority the rebuild/projector actually uses — MODELED_ENTITIES vs. the schema — and asserts the
// two prose narrations still enumerate the same wiped set. Concretely, it fails the build when:
//   - a new table is added to schema.sql outside MODELED_ENTITIES and not categorized here
//     (the exact drift the task names: "a future table added outside MODELED_ENTITIES"), or
//   - a wiped table drops out of the notice or either prose narration.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELED_ENTITIES } from './campDocument.js'
import {
  PURGE_WIPED_TABLES,
  PURGE_LEDGER_TABLES,
  PURGE_PRESERVED_TABLES,
  PURGE_INFRASTRUCTURE_TABLES,
  ALL_NON_MODELED_TABLES,
} from './purgeCollateral.js'
import { PURGE_NOT_RECOVERABLE_NOTICE } from './hostKeyPreservation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
const purgeCommandSrc = fs.readFileSync(path.join(__dirname, 'purgeSupportCommand.js'), 'utf8')
const securityMd = fs.readFileSync(path.join(__dirname, '../../SECURITY.md'), 'utf8')

// Every CREATE TABLE in schema.sql that MODELED_ENTITIES does NOT replicate. This IS the authority a
// purge answers to: rebuildProjectionFromDocumentAtPath reprojects exactly the modeled entities, so
// the complement is precisely the collateral set the narrations describe.
const schemaNonModeled = [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
  .map((m) => m[1])
  .filter((t) => !MODELED_ENTITIES.has(t))
  .sort()

// The "Camper-record purge" section of SECURITY.md, sliced from its heading to the next `#### `.
const securityPurgeSection = (() => {
  const start = securityMd.indexOf('#### Camper-record purge')
  expect(start).toBeGreaterThan(-1)
  const rest = securityMd.slice(start + 4)
  const nextHeading = rest.indexOf('\n#### ')
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
})()

describe('purge collateral accounting is the single source of truth for the wiped-table narrations', () => {
  it('the four buckets are disjoint (no table categorized twice)', () => {
    expect(new Set(ALL_NON_MODELED_TABLES).size).toBe(ALL_NON_MODELED_TABLES.length)
  })

  it('the partition covers EXACTLY the non-modeled tables in schema.sql', () => {
    // The core drift catcher: a table added to schema.sql outside MODELED_ENTITIES must be placed in
    // one of purgeCollateral.js's buckets, or this fails until it is categorized. A modeled table
    // mistakenly listed as collateral fails here too.
    expect([...ALL_NON_MODELED_TABLES].sort()).toEqual(schemaNonModeled)
  })

  it('no wiped/ledger/preserved/infrastructure table is secretly modeled', () => {
    for (const t of ALL_NON_MODELED_TABLES) expect(MODELED_ENTITIES.has(t)).toBe(false)
  })

  it('the preserved set is exactly the two device-identity key tables (5b)', () => {
    // camps.signing_public_key is a COLUMN on the modeled `camps` table, not its own table, so it is
    // correctly absent from this table-level partition even though 5b preserves it.
    expect([...PURGE_PRESERVED_TABLES].sort()).toEqual(['device_identity_key', 'host_signing_key'])
  })

  it('schedule_snapshots is MODELED and therefore never listed as purge collateral', () => {
    // Regression guard: the header comment once listed schedule_snapshots as wiped collateral, but it
    // is document-replicated and round-trips back via the fresh document.
    expect(MODELED_ENTITIES.has('schedule_snapshots')).toBe(true)
    expect(ALL_NON_MODELED_TABLES).not.toContain('schedule_snapshots')
  })
})

describe('the three narrations agree with the wiped-table source of truth', () => {
  it('PURGE_NOT_RECOVERABLE_NOTICE names every wiped table (it is derived from the constant)', () => {
    for (const t of PURGE_WIPED_TABLES) expect(PURGE_NOT_RECOVERABLE_NOTICE).toContain(t)
  })

  it("purgeSupportCommand.js's BLAST RADIUS comment names every wiped table", () => {
    for (const t of PURGE_WIPED_TABLES) expect(purgeCommandSrc).toContain(t)
  })

  it("SECURITY.md's Camper-record purge section names every wiped table", () => {
    for (const t of PURGE_WIPED_TABLES) expect(securityPurgeSection).toContain(t)
  })

  it('all three narrations record that operations (the ledger) is emptied', () => {
    for (const t of PURGE_LEDGER_TABLES) {
      expect(PURGE_NOT_RECOVERABLE_NOTICE).toContain(t)
      expect(purgeCommandSrc).toContain(t)
      expect(securityPurgeSection).toContain(t)
    }
  })
})
