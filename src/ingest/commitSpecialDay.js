// T40 slice 3b — write a confirmed special-day plan.
//
// NO DATABASE ACCESS HERE. The caller injects `writeField` and `newId`, which
// makes the whole write ORDER testable without Electron — and the order is the
// design, for the reason below.
//
// THERE IS NO TRANSACTION, and this does not pretend otherwise. A special day is
// a parent row, N period rows and N*M cell rows, each its own IPC write. That is
// the partial-write class T109 covers, and the existing author screen
// (SpecialEventsScreen's seedFromCampTimeBlocks) already faces it and answers
// the same way: write in order, count what landed, and tell the director exactly
// where it stopped. This follows that precedent rather than inventing a
// guarantee the IPC surface cannot honour.
//
// So the ORDER is chosen for the least-bad partial state:
//
//   1. the special_days row FIRST — any later failure then leaves something
//      the director can SEE on the Special Events screen and delete, rather
//      than orphan periods and cells pointing at a parent that never existed.
//   2. missing activities — catalog rows the cells will bind to.
//   3. this day's own periods.
//   4. the cells.
//
// On failure the rejection carries the specialDayId and the counts, because
// "nothing happened" would be a lie the director would act on.

export async function commitSpecialDayPlan(plan, { writeField, newId }) {
  if (!plan || !plan.ready) {
    throw new Error(`That special day is not ready to build (${(plan?.blockedBy ?? []).join(', ') || 'no plan'}).`)
  }

  const specialDayId = newId()
  const counts = { periods: 0, cells: 0, activitiesCreated: 0 }
  // Red Hat (T40 3b review): set only once the parent row has ACTUALLY landed.
  // The id is minted before the first write, and attaching it unconditionally
  // meant a failure ON that first write still told the director to "find it
  // under Special Events and delete it" — sending them to look for a day that
  // was never created. That is the same class of lie as claiming nothing
  // happened, pointed the other way.
  let dayExists = false
  const fail = (err) => {
    const wrapped = err instanceof Error ? err : new Error(String(err))
    wrapped.message = dayExists
      ? `"${plan.name}" was only partly built — ${wrapped.message}`
      : `"${plan.name}" could not be started — ${wrapped.message} Nothing was written.`
    if (dayExists) {
      wrapped.specialDayId = specialDayId
      wrapped.counts = counts
    }
    throw wrapped
  }

  try {
    await writeField('special_days', specialDayId, 'name', plan.name)
    dayExists = true
    if (plan.notes) await writeField('special_days', specialDayId, 'notes', plan.notes)

    // Activity ids by the plan's own spelling, so a cell can bind to a row this
    // same commit created a moment ago.
    const activityIdByName = new Map()
    for (const a of plan.activities) {
      if (a.activityId) { activityIdByName.set(a.name, a.activityId); continue }
      const id = newId()
      await writeField('activities', id, 'name', a.name)
      activityIdByName.set(a.name, id)
      counts.activitiesCreated += 1
    }

    const blockIdByName = new Map()
    for (const b of plan.timeBlocks) {
      const id = newId()
      await writeField('special_day_time_blocks', id, 'special_day_id', specialDayId)
      await writeField('special_day_time_blocks', id, 'name', b.name)
      await writeField('special_day_time_blocks', id, 'sort_order', b.sort_order)
      if (b.start_time) await writeField('special_day_time_blocks', id, 'start_time', b.start_time)
      // Written only when the file actually gave an end — a null end_time write
      // would record "this period ends at nothing" rather than "nobody said".
      if (b.end_time) await writeField('special_day_time_blocks', id, 'end_time', b.end_time)
      blockIdByName.set(b.name, id)
      counts.periods += 1
    }

    const groupIdByColumn = new Map(plan.columns.map((c) => [c.columnName, c.groupId]))
    for (const s of plan.slots) {
      const groupId = groupIdByColumn.get(s.columnName)
      const blockId = blockIdByName.get(s.blockName)
      const activityId = activityIdByName.get(s.activityName)
      // A cell whose column or period did not resolve is skipped rather than
      // written half-bound; `ready` already guarantees columns resolve, so this
      // is a belt-and-braces guard, not an expected path.
      if (!groupId || !blockId) continue
      const id = newId()
      await writeField('special_day_slots', id, 'special_day_id', specialDayId)
      await writeField('special_day_slots', id, 'group_id', groupId)
      await writeField('special_day_slots', id, 'time_block_id', blockId)
      if (activityId) await writeField('special_day_slots', id, 'activity_id', activityId)
      counts.cells += 1
    }
  } catch (err) {
    fail(err)
  }

  return { specialDayId, ...counts }
}
