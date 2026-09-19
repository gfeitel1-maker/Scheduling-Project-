// Electives consumer for parseGridSchedule's output — Consumer 2 of
// docs/adr/2026-08-22-event-schedule-import.md §8. An elective set is a FLAT
// membership list, not a 2D grid, so only cells[].activityName is read;
// timeIndex/groupIndex/locationName are ignored.
//
// Pure logic against a `repo` shim — no localClient/IPC import here, so it
// can be unit tested against a mock repo, mirroring eventGridPopulate.js.
// The real ElectivesScreen.jsx wires a repo backed by setupCrudRepository.

import { createActivity } from '../screens/schedule/createActivityHelper.js'
import { markElectivePermissionTier } from './electivePermissionTier.js'
import { normalizeName } from './preview.js'

// Content-keyed on the RESOLVED activity (not source position, unlike
// deriveEventImportId) — a flat set has no meaningful cell position, and
// keying on the activity id makes a re-import of the same file (or a
// different file naming the same activities) converge on the same row
// instead of minting a duplicate offering, per ADR §8.
export function deriveElectiveImportId(electiveSetId, activityId) {
  return `elective-import:${electiveSetId}:${activityId}`
}

const NOTHING_TO_IMPORT_MESSAGE =
  "No schedule could be read out of that. It may be a scan rather than a document with text in it."

/**
 * Map a parseGridSchedule result onto this elective set's flat offering list.
 *
 * Returns `{ ok: true }` on success (all writes made through `repo`), or
 * `{ ok: false, reason }` when there is nothing to import (ADR §8) — writing
 * nothing in that case. There is no longer a nonempty-set refusal (T195):
 * import is a per-activity POTENTIAL-ONLY upsert —
 *   - no existing row for this (set, activity) pair -> write status: 'potential'
 *   - existing row status 'potential' -> rewrite the same fields (idempotent)
 *   - existing row status 'confirmed' -> SKIP ENTIRELY, touch no field. This
 *     is the load-bearing safety property: import can never regress a
 *     director's confirmed decision, and there is no promotion logic to get
 *     wrong because import never promotes.
 * An activity that fell off a later sheet is left alone — no auto-delete, no
 * auto-demote (owner ruling pending; this is a named limitation, not an
 * oversight).
 *
 * A mid-write IO failure is NOT covered by the "nothing on failure"
 * guarantee above: it throws with some writes already made, and the caller
 * is responsible for reloading. Retrying is safe even so — every write is
 * content-keyed and a confirmed row is structurally unreachable.
 */
export async function populateElectiveSet(parsed, { electiveSetId, campId, repo, existingActivities, existingOfferings }) {
  const distinctNames = [...new Set((parsed?.cells ?? []).map((c) => c.activityName).filter((name) => String(name ?? '').trim()))]
  if (distinctNames.length === 0) {
    return { ok: false, reason: NOTHING_TO_IMPORT_MESSAGE }
  }

  const activities = [...(existingActivities ?? [])]
  const offeringByActivityId = new Map((existingOfferings ?? []).map((o) => [o.activity_id, o]))

  for (const name of distinctNames) {
    const { activityId, activity, isNew } = await createActivity(
      { name, campId, activities },
      { writeActivityFields: repo.writeActivityFields }
    )
    if (isNew) activities.push(activity)

    if (offeringByActivityId.get(activityId)?.status === 'confirmed') continue

    const id = deriveElectiveImportId(electiveSetId, activityId)
    await repo.writeFields('elective_set_activities', id, {
      elective_set_id: electiveSetId,
      activity_id: activityId,
      // v66 (T194, ADR D3): an imported offering has no declared cap. Written
      // explicitly rather than left to the column DEFAULT, because a projection
      // write is a field-by-field UPDATE and the default only applies to the
      // ensureExists INSERT. Same meaning as the v39 `camper_headcount: null`
      // this replaces — that column is now retired from the write path.
      capacity_mode: 'unlimited',
      capacity_limit: null,
      // v68 (T195): the importer is the only writer that ever says
      // 'potential' — never 'confirmed'. Confirmation is director-driven.
      status: 'potential',
    })
    await markElectivePermissionTier(repo, activityId, activity.recurrence_truth_status)
  }

  // `activities` (the resolved+newly-created list) is returned so a caller
  // importing several sets in one pass (populateElectiveGrid) can thread it
  // through successive calls — a name minted while importing one set must
  // be visible to the next set's dedup, or the same activity name appearing
  // in two grid cells mints two catalog rows.
  return { ok: true, activities }
}

// --- Grid consumer (T195): a day x period grid of offering MENU cells -----
//
// Content-keyed on the RESOLVED (week, day, time_block) triple — a re-import
// of the same file (or a different file naming the same day/period) converges
// on the same elective_sets row instead of minting a duplicate, mirroring
// deriveElectiveImportId's reasoning above.
export function deriveElectiveSetImportId(scheduleWeekId, dayId, timeBlockId) {
  return `elective-set-import:${scheduleWeekId}:${dayId}:${timeBlockId}`
}

