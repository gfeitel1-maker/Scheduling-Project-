import { assertIdListShape } from './assertIdListShape.js'
import { isActivityEligibleForGroup } from './eligibility.js'

// Pure function — zero React dependencies, zero Supabase calls.
//
// Supports two call signatures:
//
//   NEW (multi-cohort):
//   buildSchedule({ cohorts, days, activities, campId })
//   where cohorts = [{ cohort, timeBlocks, tiers, groups, preplacedSlots, activityTargets }]
//
//   LEGACY (single-cohort, backward compat):
//   buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })
//
// Output: { slots, conflicts, findings }
//   slots     — array of scheduled slot objects (cohort_id and is_span_head added).
//               Per-slot flags carry only UNFILLABLE now — UNDERSERVED/DISTRIBUTION
//               moved to `findings` and WEATHER_RISK was removed entirely (outdoor
//               exposure is read at render time from activity.is_outdoor).
//               (T65: a coverage `stats` object was removed here — nothing outside
//               this file ever read it; the renderer computes its own stats from
//               DB rows via recalcStats in src/screens/schedule/useScheduleData.js.)
//   conflicts — cross-cohort resource conflicts (always [] until multi-cohort engine in Sub-project 3)
//   findings  — aggregate, one entry per (groupId, activityId, kind) for
//               UNDERSERVED/DISTRIBUTION. Never persisted — recomputed fresh
//               on every build. See docs/adr/2026-07-28-schedule-flag-findings-reshape.md.

