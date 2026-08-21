// The schedule screen's persistence seam (ADR 2026-08-01). A React-free module
// that owns every read and write ScheduleScreen makes against the schedule
// entities, and hides the mechanics behind named methods.
//
// It owns: token acquisition, the list/write/bulkReplace/deleteEntity calls,
// the writeFields-style per-field write, the SINGLE engine-slot -> DB-row
// mapper (replacing the three drifting copies in generate/placeAnchors/
// restoreSnapshot), normalizeSlots on read, and the snapshot->row mappings.
//
// It does NOT own: React state, error-banner copy, describeWriteFailure/admin
// message decisions, route-selection policy, or any engine call. It returns
// data and throws typed persistence errors; the screen decides what to show.
//
// Collaborators are injected (ADR §3) so the seam is the test surface: a test
// drives it with a fake localClient and a fake getToken, asserting the exact
// rows/fields handed to write/bulkReplace — no React, no Electron.
import { normalizeSlots } from '../utils/normalizeSlots'

// The single engine-slot / snapshot-slot -> template_slots row mapper. The two
// input shapes differ only in field naming (camelCase engine slots vs
// snake_case snapshot slots) and in whether a span-head marker travels with the
// slot; both are made explicit so each call site's persisted row is
// byte-for-byte what it hand-wrote before.
//
// is_span_head is LOAD-BEARING: generate()/placeAnchors() emit it (`!== false`
// -> '1'/'0'); restoreSnapshot() omits it entirely so the template_slots column
// keeps its default (the column is added by ALTER TABLE with no DEFAULT, i.e.
// NULL — electron/db/localDb.js). Emitting it on the restore path would change
// what that site persists, so `spanHead` gates it off there.
function mapSlotToRow(slot, templateId, { spanHead }) {
  // Read the snake_case field when the slot HAS it, else the camelCase one —
  // presence, not `??` coalescing, because a snapshot slot's `anchor_id` is a
  // legitimate null that `??` would wrongly replace with the camelCase
  // undefined, changing what restoreSnapshot persists.
  const has = (k) => Object.prototype.hasOwnProperty.call(slot, k)
  const row = {
    id: crypto.randomUUID(),
    template_id: templateId,
    group_id: has('group_id') ? slot.group_id : slot.groupId,
    day_id: has('day_id') ? slot.day_id : slot.dayId,
    time_block_id: has('time_block_id') ? slot.time_block_id : slot.blockId,
    activity_id: has('activity_id') ? slot.activity_id : slot.activityId,
    anchor_id: has('anchor_id') ? slot.anchor_id : slot.anchorId,
    // is_anchor is derived per-shape, NOT as a disjunction. Engine slots (the
    // spanHead path) carry `type` ('anchor') and no `is_anchor`; snapshot slots
    // carry a boolean `is_anchor` and no `type`. Keying off the same
    // discriminator that gates is_span_head keeps each path byte-identical to
    // its original call site and avoids a latent trap if a slot ever carried
    // both fields (T28 review — Red Hat + Code Reviewer converged on this).
    is_anchor: (spanHead ? slot.type === 'anchor' : slot.is_anchor) ? '1' : '0',
  }
  if (spanHead) row.is_span_head = slot.is_span_head !== false ? '1' : '0'
  row.flags = JSON.stringify(slot.flags || {})
  return row
}

