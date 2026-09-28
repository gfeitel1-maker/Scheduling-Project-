import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as XLSX from 'xlsx'
import { listEntities } from './ops/read.js'
import { buildCampDataWorkbook } from '../src/utils/buildCampDataWorkbook.js'

// T292 S2 — the main-process auto-writer for the read-only camp data
// document. docs/work/specs/2026-09-28-t292-database-document-view.md §3.
//
// LOAD-BEARING SAFETY PROPERTY: this writer's fire path must NEVER throw
// into, or block, the op-apply path that triggers it. Every failure mode
// (Documents unwritable, file locked by Excel, etc.) is caught, logged with
// console.error (console.log is dropped in non-TTY gate output — see
// docs/work/... vitest console.log note), and retried on the next
// schedule() rather than surfaced as a crash.

// Round 2 FIX 1: 'camps' is deliberately NOT listed here. listEntities(db,
// 'camps') throws ("Unrecognized entity: camps") — camps is neither in
// DIRECT_CAMP_ENTITIES nor PARENT_SCOPED_ENTITIES (campScopedEntities.js);
// it is looked up directly by fireOnce's own `SELECT id, name FROM camps`
// instead, and that single row is what becomes entities.camps below.
const ENTITY_NAMES = [
  'tiers', 'cohorts', 'groups', 'campers', 'locations', 'activities',
  'days_of_operation', 'time_blocks', 'schedule_weeks', 'fixed_events',
  'special_days', 'events', 'elective_sets',
]

function sanitizeFilenamePart(name) {
  return String(name ?? '').replace(/[/\\:*?"<>|]/g, '_').trim() || 'Camp'
}

function defaultWriteFn(wb) {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

export function createCampDataRecordWriter({
  db,
  documentsDir,
  isDev = false,
  debounceMs = 1500,
  now = () => new Date(),
  fsImpl = fs,
  listEntitiesFn = listEntities,
  buildFn = buildCampDataWorkbook,
  writeFn = defaultWriteFn,
} = {}) {
  let timer = null

  function targetPath(campName) {
    const dir = path.join(documentsDir, 'Shoresh')
    const suffix = isDev ? ' (dev)' : ''
    const file = `${sanitizeFilenamePart(campName)} data${suffix}.xlsx`
    return { dir, file, full: path.join(dir, file) }
  }

  // Round 2 FIX 6: fireOnce is entirely synchronous (fs.*Sync throughout, no
  // await/yield point), so two invocations can never genuinely overlap on
  // this single-threaded event loop — a "writing" re-entrancy guard around a
  // fully synchronous function is dead code that can never be observed true.
  // Removed rather than kept as decoration. The accepted tradeoff this
  // leaves: fireOnce's synchronous fs calls run on the main thread, so a very
  // large camp's write briefly blocks it. flush() (quit path) needs this
  // synchronicity anyway; the debounced path could be made async later if a
  // real camp's write time is ever shown to matter, but no camp so far comes
  // close (see spec's expected row counts).
  function fireOnce() {
    try {
      const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
      if (!camp) return

      const entities = { camps: [camp] }
      for (const name of ENTITY_NAMES) {
        entities[name] = listEntitiesFn(db, name)
      }

      const wb = buildFn({ entities, campName: camp.name, asOf: now() })
      const buffer = writeFn(wb)

      const { dir, full } = targetPath(camp.name)
      if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true })

      const tempPath = path.join(dir, `.${sanitizeFilenamePart(camp.name)}.${randomBytes(4).toString('hex')}.tmp`)
      try {
        fsImpl.writeFileSync(tempPath, buffer)
        fsImpl.renameSync(tempPath, full)
      } finally {
        // Best-effort cleanup if the rename never happened (write threw, or
        // renameSync itself threw) — never leave a stray temp file behind.
        if (fsImpl.existsSync(tempPath)) {
          try { fsImpl.unlinkSync(tempPath) } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      console.error('[campDataRecord] failed to write camp data document (will retry on next change):', err)
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fireOnce()
    }, debounceMs)
  }

  // Round 2 FIX 3: called from app's will-quit. If a debounced write is
  // still pending, write it NOW, synchronously, instead of losing it to the
  // process exiting before the timer fires. A no-op when nothing is pending.
  // fireOnce already catches every failure internally, so this can never
  // throw into the quit handler.
  function flush() {
    if (!timer) return
    clearTimeout(timer)
    timer = null
    fireOnce()
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { schedule, flush, dispose }
}