function djb2(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// Normalize both call signatures into the cohorts-array format.
// Omitting `locations` defaults it to [] → an empty capacity map, so every
// activity's location_id is unmapped and therefore unconstrained (see
// placeBlocked). Callers that rely on place capacity must therefore pass
// `locations`; both live callers do.
function normalizeInput(input) {
  if (input.cohorts) {
    return {
      cohorts: input.cohorts,
      days: input.days,
      activities: input.activities,
      campId: input.campId || '',
      locations: input.locations || [],
      anchorsOnly: input.anchorsOnly || false,
      weekId: input.weekId ?? null,
    }
  }
  return {
    cohorts: [{
      cohort: { id: null, anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
      timeBlocks: input.timeBlocks || [],
      tiers: input.tiers || [],
      groups: input.groups || [],
      preplacedSlots: input.preplacedSlots || [],
      activityTargets: null,
      _legacyAnchors: input.anchors || [],
    }],
    days: input.days || [],
    activities: input.activities || [],
    campId: input.campId || '',
    locations: input.locations || [],
    anchorsOnly: input.anchorsOnly || false,
    weekId: input.weekId ?? null,
  }
}

function scheduleCohort({ cohortEntry, days, activities, rand, locationCapById, anchorsOnly = false, weekId = null }) {
  const { cohort, timeBlocks, tiers: _tiers, groups, preplacedSlots, activityTargets, _legacyAnchors } = cohortEntry
  const cohortId = cohort?.id ?? null

  // Sort time blocks by sort_order so span_blocks consecutive logic is stable
  const timeBlocksSorted = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
  const blockOrder = new Map(timeBlocksSorted.map((b, i) => [b.id, i]))

  // ── Pass 0: resolve eligibility ──────────────────────────────────────────
  const eligibility = new Map() // activityId → Set<groupId>
  for (const act of activities) {
    // Contract: eligible_tier_ids / eligible_group_ids are arrays of ids.
    // Callers normalize — this engine does not deserialize; see
    // src/utils/normalizeActivityEligibility.js.
    if (import.meta.env.DEV) assertIdListShape(act.eligible_group_ids, 'eligible_group_ids', act.id)
    const eligible = new Set()
    for (const g of groups) {
      if (isActivityEligibleForGroup(act, g)) eligible.add(g.id)
    }
    eligibility.set(act.id, eligible)
  }

  // ── Pass 1: map the grid ──────────────────────────────────────────────────
  // Build anchor lookup from legacy anchors (flat signature) or preplacedSlots
  const anchorLookup = new Map() // "groupId|dayId|blockId" → anchor
  // Slice 2 (schedule_week_id, docs/work/specs/2026-08-23-unified-schedule-
  // overlay-slices.md): schedule_week_id NULL means "every week" (today's
  // implicit behavior, unchanged). A non-null schedule_week_id that doesn't
  // match the week being built is dropped here, BEFORE anchoredActivityIds is
  // built below — a week-bound anchor must not occupy a cell on another week,
  // and must not exclude its activity from regular placement there either.
  const anchors = (_legacyAnchors || []).filter(
    (a) => a.schedule_week_id == null || a.schedule_week_id === weekId
  )
  const anchoredActivityIds = new Set()
  for (const anchor of anchors) {
    if (anchor.activity_id != null) anchoredActivityIds.add(anchor.activity_id)
  }
  for (const anchor of anchors) {
    // Scope resolution order: unit_id > is_all_groups > group_ids
    let groupList
    if (anchor.unit_id != null && anchor.unit_id !== '') {
      groupList = groups.filter(g => g.tier_id === anchor.unit_id).map(g => g.id)
    } else if (anchor.is_all_groups) {
      groupList = groups.map(g => g.id)
    } else {
      // Contract: group_ids is an array of ids. Callers normalize — this
      // engine does not deserialize; see src/screens/schedule/useScheduleData.js.
      if (import.meta.env.DEV) assertIdListShape(anchor.group_ids, 'group_ids', anchor.id)
      groupList = anchor.group_ids || []
    }

    // day_id null/undefined means every day
    const dayList = (anchor.day_id != null && anchor.day_id !== '')
      ? [anchor.day_id]
      : days.map(d => d.id)

    const spanBlocks = anchor.span_blocks || 1
    for (const gid of groupList) {
      for (const did of dayList) {
        // Head block
        anchorLookup.set(`${gid}|${did}|${anchor.time_block_id}`, { ...anchor, _isSpanHead: true })
        // Tail blocks (span_blocks > 1)
        if (spanBlocks > 1) {
          const headIdx = blockOrder.get(anchor.time_block_id)
          if (headIdx !== undefined) {
            for (let i = 1; i < spanBlocks; i++) {
              const tailBlock = timeBlocksSorted[headIdx + i]
              if (tailBlock) {
                anchorLookup.set(`${gid}|${did}|${tailBlock.id}`, { ...anchor, _isSpanHead: false })
              }
            }
          }
        }
      }
    }
  }

  // T41 slice 1 (group-level electives,
  // docs/work/specs/2026-08-20-group-electives-design.md): a template_slots
  // cell carrying elective_set_id is authored content, never engine output —
  // the same pre-placed/do-not-fill treatment anchors get via anchorLookup
  // above (T62 closed anchor double-scheduling the same way). Threaded
  // through preplacedSlots entries carrying an electiveSetId (rather than an
  // activityId) so callers don't need a third top-level array.
  const electiveLookup = new Map() // "groupId|dayId|blockId" → electiveSetId
  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §6): same posture as electiveLookup above — a
  // template_slots cell carrying event_id is authored content, never engine
  // output, threaded through preplacedSlots entries carrying an eventId.
  const eventLookup = new Map() // "groupId|dayId|blockId" → eventId
  for (const pre of (preplacedSlots || [])) {
    if (pre.electiveSetId != null) {
      electiveLookup.set(`${pre.groupId}|${pre.dayId}|${pre.blockId}`, pre.electiveSetId)
    }
    if (pre.eventId != null) {
      eventLookup.set(`${pre.groupId}|${pre.dayId}|${pre.blockId}`, pre.eventId)
    }
  }

  const groupMap = new Map(groups.map(g => [g.id, g]))
  const slots = []
  const openSlots = []

  for (const group of groups) {
    for (const day of days) {
      for (const block of timeBlocksSorted) {
        const key = `${group.id}|${day.id}|${block.id}`
        const anchor = anchorLookup.get(key)

        // Deliberate precedence: anchor is checked before elective, so a
        // slot carrying BOTH is_anchor and elective_set_id resolves as an
        // anchor — the elective is silently dropped for that cell. Slice 1
        // has no writer that can produce both on the same slot, but if one
        // ever does, this is the intended tie-break (anchors are the older,
        // more constrained mechanism).
        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'anchor', activityId: null, anchorId: anchor.id, is_span_head: anchor._isSpanHead !== false, flags: {} })
          continue
        }

        // Precedence anchor → event → elective → open (ADR §6) — only one of
        // these is ever populated on real data by write-path convention
        // (MUTUALLY_EXCLUSIVE_FIELDS), this order is the documented tie-break.
        const eventId = eventLookup.get(key)
        if (eventId != null) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'event', activityId: null, anchorId: null, eventId, is_span_head: true, flags: {} })
          continue
        }

        const electiveSetId = electiveLookup.get(key)
        if (electiveSetId != null) {
          // Excluded from openSlots entirely: the engine never fills this
          // cell and never counts it as unfilled (no UNFILLABLE flag), the
          // same way an anchor slot above is excluded.
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'elective', activityId: null, anchorId: null, electiveSetId, is_span_head: true, flags: {} })
          continue
        }

        const avail = group.availability
        const pod = block.part_of_day
        if (avail !== 'all' && avail !== pod) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'unavailable', activityId: null, anchorId: null, is_span_head: true, flags: {} })
          continue
        }

        const eligibleActs = activities.filter(a => !anchoredActivityIds.has(a.id) && (eligibility.get(a.id) || new Set()).has(group.id))
        openSlots.push({ groupId: group.id, dayId: day.id, blockId: block.id, eligibleActs })
      }
    }
  }

  // ── Pass 2: place activities ──────────────────────────────────────────────
  const assigned = new Map() // "groupId|dayId|blockId" → activityId
  const spanTails = new Set() // keys for tail blocks of multi-block placements
  const usageCount = new Map() // "groupId|activityId" → count
  const dailyUsage = new Set() // "groupId|dayId|activityId" — per-day dedup guard
  // Two independent occupancy ledgers, two independent constraints (ADR D2):
  //   placeUsage — how many groups are in a PLACE at once, keyed by the shared
  //     location_id, capped at locations.capacity. Occupant list (not a count)
  //     because same_tier_only reasons about who else is there.
  //   activityUsage — how many groups can do an ACTIVITY at once (an
  //     instructor/equipment cap), keyed per activity, capped at
  //     max_groups_per_slot. NOT a min() of the two — different key, different
  //     constraint; the engine checks both.
  const placeUsage = new Map()    // "locationId|dayId|blockId" → [{ groupId, tierId }]
  const activityUsage = new Map() // "activityId|dayId|blockId" → count

  function getCount(groupId, actId) {
    return usageCount.get(`${groupId}|${actId}`) || 0
  }

  function incCount(groupId, actId, dayId) {
    const k = `${groupId}|${actId}`
    usageCount.set(k, (usageCount.get(k) || 0) + 1)
    dailyUsage.add(`${groupId}|${dayId}|${actId}`)
  }

  function placedTodayForGroup(groupId, dayId, actId) {
    return dailyUsage.has(`${groupId}|${dayId}|${actId}`)
  }

  // Place capacity + same_tier_only at ONE block. Only constrains an activity
  // bound to a location — location_id == null has no place (interim M1→M3
  // state) and is unconstrained, identical to today's no-location behavior.
  // A location_id that IS set but resolves to nothing in locationCapById (a
  // deleted place, a cross-device race, a stale import — "dangling") gets the
  // same unconstrained treatment, not a silent capacity-1 default: an absent
  // map entry is not evidence of a capacity-1 place, it's evidence the place
  // doesn't exist, and the director sees that via the DANGLING_LOCATION
  // finding in buildSchedule() rather than an invisibly tightened schedule.
  // Returns true when the place at this block cannot admit `act` for `group`.
  // Applied at the head AND at every span tail (a span occupies its place at
  // every block it covers — place()/occupyPlace push tails into placeUsage, so
  // the check side must match, or a span overfills its place at the tail).
  function placeBlocked(act, group, dayId, blockId) {
    const locId = act.location_id ?? null
    if (locId == null || !locationCapById.has(locId)) return false
    const capacity = locationCapById.get(locId)
    const occupants = placeUsage.get(`${locId}|${dayId}|${blockId}`) || []
    if (occupants.length >= capacity) return true
    if (act.same_tier_only && occupants.length > 0) {
      if (!occupants.every(o => o.tierId === group?.tier_id)) return true
    }
    return false
  }

  function canPlace(act, groupId, dayId, blockId) {
    if (getCount(groupId, act.id) >= act.max_per_week) return false
    if (placedTodayForGroup(groupId, dayId, act.id)) return false

    const group = groupMap.get(groupId)
    if (placeBlocked(act, group, dayId, blockId)) return false

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      if (blockIdx === undefined) return false
      const avail = group?.availability
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (!nextBlock) return false  // not enough blocks remaining
        const nextKey = `${groupId}|${dayId}|${nextBlock.id}`
        // A multi-block activity must not span INTO an elective cell, same
        // as it can't span into an anchor — otherwise place() would write
        // phantom bookkeeping (assigned/usageCount/placeUsage/activityUsage)
        // at the elective coordinate, corrupting session credit and capacity
        // even though the visible schedule still renders the elective.
        if (assigned.has(nextKey) || anchorLookup.has(nextKey) || electiveLookup.has(nextKey) || eventLookup.has(nextKey)) return false
        // Tail block must also be within the group's available part of day
        if (avail !== 'all' && avail !== nextBlock.part_of_day) return false
        // Tail block occupies the place too — same capacity + same_tier_only
        // guard as the head.
        if (placeBlocked(act, group, dayId, nextBlock.id)) return false
      }
    }

    // Activity (instructor/equipment) capacity, per activity per (day, block).
    // null/0 mean "no per-activity cap" — unchanged from today, and matching
    // computeOverlaps/normalizeActivityEligibility's documented `null = no cap`.
    if (act.max_groups_per_slot > 0) {
      if ((activityUsage.get(`${act.id}|${dayId}|${blockId}`) || 0) >= act.max_groups_per_slot) return false
    }

    return true
  }

  function occupyPlace(act, safeGroup, groupId, dayId, blockId) {
    const locId = act.location_id ?? null
    if (locId != null) {
      const lk = `${locId}|${dayId}|${blockId}`
      const list = placeUsage.get(lk) || []
      list.push({ groupId, tierId: safeGroup.tier_id })
      placeUsage.set(lk, list)
    }
    const ak = `${act.id}|${dayId}|${blockId}`
    activityUsage.set(ak, (activityUsage.get(ak) || 0) + 1)
  }

  function place(act, groupId, dayId, blockId) {
    const group = groupMap.get(groupId)
    // Guard: if group is not in this cohort, occupancy still tracks with a null
    // tier_id (can't read it) — same_tier_only then treats it as its own tier.
    const safeGroup = group ?? { tier_id: null }
    const headKey = `${groupId}|${dayId}|${blockId}`
    assigned.set(headKey, act.id)
    incCount(groupId, act.id, dayId)  // count once per placement (head only)

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (nextBlock) {
          const tailKey = `${groupId}|${dayId}|${nextBlock.id}`
          assigned.set(tailKey, act.id)
          spanTails.add(tailKey)
          // A span tail occupies both the place and the activity at its block.
          occupyPlace(act, safeGroup, groupId, dayId, nextBlock.id)
        }
      }
    }

    occupyPlace(act, safeGroup, groupId, dayId, blockId)
  }

  // Pre-place locked slots (anchors from new signature + any explicit preplacedSlots)
  // Note: place() calls incCount() which registers daily usage, so canPlace() will
  // correctly block duplicate same-day placements even for pre-placed activities.
  for (const pre of (preplacedSlots || [])) {
    const key = `${pre.groupId}|${pre.dayId}|${pre.blockId}`
    // Defense-in-depth: no slice-1 writer can produce a preplacedSlots entry
    // that is both a locked activity AND an elective cell at the same
    // coordinate, but a future write path or a sync race shouldn't be able
    // to silently corrupt bookkeeping if it ever does — mirrors the same
    // guard anchorLookup effectively gets via the openSlots exclusion above.
    if (!assigned.has(key) && !electiveLookup.has(key) && !eventLookup.has(key)) {
      const act = activities.find(a => a.id === pre.activityId)
      if (act) place(act, pre.groupId, pre.dayId, pre.blockId)
    }
  }

  const dayOrder = new Map(days.map((d, i) => [d.id, i]))

  function scoreForPrefer(act, groupId, dayId) {
    if (act.prefer_before_day == null || act.prefer_before_day_min == null) return 0
    const dayIdx = dayOrder.get(dayId)
    const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
    if (targetIdx < 0) return 0
    const countSoFar = getCount(groupId, act.id)
    if (countSoFar < act.prefer_before_day_min && dayIdx >= targetIdx) return 1
    return 0
  }

  function runRound(slotsToFill, priority) {
    const roundSlots = slotsToFill.filter(s => {
      const acts = s.eligibleActs.filter(a => a.priority === priority)
      return acts.some(a => canPlace(a, s.groupId, s.dayId, s.blockId))
    })
    roundSlots.sort((a, b) => {
      const aCount = a.eligibleActs.filter(x => x.priority === priority && canPlace(x, a.groupId, a.dayId, a.blockId)).length
      const bCount = b.eligibleActs.filter(x => x.priority === priority && canPlace(x, b.groupId, b.dayId, b.blockId)).length
      return aCount - bCount
    })
    for (const slot of roundSlots) {
      if (assigned.has(`${slot.groupId}|${slot.dayId}|${slot.blockId}`)) continue
      let candidates = slot.eligibleActs
        .filter(a => a.priority === priority && canPlace(a, slot.groupId, slot.dayId, slot.blockId))
      if (!candidates.length) continue
      const normal = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) === 0)
      const deferred = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) !== 0)
      const ordered = [...normal, ...deferred]
      ordered.sort((a, b) => {
        const diff = getCount(slot.groupId, a.id) - getCount(slot.groupId, b.id)
        return diff !== 0 ? diff : rand() - 0.5
      })
      place(ordered[0], slot.groupId, slot.dayId, slot.blockId)
    }
  }

  const unfilledSlots = openSlots.filter(s => !assigned.has(`${s.groupId}|${s.dayId}|${s.blockId}`))
  if (!anchorsOnly) {
    runRound(unfilledSlots, 'high')
    const stillUnfilled = openSlots.filter(s => !assigned.has(`${s.groupId}|${s.dayId}|${s.blockId}`))
    runRound(stillUnfilled, 'low')
  }

  // ── Pass 3: audit ─────────────────────────────────────────────────────────
  const resultSlots = []

  for (const slot of slots) {
    resultSlots.push({ ...slot })
  }

  for (const os of openSlots) {
    const key = `${os.groupId}|${os.dayId}|${os.blockId}`
    const actId = assigned.get(key) || null
    const isSpanHead = !spanTails.has(key)
    const flags = {}

    if (!actId && !anchorsOnly) {
      flags.UNFILLABLE = true
      flags.UNFILLABLE_reason = 'No eligible activity could be placed in this slot'
    }

    resultSlots.push({ groupId: os.groupId, dayId: os.dayId, blockId: os.blockId, cohort_id: cohortId, type: 'activity', activityId: actId, anchorId: null, is_span_head: isSpanHead, flags })
  }

  // Resolve activityTargets: caller may supply scaled min/max for override weeks
  function getMin(actId) {
    if (activityTargets?.[actId]?.min_per_week != null) return activityTargets[actId].min_per_week
    return activities.find(a => a.id === actId)?.min_per_week ?? 0
  }

  // Aggregate findings — one per (groupId, activityId, kind), never stamped
  // onto individual slots. See docs/adr/2026-07-28-schedule-flag-findings-reshape.md.
  const findings = []
  const underserved = []
  if (!anchorsOnly) {
    for (const group of groups) {
      for (const act of activities) {
        if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
        if (getMin(act.id) <= 0) continue
        if (getCount(group.id, act.id) < getMin(act.id)) {
          underserved.push({ groupId: group.id, activityId: act.id, got: getCount(group.id, act.id), needed: getMin(act.id) })
        }
      }
    }

    for (const u of underserved) {
      const groupName = groupMap.get(u.groupId)?.name || u.groupId
      const act = activities.find(a => a.id === u.activityId)
      const actName = act?.name || u.activityId
      const reason = `Goal: ${u.needed}×/wk — scheduled ${u.got}× (group: ${groupName}, activity: ${actName})`
      findings.push({ kind: 'UNDERSERVED', groupId: u.groupId, activityId: u.activityId, severity: 'caution', reason, got: u.got, needed: u.needed })
    }

    for (const group of groups) {
      for (const act of activities) {
        if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
        if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
        const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
        if (targetIdx < 0) continue
        // One SESSION, not one block: a 2-block swim is a single swim. The
        // tail rows of a span carry the same activityId and would otherwise
        // each count, which both overstates the week and disagreed with
        // computeFindings() below (which has always counted heads only).
        const beforeCount = resultSlots.filter(s =>
          s.type === 'activity' && s.groupId === group.id && s.activityId === act.id &&
          s.is_span_head !== false &&
          (dayOrder.get(s.dayId) ?? 99) < targetIdx
        ).length
        if (beforeCount < act.prefer_before_day_min) {
          const reason = `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} — only ${beforeCount}× placed (group: ${group.name}, activity: ${act.name})`
          findings.push({ kind: 'DISTRIBUTION', groupId: group.id, activityId: act.id, severity: 'info', reason, beforeCount, requiredBefore: act.prefer_before_day_min, byDay: act.prefer_before_day })
        }
      }
    }
  }

  return {
    slots: resultSlots,
    findings,
  }
}

