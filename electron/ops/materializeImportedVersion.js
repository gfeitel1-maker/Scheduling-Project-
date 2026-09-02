// T117 slice 2 — the Host-side orchestrator that turns a raw schedule
// import's captured placements into a saved version (a schedule_snapshots
// row on the camp's manual schedule_templates), per
// docs/adr/2026-09-02-imported-schedule-materializes-as-a-version.md.
//
// Writes go through syncClient.write (not a bare db.prepare) so they get the
// op-log + Host broadcast for free — see the ADR and CLAUDE.md's op-log rule.
// This mirrors createUser's write-per-field loop (electron/auth/localAuth.js).

import { randomUUID } from 'node:crypto'
import { normalizeName } from '../../src/ingest/preview.js'
import { resolveImportedPlacements } from './resolveImportedPlacements.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'

async function writeFields(syncClient, entity, entityId, fields, authorUserId) {
  for (const [field, value] of Object.entries(fields)) {
    const result = await syncClient.write({ entity, entity_id: entityId, field, value, author_user_id: authorUserId })
    if (!(result && result.status === 'applied')) {
      throw new Error(`materializeImportedVersion: write failed for ${entity}.${field} (status: ${result?.status})`)
    }
  }
}

function nameMap(db, table, campId, nameColumn = 'name') {
  const rows = db.prepare(`SELECT id, ${nameColumn} AS name FROM ${table} WHERE camp_id = ?`).all(campId)
  return new Map(rows.map((row) => [normalizeName(row.name), row.id]))
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{write: Function}} syncClient
 * @param {{campId: string, authorUserId: string, placements: Array}} args
 * @returns {Promise<{created: boolean, snapshotId: string|null, unresolvedCount: number, unresolvedNames: string[]}>}
 */
export async function materializeImportedVersion(db, syncClient, { campId, authorUserId, placements }) {
  if (!placements || placements.length === 0) {
    return { created: false, snapshotId: null, unresolvedCount: 0, unresolvedNames: [] }
  }

  const week = db
    .prepare('SELECT id FROM schedule_weeks WHERE camp_id = ? AND is_archived = 0 ORDER BY sort_order ASC LIMIT 1')
    .get(campId)
  if (!week) {
    return { created: false, snapshotId: null, unresolvedCount: placements.length, unresolvedNames: placements.map((p) => p.activityName) }
  }
  const weekId = week.id

  let template = db.prepare("SELECT id FROM schedule_templates WHERE week_id = ? AND kind = 'manual'").get(weekId)
  let templateId = template?.id
  if (!templateId) {
    templateId = deriveScheduleTemplateId(weekId, 'manual')
    await writeFields(syncClient, 'schedule_templates', templateId, { kind: 'manual', camp_id: campId, week_id: weekId, name: '' }, authorUserId)
  }

  const maps = {
    activityIdByName: nameMap(db, 'activities', campId),
    anchorIdByName: nameMap(db, 'anchor_activities', campId),
    groupIdByName: nameMap(db, 'groups', campId),
    dayIdByName: nameMap(db, 'days_of_operation', campId, 'label'),
    blockIdByName: nameMap(db, 'time_blocks', campId),
  }

  const { slots, unresolved } = resolveImportedPlacements(placements, maps)

  if (slots.length === 0) {
    return { created: false, snapshotId: null, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName) }
  }

  const snapshotId = randomUUID()
  await writeFields(syncClient, 'schedule_snapshots', snapshotId, {
    template_id: templateId,
    name: 'Imported schedule',
    is_auto: false,
    created_at: new Date().toISOString(),
    slots: JSON.stringify(slots),
    day_overrides_json: '[]',
  }, authorUserId)

  return { created: true, snapshotId, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName) }
}
