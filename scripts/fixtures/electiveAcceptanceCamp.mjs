// Build the T199 §6 acceptance camp into a real database file, so the MANUAL
// half of T251's acceptance looks at THE SAME CAMP the automated half does.
//
// T251 (docs/work/tickets/T251-t199-acceptance-fixture.md);
// docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md §6.
//
// WHY THIS EXISTS. §6's conditions are checked by six vitest files against a
// camp built by electron/fixtures/electiveAcceptanceCamp.js. A director-eye
// pass over `npm run electron:dev` is a different kind of evidence and is worth
// having — but only if it is looking at the same camp. A second,
// hand-assembled dev camp would make the two halves incomparable, which is the
// whole reason the builder is one module. This script is a thin argv wrapper
// over that module and constructs nothing of its own.
//
// USAGE
//   node --import ./scripts/fixtures/registerElectronStub.mjs \
//        scripts/fixtures/electiveAcceptanceCamp.mjs --db <path> [--force]
//
// The default --db is the DEVELOPMENT database (`shoresh-dev`), never the
// installed app's. That is deliberate and matches the separation
// electron/db/userDataPath.js already enforces: development work cannot touch a
// real camp's data. The script REFUSES a database that already holds a camp
// unless --force is given, because the builder bootstraps a camp row and a
// second one in the same file would break the single-camp-per-device invariant
// every `SELECT ... FROM camps LIMIT 1` in this codebase depends on.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openLocalDb } from '../../electron/db/localDb.js'
import {
  seedAcceptanceCamp, importResolvedSheet, ACCEPTANCE_MANIFEST,
} from '../../electron/fixtures/electiveAcceptanceCamp.js'

function parseArgs(argv) {
  const out = { db: null, force: false, name: 'Director', pin: '123400' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') out.force = true
    else if (arg === '--db') out.db = argv[++i]
    else if (arg === '--name') out.name = argv[++i]
    else if (arg === '--pin') out.pin = argv[++i]
    else throw new Error(`unrecognised argument: ${arg}`)
  }
  return out
}

// The same path electron/db/userDataPath.js resolves for a DEV run. Recomputed
// rather than imported because that module reads it off Electron's `app`, which
// is not running here — and getting it wrong in the other direction (writing
// into the installed app's database) is the one mistake this script must not
// make, so the fallback is spelled out where a reader can check it.
function defaultDevDbPath() {
  const home = os.homedir()
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming')
      : path.join(home, '.config')
  return path.join(base, 'shoresh-dev', 'shoresh.sqlite')
}

// electron/main.js RUNS ITS STARTUP AT IMPORT TIME, and that startup cannot
// complete without a real Electron runtime — it fails and prints a
// director-facing "Shoresh could not start" banner. The failure is inert
// (`makeHandlers` is a pure export that does not depend on it, and the vitest
// files get exactly the same failure from their own electron mock), but the
// banner would tell whoever runs this script the opposite of what happened. So
// the import is deferred to here and its console output is held back — only its
// output, and only for the duration of the import.
async function loadHandlersFactory() {
  const real = { log: console.log, error: console.error, warn: console.warn }
  const held = []
  console.log = console.error = console.warn = (...a) => held.push(a)
  try {
    const mod = await import('../../electron/main.js')
    return mod.makeHandlers
  } finally {
    Object.assign(console, real)
  }
}

// A failure after the camp row is already written leaves a FRESH db file
// holding a half-built camp — worse than the "already holds N camp(s)" guard
// above, because a retry now sees a real camp row and refuses without
// --force, hiding that the camp is incomplete. Deletes the db file and its
// WAL/SHM sidecars, but only when THIS run created the file: a failure
// against a db the caller already owned is not this script's to delete.
export function deleteHalfBuiltDb(dbPath, { dbAlreadyExisted, campRowWritten }) {
  if (dbAlreadyExisted || !campRowWritten) return
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix) } catch { /* best effort */ }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db ?? defaultDevDbPath()
  if (/[/\\]shoresh[/\\]/.test(dbPath) && !args.force) {
    throw new Error(
      `${dbPath} looks like the INSTALLED app's database. Pass --db explicitly with --force if that is really what you want.`
    )
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const dbAlreadyExisted = fs.existsSync(dbPath)
  const db = openLocalDb(dbPath)
  let campRowWritten = false
  try {
    const existing = db.prepare('SELECT COUNT(*) c FROM camps').get().c
    if (existing > 0 && !args.force) {
      throw new Error(
        `${dbPath} already holds ${existing} camp(s). This builder bootstraps its own, and two camps in one ` +
        'database breaks the single-camp-per-device invariant. Move the file aside, or pass --force.'
      )
    }

    // THE SAME PREAMBLE THE VITEST HARNESS RUNS, from the same function. Hand-
    // copying it here was a sixth copy of the thing the shared module exists to
    // prevent, and a drift between it and the harness would make the manual and
    // automated halves of T251's acceptance incomparable — which is precisely
    // what this script's own header says must not happen. `makeHandlers` is
    // passed in rather than imported by the shared module, so the deferral
    // below still holds.
    const { campId, handlers, token, userId, fixture } = await seedAcceptanceCamp(db, {
      makeHandlers: await loadHandlersFactory(), name: args.name, pin: args.pin,
    })
    campRowWritten = true
    const imported = await importResolvedSheet(db, {
      dbPath, handlers, token, authorUserId: userId,
      campId, groupIdByName: fixture.groupIdByName,
    })

    process.stdout.write(
      `built ${ACCEPTANCE_MANIFEST.campName} in ${dbPath}\n` +
      `  sign in as ${args.name} / ${args.pin}\n` +
      `  elective set ${fixture.electiveSetId}\n` +
      `  imported run ${imported.runId}\n` +
      '  NOTE: no run is SOLVED — the solve lives inside AssignmentPanel, so the\n' +
      '        director does it by hand, which is the point of the manual pass.\n'
    )
  } catch (err) {
    db.close()
    deleteHalfBuiltDb(dbPath, { dbAlreadyExisted, campRowWritten })
    throw err
  }
  db.close()
}

// Guarded so electiveAcceptanceCamp.cleanup.test.mjs can import
// deleteHalfBuiltDb below without running the whole script as an import
// side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
  })
}
