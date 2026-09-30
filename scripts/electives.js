#!/usr/bin/env node
// Thin CLI wrapper around scripts/electivesCli.js's runElectivesCli — argv parsing and stdout
// printing only, mirroring scripts/ingest.js exactly.
//
//   node scripts/electives.js preview --file <path> --db <path> [--author <userId>] [--json]
//   node scripts/electives.js commit --file <path> --db <path> [--author <userId>] [--json]
//   node scripts/electives.js export --run <runId> --db <path> --format json|xlsx [--file <path>] [--json]
//
// `generate` (solving a run) is NOT an action this CLI accepts.
//
// The ticket's `preview`/`commit` line also lists `--week --route --tier`. Those three flags are NOT
// accepted here: `runPreferenceSheetCli` (scripts/preferenceSheetCli.js) takes no such parameters, and
// a preference-sheet import is not scoped by week/route/tier — it derives a run from the sheet's own
// rows, not from a schedule slice the caller names in advance.

import { fileURLToPath } from 'node:url'
import { runElectivesCli } from './electivesCli.js'

const USAGE =
  'usage: node scripts/electives.js <preview|commit|export> --db <path> ' +
  '[--file <path>] [--author <userId>] [--run <runId>] [--format json|xlsx] [--json]'

export function parseArgs(argv) {
  const opts = { action: null, dbPath: null, file: null, authorUserId: null, runId: null, format: 'json', json: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') opts.dbPath = argv[++i]
    else if (arg === '--file') opts.file = argv[++i]
    else if (arg === '--author') opts.authorUserId = argv[++i]
    else if (arg === '--run') opts.runId = argv[++i]
    else if (arg === '--format') opts.format = argv[++i]
    else if (arg === '--json') opts.json = true
    else positional.push(arg)
  }
  opts.action = positional[0] ?? null
  return opts
}

function printHuman(result) {
  const lines = [`${result.action} — ${JSON.stringify(result.file ?? result.runId ?? '')}`]
  if (result.error) lines.push(`ERROR: ${result.error}`)
  if (result.ok && result.export) lines.push(`export: format_version ${result.export.format_version}`)
  if (result.ok && result.runId) lines.push(`runId: ${result.runId}`)
  console.log(lines.join('\n'))
}

export function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const opts = parseArgs(argv)
  if (!opts.action || !opts.dbPath) {
    console.error(USAGE)
    return 1
  }
  if (!['preview', 'commit', 'export'].includes(opts.action)) {
    console.error(`invalid action: ${opts.action} (must be preview, commit, or export)`)
    return 1
  }

  const result = runElectivesCli({
    action: opts.action,
    dbPath: opts.dbPath,
    file: opts.file,
    authorUserId: opts.authorUserId,
    runId: opts.runId,
    format: opts.format,
  })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printHuman(result)
  }
  return result.exitCode
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
