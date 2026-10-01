import { describe, it, expect } from 'vitest'
import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMA_FAMILY_GLOBS, resolveSchemaFamilyFiles } from './schemaCheck.js'

// Drift guard (board q-schema-bump-family-self-maintaining): if a new migration
// test file lands under a directory this script globs, it must be swept in
// automatically. What this guard can't catch is a NEW family member living
// under a directory/pattern nobody added to SCHEMA_FAMILY_GLOBS yet — that is
// a human call at ticket-writing time, not something a glob-vs-glob check can
// discover on its own.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

describe('schema:check family resolution', () => {
  it('every declared glob resolves to at least one real file', () => {
    for (const pattern of SCHEMA_FAMILY_GLOBS) {
      const matches = globSync(pattern, { cwd: repoRoot })
      expect(matches.length, `glob "${pattern}" resolved zero files`).toBeGreaterThan(0)
    }
  })

  it('resolves the full named family: every electron/db test, rollback tests, ops parity, ipc surface, purge collateral, the engine fixture-parity guard, and the two integration fixtures', () => {
    const files = resolveSchemaFamilyFiles(repoRoot)

    expect(files.length, 'family is suspiciously small — a glob likely stopped matching').toBeGreaterThan(60)

    const mustInclude = [
      'electron/db/localDb.migrations.test.js',
      'electron/db/schemaIndexParity.migration.test.js',
      'electron/db/rollback/bareEqualityRollback.guard.test.js',
      'electron/db/rollback/rollbackIdentity.guard.test.js',
      'electron/db/rollback/v86_down.test.js',
      'electron/ops/projectionsEntityParity.test.js',
      'electron/ops/slotOccupantCascadeParity.test.js',
      'electron/ops/electiveChoiceLabelKey.keyParity.test.js',
      'electron/ops/undoReferences.schemaParity.test.js',
      'electron/ipcSurfaceParity.test.js',
      'electron/automerge/purgeCollateral.test.js',
      // Round-1 Red Hat finding: these import CURRENT_SCHEMA_VERSION/getSchemaVersion
      // but carry no ".migration" in their filename, so the original
      // "*.migration*.test.js" glob silently omitted them.
      'electron/db/eraMigration.test.js',
      'electron/db/migrationDomainState.test.js',
      'electron/db/migrationWriteTrace.test.js',
      'electron/db/projectManager.test.js',
      'electron/db/testDbTemplate.test.js',
      // The fresh-vs-migrated schema parity guard, deliberately under src/engine/
      // (not electron/db/) to keep the engine pure — see its own file header.
      'src/engine/fixtureSchemaParity.test.js',
      // Real parse/placement pipelines exercised end-to-end; run cleanly standalone,
      // no automerge multi-node harness needed.
      'electron/electiveAcceptanceFixture.integration.test.js',
      'electron/ingestPassExclusivity.integration.test.js',
    ]
    for (const expected of mustInclude) {
      expect(files, `missing required family member ${expected}`).toContain(expected)
    }
  })

  it('returns no duplicates even when globs overlap', () => {
    const files = resolveSchemaFamilyFiles(repoRoot)
    expect(new Set(files).size).toBe(files.length)
  })
})
