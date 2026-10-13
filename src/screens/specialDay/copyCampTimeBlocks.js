import { localClient } from '../../localClient'
import { resolveFixedEventGroupIds } from '../../engine/fixedEventScope'
import { COPY_TIMEOUT_MESSAGE } from './seedFailureMessage'
import { parseIdList } from '../../utils/normalizeActivityEligibility'
import { timeBlockLabel } from '../../utils/timeBlockLabel'

const isEveryDay = (ev) => ev.day_id == null || ev.day_id === ''

// The same event on different days: everything but its day and its group scope matches.
const eventIdentity = (ev) => JSON.stringify([ev.kind, ev.name, ev.activity_id, ev.time_block_id, ev.span_blocks ?? 1, ev.location_id ?? null])

// Which camp fixed events a special day takes. A week-scoped override is never
// carried. An event comes across for a GROUP when that group has it on every operating
// day, whether as one every-day row or one row per day (what an import writes), so a
// group-scoped lunch wave lands in its own groups' cells and nowhere else. Anything else
// (a recurring or day-specific event) is OFFERED, and only when the special day is placed
// on exactly one weekday (a special day replaces that day), for events that apply to it.
// `placedWeekId`: the one week every placement of the special day is in, else null. A week-only event
// (its Weeks column) is never CARRIED (the copy is week-agnostic) and is OFFERED only for that week: the
// special day's grid is shared by every week it is placed in, so a week-only event offered for a day
// placed in two weeks would show in the wrong one.
function splitFixedEvents(fixedEvents, groups, placedDayId, operatingDayIds, placedWeekId = null) {
  const live = fixedEvents.filter((ev) => ev.schedule_week_id == null && ev.activity_id != null)
  const offerable = fixedEvents.filter((ev) => ev.activity_id != null && (ev.schedule_week_id == null || (placedWeekId != null && ev.schedule_week_id === placedWeekId)))
  const byIdentity = new Map()
  for (const ev of live) {
    const key = eventIdentity(ev)
    byIdentity.set(key, [...(byIdentity.get(key) || []), ev])
  }
  const carry = []
  const carriedRows = new Set()
  for (const rows of byIdentity.values()) {
    const days = new Map()
    for (const row of rows) {
      for (const groupId of resolveFixedEventGroupIds(row, groups)) {
        days.set(groupId, [...(days.get(groupId) || []), row.day_id])
      }
    }
    const covered = [...days].filter(([, ids]) => ids.some((d) => d == null || d === '') || (operatingDayIds.length > 0 && operatingDayIds.every((id) => ids.includes(id)))).map(([id]) => id)
    if (!covered.length) continue
    carry.push({ ...rows[0], is_all_groups: 0, unit_id: null, unit_ids: [], group_ids: covered })
    const coveredSet = new Set(covered)
    for (const row of rows) {
      if (resolveFixedEventGroupIds(row, groups).every((id) => coveredSet.has(id))) carriedRows.add(row)
    }
  }
  const offered = placedDayId
    ? offerable.filter((ev) => !carriedRows.has(ev) && (ev.day_id === placedDayId || (ev.kind === 'recurring' && isEveryDay(ev))))
    : []
  return { carry, offered, varies: live.some((ev) => !carriedRows.has(ev)) }
}

// The single week a special day is placed in, or null when it is unplaced or placed in several weeks.
function onlyWeek(placements, specialDayId) {
  const weeks = [...new Set((placements || []).filter((p) => p.special_day_id === specialDayId).map((p) => p.week_id))]
  return weeks.length === 1 ? weeks[0] : null
}

// Whether a camp's fixed events differ by weekday for some group, which is when an unplaced
// special day cannot carry them and the editor says to place the day. Same rule as the copy.
export function campEventsVaryByWeekday({ fixedEvents, groups, operatingDayIds }) {
  const parsed = (fixedEvents || []).map((ev) => ({ ...ev, group_ids: parseIdList(ev.group_ids), unit_ids: parseIdList(ev.unit_ids) }))
  return splitFixedEvents(parsed, groups || [], null, operatingDayIds || []).varies
}

