import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { computeFindings } from '../../engine/buildSchedule'
import { parseSnapshotPayload, unrestorableMessage } from '../snapshotRestore'
import { routeSetter } from './useRouteState'
import { toSnapshotSlot } from '../../utils/snapshotSlot'
import { attachNames, remapSnapshotSlots, describeSkipped } from '../../utils/snapshotRemap'

// Snapshots / versions CRUD + restore, over the T28 repository.
//
// This hook orchestrates route-scoped state but does NOT own it (that lives in
// T31's useRouteState): the injected `routeState` supplies every route value and
// setter it touches — existingTemplates, templateIdFor/templateId, the route
// data (slotsByRoute), the route-explicit setSnapshotsByRoute
// (for the route-explicit saveSnapshot), and the current-route
// setSnapshots/setSlots/setFindings/setDismissedFindingKeys. It
// calls the repo and reports failures via the injected setActionError.
// Restore-time reference guard (Red Hat HIGH, T117 slice 2): drops stored
// rows (snake_case) whose group, day, time block, fixed event or activity no
// longer exists, so they are never written back dangling. Also guards
// generate()'s carry-forward of replaced-day rows (T350, ADR D4.6).
export function dropDeadReferences(slots, { groups, days, timeBlocks, activities, fixedEvents, events, electiveSets }) {
  const groupIds = new Set(groups.map(g => g.id))
  const dayIds = new Set(days.map(d => d.id))
  const timeBlockIds = new Set((timeBlocks || []).map(b => b.id))
  const activityIds = new Set(activities.map(a => a.id))
  const fixedEventIds = new Set((fixedEvents || []).map(a => a.id))
  // events / electiveSets are checked only when the caller supplies them
  // (restore does; carry-forward does not need to).
  const eventIds = events ? new Set(events.map(e => e.id)) : null
  const electiveSetIds = electiveSets ? new Set(electiveSets.map(e => e.id)) : null
  return slots.filter(s =>
    groupIds.has(s.group_id) &&
    dayIds.has(s.day_id) &&
    timeBlockIds.has(s.time_block_id) &&
    !(s.is_fixed_event && s.fixed_event_id && !fixedEventIds.has(s.fixed_event_id)) &&
    !(!s.is_fixed_event && s.activity_id && !activityIds.has(s.activity_id)) &&
    !(eventIds && s.event_id && !eventIds.has(s.event_id)) &&
    !(electiveSetIds && s.elective_set_id && !electiveSetIds.has(s.elective_set_id))
  )
}

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
  fixedEvents,
  events,
  electiveSets,
  weekId,
  replacedDayIds,
  activityExclusions,
  groupExclusions,
  locationExclusions,
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

  // routeName is explicit so generate()/placeFixedEvents() can snapshot the route
  // they are building rather than whichever one happens to be on screen; every
  // other caller is a user action on the visible route and defaults to it.
  async function saveSnapshot(name, isAuto, routeName = route) {
    if (!existingTemplates[routeName]) return
    const tid = templateIdFor(routeName)
    const setRouteSnapshots = routeSetter(setSnapshotsByRoute, routeName)
    const snapSlots = slotsByRoute[routeName].map(sl => attachNames(toSnapshotSlot(sl), { groups, days, timeBlocks, activities, fixedEvents, events, electiveSets }))
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    setActionError(null)
    try {
      await repo.writeSnapshotFields(id, {
        template_id: tid,
        name: name || null,
        is_auto: isAuto,
        created_at: createdAt,
        slots: JSON.stringify(snapSlots),
      })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That version could not be saved.'))
      throw err
    }
    setRouteSnapshots(prev => [{ id, template_id: tid, name: name || null, is_auto: isAuto, created_at: createdAt, slots: JSON.stringify(snapSlots), restorable: true }, ...prev])
  }

  // Deleting a version is the director's call, never an automatic cleanup.
  // Known cost, by ruling: every auto-save is about 60-70 KB with names and
  // nothing prunes them automatically.
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
          ? 'Admin only.'
          : describeWriteFailure(err, 'That version could not be deleted.')
      )
      return
    }
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      setActionError("Couldn't delete that version.")
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
      setActionError('Belongs to the other schedule.')
      return
    }

    fullSnap.slots = parsed.slots
    // T145 — day_overrides are gone. A snapshot saved while the feature
    // existed still CARRIES day_overrides_json; restore now ignores it rather
    // than applying it. Deliberately ignore-on-read, not rewrite-on-migrate:
    // an old version stays restorable and simply comes back without the
    // per-day diffs the feature used to layer on top.

    // A Replace re-import mints NEW ids for groups/days/blocks/activities.
    // Saved cells carry the names they had, so each dead id is re-bound to the
    // live row with the same name; a cell that cannot be matched is skipped and
    // reported by name. Old snapshots (no names) skip their dead cells.
    const { slots: remapped, skipped } = remapSnapshotSlots(fullSnap.slots, { groups, days, timeBlocks, activities, fixedEvents, events, electiveSets })
    const survivingSlots = dropDeadReferences(remapped, { groups, days, timeBlocks, activities, fixedEvents, events, electiveSets })
    const otherDropped = remapped.length - survivingSlots.length

    // Keep the week being replaced as a version, so a restore is never a one-way door.
    // saveSnapshot already surfaces its own failure; do not replace the week after it.
    try {
      await saveSnapshot(null, true)
    } catch {
      return
    }

    setActionError(null)
    try {
      await repo.restoreSnapshotRows(templateId, survivingSlots)
    } catch (err) {
      setActionError(
        err?.message?.includes('admin role required')
          ? 'Admin only.'
          : describeWriteFailure(err, 'That version could not be restored.')
      )
      return
    }

    const freshSlots = await repo.reloadSlots(templateId)
    setSlots(freshSlots)

    recalcStats(freshSlots)
    // FIXED_EVENT_DUPLICATE is generated-route only — see useScheduleData's route
    // loop for the same gate and reasoning.
    setFindings(computeFindings(route === 'generated'
      ? { slots: freshSlots, groups, activities, days, replacedDayIds, fixedEvents, weekId, activityExclusions, groupExclusions, locationExclusions }
      : { slots: freshSlots, groups, activities, days, replacedDayIds }))
    setDismissedFindingKeys(new Set())

    if (skipped.length > 0 || otherDropped > 0) {
      const detail = skipped.length > 0 ? `: ${describeSkipped(skipped)}` : ''
      const extra = otherDropped > 0 ? ` (${otherDropped} more no longer exist)` : ''
      setActionError(`Restored; ${skipped.length + otherDropped} cell(s) skipped${detail}${extra}`)
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
