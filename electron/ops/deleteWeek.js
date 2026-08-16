import { appendOp, DELETE_FIELD } from './operations.js'

// Permanently delete a week and every row scoped to it, in one transaction,
// children before parents, every delete routed through the op-log so it
// replicates and is auditable.
//
// HOST ONLY — same pattern as deleteRecord.js and duplicateWeek.js. A Client
// cannot express a multi-op atomic transaction over submit_op, and a Client's
// delete could execute against a count the director was shown earlier.
//
// Cascade order per spec §4.1 — load-bearing, do not reorder:
//   1. schedule_snapshots      (real FK → schedule_templates)
//   2. template_overlays       (real FK → schedule_templates)
//   3. template_slots          (no FK — orphans must be cleaned explicitly)
//   4. week_activity_exclusions
//   5. week_group_exclusions
//   6. week_location_exclusions (no FK on location_id — see M1's deliberate
//      no-FK convention, deleteRecord.js:40; week_id itself IS a real FK)
//   7. conflicts               (unresolved rows pointing at entities deleted above)
//   8. schedule_templates      (real FK ← schedule_weeks via week_id)
//   9. schedule_weeks          (the week row itself, last)
//
// Explicitly NOT cascaded (not an omission):
//   - day_override_templates / day_override_template_slots — camp-scoped via
//     camp_id, no relationship to weeks at all.
//   - operations — append-only history, never deleted; this is what makes
//     the delete auditable across devices.
//
// Returns { ops } for the caller to broadcast after commit,
// or { error: 'last-week' } if this is the camp's only week.
export function deleteWeek(db, { weekId, campId }, { author_user_id, device_id } = {}) {
  if (typeof weekId !== 'string' || !weekId) return { error: 'no-week' }

  // S3-2: Last-week guard — data-layer invariant, before the transaction.
  // The UI also prevents it, but this guard lives here.
  const weekCount = db.prepare('SELECT COUNT(*) as c FROM schedule_weeks WHERE camp_id = ?').get(campId).c
  if (weekCount <= 1) return { error: 'last-week' }

  if (!db.prepare('SELECT 1 FROM schedule_weeks WHERE id = ?').get(weekId)) {
    return { error: 'no-week' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = db.transaction(() => {
    const ops = []

    const templates = db
      .prepare('SELECT id FROM schedule_templates WHERE week_id = ?')
      .all(weekId)

    // Collect deleted entity ids for conflict closure (steps 1–5).
    const deletedEntityIds = new Set()

    for (const tmpl of templates) {
      // Step 1: schedule_snapshots
      const snapshots = db
        .prepare('SELECT id FROM schedule_snapshots WHERE template_id = ?')
        .all(tmpl.id)
      for (const s of snapshots) {
        ops.push(del('schedule_snapshots', s.id))
        deletedEntityIds.add(s.id)
      }

      // Step 2: template_overlays
      const overlays = db
        .prepare('SELECT id FROM template_overlays WHERE template_id = ?')
        .all(tmpl.id)
      for (const o of overlays) {
        ops.push(del('template_overlays', o.id))
        deletedEntityIds.add(o.id)
      }

      // Step 3: template_slots (no FK — orphans must be cleaned explicitly)
      const slots = db
        .prepare('SELECT id FROM template_slots WHERE template_id = ?')
        .all(tmpl.id)
      for (const sl of slots) {
        ops.push(del('template_slots', sl.id))
        deletedEntityIds.add(sl.id)
      }
    }

    // Step 4: week_activity_exclusions
    const actExclusions = db
      .prepare('SELECT id FROM week_activity_exclusions WHERE week_id = ?')
      .all(weekId)
    for (const e of actExclusions) {
      ops.push(del('week_activity_exclusions', e.id))
      deletedEntityIds.add(e.id)
    }

    // Step 5: week_group_exclusions
    const grpExclusions = db
      .prepare('SELECT id FROM week_group_exclusions WHERE week_id = ?')
      .all(weekId)
    for (const e of grpExclusions) {
      ops.push(del('week_group_exclusions', e.id))
      deletedEntityIds.add(e.id)
    }

    // Step 6: week_location_exclusions
    const locExclusions = db
      .prepare('SELECT id FROM week_location_exclusions WHERE week_id = ?')
      .all(weekId)
    for (const e of locExclusions) {
      ops.push(del('week_location_exclusions', e.id))
      deletedEntityIds.add(e.id)
    }

    // S3-3: Step 7 — conflict closure.
    // Close any unresolved conflicts rows whose entity_id is one of the rows
    // deleted in steps 1–6. Closing means a delete op, not raw SQL, so it
    // replicates and appears in history.
    if (deletedEntityIds.size > 0) {
      const pendingConflicts = db
        .prepare('SELECT id, entity_id FROM conflicts WHERE resolved_at IS NULL')
        .all()
      for (const c of pendingConflicts) {
        if (deletedEntityIds.has(c.entity_id)) {
          ops.push(del('conflicts', c.id))
        }
      }
    }

    // Step 8: schedule_templates (both manual + generated)
    for (const tmpl of templates) {
      ops.push(del('schedule_templates', tmpl.id))
    }

    // Step 9: schedule_weeks — the week row itself, last
    ops.push(del('schedule_weeks', weekId))

    return { ok: true, ops }
  })()

  return outcome
}