export function createScheduleRepository({
  localClient,
  getToken = () => localStorage.getItem('shoresh-token'),
}) {
  // Fires one write() per field (the op-log is field-level) and surfaces the
  // first failure rather than a silent partial write. Field order is preserved
  // from the caller's object — load-bearing for schedule_templates, where `kind`
  // must be written first (electron/ops/projections.js write-ordering contract).
  async function writeFields(entity, id, fields) {
    const token = getToken()
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, entity, id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  return {
    // --- reads -------------------------------------------------------------
    async loadSetupLists() {
      const [groups, days_of_operation, time_blocks, activities, anchor_activities, tiers, cohorts, locations, elective_sets, elective_set_activities] =
        await Promise.all([
          localClient.list('groups'),
          localClient.list('days_of_operation'),
          localClient.list('time_blocks'),
          localClient.list('activities'),
          localClient.list('anchor_activities'),
          localClient.list('tiers'),
          localClient.list('cohorts'),
          localClient.list('locations'),
          // electiveSetsAll (design §2) — the UNFILTERED render-surface list,
          // via the same generic list() primitive every other setup list
          // already uses. Never the reuse surface — see loadDurableElectiveSets.
          localClient.list('elective_sets'),
          localClient.list('elective_set_activities'),
        ])
      return { groups, days_of_operation, time_blocks, activities, anchor_activities, tiers, cohorts, locations, elective_sets, elective_set_activities }
    },

    // durableElectiveSets (design §2) — the reuse-surface list, is_reusable=1
    // only, via the dedicated listDurableElectiveSets IPC seam. Never a
    // client-side filter of loadSetupLists' elective_sets.
    async loadDurableElectiveSets() {
      return (await localClient.listDurableElectiveSets()) || []
    },

    // Fresh read of a single elective set's is_reusable at undo time (T105
    // Red Hat fold-in B) — deliberately NOT a value captured in the undo
    // closure at forward-write time, so a set promoted/synced between the
    // forward write and the undo is never wrongly deleted.
    async readElectiveSetIsReusable(electiveSetId) {
      const rows = await localClient.list('elective_sets')
      const row = (rows || []).find(r => r.id === electiveSetId)
      return row ? row.is_reusable : null
    },

    async loadTemplateData() {
      const templates = (await localClient.list('schedule_templates')) || []
      const [slotData, overlayData, snapData] = await Promise.all([
        localClient.list('template_slots'),
        localClient.list('template_overlays'),
        localClient.list('schedule_snapshots'),
      ])
      return {
        templates,
        slots: normalizeSlots(slotData),
        overlays: overlayData || [],
        snapshots: snapData || [],
      }
    },

    async reloadSlots(templateId) {
      return normalizeSlots(await localClient.listByScope('template_slots', templateId ?? null))
    },

    async reloadOverlays(templateId) {
      return await localClient.listByScope('template_overlays', templateId ?? null)
    },

    async getSnapshot(snapshotId) {
      return (await localClient.list('schedule_snapshots')).find(s => s.id === snapshotId)
    },

    async loadWeeks() {
      return (await localClient.list('schedule_weeks')) || []
    },

    async loadWeekExclusions(weekId) {
      const [activityExclusions, groupExclusions, locationExclusions] = await Promise.all([
        localClient.listByScope('week_activity_exclusions', weekId ?? null),
        localClient.listByScope('week_group_exclusions', weekId ?? null),
        localClient.listByScope('week_location_exclusions', weekId ?? null),
      ])
      return {
        activityExclusions: activityExclusions || [],
        groupExclusions: groupExclusions || [],
        locationExclusions: locationExclusions || [],
      }
    },

    async toggleActivityExclusion(weekId, activityId, excluded) {
      if (excluded) {
        const id = crypto.randomUUID()
        await writeFields('week_activity_exclusions', id, {
          week_id: weekId,
          activity_id: activityId,
        })
      } else {
        const rows = (await localClient.list('week_activity_exclusions')) || []
        const row = rows.find((r) => r.week_id === weekId && r.activity_id === activityId)
        if (row) {
          await localClient.deleteEntity(getToken(), 'week_activity_exclusions', row.id)
        }
      }
    },

    async toggleGroupExclusion(weekId, groupId, excluded) {
      if (excluded) {
        const id = crypto.randomUUID()
        await writeFields('week_group_exclusions', id, {
          week_id: weekId,
          group_id: groupId,
        })
      } else {
        const rows = (await localClient.list('week_group_exclusions')) || []
        const row = rows.find((r) => r.week_id === weekId && r.group_id === groupId)
        if (row) {
          await localClient.deleteEntity(getToken(), 'week_group_exclusions', row.id)
        }
      }
    },

    async toggleLocationExclusion(weekId, locationId, excluded) {
      if (excluded) {
        const id = crypto.randomUUID()
        await writeFields('week_location_exclusions', id, {
          week_id: weekId,
          location_id: locationId,
        })
      } else {
        const rows = (await localClient.list('week_location_exclusions')) || []
        const row = rows.find((r) => r.week_id === weekId && r.location_id === locationId)
        if (row) {
          await localClient.deleteEntity(getToken(), 'week_location_exclusions', row.id)
        }
      }
    },

    // --- field writes ------------------------------------------------------
    // `kind` is written FIRST (see writeFields note); the caller's object order
    // guarantees it.
    async createScheduleTemplate(templateId, { kind, campId, weekId, name }) {
      await writeFields('schedule_templates', templateId, { kind, camp_id: campId, week_id: weekId, name })
    },

    async createWeek(weekId, { campId, name, sortOrder }) {
      await writeFields('schedule_weeks', weekId, {
        camp_id: campId, name, sort_order: String(sortOrder ?? 0), is_archived: '0',
      })
    },

    async writeWeekFields(weekId, fields) {
      await writeFields('schedule_weeks', weekId, fields)
    },

    async writeSlotFields(slotId, fields) {
      await writeFields('template_slots', slotId, fields)
    },

    async writeActivityFields(activityId, fields) {
      await writeFields('activities', activityId, fields)
    },

    async writeOverlayFields(overlayId, fields) {
      await writeFields('template_overlays', overlayId, fields)
    },

    async writeElectiveSetFields(electiveSetId, fields) {
      await writeFields('elective_sets', electiveSetId, fields)
    },

    async writeElectiveSetActivityFields(memberId, fields) {
      await writeFields('elective_set_activities', memberId, fields)
    },

    // Undo-time cleanup for a one-off elective the director never promoted
    // (T105 design §1). Best-effort — callers accept a thrown error the same
    // way every other undo write does.
    async deleteElectiveSet(electiveSetId) {
      return localClient.deleteElectiveSet({ electiveSetId })
    },

    async writeSnapshotFields(snapshotId, fields) {
      await writeFields('schedule_snapshots', snapshotId, fields)
    },

    // --- bulk replace ------------------------------------------------------
    // generate() and placeAnchors() both: clear overlays, then replace slots
    // from engine slots. Identical operation, one method.
    async replaceWeek(templateId, engineSlots) {
      const token = getToken()
      // 'unavailable' engine slots (group availability excludes the block's
      // part_of_day, buildSchedule.js) are dropped here, not persisted. `type`
      // is not a template_slots column, so once loaded such a row is
      // byte-identical to an empty placeable slot — it renders as empty
      // (gridGeometry.js's decideCell falls into the empty branch before the
      // unreachable 'unavailable' cellType) and rejects drops either way
      // (dragHandlers.js's isSwapTarget). Persisting it only inflates the
      // Placed denominator (T65) with time that is always re-derivable from
      // group.availability vs block.part_of_day — no data is lost by omitting it.
      const placeableSlots = engineSlots.filter(s => s.type !== 'unavailable')
      const rows = placeableSlots.map(s => mapSlotToRow(s, templateId, { spanHead: true }))
      await localClient.bulkReplace(token, 'template_overlays', templateId, [])
      await localClient.bulkReplace(token, 'template_slots', templateId, rows)
    },

    // restoreSnapshot(): replace slots (from snapshot slots — no is_span_head),
    // then overlays. Opposite order and different overlay content from
    // replaceWeek; both preserved.
    async restoreSnapshotRows(templateId, snapshotSlots, snapshotOverlays) {
      const token = getToken()
      const rows = snapshotSlots.map(s => mapSlotToRow(s, templateId, { spanHead: false }))
      const overlayRows = (snapshotOverlays || []).map(o => ({
        id: crypto.randomUUID(),
        template_id: templateId,
        unit_id: o.unit_id,
        day_id: o.day_id,
        from_block_order: o.from_block_order != null ? String(o.from_block_order) : null,
        to_block_order: o.to_block_order != null ? String(o.to_block_order) : null,
        label: o.label,
      }))
      await localClient.bulkReplace(token, 'template_slots', templateId, rows)
      await localClient.bulkReplace(token, 'template_overlays', templateId, overlayRows)
    },

    // --- delete ------------------------------------------------------------
    // Owns the call + token, RETURNS the raw result. The status->message
    // decision stays in the screen: removeOverlay throws on a bad status while
    // deleteSnapshot distinguishes it from a thrown "admin role required", so
    // the repository must not collapse those by throwing here.
    async deleteEntity(entity, id) {
      return localClient.deleteEntity(getToken(), entity, id)
    },
  }
}
