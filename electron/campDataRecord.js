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

const ENTITY_NAMES = [
  'camps', 'tiers', 'cohorts', 'groups', 'campers', 'locations', 'activities',
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
  let writing = false
  let pendingAgain = false

  function targetPath(campName) {
    const dir = path.join(documentsDir, 'Shoresh')
    const suffix = isDev ? ' (dev)' : ''
    const file = `${sanitizeFilenamePart(campName)} data${suffix}.xlsx`
    return { dir, file, full: path.join(dir, file) }
  }

  function fireOnce() {
    try {
      const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
      if (!camp) return

      const entities = {}
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

  function runFire() {
    if (writing) {
      // A new schedule() arrived while a write was in flight — the trailing
      // edge already fired, so make sure a follow-up write happens once this
      // one finishes rather than dropping the newer data.
      pendingAgain = true
      return
    }
    writing = true
    try {
      fireOnce()
    } finally {
      writing = false
      if (pendingAgain) {
        pendingAgain = false
        runFire()
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      runFire()
    }, debounceMs)
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { schedule, dispose }
}
