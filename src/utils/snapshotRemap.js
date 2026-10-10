// Names carried inside a saved version, and the restore-time remap that uses them.
//
// A Replace import mints new ids for groups/days/blocks/activities, so a version
// saved before it names rows that no longer exist. Each saved slot therefore also
// records `names` (display names, not ids), and restore re-binds a dead id to the
// live row with the same name. Old snapshots have no `names`: their dead ids are
// skipped, as before. Pure; shared by the main process (writeRouteSnapshot) and
// the renderer (saveSnapshot, restoreSnapshot).

const norm = (v) => String(v ?? '').trim().toLowerCase()

// catalog: { groups, days, timeBlocks, activities, fixedEvents } (snake_case rows)
export function attachNames(slot, { groups = [], days = [], timeBlocks = [], activities = [], fixedEvents = [] }) {
  const byId = (rows, id) => rows.find((r) => r.id === id)
  const block = byId(timeBlocks, slot.time_block_id)
  return {
    ...slot,
    names: {
      group: byId(groups, slot.group_id)?.name ?? null,
      day: byId(days, slot.day_id)?.label ?? null,
      block: block?.name ?? null,
      block_start: block?.start_time ?? null,
      block_end: block?.end_time ?? null,
      activity: slot.activity_id ? byId(activities, slot.activity_id)?.name ?? null : null,
      fixed_event: slot.fixed_event_id ? byId(fixedEvents, slot.fixed_event_id)?.name ?? null : null,
    },
  }
}

function resolver(rows, nameOf) {
  const live = new Set(rows.map((r) => r.id))
  return (id, name) => {
    if (live.has(id)) return { id }
    if (!norm(name)) return { problem: 'no matching' }
    const matches = rows.filter((r) => norm(nameOf(r)) === norm(name))
    if (matches.length === 1) return { id: matches[0].id }
    return { problem: matches.length ? 'ambiguous' : 'no matching' }
  }
}

const describe = (s) => {
  const n = s.names ?? {}
  const where = [n.group, [n.day, n.block].filter(Boolean).join(' '), n.activity ?? n.fixed_event].filter(Boolean)
  return where.length ? where.join(' · ') : 'a cell saved without names'
}

/**
 * @returns {{ slots: Array, skipped: Array<{ label: string, reason: string }> }}
 *   Slots with dead ids re-bound by name; cells that cannot be matched are
 *   skipped and listed by name with the reason.
 */
export function remapSnapshotSlots(slots, { groups, days, timeBlocks, activities, fixedEvents }) {
  const group = resolver(groups, (g) => g.name)
  const day = resolver(days, (d) => d.label)
  const block = resolver(timeBlocks || [], (b) => b.name)
  const activity = resolver(activities, (a) => a.name)
  const fixed = resolver(fixedEvents || [], (f) => f.name)

  const out = []
  const skipped = []
  for (const s of slots) {
    const n = s.names ?? {}
    const g = group(s.group_id, n.group)
    const d = day(s.day_id, n.day)
    const b = block(s.time_block_id, n.block)
    const isFixed = Boolean(s.is_fixed_event && s.fixed_event_id)
    const needsActivity = !s.is_fixed_event && s.activity_id
    const a = needsActivity ? activity(s.activity_id, n.activity) : null
    const f = isFixed ? fixed(s.fixed_event_id, n.fixed_event) : null

    const problems = [
      g.problem && `${g.problem} group`, d.problem && `${d.problem} day`, b.problem && `${b.problem} time block`,
      a?.problem && `${a.problem} activity`, f?.problem && `${f.problem} fixed event`,
    ].filter(Boolean)
    if (problems.length) {
      skipped.push({ label: describe(s), reason: problems.join(', ') })
      continue
    }
    out.push({
      ...s,
      group_id: g.id,
      day_id: d.id,
      time_block_id: b.id,
      ...(a ? { activity_id: a.id } : {}),
      ...(f ? { fixed_event_id: f.id } : {}),
    })
  }
  return { slots: out, skipped }
}

export function describeSkipped(skipped, limit = 5) {
  const shown = skipped.slice(0, limit).map((k) => `${k.label} — ${k.reason}`)
  const more = skipped.length > limit ? `; and ${skipped.length - limit} more` : ''
  return `${shown.join('; ')}${more}`
}
