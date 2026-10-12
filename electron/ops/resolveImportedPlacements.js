// Pure resolver for T117 slice 2 — turns capturePlacements.js's raw name
// placements into snapshot-shaped slots by resolving each name against the
// live catalog maps. No I/O; the caller (materializeImportedVersion.js)
// builds the maps from the db and owns everything else.
//
// Spans: an ACTIVITY with span_blocks N printed in back-to-back blocks is marked
// head + tails in runs of N (markActivitySpans), the shape Generate places, so a
// version restored on Manual shows one session, not N cells (final audit,
// packaged 5813133). An ELECTIVE held in back-to-back blocks is marked the same
// way (T219, markElectiveSpans); a set has no span_blocks, so its run is the span.

import { normalizeName } from '../../src/ingest/preview.js'
import { strictSplit } from '../../src/ingest/splitListCell.js'
import { listSetName } from '../../src/ingest/electiveSetName.js'
import { timeBlockLabel } from '../../src/utils/timeBlockLabel.js'
import { formatBlockTime12h } from '../../src/ingest/blockTimeText.js'

/**
 * @param {Array<{groupName, dayName, blockLabel, activityName}>} placements
 * @param {{
 *   groupIdByName: Map<string,string>,
 *   dayIdByName: Map<string,string>,
 *   blockIdByName: Map<string,string>,
 *   activityIdByName: Map<string,string>,
 *   fixedEventIdByName: Map<string,string>,
 *   electiveSetIdByName?: Map<string,string>,
 * }} maps  keys are normalizeName(name)
 * @returns {{
 *   slots: Array<{group_id, day_id, time_block_id, activity_id, fixed_event_id, is_fixed_event, flags}>,
 *   unresolved: Array<{groupName, dayName, blockLabel, activityName, reason}>,
 * }}
 */
export function resolveImportedPlacements(placements, maps) {
  const { groupIdByName, dayIdByName, blockIdByName, activityIdByName, fixedEventIdByName, electiveSetIdByName = new Map() } = maps
  const slots = []
  const unresolved = []

  for (const placement of placements) {
    const { groupName, dayName, blockLabel, activityName, electiveSetName } = placement
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

    if (electiveSetName) {
      const electiveSetId = electiveSetIdByName.get(normalizeName(electiveSetName))
      if (!electiveSetId) {
        unresolved.push({ ...placement, reason: 'elective_set' })
        continue
      }
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        elective_set_id: electiveSetId, activity_id: null, fixed_event_id: null, is_fixed_event: false, flags: {},
      })
      continue
    }

    // Fixed-event-first.
    const fixedEventId = fixedEventIdByName.get(normalizeName(activityName))
    if (fixedEventId) {
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        // A recurring event that shares its name with an activity IS that
        // activity's session: carry the link so the palette tally counts it.
        activity_id: activityIdByName.get(normalizeName(activityName)) ?? null,
        fixed_event_id: fixedEventId, is_fixed_event: true, flags: {},
      })
      continue
    }
    const activityId = activityIdByName.get(normalizeName(activityName))
    if (activityId) {
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        activity_id: activityId, fixed_event_id: null, is_fixed_event: false, flags: {},
      })
      continue
    }
    // A list cell the camp holds as an elective set (named after its choices, D3) resolves to that set.
    const listParts = strictSplit(activityName)
    const listSetId = listParts ? electiveSetIdByName.get(normalizeName(listSetName(listParts))) : null
    if (listSetId) {
      slots.push({
        group_id: groupId, day_id: dayId, time_block_id: blockId,
        elective_set_id: listSetId, activity_id: null, fixed_event_id: null, is_fixed_event: false, flags: {},
      })
      continue
    }
    unresolved.push({ ...placement, reason: 'activity' })
  }

  markElectiveSpans(slots, maps.blockOrder, maps.blockContinues)
  markActivitySpans(slots, maps.blockOrder, maps.blockContinues, maps.activitySpanBlocks)
  return { slots, unresolved }
}

