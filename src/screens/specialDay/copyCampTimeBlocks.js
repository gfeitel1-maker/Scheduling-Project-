import { localClient } from '../../localClient'
import { resolveFixedEventGroupIds } from '../../engine/fixedEventScope'
import { parseIdList } from '../../utils/normalizeActivityEligibility'
import { timeBlockLabel } from '../../utils/timeBlockLabel'
import { cellFailureMessage, bringFailureMessage } from './seedFailureMessage'

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
// placed on exactly one weekday (a special day replaces that day), for events
// that apply to that weekday.
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
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const cells = []
  for (const ev of events) {
    const head = campBlocks.findIndex((b) => b.id === ev.time_block_id)
    if (head < 0) continue
    const groupIds = resolveFixedEventGroupIds(ev, groups)
    for (const b of campBlocks.slice(head, head + (ev.span_blocks || 1))) {
      for (const groupId of groupIds) {
        cells.push({
          eventName: ev.name, groupId, groupName: groupName.get(groupId), blockId: blockIdMap.get(b.id),
          blockLabel: timeBlockLabel(b), activityId: ev.activity_id, locationId: ev.location_id,
        })
      }
    }
  }
  return cells
}

// A slot row is created by its identity fields (the third one materializes it), so a
// cell is several writes and cannot be atomic. On a mid-cell failure the row this call
// created is deleted again (best effort) so no half-written row is left behind.
async function writeCell(specialDayId, cell, existing) {
  const id = existing?.id ?? crypto.randomUUID()
  try {
    if (!existing) {
      await writeField('special_day_slots', id, 'special_day_id', specialDayId)
      await writeField('special_day_slots', id, 'group_id', cell.groupId)
      await writeField('special_day_slots', id, 'time_block_id', cell.blockId)
    }
    await writeField('special_day_slots', id, 'activity_id', cell.activityId)
    if (cell.locationId) await writeField('special_day_slots', id, 'location_id', cell.locationId)
  } catch (err) {
    if (!existing) {
      try { await localClient.deleteEntity?.(localStorage.getItem('shoresh-token'), 'special_day_slots', id) } catch { /* best effort */ }
    }
    throw err
  }
  return id
}

// Re-lists the day's slots every call, so a cell the director filled by hand (or an
// earlier Bring filled) is never written twice. A cell is marked taken only after its
// write succeeds. Returns the cells written, the events that failed, and the cells kept.
async function placeCells(specialDayId, cells) {
  const [slotRows, activityRows] = await Promise.all([localClient.list('special_day_slots'), localClient.list('activities')])
  const activityName = new Map((activityRows || []).map((a) => [a.id, a.name]))
  const slots = new Map(
    (slotRows || []).filter((s) => s.special_day_id === specialDayId).map((s) => [`${s.group_id}|${s.time_block_id}`, s])
  )
  let written = 0
  const failed = new Set()
  const skipped = []
  for (const c of cells) {
    const key = `${c.groupId}|${c.blockId}`
    const row = slots.get(key)
    if (row?.activity_id) {
      if (row.activity_id !== c.activityId) {
        skipped.push(`${activityName.get(row.activity_id) ?? 'Another activity'} kept in ${c.groupName} ${c.blockLabel} — ${c.eventName} not added there`)
      }
      continue
    }
    try {
      const id = await writeCell(specialDayId, c, row)
      slots.set(key, { id, activity_id: c.activityId })
      written += 1
    } catch (err) {
      console.error('special day copy: could not place a fixed event cell', err)
      failed.add(c.eventName)
    }
  }
  return { written, failed: [...failed], skipped }
}

// The one copy path behind both "Start from your time blocks?" (right after a
// Special Day is created) and the Copy time blocks action on an empty special
// schedule. Sequential writes, not a transaction: on a failure the thrown error
// carries how many blocks landed so the caller can say so (seedFailureMessage).
//
// Returns { carriedCount, placed, offer, cellFailure, notice }.
//  - cellFailure: set when the blocks copied but some fixed-event cells did not
//    (names only the events that failed; it does not throw, the blocks are in).
//  - notice: cells kept as they were, or why no offer is made.
//  - offer: null or { count, dayLabel, specialDayId, apply } where apply() places the
//    offered recurring events and returns { written, failure, notice }.
export async function copyCampTimeBlocks({ campId, specialDayId }) {
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
    const { carry, offered } = splitFixedEvents(fixedEvents, placedDayId)

    const placedCarry = await placeCells(specialDayId, cellsFor(carry, groups, scoped, blockIdMap))
    const notices = [...placedCarry.skipped]
    if (multiDay) {
      notices.push(`This special day is on ${placedDayIds.map(dayLabel).join(' and ')}, so recurring events aren't offered. Add them by hand.`)
    }

    let offer = null
    if (offered.length) {
      offer = {
        count: offered.length,
        dayLabel: dayLabel(placedDayId),
        specialDayId,
        apply: async () => {
          const stillThere = (await localClient.list('special_days') || []).some((d) => d.id === specialDayId)
          if (!stillThere) return { written: 0, failure: 'This special day was deleted.', notice: null }
          const r = await placeCells(specialDayId, cellsFor(offered, groups, scoped, blockIdMap))
          return {
            written: r.written,
            failure: r.failed.length ? bringFailureMessage(r.failed, r.written) : null,
            notice: r.skipped.length ? r.skipped.join('; ') : null,
          }
        },
      }
    }
    return {
      carriedCount: placedCarry.written,
      placed: placedDayId != null || multiDay,
      offer,
      cellFailure: placedCarry.failed.length ? cellFailureMessage(placedCarry.failed) : null,
      notice: notices.length ? notices.join('; ') : null,
    }
  } catch (err) {
    err.seededCount = seededCount
    err.totalCount = totalCount
    throw err
  }
}