// Pure, placement-free recompute of UNDERSERVED/DISTRIBUTION findings from an
// already-persisted set of template_slots rows (snake_case DB shape:
// group_id/day_id/time_block_id/activity_id). Used when the screen loads or
// restores a schedule without regenerating it — see B2 in the round-2 review:
// findings must reflect what's on screen, not just what the last generate()
// happened to compute. Mirrors the aggregate-findings logic in scheduleCohort's
// Pass 3, but reads counts off `slots` instead of the live placement maps.
export function computeFindings({ slots, groups, activities, days }) {
  const findings = []
  if (!slots || !groups || !activities || !days) return findings

  const eligibility = new Map()
  for (const act of activities) {
    // Contract: eligible_tier_ids / eligible_group_ids are arrays of ids.
    // Callers normalize — this engine does not deserialize; see
    // src/utils/normalizeActivityEligibility.js.
    if (import.meta.env.DEV) assertIdListShape(act.eligible_group_ids, 'eligible_group_ids', act.id)
    const eligible = new Set()
    for (const g of groups) {
      if (isActivityEligibleForGroup(act, g)) eligible.add(g.id)
    }
    eligibility.set(act.id, eligible)
  }

  const groupMap = new Map(groups.map(g => [g.id, g]))
  const dayOrder = new Map(days.map((d, i) => [d.id, i]))

  // Count once per placement (head only), matching Pass 3 above — a spanned
  // activity persists as a head row plus one tail row per extra block. Rows
  // predating the is_span_head column have it undefined and count as heads.
  const activitySlots = slots.filter(s => !s.is_anchor && s.activity_id && s.is_span_head !== false)
  const counts = new Map() // "groupId|activityId" → count
  for (const s of activitySlots) {
    const k = `${s.group_id}|${s.activity_id}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  function getCount(groupId, actId) { return counts.get(`${groupId}|${actId}`) || 0 }

  const underserved = []
  for (const group of groups) {
    for (const act of activities) {
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const min = act.min_per_week ?? 0
      if (min <= 0) continue
      const got = getCount(group.id, act.id)
      if (got < min) underserved.push({ groupId: group.id, activityId: act.id, got, needed: min })
    }
  }

  for (const u of underserved) {
    const groupName = groupMap.get(u.groupId)?.name || u.groupId
    const act = activities.find(a => a.id === u.activityId)
    const actName = act?.name || u.activityId
    const reason = `Goal: ${u.needed}×/wk — scheduled ${u.got}× (group: ${groupName}, activity: ${actName})`
    findings.push({ kind: 'UNDERSERVED', groupId: u.groupId, activityId: u.activityId, severity: 'caution', reason, got: u.got, needed: u.needed })
  }

  for (const group of groups) {
    for (const act of activities) {
      if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
      if (targetIdx < 0) continue
      const beforeCount = activitySlots.filter(s =>
        s.group_id === group.id && s.activity_id === act.id &&
        (dayOrder.get(s.day_id) ?? 99) < targetIdx
      ).length
      if (beforeCount < act.prefer_before_day_min) {
        const reason = `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} — only ${beforeCount}× placed (group: ${group.name}, activity: ${act.name})`
        findings.push({ kind: 'DISTRIBUTION', groupId: group.id, activityId: act.id, severity: 'info', reason, beforeCount, requiredBefore: act.prefer_before_day_min, byDay: act.prefer_before_day })
      }
    }
  }

  return findings
}

function buildSchedule(input) {
  const { cohorts, days, activities, campId, locations, anchorsOnly, weekId } = normalizeInput(input)

  // location_id → capacity (how many GROUPS fit in this place at once). Built
  // once from the camp's locations rows. A stored capacity of 0 or negative
  // (not reachable via the M3a UI — CapacityStepper floors at 1 — but
  // reachable via the op-log or a future import) floors to 1, matching M1's
  // migration; a place always holds at least 1 group. A location_id absent
  // from this map entirely (dangling — see placeBlocked) is a different case
  // and is NOT defaulted here: its absence from the map is exactly what tells
  // placeBlocked to treat it as unconstrained.
  const locationCapById = new Map()
  for (const loc of (locations || [])) {
    if (loc && loc.id != null) locationCapById.set(loc.id, loc.capacity > 0 ? loc.capacity : 1)
  }

  // Findings that are properties of an activity, not of any one cohort/group,
  // so computed once here rather than per cohort. Gated by anchorsOnly like
  // the rest of the findings work (Pass 3), since anchorsOnly is an
  // anchors-grid-only audit.
  const danglingFindings = []
  if (!anchorsOnly) {
    for (const act of activities) {
      if (act.location_id != null && !locationCapById.has(act.location_id)) {
        danglingFindings.push({
          kind: 'DANGLING_LOCATION',
          groupId: null,
          activityId: act.id,
          severity: 'caution',
          reason: `"${act.name || act.id}" is set to a location that isn't in your locations list, so it has no capacity limit`,
        })
      }
    }
  }

  // Pass 1: schedule each cohort independently
  // (multi-cohort cross-resource conflict detection is Sub-project 3)
  const allSlots = []
  const allFindings = [...danglingFindings]

  for (let idx = 0; idx < cohorts.length; idx++) {
    const cohortEntry = cohorts[idx]
    const cohortSeed = campId + (cohortEntry.cohort?.id || String(idx))
    const rand = mulberry32(djb2(cohortSeed))
    const { slots, findings } = scheduleCohort({ cohortEntry, days, activities, rand, locationCapById, anchorsOnly, weekId })
    allSlots.push(...slots)
    allFindings.push(...findings)
  }

  return {
    slots: allSlots,
    conflicts: [], // Sub-project 3: cross-cohort conflict detection
    findings: allFindings,
  }
}

export default buildSchedule
