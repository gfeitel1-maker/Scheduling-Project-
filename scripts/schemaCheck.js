// npm run schema:check — the whole schema-sensitive test family in one
// invocation, so a schema bump gets ONE CI round instead of the one-red-per-
// forgotten-file pattern v84/v85/v86 each cost (board q-schema-bump-family-
// self-maintaining). Family membership is globbed from disk, not hand-listed,
// so a newly added migration test is swept in automatically rather than
// requiring this file to be remembered and edited.
//
// electron/db/*.migration*.test.js was the first cut and it under-covered:
// Red Hat (round 1 review) found five electron/db/*.test.js files that import
// CURRENT_SCHEMA_VERSION/getSchemaVersion but don't carry ".migration" in
// their filename — eraMigration.test.js, migrationDomainState.test.js,
// migrationWriteTrace.test.js, projectManager.test.js, testDbTemplate.test.js
// — plus src/engine/fixtureSchemaParity.test.js, the fresh-vs-migrated schema
// parity guard that lives under src/engine/ deliberately (to keep the engine
// pure; see that file's own header) rather than under electron/db/. The glob
// below is now the whole electron/db/ directory, which is broader than
// "*.migration*" but is what actually makes "schema-sensitive" true rather
// than "named like a migration".
//
// Two integration-suffixed files ARE included here (electron/
// electiveAcceptanceFixture.integration.test.js,
// electron/ingestPassExclusivity.integration.test.js) because both run
// cleanly standalone under plain `vitest run` — confirmed by running them in
// isolation — and ingestPassExclusivity's own suite includes "is written
// against the current schema version". Neither needs test/integration's
// multi-process harness (that harness is `test/integration/scenarios/
// *.automerge.js`, a different naming convention entirely); the
// ".integration.test.js" suffix here means "a real parse/placement pipeline
// exercised end-to-end", not "needs the automerge multi-node harness". Naming
// them explicitly avoids leaving them silently unaccounted for.
import { globSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Each entry is a glob, relative to the repo root, describing one family member
// named in the ticket. Keep this list exactly in sync with that enumeration —
// schemaCheck.test.js asserts every glob resolves to at least one real file.
export const SCHEMA_FAMILY_GLOBS = [
  'electron/db/*.test.js',
  'electron/db/rollback/*.test.js',
  'electron/ops/*[Pp]arity*.test.js',
  'electron/ipcSurfaceParity.test.js',
  'electron/automerge/purgeCollateral.test.js',
  'src/engine/fixtureSchemaParity.test.js',
  'electron/electiveAcceptanceFixture.integration.test.js',
  'electron/ingestPassExclusivity.integration.test.js',
]

export function resolveSchemaFamilyFiles(root = repoRoot) {
  const files = new Set()
  for (const pattern of SCHEMA_FAMILY_GLOBS) {
    for (const match of globSync(pattern, { cwd: root })) {
      files.add(match)
    }
  }
  return [...files].sort()
}

function main() {
  const files = resolveSchemaFamilyFiles(repoRoot)
  if (files.length === 0) {
    console.error('schema:check found zero family files — globs in scripts/schemaCheck.js are stale.')
    process.exit(1)
  }

  console.log(`schema:check — running ${files.length} files across the schema-sensitive test family:`)
  for (const pattern of SCHEMA_FAMILY_GLOBS) console.log(`  ${pattern}`)
  console.log('')

  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--root', repoRoot, ...files],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  process.exit(result.status ?? 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
