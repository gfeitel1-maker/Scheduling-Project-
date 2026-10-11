// F3/F4 slice 2 (docs/adr/2026-10-11-import-special-days-and-field-trips.md, "Weekly import" 3-5 and
// the slice-0 findings): turn the detector's proposals into week-bound fixed_events entries, and take the
// cells an accepted trip claims out of the other two inference passes. PURE: ImportScreen and the tests
// call the same functions, so the glue is not re-typed anywhere.
//
// Rules:
//   * Offered: every 'trip' and 'subset-day' detection, only when the camp has at least one week.
//     A camp with no weeks is not offered trips (the cells stay as they import today). 'all-camp-day'
//     is planWholeCampDays below (slice 3b), never this function.
//   * Answer: the director's answer for the item, else the detector's defaultAnswer. With no week to
//     bind to (several weeks, none open) the item is PENDING whatever its default: a trip is never
//     written with a NULL week, and a pending item's cells commit as they do today.
//   * Accepted ('event' + a week): one fixedEvents entry per detection, start block = first block,
//     span_blocks = number of blocks, days = [day], weekId. Some groups -> kind 'recurring' with the
//     detected groups; every group of the camp -> kind 'fixed', all groups. Two same-slot same-name
//     detections for disjoint groups are two entries; the commit unions them into ONE row (the
//     slot-0 decision), because the slot key is scope-blind.
//   * Claims: an accepted trip's cells leave fixed-event inference and activity inference, so the
//     trip name neither becomes a second event on the same cells nor inflates min_per_week.
//   * Precedence over the "Every week" / "Just this once" multi-block question (slice-0 finding 7):
//     an accepted trip wins. A multi-block candidate with the same name and start block loses the
//     trip's day, and is not offered at all when that was its only day.

import { normalizeName } from './preview.js'
import { groupDaySequences } from './textSpans.js'

export const OFFERED_KINDS = Object.freeze(['trip', 'subset-day'])

/** Stable identity of one detection, used as the review item's key and its answer-memory id. */
export function tripItemKey(d) {
  return JSON.stringify([normalizeName(d.name), d.day, normalizeName(d.blocks?.[0] ?? ''), [...(d.groupIds ?? [])].map(normalizeName).sort()])
}

const cellKey = (group, day, block) => JSON.stringify([normalizeName(group), normalizeName(day), normalizeName(block)])

/**
 * @param {object} args
 * @param {Array} args.detections  detectTripsAndSpecialDays output
 * @param {Record<string, 'event'|'activity'>} [args.answers]  director answers keyed by tripItemKey
 * @param {string|null} args.weekId  the week the import binds trips to (null: none open/known)
 * @param {Record<string, string>} [args.weekByKey]  a per-item week the director picked, keyed by tripItemKey
 * @param {boolean} args.hasWeeks  whether the camp has any schedule week at all
 * @param {string[]} args.allGroupNames  every group the import knows
 * @returns {{ items: Array<{ key, detection, answer: 'event'|'activity'|null, weekId: string|null, pending: boolean, accepted: boolean }>,
 *   fixedEvents: Array<object>, claims: Map<string, string> }}
 */
export function planTripEvents({ detections = [], answers = {}, weekId = null, weekByKey = {}, hasWeeks = false, allGroupNames = [] } = {}) {
  const items = []
  const fixedEvents = []
  const claims = new Map() // cellKey -> normalized trip name
  if (!hasWeeks) return { items, fixedEvents, claims }
  const all = new Set(allGroupNames.map(normalizeName))
  for (const d of detections) {
    if (!OFFERED_KINDS.includes(d.kind)) continue
    const key = tripItemKey(d)
    const answer = answers[key] ?? d.defaultAnswer ?? null
    const week = weekByKey[key] ?? weekId ?? null
    const pending = !week || answer == null
    const accepted = !pending && answer === 'event'
    items.push({ key, detection: d, answer, weekId: week, pending, accepted })
    if (!accepted) continue
    const groups = [...d.groupIds]
    const everyGroup = all.size > 0 && all.size === new Set(groups.map(normalizeName)).size && groups.every((g) => all.has(normalizeName(g)))
    fixedEvents.push({
      name: d.name,
      time_block: d.blocks[0],
      days: [d.day],
      kind: everyGroup ? 'fixed' : 'recurring',
      scope: everyGroup ? { is_all_groups: true, groups: null } : { is_all_groups: false, groups },
      confidence: 'high',
      ...(d.blocks.length > 1 ? { span_blocks: d.blocks.length } : {}),
      weekId: week,
      trip: true,
    })
    for (const c of d.claims ?? []) claims.set(cellKey(c.groupName, c.dayName, c.blockLabel), normalizeName(d.name))
  }
  return { items, fixedEvents, claims }
}

