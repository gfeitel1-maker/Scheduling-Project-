import { runAtomic } from './operations.js'
import { cascadeDeleteElectiveRun } from './deleteElectiveRun.js'

// T343 — director-triggered purge of elective runs with deleteElectiveRun's
// exact cascade, all in one runAtomic frame (all or none). Scope is explicit:
//   'season' (default) — EVERY run, including schedule_week_id NULL runs;
//   'week'             — only runs whose schedule_week_id = weekId (exact match;
//                        NULL-week runs are NOT matched). weekId is required.
// Offerings setup (sets, bundles, ...) and every non-elective table are
// deliberately untouched. Idempotent: with no in-scope runs it returns
// { ok: true, runsDeleted: 0, ops: [] }.
export function purgeElectiveSeason(db, { scope = 'season', weekId, author_user_id, device_id } = {}) {
  if (scope !== 'season' && scope !== 'week') throw new Error(`unknown purge scope: ${scope}`)
  if (scope === 'week' && (typeof weekId !== 'string' || weekId === '')) throw new Error('weekId is required for a by-week purge')
  return runAtomic(db, () => {
    const runs = scope === 'week'
      ? db.prepare('SELECT id FROM elective_assignment_runs WHERE schedule_week_id = ?').all(weekId)
      : db.prepare('SELECT id FROM elective_assignment_runs').all()
    const ops = runs.flatMap((r) => cascadeDeleteElectiveRun(db, r.id, { author_user_id, device_id }))
    return { ok: true, runsDeleted: runs.length, ops }
  })
}