/**
 * T219: one group's elective set in back-to-back blocks of one day is ONE
 * session. The first block gets is_span_head: true and the rest false, which
 * is the shape the grid and Generate already read for activity spans. A slot
 * not in a run of two or more is left without the field.
 *
 * @param {Array} slots resolved slots, mutated in place
 * @param {Map<string, number>} [blockOrder] time_block_id -> position in the
 *        camp's day; without it nothing is marked
 * @param {Set<string>} [blockContinues] blocks that start exactly when the block before them
 *        ends (blocksThatContinue); a run breaks at any other block, so a time gap keeps
 *        two periods separate; without it nothing is marked
 */
export function markElectiveSpans(slots, blockOrder, blockContinues) {
  if (!blockOrder || !blockContinues) return
  const byGroupDaySet = new Map()
  for (const s of slots) {
    if (!s.elective_set_id || !blockOrder.has(s.time_block_id)) continue
    const k = `${s.group_id}|${s.day_id}|${s.elective_set_id}`
    if (!byGroupDaySet.has(k)) byGroupDaySet.set(k, [])
    byGroupDaySet.get(k).push(s)
  }
  for (const list of byGroupDaySet.values()) {
    list.sort((a, b) => blockOrder.get(a.time_block_id) - blockOrder.get(b.time_block_id))
    let run = [list[0]]
    const close = () => {
      if (run.length > 1) run.forEach((s, i) => { s.is_span_head = i === 0 })
    }
    for (let i = 1; i < list.length; i++) {
      const next = list[i].time_block_id
      if (blockOrder.get(next) === blockOrder.get(run[run.length - 1].time_block_id) + 1 && blockContinues.has(next)) run.push(list[i])
      else { close(); run = [list[i]] }
    }
    close()
  }
}

// What the director needs to find a left-out placement again: the name, the
// day, the group, and the block in its 12-hour form when the camp has that
// block (a block the camp lacks keeps the file's own spelling).
export function describeUnresolved(unresolved, timeBlocks = []) {
  const blockByName = new Map()
  for (const b of timeBlocks) {
    const key = normalizeName(b.name)
    if (!blockByName.has(key)) blockByName.set(key, b)
  }
  return unresolved.map((u) => {
    const block = blockByName.get(normalizeName(u.blockLabel))
    return {
      activityName: u.activityName ?? u.electiveSetName,
      groupName: u.groupName,
      dayName: u.dayName,
      blockText: block ? timeBlockLabel(block) : formatBlockTime12h(u.blockLabel),
      reason: u.reason,
    }
  })
}

/**
 * One group's activity in back-to-back blocks of one day, cut into sessions of the activity's
 * span_blocks: each session's first block is the head, the rest tails. A run shorter than
 * span_blocks (or the remainder of a longer one) is left unmarked, as single cells.
 *
 * @param {Map<string, number>} [activitySpanBlocks] activity_id -> span_blocks (> 1 only)
 */
export function markActivitySpans(slots, blockOrder, blockContinues, activitySpanBlocks) {
  if (!blockOrder || !blockContinues || !activitySpanBlocks?.size) return
  const byGroupDayActivity = new Map()
  for (const s of slots) {
    if (!s.activity_id || s.is_fixed_event || !activitySpanBlocks.has(s.activity_id) || !blockOrder.has(s.time_block_id)) continue
    const k = `${s.group_id}|${s.day_id}|${s.activity_id}`
    if (!byGroupDayActivity.has(k)) byGroupDayActivity.set(k, [])
    byGroupDayActivity.get(k).push(s)
  }
  for (const list of byGroupDayActivity.values()) {
    const n = activitySpanBlocks.get(list[0].activity_id)
    list.sort((a, b) => blockOrder.get(a.time_block_id) - blockOrder.get(b.time_block_id))
    const cut = (run) => {
      for (let i = 0; i + n <= run.length; i += n) run.slice(i, i + n).forEach((s, j) => { s.is_span_head = j === 0 })
    }
    let run = [list[0]]
    for (let i = 1; i < list.length; i++) {
      const next = list[i].time_block_id
      if (blockOrder.get(next) === blockOrder.get(run[run.length - 1].time_block_id) + 1 && blockContinues.has(next)) run.push(list[i])
      else { cut(run); run = [list[i]] }
    }
    cut(run)
  }
}