/**
 * F3/F4 slice 3b: the 'all-camp-day' detections. The dangerous item: it is never pre-selected (the detector
 * gives it no default, and nothing here supplies one), so only the director's explicit answer accepts it.
 *   answer 'special_day' + a week -> a wholeCampDays entry (commitPlan builds the special day and binds it to
 *                                    that week and day); its cells are claimed.
 *   anything else + a week        -> week-bound all-camp 'fixed' events, the non-replacing result.
 *   no week                       -> pending, nothing emitted; the cells import as they do today.
 * @returns {{ items: Array<{ key, detection, answer: 'special_day'|'events'|null, weekId: string|null, pending: boolean, accepted: boolean }>,
 *   fixedEvents: Array<object>, wholeCampDays: Array<object>, claims: Map<string, string> }}
 */
export function planWholeCampDays({ detections = [], answers = {}, weekId = null, weekByKey = {}, hasWeeks = false } = {}) {
  const items = []
  const fixedEvents = []
  const wholeCampDays = []
  const claims = new Map()
  if (!hasWeeks) return { items, fixedEvents, wholeCampDays, claims }
  for (const d of detections) {
    if (d.kind !== 'all-camp-day') continue
    const key = tripItemKey(d)
    const answer = answers[key] ?? null
    const week = weekByKey[key] ?? weekId ?? null
    const accepted = Boolean(week) && answer === 'special_day'
    items.push({ key, detection: d, answer, weekId: week, pending: answer == null || !week, accepted })
    if (!week) continue
    if (accepted) {
      wholeCampDays.push({ name: d.name, day: d.day, weekId: week, blocks: [...d.blocks], groups: [...d.groupIds] })
    } else {
      fixedEvents.push({
        name: d.name,
        time_block: d.blocks[0],
        days: [d.day],
        kind: 'fixed',
        scope: { is_all_groups: true, groups: null },
        confidence: 'high',
        ...(d.blocks.length > 1 ? { span_blocks: d.blocks.length } : {}),
        weekId: week,
        trip: true,
      })
    }
    for (const c of d.claims ?? []) claims.set(cellKey(c.groupName, c.dayName, c.blockLabel), normalizeName(d.name))
  }
  return { items, fixedEvents, wholeCampDays, claims }
}

/**
 * Remove an accepted trip's cells from fixed-event inference and activity inference.
 * @returns {{ fixedEvents, seenCounts, activityPages, textSpans, fullyClaimedNames: string[] }}
 */
