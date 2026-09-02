// Pure resolver for T117 slice 2 — turns capturePlacements.js's raw name
// placements into snapshot-shaped slots by resolving each name against the
// live catalog maps. No I/O; the caller (materializeImportedVersion.js)
// builds the maps from the db and owns everything else.
//
// v1 scope (matches capturePlacements.js's own documented limitation):
// multi-block spans flatten to one slot per (group, day, block) cell, no
// span-head merging.

import { normalizeName } from '../../src/ingest/preview.js'

/**
 * @param {Array<{groupName, dayName, blockLabel, activityName}>} placements
 * @param {{
 *   groupIdByName: Map<string,string>,
 *   dayIdByName: Map<string,string>,
 *   blockIdByName: Map<string,string>,
 *   activityIdByName: Map<string,string>,
 *   anchorIdByName: Map<string,string>,
 * }} maps  keys are normalizeName(name)
 * @returns {{
 *   slots: Array<{group_id, day_id, time_block_id, activity_id, anchor_id, is_anchor, flags}>,
 *   unresolved: Array<{groupName, dayName, blockLabel, activityName, reason}>,
 * }}
 */
export function resolveImportedPlacements(placements, maps) {
  const { groupIdByName, dayIdByName, blockIdByName, activityIdByName, anchorIdByName } = maps
  const slots = []
  const unresolved = []

  for (const placement of placements) {
    const { groupName, dayName, blockLabel, activityName } = placement
    const groupId = groupIdByName.get(normalizeName(groupName))
    if (!groupId) {
      unresolved.push({ ...placement, reason: 'group' })
      continue
    }
    const dayId = dayIdByName.get(normalizeName(dayName))
    if (!dayId) {
      unresolved.push({ ...placement, reason: 'day' })
      continue
    }
    const blockId = blockIdByName.get(normalizeName(blockLabel))
    if (!blockId) {
      unresolved.push({ ...placement, reason: 'block' })
      continue
    }

    // Anchor-first.
    const anchorId = anchorIdByName.get(normalizeName(activityName))
    if (anchorId) {
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        activity_id: null, anchor_id: anchorId, is_anchor: true, flags: {},
      })
      continue
    }
    const activityId = activityIdByName.get(normalizeName(activityName))
    if (activityId) {
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        activity_id: activityId, anchor_id: null, is_anchor: false, flags: {},
      })
      continue
    }
    unresolved.push({ ...placement, reason: 'activity' })
  }

  return { slots, unresolved }
}
