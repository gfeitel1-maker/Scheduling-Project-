import { randomUUID } from 'node:crypto'
import { appendOp, appendBulkReplaceOp, BULK_REPLACE_ENTITIES } from './operations.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'

// Pick only the columns the bulk_replace entity accepts, replacing the id and
// the scope column with fresh values for the new template.
function pickBulkColumns(row, entity, newId, newScopeId) {
  const config = BULK_REPLACE_ENTITIES[entity]
  const out = {}
  for (const col of config.columns) {
    if (col === 'id') { out.id = newId; continue }
    if (col === config.scopeColumn) { out[col] = newScopeId; continue }
    const v = col in row ? row[col] : null
    out[col] = v === null || v === undefined ? null : String(v)
  }
  return out
}

// Duplicate a week: create a new schedule_weeks row, two new schedule_templates
// rows (one per route), copy all template_slots via
// appendBulkReplaceOp, and copy exclusion rows via per-row appendOp.
//
// The new week's ops are appended LAST (after all children) so a partially-
// replayed set does not surface a selectable-but-hollow week in the switcher.
//
// All client_write_ids are derived deterministically from the duplication's
// identity so a retried call (same sourceWeekId + newWeekId) produces exactly
// one copy. newWeekId is minted once before the transaction and reused on
// retry — callers that receive a timeout must pass the same newWeekId back.
//
// Returns { newWeekId, ops } for the caller to broadcast after commit.
// HOST ONLY — same pattern as deleteRecord.js.
export function duplicateWeek(db, { sourceWeekId, campId }, { author_user_id, device_id } = {}) {
  if (typeof sourceWeekId !== 'string' || !sourceWeekId) {
    return { error: 'no-source-week' }
  }

  const sourceWeek = db.prepare('SELECT * FROM schedule_weeks WHERE id = ?').get(sourceWeekId)
  if (!sourceWeek) return { error: 'no-source-week' }

  const newWeekId = randomUUID()

  // Collision-safe name for the new week.
  const existingNames = new Set(
    db.prepare('SELECT name FROM schedule_weeks WHERE camp_id = ?').all(campId).map((r) => r.name)
  )
  let newName = `${sourceWeek.name} copy`
  if (existingNames.has(newName)) {
    let n = 2
    while (existingNames.has(`${sourceWeek.name} copy (${n})`)) n++
    newName = `${sourceWeek.name} copy (${n})`
  }

  const maxSortOrder = db
    .prepare('SELECT MAX(sort_order) as m FROM schedule_weeks WHERE camp_id = ?')
    .get(campId)?.m ?? 0

  const ROUTES = ['generated', 'manual']

  let outcome
  outcome = db.transaction(() => {
    const ops = []

    const cwid = (entity, n) =>
      `dup:${sourceWeekId}:${newWeekId}:${entity}:${n}`

    // DELIBERATE op-log invariant deviation, not an oversight: schedule_templates.week_id
    // carries a NOT NULL FK to schedule_weeks, so the new week's row must exist inside
    // THIS transaction before any template op below can be appended and applied. A raw
    // INSERT OR IGNORE (placeholder name='', sort_order=0) is safe because:
    //   1. It is inside the same db.transaction() as every op below — a rollback here
    //      rolls back the raw insert too, so no partial state is ever visible.
    //   2. The ops appended later in this same transaction (the week-row ops near the
    //      end of this function) UPDATE this row with the real name/sort_order via
    //      applyProjection, so the creating device's final state is correct.
    //   3. On a peer device this raw insert is never replicated — only the ops are.
    //      The peer's own schedule_weeks ensureExists (op replay path) performs the
    //      equivalent INSERT OR IGNORE from op data, so convergence holds.
    // The row ops are still appended LAST (§3.4) — a partial sync sees children but not
    // the week in the switcher.
    // Cost: the week's row-creation event itself has no op-log entry — an observer
    // reading the op log sees the first `name` write as if it were the creation. This
    // is a known, accepted auditability gap, not a correctness gap. Making the op log
    // auditability-complete would require an explicit creation op — a separate ticket
    // with a real code change, not a comment.
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    db.prepare(
      "INSERT OR IGNORE INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, '', 0, 0)"
    ).run(newWeekId, camp?.id ?? campId)

    for (const kind of ROUTES) {
      const sourceTemplate = db
        .prepare('SELECT * FROM schedule_templates WHERE week_id = ? AND kind = ?')
        .get(sourceWeekId, kind)
      if (!sourceTemplate) continue

      const newTemplateId = deriveScheduleTemplateId(newWeekId, kind)

      // Write the template row: kind first (projections write-ordering contract).
      ops.push(appendOp(db, {
        entity: 'schedule_templates', entity_id: newTemplateId,
        field: 'kind', value: kind,
        author_user_id, device_id,
        client_write_id: cwid(`schedule_templates.kind.${kind}`, 0),
      }))
      ops.push(appendOp(db, {
        entity: 'schedule_templates', entity_id: newTemplateId,
        field: 'camp_id', value: campId,
        author_user_id, device_id,
        client_write_id: cwid(`schedule_templates.camp_id.${kind}`, 0),
      }))
      ops.push(appendOp(db, {
        entity: 'schedule_templates', entity_id: newTemplateId,
        field: 'week_id', value: newWeekId,
        author_user_id, device_id,
        client_write_id: cwid(`schedule_templates.week_id.${kind}`, 0),
      }))
      ops.push(appendOp(db, {
        entity: 'schedule_templates', entity_id: newTemplateId,
        field: 'name', value: sourceTemplate.name,
        author_user_id, device_id,
        client_write_id: cwid(`schedule_templates.name.${kind}`, 0),
      }))

      // Copy slots via bulk_replace (one atomic op — same shape as a generate()).
      const sourceSlots = db
        .prepare('SELECT * FROM template_slots WHERE template_id = ?')
        .all(sourceTemplate.id)
      const newSlots = sourceSlots.map((s) =>
        pickBulkColumns(s, 'template_slots', randomUUID(), newTemplateId)
      )
      ops.push(appendBulkReplaceOp(db, {
        entity: 'template_slots', scope_id: newTemplateId, rows: newSlots,
        author_user_id, device_id,
        client_write_id: cwid(`template_slots.${kind}`, 0),
      }))
    }

    // Copy exclusion rows (per-row ops, low cardinality).
    const actExclusions = db
      .prepare('SELECT * FROM week_activity_exclusions WHERE week_id = ?')
      .all(sourceWeekId)
    actExclusions.forEach((e, n) => {
      const newId = randomUUID()
      ops.push(appendOp(db, {
        entity: 'week_activity_exclusions', entity_id: newId,
        field: 'week_id', value: newWeekId,
        author_user_id, device_id,
        client_write_id: cwid('week_activity_exclusions.week_id', n),
      }))
      ops.push(appendOp(db, {
        entity: 'week_activity_exclusions', entity_id: newId,
        field: 'activity_id', value: e.activity_id,
        author_user_id, device_id,
        client_write_id: cwid('week_activity_exclusions.activity_id', n),
      }))
    })

    const grpExclusions = db
      .prepare('SELECT * FROM week_group_exclusions WHERE week_id = ?')
      .all(sourceWeekId)
    grpExclusions.forEach((e, n) => {
      const newId = randomUUID()
      ops.push(appendOp(db, {
        entity: 'week_group_exclusions', entity_id: newId,
        field: 'week_id', value: newWeekId,
        author_user_id, device_id,
        client_write_id: cwid('week_group_exclusions.week_id', n),
      }))
      ops.push(appendOp(db, {
        entity: 'week_group_exclusions', entity_id: newId,
        field: 'group_id', value: e.group_id,
        author_user_id, device_id,
        client_write_id: cwid('week_group_exclusions.group_id', n),
      }))
    })

    const locExclusions = db
      .prepare('SELECT * FROM week_location_exclusions WHERE week_id = ?')
      .all(sourceWeekId)
    locExclusions.forEach((e, n) => {
      const newId = randomUUID()
      ops.push(appendOp(db, {
        entity: 'week_location_exclusions', entity_id: newId,
        field: 'week_id', value: newWeekId,
        author_user_id, device_id,
        client_write_id: cwid('week_location_exclusions.week_id', n),
      }))
      ops.push(appendOp(db, {
        entity: 'week_location_exclusions', entity_id: newId,
        field: 'location_id', value: e.location_id,
        author_user_id, device_id,
        client_write_id: cwid('week_location_exclusions.location_id', n),
      }))
    })

    // Append the new schedule_weeks row LAST (§3.4) so a partially-replayed
    // sync does not surface a selectable-but-hollow week.
    ops.push(appendOp(db, {
      entity: 'schedule_weeks', entity_id: newWeekId,
      field: 'camp_id', value: campId,
      author_user_id, device_id,
      client_write_id: cwid('schedule_weeks.camp_id', 0),
    }))
    ops.push(appendOp(db, {
      entity: 'schedule_weeks', entity_id: newWeekId,
      field: 'name', value: newName,
      author_user_id, device_id,
      client_write_id: cwid('schedule_weeks.name', 0),
    }))
    ops.push(appendOp(db, {
      entity: 'schedule_weeks', entity_id: newWeekId,
      field: 'sort_order', value: String(maxSortOrder + 1),
      author_user_id, device_id,
      client_write_id: cwid('schedule_weeks.sort_order', 0),
    }))
    ops.push(appendOp(db, {
      entity: 'schedule_weeks', entity_id: newWeekId,
      field: 'is_archived', value: '0',
      author_user_id, device_id,
      client_write_id: cwid('schedule_weeks.is_archived', 0),
    }))

    return { ok: true, newWeekId, newName, ops }
  })()

  return outcome
}
