#!/usr/bin/env node
// Ingestion pressure-test sweep (read-only). Drives every schedule file in a
// directory through the REAL headless ingest preview against a throwaway camp
// and prints, per file: does it parse (or fail gracefully), what it extracts,
// how names route (activities / fixed events / recurring events), the inferred
// weekly-frequency spread, and any near-duplicate activity names that survived
// canonicalization (a word-form typo like "Swim Return"/"Swim Returning" that no
// safe deterministic rule merges — a human's-eye candidate).
//
// Nothing is committed and no real db is touched — preview is a dry run against
// a fresh temp camp. This is the standing "Layer A + a Layer-B first look" tool
// (docs/work/testing/ ingestion side); point it at a folder of real files:
//
//   npm run ingest:sweep -- --dir "/path/to/schedules"        (defaults to ~/Desktop/camp schedules)
//   npm run ingest:sweep -- --dir "/path" --file "One File.xlsx"   (one file, full breakdown)
//
// ABI: runs under Node — `npm run ingest:sweep` triggers the same premcp-style
// rebuild guard is NOT wired here, so run `npm rebuild better-sqlite3` first if
// electron:dev ran most recently (see CLAUDE.md).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { runIngestCli } from './ingestCli.js'
import { workbookToPages } from '../src/ingest/sheetGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'

const WORKBOOK_EXT = /\.(xlsx|xlsm|xls)$/i
const SWEEPABLE_EXT = /\.(xlsx|xlsm|xls|csv|txt)$/i
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const wsKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

// Human-check candidates: HIGH-PRECISION word-ending variants — one name is
// exactly the other plus a grammatical suffix ("Swim Return" → "Swim Returning").
// These are the word-form typos the importer deliberately does NOT auto-merge
// (a wrong merge malforms generation), surfaced for a human to judge. Precise on
// purpose: numbered siblings ("Lunch 1"/"Lunch 2") and unrelated names are NOT
// flagged — only a stem + {s, es, ed, d, ing} tail.
const WORD_ENDING = /^(s|es|ed|d|ing|ning|ping|ting)$/
function findNearDuplicateNames(names) {
  const uniq = [...new Set(names.filter((n) => wsKey(n).length >= 4))]
  const out = []
  for (let i = 0; i < uniq.length; i++) {
    for (let j = 0; j < uniq.length; j++) {
      if (i === j) continue
      const a = wsKey(uniq[i])
      const b = wsKey(uniq[j])
      if (b.length > a.length && b.startsWith(a) && WORD_ENDING.test(b.slice(a.length))) {
        out.push([uniq[i], uniq[j]])
      }
    }
  }
  return out
}

function bootstrapThrowawayDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-sweep-'))
  const dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Sweep Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(randomUUID(), 'Host')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Op', 'h', 's', 'admin')").run(randomUUID(), campId)
  db.close()
  return dbPath
}

function pagesFor(file) {
  const buf = fs.readFileSync(file)
  if (!WORKBOOK_EXT.test(file)) return null // preview handles text; breakdown is workbook-only
  const wb = XLSX.read(buf, { type: 'buffer' })
  const sheets = wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false }),
  }))
  return workbookToPages(sheets, path.basename(file))
}

// The activity/fixed/recurring/rules breakdown for one workbook.
function breakdown(file) {
  const pages = pagesFor(file)
  if (!pages) return null
  const p = extractEntities({ pages })
  const { fixedEvents, dualUseNames } = inferFixedEvents({ pages }, p)
  const feNames = new Set((fixedEvents || []).map((f) => norm(f.name)))
  const dualUse = new Set((dualUseNames || []).map(norm))
  const pinOnly = new Set([...feNames].filter((n) => !dualUse.has(n)))
  const rules = inferActivityRules(
    p.entities.activities || [], p.activityPages, p.seenCounts,
    (p.entities.days_of_operation || []).length, p.entities.groups || [], [...pinOnly]
  )
  const freq = {}
  for (const r of rules.values()) freq[r.min_per_week] = (freq[r.min_per_week] || 0) + 1

  // near-duplicate names that survived whitespace-canonicalization: a bounded
  // edit-distance pass surfaces word-form typos ("Swim Return"/"Swim Returning")
  // for a HUMAN to judge — never auto-merged (a wrong merge malforms generation
  // as badly as a duplicate). Tuned to catch a short suffix/typo while NOT
  // flagging genuinely-distinct pairs ("Swim" vs "Swim Return", len diff 6).
  const nearDups = findNearDuplicateNames(p.entities.activities || [])

  return {
    entities: p.counts,
    fixed: (fixedEvents || []).filter((f) => f.kind === 'fixed'),
    recurring: (fixedEvents || []).filter((f) => f.kind === 'recurring'),
    activities: p.entities.activities || [],
    rules, freq, nearDups,
  }
}

function main() {
  const dir = arg('dir', path.join(os.homedir(), 'Desktop', 'camp schedules'))
  const only = arg('file', null)
  if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(1) }
  const dbPath = bootstrapThrowawayDb()
  const files = fs.readdirSync(dir)
    .filter((f) => SWEEPABLE_EXT.test(f) && !f.startsWith('~$') && !f.startsWith('.'))
    .filter((f) => !only || f === only)
    .sort()

  console.log(`\nIngest sweep — ${files.length} file(s) in ${dir}\n${'='.repeat(72)}`)
  for (const f of files) {
    const full = path.join(dir, f)
    let prev
    try { prev = runIngestCli({ file: full, dbPath, mode: 'add', action: 'preview' }) }
    catch (e) { console.log(`\n### ${f}\n  CRASH: ${e.message}`); continue }
    if (prev.error) { console.log(`\n### ${f}\n  did not parse: ${prev.error}`); continue }

    const b = breakdown(full)
    console.log(`\n### ${f}`)
    console.log(`  entities: ${Object.entries(b.entities).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log(`  fixed events (all-camp): ${b.fixed.length}  |  recurring (group-scoped): ${b.recurring.length}`)
    console.log(`  activity weekly-frequency spread (min/wk → count): ${JSON.stringify(b.freq)}`)
    if (b.nearDups.length) {
      console.log(`  ⚠ near-duplicate activity names (human check — word-form typos survive canonicalization):`)
      for (const d of b.nearDups) console.log(`      ${d.join('  ·  ')}`)
    }
    if (only) {
      console.log(`  activities: ${b.activities.join(', ')}`)
      console.log(`  fixed: ${b.fixed.map((e) => e.name).join(', ')}`)
      console.log(`  recurring: ${b.recurring.map((e) => `${e.name} [${(e.scope?.groups || []).length || 'all'}]`).join(', ')}`)
    }
  }
  console.log(`\n${'='.repeat(72)}\nRead-only: no data was changed. Point --dir at a folder of real files to widen coverage.`)
}

main()
