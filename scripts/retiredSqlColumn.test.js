// Catches a SQL string/template literal that still names a column T293 (v84)
// renamed: template_slots.anchor_id -> fixed_event_id, template_slots.is_anchor
// -> is_fixed_event, cohorts.anchor_model -> fixed_event_model,
// compound_cell_decisions.anchor_name -> base_name (electron/db/localDb.js,
// the v84 migration block, confirmed 2026-10-01).
//
// Keyword gate is deliberately NARROW (insert into / create table / alter
// table only) — see header in retiredSqlColumn.js for what this does not see.

import { describe, it, expect } from 'vitest'
import { scanRetiredSqlColumnInText, RETIRED_COLUMNS } from './retiredSqlColumn.js'

function check(source, path = 'fixture.js') {
  return scanRetiredSqlColumnInText(path, source)
}

// The two positive fixtures below build their SQL text by RUNTIME
// concatenation (keyword in one literal, retired column name in another) so
// that THIS file — scanned by the very detector under test when
// check:governance runs on the real tree — never contains a single literal
// combining a SQL keyword with a retired column name. The concatenated
// string, once handed to scanRetiredSqlColumnInText and parsed as its own
// fresh source, DOES contain one contiguous literal, which is exactly what
// the detector needs to see.
describe('retiredSqlColumn', () => {
  it('fires on a CREATE TABLE string literal naming a retired column', () => {
    const src = "db.exec('CREATE TABLE template_slots (id TEXT, " + "anchor_id TEXT)')"
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('retired-column-in-sql-literal')
    expect(findings[0].message).toContain('anchor_id')
  })

  it('fires on an INSERT INTO template literal naming a retired column', () => {
    const src = 'const sql = `INSERT INTO template_slots (id, ' + 'is_anchor) VALUES (?, ?)`'
    const findings = check(src)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('is_anchor')
  })

  it('does not fire for the safe variant using the live column name', () => {
    const src = `
      db.exec('CREATE TABLE template_slots (id TEXT, fixed_event_id TEXT)')
    `
    expect(check(src)).toEqual([])
  })

  it('ignores a non-SQL string that merely contains the substring', () => {
    const src = `
      const label = 'anchor_id is the legacy name for fixed_event_id'
    `
    expect(check(src)).toEqual([])
  })

  it('ignores a retired column name that appears only inside a SQL comment', () => {
    const src = `
      db.exec('CREATE TABLE template_slots (id TEXT) -- was is_anchor before v84')
    `
    expect(check(src)).toEqual([])
  })

  it('exposes the exact T293/v84 denylist', () => {
    expect([...RETIRED_COLUMNS].sort()).toEqual(
      ['anchor_id', 'anchor_model', 'anchor_name', 'is_anchor'].sort(),
    )
  })
})
