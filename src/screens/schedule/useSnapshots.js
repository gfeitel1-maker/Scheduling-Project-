import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { computeFindings } from '../../engine/buildSchedule'
import { parseSnapshotPayload, unrestorableMessage } from '../snapshotRestore'
import { routeSetter } from './useRouteState'

// Snapshots / versions CRUD + restore, over the T28 repository.
//
// This hook orchestrates route-scoped state but does NOT own it (that lives in
// T31's useRouteState): the injected `routeState` supplies every route value and
// setter it touches — existingTemplates, templateIdFor/templateId, the route
// data (slotsByRoute/overlaysByRoute), the route-explicit setSnapshotsByRoute
// (for the route-explicit saveSnapshot), and the current-route
// setSnapshots/setSlots/setOverlays/setFindings/setDismissedFindingKeys. It
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
  weekId,
}) {
  const {
    route,
    existingTemplates,
    templateIdFor,
    templateId,
    slotsByRoute,
    overlaysByRoute,
    setSnapshotsByRoute,
    setSnapshots,
    setSlots,
    setOverlays,
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
    const snapOverlays = overlaysByRoute[routeName].map(o => ({ unit_id: o.unit_id, day_id: o.day_id, from_block_order: o.from_block_order, to_block_order: o.to_block_order, label: o.label }))
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
        overlays: JSON.stringify(snapOverlays),
        day_overrides_json: dayOverridesJson,
      })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That version could not be saved.'))
      throw err
    }
    setRouteSnapshots(prev => [{ id, template_id: tid, name: name || null, is_auto: isAuto, created_at: createdAt, slots: JSON.stringify(snapSlots), overlays: JSON.stringify(snapOverlays), day_overrides_json: dayOverridesJson, restorable: true }, ...prev])
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
    fullSnap.overlays = parsed.overlays
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

    setActionError(null)
    try {
      await repo.restoreSnapshotRows(templateId, fullSnap.slots, fullSnap.overlays, snapshotDayOverrides)
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

    const freshOverlays = await repo.reloadOverlays(templateId)
    setOverlays(freshOverlays)

    recalcStats(freshSlots)
    setFindings(computeFindings({ slots: freshSlots, groups, activities, days }))
    setDismissedFindingKeys(new Set())
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
