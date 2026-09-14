// @vitest-environment node
//
// The mechanism, not the data: these fail when someone adds a migration without
// deciding whether it changes what the camp MEANS. That decision is the whole
// point of migrationDomainState.js — the guard it feeds cannot fire for a
// migration nobody classified.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { CURRENT_SCHEMA_VERSION } from './localDb.js'
import {
  DOMAIN_STATE_MIGRATIONS,
  SCHEMA_ONLY_MIGRATIONS,
  isDomainStateMigration,
  domainStateMigrationsIn,
} from './migrationDomainState.js'

describe('every migration is classified', () => {
  it('covers 1..CURRENT_SCHEMA_VERSION with no gaps', () => {
    const classified = new Set([...DOMAIN_STATE_MIGRATIONS.keys(), ...SCHEMA_ONLY_MIGRATIONS])
    const missing = []
    for (let v = 1; v <= CURRENT_SCHEMA_VERSION; v += 1) if (!classified.has(v)) missing.push(v)
    // A new migration lands here first. Classify it in migrationDomainState.js:
    // does it change domain ROW VALUES of a table the document models, or only
    // table shape / a host-local table?
    expect(missing).toEqual([])
  })

  it('classifies each version exactly once', () => {
    const both = [...DOMAIN_STATE_MIGRATIONS.keys()].filter((v) => SCHEMA_ONLY_MIGRATIONS.has(v))
    expect(both).toEqual([])
  })

  it('never classifies a version above the current schema', () => {
    const all = [...DOMAIN_STATE_MIGRATIONS.keys(), ...SCHEMA_ONLY_MIGRATIONS]
    expect(all.filter((v) => v > CURRENT_SCHEMA_VERSION)).toEqual([])
  })

  it('every domain-state entry says WHAT it does, so the classification can be checked', () => {
    for (const [version, why] of DOMAIN_STATE_MIGRATIONS) {
      expect(typeof why, `v${version}`).toBe('string')
      expect(why.length, `v${version}`).toBeGreaterThan(20)
    }
  })
})

describe('the span query the startup guard asks', () => {
  it('reports only migrations inside (from, to]', () => {
    expect(domainStateMigrationsIn(11, 12)).toEqual([12])
    expect(domainStateMigrationsIn(12, 12)).toEqual([])
    expect(domainStateMigrationsIn(32, CURRENT_SCHEMA_VERSION)).toEqual([])
  })

  it('a fresh database (from 0) reports every one of them — and has no document by definition', () => {
    expect(domainStateMigrationsIn(0, CURRENT_SCHEMA_VERSION)).toEqual([...DOMAIN_STATE_MIGRATIONS.keys()].sort((a, b) => a - b))
  })

  it('THE PROPERTY THAT MAKES THIS UNREACHABLE TODAY: nothing above v52 changes domain state', () => {
    // A database that has ever produced a .automerge file has run a build from
    // the document era, so it is at v57 or higher. If this ever fails, the guard
    // in main.js has stopped being theoretical and the migration needs to write
    // through the document instead.
    const aboveDocumentEra = [...DOMAIN_STATE_MIGRATIONS.keys()].filter((v) => v > 52)
    expect(aboveDocumentEra).toEqual([])
  })

  it('isDomainStateMigration agrees with the map', () => {
    expect(isDomainStateMigration(32)).toBe(true)
    expect(isDomainStateMigration(59)).toBe(false)
  })
})

describe('the classification is checked against the source, not just asserted', () => {
  it('every version claimed schema-only has no UPDATE/INSERT of a modeled domain table in its block', () => {
    // BLIND SPOT, stated because a test that pretends to cover more than it does
    // is worse than no test: this only sees writes written INLINE in a
    // migration's own block. v32's `backfillLocations(db)` is a call to a
    // function defined 900 lines away, and its UPDATE/INSERT statements are
    // invisible here — v32 is classified domain-state by reading it, not by
    // this scan. So this catches the common shape (someone adds an UPDATE to a
    // migration) and not the indirect one. Verified non-vacuous by planting an
    // inline write in a schema-only block and watching it fail.
    //
    // Coarse but real: read localDb.js, split it at each migration's own
    // `schema_migrations ... VALUES (N,` stamp, and look for writes to modeled
    // tables inside blocks classified as schema-only. A table-RECREATE migration
    // legitimately INSERTs into its own `_vNN` shadow table and then renames,
    // which is shape work, so those are excluded by name.
    const src = fs.readFileSync(new URL('./localDb.js', import.meta.url), 'utf8')
    const lines = src.split('\n')
    const stamps = []
    lines.forEach((line, i) => {
      const m = line.match(/schema_migrations \(version, applied_at\) VALUES \((\d+),/)
      if (m) stamps.push({ line: i, version: Number(m[1]) })
    })
    const MODELED = ['groups', 'tiers', 'activities', 'cohorts', 'days_of_operation', 'time_blocks',
      'anchor_activities', 'schedule_templates', 'schedule_weeks', 'locations', 'special_days',
      'elective_sets', 'events', 'template_slots']
    const offenders = []
    let start = 0
    for (const { line, version } of stamps) {
      const block = lines.slice(start, line + 1).join('\n')
      start = line + 1
      if (!SCHEMA_ONLY_MIGRATIONS.has(version)) continue
      for (const table of MODELED) {
        // `_vNN` shadow tables are shape work; so is a bare CREATE/DROP/ALTER.
        const write = new RegExp(`(UPDATE|INSERT INTO|INSERT OR \\w+ INTO)\\s+${table}\\b(?!_v)`, 'i')
        if (write.test(block)) offenders.push(`v${version} writes ${table}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the startup guard fires on the span, not on the schema version', () => {
  it('a device already at the current version has nothing to refuse', () => {
    // The realistic shape: the app opens a database it last wrote itself.
    expect(domainStateMigrationsIn(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION)).toEqual([])
  })

  it('a database dragged forward ACROSS a domain-state migration reports it', () => {
    // The hypothetical the guard exists for: some future build adds a
    // domain-state migration at vN, and a camp with a document is opened by it.
    // Simulated here with a historical one, since none above v52 exists (yet).
    expect(domainStateMigrationsIn(30, 33)).toEqual([32])
  })
})
