import { runAtomic } from './operations.js'
import { cascadeDeleteElectiveRun } from './deleteElectiveRun.js'

// T343 — end-of-season purge: delete EVERY elective run with deleteElectiveRun's
// exact cascade, all in one runAtomic frame (all or none). Offerings setup
// (sets, bundles, ...) and every non-elective table are deliberately untouched.
// Idempotent: with no runs it returns { ok: true, runsDeleted: 0, ops: [] }.
export function purgeElectiveSeason(db, { author_user_id, device_id } = {}) {
  return runAtomic(db, () => {
    const runs = db.prepare('SELECT id FROM elective_assignment_runs').all()
    const ops = runs.flatMap((r) => cascadeDeleteElectiveRun(db, r.id, { author_user_id, device_id }))
    return { ok: true, runsDeleted: runs.length, ops }
  })
}