export function applyTripClaims({ parsed, proposal, claims, fixedEvents = [], textSpans = null }) {
  const seenCounts = proposal?.seenCounts ? { ...proposal.seenCounts, activities: { ...(proposal.seenCounts.activities ?? {}) } } : proposal?.seenCounts ?? null
  const activityPages = { ...(proposal?.activityPages ?? {}) }
  const spans = textSpans ? new Map(textSpans) : textSpans
  if (!claims || claims.size === 0) return { fixedEvents, seenCounts, activityPages, textSpans: spans, fullyClaimedNames: [] }

  const tripNames = new Set(claims.values())
  const seqs = groupDaySequences(parsed, proposal)
  const claimed = new Map() // norm -> claimed printed cells
  const runs = new Map() // norm -> claimed (group, day) runs
  const unclaimedGroups = new Map() // norm -> Set(group) with at least one unclaimed printed cell
  const groupsOnDay = new Map()
  for (const seq of seqs) {
    if (!groupsOnDay.has(normalizeName(seq.dayName))) groupsOnDay.set(normalizeName(seq.dayName), new Set())
    groupsOnDay.get(normalizeName(seq.dayName)).add(seq.groupName)
    const runSeen = new Set()
    for (const cell of seq.cells) {
      for (const n of cell.names) {
        const norm = normalizeName(n)
        if (!tripNames.has(norm)) continue
        if (claims.get(cellKey(seq.groupName, seq.dayName, cell.blockLabel)) === norm) {
          claimed.set(norm, (claimed.get(norm) ?? 0) + 1)
          if (!runSeen.has(norm)) { runSeen.add(norm); runs.set(norm, (runs.get(norm) ?? 0) + 1) }
        } else {
          if (!unclaimedGroups.has(norm)) unclaimedGroups.set(norm, new Set())
          unclaimedGroups.get(norm).add(seq.groupName)
        }
      }
    }
  }

  const fullyClaimedNames = []
  for (const norm of tripNames) {
    const counted = Object.keys(seenCounts?.activities ?? {}).find((k) => normalizeName(k) === norm)
    if (counted) seenCounts.activities[counted] = Math.max(0, (Number(seenCounts.activities[counted]) || 0) - (claimed.get(norm) ?? 0))
    const left = unclaimedGroups.get(norm)
    if (!left || left.size === 0) {
      fullyClaimedNames.push(counted ?? norm)
      delete activityPages[norm]
      spans?.delete(norm)
    } else {
      // Page keys are group names on by-day grids; on a page-per-group grid they are page titles, which
      // this cannot map, so the list is kept rather than emptied.
      const kept = Array.isArray(activityPages[norm]) ? activityPages[norm].filter((g) => left.has(g)) : []
      if (kept.length > 0) activityPages[norm] = kept
      const sp = spans?.get(norm)
      if (sp) {
        const sessions = sp.sessions - (runs.get(norm) ?? 0)
        if (sessions > 0) spans.set(norm, { ...sp, sessions })
        else spans.delete(norm)
      }
    }
  }

  // Fixed-event inference: drop each (day, group) occurrence an accepted trip of the same name claims.
  const out = []
  for (const fe of fixedEvents) {
    const norm = normalizeName(fe.name)
    if (!tripNames.has(norm)) { out.push(fe); continue }
    const keptDays = []
    for (const day of fe.days ?? []) {
      const inScope = fe.scope?.is_all_groups
        ? [...(groupsOnDay.get(normalizeName(day)) ?? [])]
        : (fe.scope?.groups ?? [])
      const left = inScope.filter((g) => claims.get(cellKey(g, day, fe.time_block)) !== norm)
      if (left.length === inScope.length) keptDays.push(day)
      else if (left.length > 0) out.push({ ...fe, days: [day], scope: { is_all_groups: false, groups: left } })
    }
    if (keptDays.length > 0) out.push(keptDays.length === (fe.days ?? []).length ? fe : { ...fe, days: keptDays })
  }
  return { fixedEvents: out, seenCounts, activityPages, textSpans: spans, fullyClaimedNames }
}

/** An accepted trip wins over a multi-block candidate for the same name and start block on its day. */
export function dropMultiBlockForTrips(candidates = [], tripFixedEvents = []) {
  const tripDays = new Map() // name|block -> Set(day)
  for (const fe of tripFixedEvents) {
    const k = `${normalizeName(fe.name)}|${normalizeName(fe.time_block)}`
    if (!tripDays.has(k)) tripDays.set(k, new Set())
    for (const d of fe.days ?? []) tripDays.get(k).add(normalizeName(d))
  }
  const out = []
  for (const c of candidates) {
    const taken = tripDays.get(`${normalizeName(c.name)}|${normalizeName(c.start_block)}`)
    if (!taken) { out.push(c); continue }
    const days = (c.days ?? []).filter((d) => !taken.has(normalizeName(d)))
    if (days.length > 0) out.push({ ...c, days })
  }
  return out
}

export function wholeCampDayNotices(outcome) {
  const notices = []
  for (const w of outcome?.wholeCampDays ?? []) {
    if (w.keptExisting) notices.push(`${w.name} on ${w.day} was not made a special day: that day already has a special day in that week, and it was left as it was.`)
    else if (w.skipped) notices.push(`${w.name} on ${w.day} was not made a special day: ${w.skipped}.`)
  }
  for (const p of outcome?.placementsDropped ?? []) {
    notices.push(`A special day placed on ${p.dayLabel ?? 'a day'} was unplaced because that day no longer exists after Replace. The special day itself is kept.`)
  }
  return notices
}
