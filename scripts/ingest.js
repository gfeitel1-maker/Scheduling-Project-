#!/usr/bin/env node
// Thin CLI wrapper around scripts/ingestCli.js's runIngestCli — argv parsing
// and stdout printing only. Run under Node with better-sqlite3 built for the
// Node ABI (npm rebuild better-sqlite3), the same ABI the test suite uses.
//
// docs/work/specs/2026-08-20-ingestion-cli-design.md
//
//   node scripts/ingest.js <file> --db <path> [--preview | --commit] [--mode add|replace] [--author <userId>] [--json]

import { fileURLToPath } from 'node:url'
import { runIngestCli } from './ingestCli.js'

const USAGE = 'usage: node scripts/ingest.js <file> --db <path> [--preview | --commit] [--mode add|replace] [--author <userId>] [--json]'

export function parseArgs(argv) {
  const opts = { file: null, dbPath: null, action: 'preview', mode: 'add', authorUserId: null, json: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') opts.dbPath = argv[++i]
    else if (arg === '--preview') opts.action = 'preview'
    else if (arg === '--commit') opts.action = 'commit'
    else if (arg === '--mode') opts.mode = argv[++i]
    else if (arg === '--author') opts.authorUserId = argv[++i]
    else if (arg === '--json') opts.json = true
    else positional.push(arg)
  }
  opts.file = positional[0] ?? null
  return opts
}

function printHuman(result) {
  const lines = []
  lines.push(`${result.action === 'commit' ? 'Commit' : 'Preview'} — ${result.file} -> ${result.db} (mode: ${result.mode})`)
  if (result.error) {
    lines.push(`ERROR: ${result.error}`)
  }
  if (result.summary) {
    const s = result.summary
    const created = Object.entries(s.created ?? {})
      .filter(([, n]) => n > 0)
      .map(([entity, n]) => `${entity}: ${n}`)
      .join(', ') || 'none'
    lines.push(`created: ${created}`)
    lines.push(`updated: ${s.updated}  unchanged: ${s.unchanged ?? 'n/a'}  conflicts: ${s.conflicts}  fixed events created: ${s.fixedEventsCreated}`)
    if (s.held) lines.push('HELD — nothing was written. Resolve the conflicts below and retry.')
  }
  if (result.conflicts?.length > 0) {
    lines.push(`conflicts (${result.conflicts.length}):`)
    for (const c of result.conflicts) lines.push(`  - ${c.reason ?? 'conflict'}: ${JSON.stringify(c)}`)
  }
  if (result.residual) {
    const { sheets, cells } = result.residual
    if (sheets.length === 0 && cells.length === 0) {
      lines.push('residual: none — every sheet and cell was recognised')
    } else {
      lines.push(`residual: ${sheets.length} sheet(s) and ${cells.length} cell(s) not recognised`)
      for (const s of sheets) lines.push(`  sheet "${s.sheet}": ${JSON.stringify(s.sample)}`)
      for (const c of cells) lines.push(`  cell "${c.value}" (x${c.count})`)
    }
  }
  console.log(lines.join('\n'))
}

export function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const opts = parseArgs(argv)
  if (!opts.file || !opts.dbPath) {
    console.error(USAGE)
    return 1
  }
  if (opts.mode !== 'add' && opts.mode !== 'replace') {
    console.error(`invalid --mode: ${opts.mode} (must be add or replace)`)
    return 1
  }

  const result = runIngestCli(opts)
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
