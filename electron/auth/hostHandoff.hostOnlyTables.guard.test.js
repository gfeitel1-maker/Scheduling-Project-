// @vitest-environment node
//
// Guard: every table schema.sql marks host-only must travel with hosting, or be explicitly excluded
// here. A host-only table that is added without being added to HANDOFF_TABLES would be silently left
// behind on the old host at the next handoff — the successor would lose, say, its import decisions
// and nothing would say so. The scan reads the comment block that sits directly above each CREATE
// TABLE: a block whose first line opens "Host-only" or "Host-local" marks the table.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HANDOFF_TABLES } from './hostHandoff.js'

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8')

// The key itself travels as its own field, and the handoff's own tables are the mechanism.
const ALLOWED_EXCLUSIONS = ['host_signing_key', 'host_handoff', 'host_signing_key_pending']

export function hostOnlyTables(sql) {
  const found = []
  let block = []
  for (const line of sql.split('\n')) {
    if (line.startsWith('--')) { block.push(line); continue }
    const m = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(line)
    if (m && block.length && /^-- Host-(only|local)\b/i.test(block[0])) found.push(m[1])
    block = []
  }
  return found
}

const missing = (sql) => hostOnlyTables(sql).filter((t) => !HANDOFF_TABLES.includes(t) && !ALLOWED_EXCLUSIONS.includes(t))

describe('host-only tables travel with hosting', () => {
  it('the scan finds the seven tables and the key, so it cannot pass vacuously', () => {
    expect(hostOnlyTables(SCHEMA).sort()).toEqual([...HANDOFF_TABLES, 'host_signing_key'].sort())
  })

  it('every host-only table in schema.sql is in the handoff payload list or an allowed exclusion', () => {
    expect(missing(SCHEMA)).toEqual([])
  })

  it('fires when a host-only table is added without being added to the payload (planted)', () => {
    const planted = `${SCHEMA}\n-- Host-only table, like source_aliases. NEVER synced.\nCREATE TABLE IF NOT EXISTS planted_host_only_table (\n  id TEXT PRIMARY KEY\n);\n`
    expect(missing(planted)).toEqual(['planted_host_only_table'])
  })
})