const NOT_CONFIDENT_MESSAGE =
  "Couldn't tell which side of this file is the schedule's times. Check that the file has a clear time column or time row, and try again."

/**
 * Map a parseGridScheduleMenu result onto elective_sets/elective_set_activities:
 * one elective_set per (day, time_block), each populated with the per-row
 * potential-only upsert populateElectiveSet already implements.
 *
 * Never invents a day or time block: a timeAxis/groupAxis label with no
 * matching existing entity is reported in `unmapped` and that whole grid
 * column/row is skipped, writing nothing for it — mirrors
 * eventGridPopulate.js's pattern. Orientation-not-confident refuses the
 * WHOLE sheet, writing nothing (same posture as eventGridPopulate.js).
 *
 * `recurrence_level` no longer exists (removed in v71/T181 — dead data,
 * superseded by kind/day_id/schedule_week_id), so there is nothing for this
 * import to set. `parsed.linkageMarkers` is never read here — it passes
 * straight through in the return shape for the caller to surface, never
 * applied.
 */
export async function populateElectiveGrid(parsed, {
  campId, scheduleWeekId, repo, existingDays, existingTimeBlocks, existingElectiveSets, existingActivities, existingOfferings,
}) {
  if (!parsed || parsed.orientation?.confident !== true) {
    return { ok: false, reason: NOT_CONFIDENT_MESSAGE }
  }

  const daysByName = new Map((existingDays ?? []).map((d) => [normalizeName(d.name), d]))
  const timeBlocksByName = new Map((existingTimeBlocks ?? []).map((t) => [normalizeName(t.name), t]))
  const unmapped = [...(parsed.unmapped ?? [])]

  // Resolve every distinct groupIndex -> day_id and timeIndex -> time_block_id
  // up front, once, rather than per cell.
  const dayIdByGroupIndex = new Map()
  for (const g of parsed.groupAxis ?? []) {
    const match = daysByName.get(normalizeName(g.name))
    if (match) dayIdByGroupIndex.set(g.sourceIndex, match.id)
    else unmapped.push({ sourceExcerpt: g.name, reason: 'no matching day for this column' })
  }
  const timeBlockIdByTimeIndex = new Map()
  for (const t of parsed.timeAxis ?? []) {
    const match = timeBlocksByName.get(normalizeName(t.name))
    if (match) timeBlockIdByTimeIndex.set(t.sourceIndex, match.id)
    else unmapped.push({ sourceExcerpt: t.name, reason: 'no matching time block for this period' })
  }

  // Group cells by (timeIndex, groupIndex) -> only cells whose BOTH axes
  // resolved contribute; an unresolved axis already has its own unmapped
  // entry above, so a cell referencing it is silently excluded here rather
  // than reported twice.
  const cellsByKey = new Map()
  for (const cell of parsed.cells ?? []) {
    const dayId = dayIdByGroupIndex.get(cell.groupIndex)
    const timeBlockId = timeBlockIdByTimeIndex.get(cell.timeIndex)
    if (!dayId || !timeBlockId) continue
    const key = `${dayId}:${timeBlockId}`
    if (!cellsByKey.has(key)) cellsByKey.set(key, { dayId, timeBlockId, cells: [] })
    cellsByKey.get(key).cells.push(cell)
  }

  const setsByKey = new Map(
    (existingElectiveSets ?? []).map((s) => [`${s.day_id}:${s.time_block_id}`, s])
  )
  // Threaded across iterations (reassigned from each populateElectiveSet
  // call's return) — a name minted while importing one (day, time_block)
  // set must be visible to the NEXT set's dedup, or the same activity name
  // appearing in two grid cells mints two catalog rows.
  let activities = [...(existingActivities ?? [])]
  const offeringsByElectiveSetId = new Map()
  for (const o of existingOfferings ?? []) {
    if (!offeringsByElectiveSetId.has(o.elective_set_id)) offeringsByElectiveSetId.set(o.elective_set_id, [])
    offeringsByElectiveSetId.get(o.elective_set_id).push(o)
  }

  for (const [key, { dayId, timeBlockId, cells }] of cellsByKey) {
    let electiveSetId = setsByKey.get(key)?.id
    if (!electiveSetId) {
      electiveSetId = deriveElectiveSetImportId(scheduleWeekId, dayId, timeBlockId)
      await repo.writeFields('elective_sets', electiveSetId, {
        camp_id: campId,
        name: electiveSetId,
        day_id: dayId,
        time_block_id: timeBlockId,
        schedule_week_id: scheduleWeekId,
        is_reusable: 0,
      })
    }

    const subParsed = { cells }
    const result = await populateElectiveSet(subParsed, {
      electiveSetId,
      campId,
      repo,
      existingActivities: activities,
      existingOfferings: offeringsByElectiveSetId.get(electiveSetId) ?? [],
    })
    // populateElectiveSet only refuses on "nothing to import", which cannot
    // happen here (cellsByKey only holds keys with at least one cell).
    if (!result.ok) unmapped.push({ sourceExcerpt: key, reason: result.reason })
    else activities = result.activities
  }

  return { ok: true, unmapped }
}
