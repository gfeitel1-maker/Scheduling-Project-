import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { computeFindings } from '../../engine/buildSchedule'
import { parseSnapshotPayload, unrestorableMessage } from '../snapshotRestore'
import { routeSetter } from './useRouteState'

// Snapshots / versions CRUD + restore, over the T28 repository.
//
// This hook orchestrates route-scoped state but does NOT own it (that lives in
// T31's useRouteState): the injected `routeState` supplies every route value and
// setter it touches — existingTemplates, templateIdFor/templateId, the route
// data (slotsByRoute), the route-explicit setSnapshotsByRoute
// (for the route-explicit saveSnapshot), and the current-route
// setSnapshots/setSlots/setFindings/setDismissedFindingKeys. It
// calls the repo and reports failures via the injected setActionError.
export function useSnapshots({
  routeState,
  repo,
  setActionError,
  recalcStats,
  resetUndoRedo,
  groups,
  activities,
  days,
  timeBlocks,
  anchors,
  weekId,
  // T108 review round 2 (HIGH #3) — dayOverrides is owned by useScheduleData,
  // not this hook; restoreSnapshot must reload it and hand the fresh rows
  // back up so the grid's applyDayOverrides composition (ScheduleScreen's
  // slots useMemo) recomposes against what was ACTUALLY restored, not
  // whatever was on screen before the restore ran.
  setDayOverrides,
}) {
  const {
    route,
    existingTemplates,
    templateIdFor,
    templateId,
    slotsByRoute,
    setSnapshotsByRoute,
    setSnapshots,
    setSlots,
    setFindings,
    setDismissedFindingKeys,
  } = routeState

  // routeName is explicit so generate()/placeAnchors() can snapshot the route
  // they are building rather than whichever one happens to be on screen; every
  // other caller is a user action on the visible route and defaults to it.
  async function saveSnapshot(name, isAuto, routeName = route) {
    if (!existingTemplates[routeName]) return
    const tid = templateIdFor(routeName)
    const setRouteSnapshots = routeSetter(setSnapshotsByRoute, routeName)
    const snapSlots = slotsByRoute[routeName].map(s => ({
      group_id: s.group_id,
      day_id: s.day_id,
      time_block_id: s.time_block_id,
      activity_id: s.activity_id,
      anchor_id: s.anchor_id,
      is_anchor: s.is_anchor,
      flags: s.flags || {},
    }))
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    // Whole-week day_overrides capture (design §5.2): snapshots are
    // whole-week/template-level, so this is every day, not just the one
    // currently on screen.
    const dayOverrides = weekId ? await repo.loadDayOverridesForWeek(weekId) : []
    const dayOverridesJson = JSON.stringify(dayOverrides)
    setActionError(null)
    try {
      await repo.writeSnapshotFields(id, {
        template_id: tid,
        name: name || null,
        is_auto: isAuto,
        created_at: createdAt,
        slots: JSON.stringify(snapSlots),
        day_overrides_json: dayOverridesJson,
      })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That version could not be saved.'))
      throw err
    }
    setRouteSnapshots(prev => [{ id, template_id: tid, name: name || null, is_auto: isAuto, created_at: createdAt, slots: JSON.stringify(snapSlots), day_overrides_json: dayOverridesJson, restorable: true }, ...prev])
  }

  // Deleting a version is the director's call, never an automatic cleanup.
  // Every snapshot saved before the op-value coercion fix (af6a9d8) recorded no
  // schedule data and shows as "Empty" — this is how those get cleared, one at a
  // time, by a human who can see what they are removing.
  //
  // deleteEntity routes to a DELETE_FIELD write, which main.js gates to admin.
  // A refused delete must surface: the row is still there, and saying otherwise
  // would repeat the exact silent-no-op failure this ticket exists to fix.
  async function deleteSnapshot(snapshotId) {
    setActionError(null)
    let result
    try {
      result = await repo.deleteEntity('schedule_snapshots', snapshotId)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can delete a saved version'
          : describeWriteFailure(err, 'That version could not be deleted.')
      )
      return
    }
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      setActionError('That version could not be deleted. It is still in the list.')
      return
    }
    setSnapshots(prev => prev.filter(s => s.id !== snapshotId))
  }

  async function restoreSnapshot(snapshot) {
    if (!existingTemplates[route]) return
    resetUndoRedo()
    const fullSnap = await repo.getSnapshot(snapshot.id)
    const parsed = parseSnapshotPayload(fullSnap)
    if (!parsed.ok) {
      // Never a bare return: a restore that cannot proceed must say so. This
      // failing silently is the whole of T8.
      setActionError(unrestorableMessage(parsed.reason))
      setSnapshots(prev => prev.map(s => s.id === snapshot.id ? { ...s, restorable: false } : s))
      return
    }
    // restoreSnapshot re-stamps template_id from component state onto every
    // row below. With two candidates per camp, restoring a version that belongs
    // to the OTHER route would silently overwrite this route's entire week —
    // so the version must be one of this route's before anything is written.
    if (fullSnap.template_id !== templateId) {
      setActionError('That saved version belongs to the other schedule. Switch to it to restore this version.')
      return
    }

    fullSnap.slots = parsed.slots
    // A snapshot saved before this feature shipped has no day_overrides_json
    // at all — an empty array correctly restores the week to "no overrides"
    // (design §5.2's delete-then-recreate-nothing case), same as an
    // explicitly-empty payload.
    let snapshotDayOverrides = []
    if (fullSnap.day_overrides_json) {
      try {
        snapshotDayOverrides = JSON.parse(fullSnap.day_overrides_json) || []
      } catch {
        snapshotDayOverrides = []
      }
    }

    // Restore-time reference guard (Red Hat HIGH, T117 slice 2) — a Replace
    // re-import mints NEW catalog ids for groups/days/time_blocks/activities
    // but does not clear existing schedule_snapshots rows. Restoring a
    // version saved before such a re-import would otherwise write
    // template_slots rows referencing dead ids (no runtime FK enforcement),
    // producing a silently-broken/blank grid. Product decision: keep the
    // versions, but skip any dead cell non-destructively and tell the
    // director how many were skipped.
    const groupIds = new Set(groups.map(g => g.id))
    const dayIds = new Set(days.map(d => d.id))
    const timeBlockIds = new Set((timeBlocks || []).map(b => b.id))
    const activityIds = new Set(activities.map(a => a.id))
    const anchorIds = new Set((anchors || []).map(a => a.id))
    let droppedCount = 0
    const survivingSlots = fullSnap.slots.filter(s => {
      const dead =
        !groupIds.has(s.group_id) ||
        !dayIds.has(s.day_id) ||
        !timeBlockIds.has(s.time_block_id) ||
        (s.is_anchor && s.anchor_id && !anchorIds.has(s.anchor_id)) ||
        (!s.is_anchor && s.activity_id && !activityIds.has(s.activity_id))
      if (dead) droppedCount += 1
      return !dead
    })

    setActionError(null)
    try {
      await repo.restoreSnapshotRows(templateId, survivingSlots, snapshotDayOverrides)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Only an admin can restore a version.'
          : describeWriteFailure(err, 'That version could not be restored.')
      )
      return
    }

    const freshSlots = await repo.reloadSlots(templateId)
    setSlots(freshSlots)

    // HIGH #3 — reload the WHOLE WEEK's day_overrides (restore is week-level,
    // design §5.2) so ScheduleScreen's applyDayOverrides composition reflects
    // exactly what restoreSnapshotRows just wrote, including restore-to-none
    // (an empty reload correctly clears stale overrides from the grid).
    if (weekId) {
      const freshDayOverrides = await repo.loadDayOverridesForWeek(weekId)
      setDayOverrides?.(freshDayOverrides)
    }

    recalcStats(freshSlots)
    setFindings(computeFindings({ slots: freshSlots, groups, activities, days }))
    setDismissedFindingKeys(new Set())

    if (droppedCount > 0) {
      setActionError(`Restored. ${droppedCount} cell(s) referenced items that no longer exist (likely from a re-import) and were skipped.`)
    }
  }

  async function renameSnapshot(snapshotId, newName) {
    setActionError(null)
    try {
      await repo.writeSnapshotFields(snapshotId, { name: newName, is_auto: false })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That version could not be renamed.'))
      return
    }
    setSnapshots(prev => prev.map(s => s.id === snapshotId ? { ...s, name: newName, is_auto: false } : s))
  }

  return { saveSnapshot, deleteSnapshot, restoreSnapshot, renameSnapshot }
}