// Cells (one per group x spanned block) an event fills, in the special day's
// own block ids. Resolves scope through the engine's resolveFixedEventGroupIds.
function cellsFor(events, groups, campBlocks, blockIdMap) {
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const cells = []
  for (const ev of events) {
    const head = campBlocks.findIndex((b) => b.id === ev.time_block_id)
    if (head < 0) continue
    const groupIds = resolveFixedEventGroupIds(ev, groups)
    for (const b of campBlocks.slice(head, head + (ev.span_blocks || 1))) {
      const blockId = blockIdMap.get(b.id)
      if (!blockId) continue
      for (const groupId of groupIds) {
        cells.push({
          eventName: ev.name, groupId, groupName: groupName.get(groupId), blockId,
          blockLabel: timeBlockLabel(b), activityId: ev.activity_id, locationId: ev.location_id,
        })
      }
    }
  }
  return cells
}

// One IPC carries the whole copy. Main writes every block and cell in a single transaction and
// skips a cell that already holds an activity (a manual placement or an earlier Bring), reporting
// it. A refusal or failure means nothing was written.
// Block ids come from (special day, camp block), so a retry after a lost reply hits
// `block-exists`: the first attempt landed whole (it is atomic), and that is not a failure.
const specialDayBlockId = (specialDayId, campBlockId) => `sdb-${specialDayId}-${campBlockId}`

async function copyInOneWrite(specialDayId, blocks, cells) {
  let r
  try {
    r = await localClient.copySpecialDayBlocks({ specialDayId, blocks, cells })
  } catch (err) {
    if (/^write timed out/i.test(err?.message ?? '')) err.timedOut = true
    throw err
  }
  if (r?.ok) return r
  if (r?.reason === 'block-exists' && blocks.length > 0) {
    return { ok: true, blocksWritten: 0, cellsWritten: 0, skipped: [], docWarning: false, alreadyCopied: true }
  }
  throw new Error(`copy refused: ${r?.reason ?? 'no answer'}`)
}

// The offer: one entry per offered event (so the director can untick one), and apply(keys)
// places only the ticked ones. Events are keyed by their row id.
function makeOffer({ specialDayId, offered, groups, scoped, blockIdMap, dayLabel }) {
  if (!offered.length) return null
  return {
    count: offered.length,
    dayLabel,
    specialDayId,
    events: offered.map((ev) => ({ key: ev.id, name: ev.name })),
    apply: async (keys) => {
      const stillThere = (await localClient.list('special_days') || []).some((d) => d.id === specialDayId)
      if (!stillThere) return { written: 0, failure: 'This special day was deleted.', notice: null }
      const chosen = keys ? offered.filter((ev) => keys.includes(ev.id)) : offered
      let r
      try {
        r = await copyInOneWrite(specialDayId, [], cellsFor(chosen, groups, scoped, blockIdMap))
      } catch (err) {
        console.error('special day copy: could not bring the offered events', err)
        return { written: 0, failure: err.timedOut ? COPY_TIMEOUT_MESSAGE : "Couldn't add those events \u2014 nothing was added, try again", notice: null }
      }
      return { written: r.cellsWritten, failure: null, notice: r.skipped.length ? r.skipped.join('; ') : null, docWarning: Boolean(r.docWarning) }
    },
  }
}

