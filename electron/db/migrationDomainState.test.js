// @vitest-environment node
//
// The mechanism, not the data: these fail when someone adds a migration without
// deciding whether it changes what the camp MEANS. That decision is the whole
// point of migrationDomainState.js — the guard it feeds cannot fire for a
// migration nobody classified.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { CURRENT_SCHEMA_VERSION } from './localDb.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import {
  DOMAIN_STATE_MIGRATIONS,
  SCHEMA_ONLY_MIGRATIONS,
  isDomainStateMigration,
  domainStateMigrationsIn,
  unresolvedDomainStateMigrations,
  shouldRefuseSyncForDomainMigration,
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
    expect(domainStateMigrationsIn(32, CURRENT_SCHEMA_VERSION)).toEqual([70])
  })

  it('a fresh database (from 0) reports every one of them — and has no document by definition', () => {
    expect(domainStateMigrationsIn(0, CURRENT_SCHEMA_VERSION)).toEqual([...DOMAIN_STATE_MIGRATIONS.keys()].sort((a, b) => a - b))
  })

  it('T205: v70 is the FIRST domain-state migration above v52 — made reachable on purpose', () => {
    // Until T205, nothing above v52 changed domain state, so main.js's
    // sync-start guard was provably unreachable (a database with a document is
    // already at v57+). v70 (days_of_operation dedupe) is the first migration
    // to actually run against real data above that line, which is exactly why
    // T205 hardened the guard to be durable across restarts
    // (domain_state_migration_pending) instead of leaving it as the
    // one-launch-only WeakMap span. A future migration in this set must get
    // the SAME durable-marker treatment, not just a classification entry.
    const aboveDocumentEra = [...DOMAIN_STATE_MIGRATIONS.keys()].filter((v) => v > 52)
    expect(aboveDocumentEra).toEqual([70])
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
    // THE INDIRECT ONE IS NOW COVERED, elsewhere: migrationWriteTrace.test.js
    // runs the chain with the db handle instrumented and reads the statements
    // SQLite was actually asked to execute, which no amount of indirection can
    // hide. This scan stays because it is fast and needs no fixture, and because
    // two measurements with different blind spots beat either alone — but it is
    // no longer the only thing standing between a helper-routed backfill and a
    // silent misclassification.
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
    // DERIVED, not hand-listed. A second copy of "which tables the document
    // owns" is exactly the drift this guard exists to prevent, and the first
    // draft's hand-typed list was already wrong: it omitted `camp_maps` and
    // every parent-scoped child, so a migration writing one of those inline
    // would have passed silently.
    const MODELED = [...DIRECT_CAMP_ENTITIES, ...Object.keys(PARENT_SCOPED_ENTITIES)]
    const offenders = []
    let start = 0
    for (const { line, version } of stamps) {
      const block = lines.slice(start, line + 1).join('\n')
      start = line + 1
      if (!SCHEMA_ONLY_MIGRATIONS.has(version)) continue
      for (const table of MODELED) {
        // `_vNN` shadow tables are shape work; so is a bare CREATE/DROP/ALTER.
        // DELETE belongs here as much as UPDATE/INSERT: removing a row changes
        // what the camp means at least as much as editing one. Its absence from
        // the first draft is why v13 — a time_blocks de-duplication, the same
        // shape as v11/v12/v14/v15 — read as schema-only for as long as it did.
        // Found by the execution trace (migrationWriteTrace.test.js), which
        // measures what ran instead of reading what was written.
        const write = new RegExp(`(UPDATE|INSERT INTO|INSERT OR \\w+ INTO|DELETE FROM)\\s+${table}\\b(?!_v)`, 'i')
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

describe('T205 part D: durable domain-state refusal', () => {
  it('unresolvedDomainStateMigrations reads rows with resolved_at IS NULL', () => {
    const db = { prepare: () => ({ all: () => [{ version: 70, detail: 'x', created_at: 't' }] }) }
    expect(unresolvedDomainStateMigrations(db)).toEqual([{ version: 70, detail: 'x', created_at: 't' }])
  })

  it('shouldRefuseSyncForDomainMigration: never refuses when no document exists', () => {
    expect(
      shouldRefuseSyncForDomainMigration({ docExists: false, riskyThisLaunch: [70], unresolvedMarkers: [{ version: 70 }] })
    ).toBe(false)
  })

  it('shouldRefuseSyncForDomainMigration: refuses on THIS launch\'s own risky span (existing behavior)', () => {
    expect(
      shouldRefuseSyncForDomainMigration({ docExists: true, riskyThisLaunch: [70], unresolvedMarkers: [] })
    ).toBe(true)
  })

  // THE ONE-LAUNCH-ONLY DEFECT'S FIX: a SECOND launch (fresh process, empty
  // WeakMap) reports NOTHING risky for its own span (from === to), but the
  // durable marker from the FIRST launch is still unresolved — must still refuse.
  it('shouldRefuseSyncForDomainMigration: refuses on a SECOND launch via the durable marker alone, even with an empty per-launch span', () => {
    expect(
      shouldRefuseSyncForDomainMigration({ docExists: true, riskyThisLaunch: [], unresolvedMarkers: [{ version: 70 }] })
    ).toBe(true)
  })

  it('shouldRefuseSyncForDomainMigration: does not refuse when nothing is risky and nothing is pending', () => {
    expect(
      shouldRefuseSyncForDomainMigration({ docExists: true, riskyThisLaunch: [], unresolvedMarkers: [] })
    ).toBe(false)
  })
})
