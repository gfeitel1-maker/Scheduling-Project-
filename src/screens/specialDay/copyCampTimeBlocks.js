import { localClient } from '../../localClient'
import { resolveFixedEventGroupIds } from '../../engine/fixedEventScope'
import { parseIdList } from '../../utils/normalizeActivityEligibility'

async function writeField(entity, id, field, value) {
  const token = localStorage.getItem('shoresh-token')
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
}

const isEveryDay = (ev) => ev.day_id == null || ev.day_id === ''

// Which camp fixed events a special day takes. A week-scoped override is never
// carried. Fixed events that run every day come across automatically; a
// recurring or day-specific event is OFFERED, and only when the special day is
// placed on a weekday (a special day replaces that day), for events that apply
// to that weekday.
function splitFixedEvents(fixedEvents, placedDayId) {
  const live = fixedEvents.filter((ev) => ev.schedule_week_id == null && ev.activity_id != null)
  const carry = live.filter((ev) => ev.kind === 'fixed' && isEveryDay(ev))
  const offered = placedDayId
    ? live.filter((ev) => !carry.includes(ev) && (ev.day_id === placedDayId || (ev.kind === 'recurring' && isEveryDay(ev))))
    : []
  return { carry, offered }
}

// Cells (one per group x spanned block) an event fills, in the special day's
// own block ids. Resolves scope through the engine's resolveFixedEventGroupIds.
function cellsFor(events, groups, campBlocks, blockIdMap) {
  const cells = []
  for (const ev of events) {
    const head = campBlocks.findIndex((b) => b.id === ev.time_block_id)
    if (head < 0) continue
    const groupIds = resolveFixedEventGroupIds(ev, groups)
    for (const b of campBlocks.slice(head, head + (ev.span_blocks || 1))) {
      for (const groupId of groupIds) {
        cells.push({ groupId, blockId: blockIdMap.get(b.id), activityId: ev.activity_id, locationId: ev.location_id })
      }
    }
  }
  return cells
}

async function writeCells(specialDayId, cells, taken) {
  let written = 0
  for (const c of cells) {
    const key = `${c.groupId}|${c.blockId}`
    if (taken.has(key)) continue
    taken.add(key)
    const id = crypto.randomUUID()
    await writeField('special_day_slots', id, 'special_day_id', specialDayId)
    await writeField('special_day_slots', id, 'group_id', c.groupId)
    await writeField('special_day_slots', id, 'time_block_id', c.blockId)
    await writeField('special_day_slots', id, 'activity_id', c.activityId)
    if (c.locationId) await writeField('special_day_slots', id, 'location_id', c.locationId)
    written += 1
  }
  return written
}

// The one copy path behind both "Start from your time blocks?" (right after a
// Special Day is created) and the Copy time blocks action on an empty special
// schedule. Sequential writes, not a transaction: on a failure the thrown error
// carries how many blocks landed so the caller can say so (seedFailureMessage).
//
// Returns { carriedCount, placed, offer }: `offer` is null or
// { count, dayLabel, apply } where apply() places the offered recurring events.
export async function copyCampTimeBlocks({ campId, specialDayId, withFixedEvents = true }) {
  let seededCount = 0
  let totalCount = 0
  try {
    const campBlocks = await localClient.list('time_blocks')
    const scoped = (campBlocks || [])
      .filter((b) => b.camp_id === campId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    totalCount = scoped.length
    const blockIdMap = new Map()
    for (const b of scoped) {
      const newId = crypto.randomUUID()
      blockIdMap.set(b.id, newId)
      await writeField('special_day_time_blocks', newId, 'special_day_id', specialDayId)
      await writeField('special_day_time_blocks', newId, 'name', b.name)
      await writeField('special_day_time_blocks', newId, 'sort_order', b.sort_order ?? 0)
      if (b.start_time) await writeField('special_day_time_blocks', newId, 'start_time', b.start_time)
      if (b.end_time) await writeField('special_day_time_blocks', newId, 'end_time', b.end_time)
      seededCount += 1
    }

    if (!withFixedEvents) return { carriedCount: 0, placed: false, offer: null }

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
    const placedDayId = (placements || []).find((p) => p.special_day_id === specialDayId)?.day_id ?? null
    const { carry, offered } = splitFixedEvents(fixedEvents, placedDayId)

    const taken = new Set()
    const carriedCount = await writeCells(specialDayId, cellsFor(carry, groups, scoped, blockIdMap), taken)

    let offer = null
    if (offered.length) {
      const day = (days || []).find((d) => d.id === placedDayId)
      offer = {
        count: offered.length,
        dayLabel: day?.label || day?.day_of_week || 'that day',
        apply: () => writeCells(specialDayId, cellsFor(offered, groups, scoped, blockIdMap), taken),
      }
    }
    return { carriedCount, placed: placedDayId != null, offer }
  } catch (err) {
    err.seededCount = seededCount
    err.totalCount = totalCount
    throw err
  }
}
