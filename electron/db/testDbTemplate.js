// A prebuilt-schema database for tests. Replaces `openLocalDb(freshPath)` in test setup.
//
// WHY: openLocalDb on a new file replays the whole migration chain. Measured 2026-09-16 (T188,
// quiet machine, schema v65): 304ms per call. electron/main.test.js alone calls it in beforeEach
// for 171 tests — 52s of its measured 70.2s is CREATE TABLE, not testing. Across the suite, 68
// files rebuild the schema per test (1084 tests), ~330s of the 1327s of total test file-time.
//
// WHAT THIS DOES: build the migrated database ONCE per process, then give each test a byte copy of
// it. Copying a finished SQLite file is ~10x cheaper than replaying 65 migrations into a new one:
// measured 304ms -> 27ms, and the copy reports the same CURRENT_SCHEMA_VERSION (65).
//
// WHY IT IS SAFE: the copy is the real database the real migration chain produced — not a
// hand-written schema, which is the T62 defect class (a fixture built from the code under test
// rather than from the schema, green for a month while the engine double-booked Lunch). The chain
// itself is still exercised in full by electron/db/*.migration.test.js; this only stops re-proving
// it once per test in files that are testing something else.
//
// THE HAZARD THIS HANDLES: openLocalDb seeds `device_identity` with one row, so every copy would
// otherwise share a device id — silently breaking any test that needs two distinct devices. The
// copy clears that row so getOrCreateDeviceId mints a fresh identity per test. Verified: 25/25
// distinct ids across 25 copies.
//
// WHEN NOT TO USE IT: anything asserting migration behaviour itself (fresh-vs-migrated equivalence,
// idempotency, rollback, write traces) must keep calling openLocalDb on a genuinely new file — the
// chain replay IS the thing under test there.
//
// THE FILES THAT MUST NOT BE CONVERTED, by name. This list lives here rather than only in a commit
// message, because "why isn't X converted?" is asked while reading the code, not while reading
// `git log` (Code Reviewer, T188/F2). All 33 electron/db/*.migration.test.js are excluded by the
// rule above; these 11 are the non-obvious ones:
//
//   electron/db/localDb.test.js .................... tests openLocalDb itself
//   electron/db/sqliteCipher.integration.test.js ... at-rest cipher; this template is PLAINTEXT
//   electron/db/projectManager.test.js ............. opens/copies/restores db FILES; paths are the subject
//   electron/db/userDataPath.test.js ............... no openLocalDb call site to convert
//   src/engine/fixtureSchemaParity.test.js ......... schema parity is the subject
//   electron/ops/undoReferences.schemaParity.test.js  schema parity is the subject
//   electron/ops/projectionsCoverage.test.js ....... introspects schema/registry coverage
//   electron/ipcSurfaceParity.test.js .............. reads source for surface parity
//   scripts/mcp/tools.test.js ...................... CLI-shaped setup, 16 call sites
//   scripts/ingestCli.test.js ...................... CLI-shaped setup, 8 call sites
//   electron/automerge/rebuildSupportCommand.test.js  rebuild over a real db file
//
// IF YOU ARE CONVERTING MORE FILES: ~38 remain, refused by the F2 transformer because their setup
// shape was unfamiliar. Converting one REMOVES the `path.join(os.tmpdir(), ...)` setup line, which
// orphans the file's `os`, `path` and `openLocalDb` imports. `npm test` will not tell you — vitest
// never runs ESLint — and the first F2 pass shipped 141 such lint errors across 49 files for exactly
// that reason. Prune the dead imports and run `npx eslint <the files>` before committing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from './localDb.js'

let templatePath = null
const created = []

function tmpPath(tag) {
  return path.join(os.tmpdir(), `shoresh-${tag}-${process.pid}-${Date.now()}-${Math.random()}.sqlite`)
}

// Build (once per process) a fully migrated database and close it, so SQLite checkpoints the WAL
// into the main file and a plain byte copy is complete. Copying while a connection is open would
// leave committed pages behind in the -wal sidecar.
//
// OPENED ONCE. This helper was originally opened TWICE, to work around a migration defect: a
// fresh database came back with 25 declared indexes and the same file reopened had 26. The extra
// one was idx_schedule_snapshots_template_id — schema.sql declares it, then migrations v53/v59
// rebuild schedule_snapshots (DROP TABLE + RENAME), which dropped it, and schema.sql's CREATE
// INDEX had already run for that open so it did not re-fire until the next one. The
// schema-equivalence assertion in this helper's own test is what surfaced it.
//
// T189 fixed that at the source: both rebuild blocks now re-create the index after their RENAME,
// and electron/db/schemaIndexParity.migration.test.js guards first-open/second-open parity for
// every declared non-table object, whole-database, so the divergence cannot come back unnoticed.
// The second open is therefore a proven no-op and is gone, as the author of the convergence
// workaround asked for in the note this comment replaces. The template is still a fixed point —
// it is now one because openLocalDb is idempotent across opens, which is the property that should
// have been true all along, rather than because this helper opened until it converged.
function ensureTemplate() {
  if (templatePath && fs.existsSync(templatePath)) return templatePath
  const p = tmpPath('tpl')
  openLocalDb(p).close()
  created.push(p)
  templatePath = p
  return p
}

// A fresh, fully migrated database, cheap. Returns the open handle; `.close()` it as usual.
export function openTemplatedDb() {
  const target = tmpPath('db')
  fs.copyFileSync(ensureTemplate(), target)
  created.push(target)
  const db = openLocalDb(target)
  // Re-mint identity per test — see "THE HAZARD THIS HANDLES" above.
  db.prepare('DELETE FROM device_identity').run()
  return { db, file: target }
}

// Remove every file this helper created, including SQLite's -wal/-shm sidecars.
export function cleanupTemplatedDbs() {
  for (const f of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(f + suffix, { force: true }) } catch { /* best effort */ }
    }
  }
  templatePath = null
}