// The offer for a special day that has just been placed on one weekday, without copying blocks
// again. The camp blocks were copied one-to-one, so a special-day block is matched to its camp
// block by position and name; a block renamed since is skipped rather than guessed at.
export async function offerForPlacedDay({ campId, specialDayId }) {
  const [campBlocks, dayBlocks, events, groupRows, days, placements] = await Promise.all([
    localClient.list('time_blocks'),
    localClient.list('special_day_time_blocks'),
    localClient.list('fixed_events'),
    localClient.list('groups'),
    localClient.list('days_of_operation'),
    localClient.list('special_day_placements'),
  ])
  const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  const scoped = (campBlocks || []).filter((b) => b.camp_id === campId).sort(bySort)
  const own = (dayBlocks || []).filter((b) => b.special_day_id === specialDayId).sort(bySort)
  const blockIdMap = new Map()
  scoped.forEach((b, i) => { if (own[i] && own[i].name === b.name) blockIdMap.set(b.id, own[i].id) })
  const placedDayIds = [...new Set((placements || []).filter((p) => p.special_day_id === specialDayId).map((p) => p.day_id))]
  if (placedDayIds.length !== 1 || blockIdMap.size === 0) return null
  const groups = (groupRows || []).filter((g) => g.camp_id === campId)
  const fixedEvents = (events || [])
    .filter((ev) => ev.camp_id === campId)
    .map((ev) => ({ ...ev, group_ids: parseIdList(ev.group_ids), unit_ids: parseIdList(ev.unit_ids) }))
  const operating = (days || []).filter((d) => d.camp_id === campId)
  const { offered } = splitFixedEvents(fixedEvents, groups, placedDayIds[0], operating.map((d) => d.id), onlyWeek(placements, specialDayId))
  const day = operating.find((d) => d.id === placedDayIds[0])
  return makeOffer({ specialDayId, offered, groups, scoped, blockIdMap, dayLabel: day?.label || day?.day_of_week || 'another day' })
}

// The one copy path behind both "Start from your time blocks?" (right after a
// Special Day is created) and the Copy time blocks action on an empty special
// schedule. One main-process write: all of it lands or none of it does, so a failure
// throws with nothing copied (seedFailureMessage).
//
// Returns { carriedCount, placed, varies, offer, notice }.
//  - notice: cells kept as they were, or why no offer is made.
//  - offer: null or { count, dayLabel, specialDayId, apply } where apply() places the
//    offered recurring events and returns { written, failure, notice }.
export async function copyCampTimeBlocks({ campId, specialDayId }) {
  let totalCount = 0
  try {
    const campBlocks = await localClient.list('time_blocks')
    const scoped = (campBlocks || [])
      .filter((b) => b.camp_id === campId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    totalCount = scoped.length
    const blockIdMap = new Map()
    const blocks = scoped.map((b) => {
      const id = specialDayBlockId(specialDayId, b.id)
      blockIdMap.set(b.id, id)
      return { id, name: b.name, sort_order: b.sort_order ?? 0, start_time: b.start_time ?? null, end_time: b.end_time ?? null }
    })

    const [events, groupRows, days, placements] = await Promise.all([
      localClient.list('fixed_events'),
      localClient.list('groups'),
      localClient.list('days_of_operation'),
      localClient.list('special_day_placements'),
    ])
    const groups = (groupRows || []).filter((g) => g.camp_id === campId)
    const fixedEvents = (events || [])
      .filter((ev) => ev.camp_id === campId)
      .map((ev) => ({ ...ev, group_ids: parseIdList(ev.group_ids), unit_ids: parseIdList(ev.unit_ids) }))
    const placedDayIds = [...new Set((placements || []).filter((p) => p.special_day_id === specialDayId).map((p) => p.day_id))]
    const dayLabel = (id) => {
      const d = (days || []).find((x) => x.id === id)
      return d?.label || d?.day_of_week || 'another day'
    }
    const multiDay = placedDayIds.length > 1
    const placedDayId = placedDayIds.length === 1 ? placedDayIds[0] : null
    const { carry, offered, varies } = splitFixedEvents(fixedEvents, groups, placedDayId, (days || []).filter((d) => d.camp_id === campId).map((d) => d.id), onlyWeek(placements, specialDayId))

    const copied = await copyInOneWrite(specialDayId, blocks, cellsFor(carry, groups, scoped, blockIdMap))
    const notices = [...copied.skipped]
    if (copied.alreadyCopied) notices.push('Already copied.')
    if (multiDay) {
      notices.push(`This special day is on ${placedDayIds.map(dayLabel).join(' and ')}, so recurring events aren't offered. Add them by hand.`)
    }

    const offer = makeOffer({ specialDayId, offered, groups, scoped, blockIdMap, dayLabel: dayLabel(placedDayId) })
    return {
      carriedCount: copied.cellsWritten,
      placed: placedDayId != null || multiDay,
      varies,
      offer,
      docWarning: Boolean(copied.docWarning),
      notice: notices.length ? notices.join('; ') : null,
    }
  } catch (err) {
    err.seededCount = 0
    err.totalCount = totalCount
    throw err
  }
}
