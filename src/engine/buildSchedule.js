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
// Output: { slots, stats, conflicts }
//   slots     — array of scheduled slot objects (cohort_id and is_span_head added)
//   stats     — coverage stats
//   conflicts — cross-cohort resource conflicts (always [] until multi-cohort engine in Sub-project 3)

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
function normalizeInput(input) {
  if (input.cohorts) {
    // New multi-cohort signature — pass through as-is
    return {
      cohorts: input.cohorts,
      days: input.days,
      activities: input.activities,
      campId: input.campId || '',
    }
  }
  // Legacy flat signature — wrap in a single-cohort array
  return {
    cohorts: [{
      cohort: { id: null, anchor_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
      timeBlocks: input.timeBlocks || [],
      tiers: input.tiers || [],
      groups: input.groups || [],
      preplacedSlots: input.preplacedSlots || [],
      activityTargets: null,
      // Legacy anchors are resolved to preplaced-style objects inside scheduleCohort
      _legacyAnchors: input.anchors || [],
    }],
    days: input.days || [],
    activities: input.activities || [],
    campId: input.campId || '',
  }
}

function scheduleCohort({ cohortEntry, days, activities, rand }) {
  const { cohort, timeBlocks, tiers: _tiers, groups, preplacedSlots, activityTargets, _legacyAnchors } = cohortEntry
  const cohortId = cohort?.id ?? null

  // Sort time blocks by sort_order so span_blocks consecutive logic is stable
  const timeBlocksSorted = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
  const blockOrder = new Map(timeBlocksSorted.map((b, i) => [b.id, i]))

  // ── Pass 0: resolve eligibility ──────────────────────────────────────────
  const eligibility = new Map() // activityId → Set<groupId>
  for (const act of activities) {
    const tierIds = act.eligible_tier_ids || []
    const groupIds = act.eligible_group_ids || []
    let eligible = new Set()
    if (tierIds.length === 0 && groupIds.length === 0) {
      for (const g of groups) eligible.add(g.id)
    } else {
      if (tierIds.length > 0) {
        const tierSet = new Set(tierIds)
        for (const g of groups) {
          if (tierSet.has(g.tier_id)) eligible.add(g.id)
        }
      }
      for (const gid of groupIds) eligible.add(gid)
    }
    eligibility.set(act.id, eligible)
  }

  // ── Pass 1: map the grid ──────────────────────────────────────────────────
  // Build anchor lookup from legacy anchors (flat signature) or preplacedSlots
  const anchorLookup = new Map() // "groupId|dayId|blockId" → anchor
  const anchors = _legacyAnchors || []
  for (const anchor of anchors) {
    const groupList = anchor.is_all_groups ? groups.map(g => g.id) : (anchor.group_ids || [])
    for (const gid of groupList) {
      anchorLookup.set(`${gid}|${anchor.day_id}|${anchor.time_block_id}`, anchor)
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

        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'anchor', activityId: null, anchorId: anchor.id, is_span_head: true, flags: {} })
          continue
        }

        const avail = group.availability
        const pod = block.part_of_day
        if (avail !== 'all' && avail !== pod) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, cohort_id: cohortId, type: 'unavailable', activityId: null, anchorId: null, is_span_head: true, flags: {} })
          continue
        }

        const eligibleActs = activities.filter(a => (eligibility.get(a.id) || new Set()).has(group.id))
        openSlots.push({ groupId: group.id, dayId: day.id, blockId: block.id, eligibleActs })
      }
    }
  }

  // ── Pass 2: place activities ──────────────────────────────────────────────
  const assigned = new Map() // "groupId|dayId|blockId" → activityId
  const spanTails = new Set() // keys for tail blocks of multi-block placements
  const usageCount = new Map() // "groupId|activityId" → count
  const locationUsage = new Map() // "location|dayId|blockId" → [{ groupId, tierId }]

  function getCount(groupId, actId) {
    return usageCount.get(`${groupId}|${actId}`) || 0
  }

  function incCount(groupId, actId) {
    const k = `${groupId}|${actId}`
    usageCount.set(k, (usageCount.get(k) || 0) + 1)
  }

  function locationKey(location, dayId, blockId) { return `${location}|${dayId}|${blockId}` }

  function canPlace(act, groupId, dayId, blockId) {
    if (getCount(groupId, act.id) >= act.max_per_week) return false

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      if (blockIdx === undefined) return false
      const group = groupMap.get(groupId)
      const avail = group?.availability
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (!nextBlock) return false  // not enough blocks remaining
        const nextKey = `${groupId}|${dayId}|${nextBlock.id}`
        if (assigned.has(nextKey) || anchorLookup.has(nextKey)) return false
        // Tail block must also be within the group's available part of day
        if (avail !== 'all' && avail !== nextBlock.part_of_day) return false
      }
    }

    if (act.location && act.max_groups_per_slot > 1) {
      const lk = locationKey(act.location, dayId, blockId)
      const occupants = locationUsage.get(lk) || []
      if (occupants.length >= act.max_groups_per_slot) return false
      const group = groupMap.get(groupId)
      if (act.same_tier_only && occupants.length > 0) {
        const allSameTier = occupants.every(o => o.tierId === group.tier_id)
        if (!allSameTier) return false
      }
    } else if (act.location && act.max_groups_per_slot === 1) {
      const lk = locationKey(act.location, dayId, blockId)
      if ((locationUsage.get(lk) || []).length >= 1) return false
    }

    return true
  }

  function place(act, groupId, dayId, blockId) {
    const group = groupMap.get(groupId)
    // Guard: if group is not in this cohort, skip location tracking (can't read tier_id)
    const safeGroup = group ?? { tier_id: null }
    const headKey = `${groupId}|${dayId}|${blockId}`
    assigned.set(headKey, act.id)
    incCount(groupId, act.id)  // count once per placement (head only)

    const spanCount = act.span_blocks || 1
    if (spanCount > 1) {
      const blockIdx = blockOrder.get(blockId)
      for (let i = 1; i < spanCount; i++) {
        const nextBlock = timeBlocksSorted[blockIdx + i]
        if (nextBlock) {
          const tailKey = `${groupId}|${dayId}|${nextBlock.id}`
          assigned.set(tailKey, act.id)
          spanTails.add(tailKey)
          // Track location usage for tail blocks too
          if (act.location) {
            const lk = locationKey(act.location, dayId, nextBlock.id)
            const list = locationUsage.get(lk) || []
            list.push({ groupId, tierId: safeGroup.tier_id })
            locationUsage.set(lk, list)
          }
        }
      }
    }

    if (act.location) {
      const lk = locationKey(act.location, dayId, blockId)
      const list = locationUsage.get(lk) || []
      list.push({ groupId, tierId: safeGroup.tier_id })
      locationUsage.set(lk, list)
    }
  }

  // Pre-place locked slots (anchors from new signature + any explicit preplacedSlots)
  for (const pre of (preplacedSlots || [])) {
    const key = `${pre.groupId}|${pre.dayId}|${pre.blockId}`
    if (!assigned.has(key)) {
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
  runRound(unfilledSlots, 'high')
  const stillUnfilled = openSlots.filter(s => !assigned.has(`${s.groupId}|${s.dayId}|${s.blockId}`))
  runRound(stillUnfilled, 'low')

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

    if (!actId) {
      flags.UNFILLABLE = true
      flags.UNFILLABLE_reason = 'No eligible activity could be placed in this slot'
    } else {
      const act = activities.find(a => a.id === actId)
      if (act?.is_outdoor) {
        flags.WEATHER_RISK = true
        flags.WEATHER_RISK_reason = 'Outdoor activity scheduled in this slot'
      }
    }

    resultSlots.push({ groupId: os.groupId, dayId: os.dayId, blockId: os.blockId, cohort_id: cohortId, type: 'activity', activityId: actId, anchorId: null, is_span_head: isSpanHead, flags })
  }

  // Resolve activityTargets: caller may supply scaled min/max for override weeks
  function getMin(actId) {
    if (activityTargets?.[actId]?.min_per_week != null) return activityTargets[actId].min_per_week
    return activities.find(a => a.id === actId)?.min_per_week ?? 0
  }

  // UNDERSERVED
  const underserved = []
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
    for (const slot of resultSlots) {
      if (slot.type === 'activity' && slot.groupId === u.groupId && slot.activityId === u.activityId) {
        slot.flags = { ...slot.flags, UNDERSERVED: true, UNDERSERVED_reason: reason }
      }
    }
  }

  // DISTRIBUTION
  for (const group of groups) {
    for (const act of activities) {
      if (act.prefer_before_day == null || act.prefer_before_day_min == null) continue
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
      if (targetIdx < 0) continue
      const beforeCount = resultSlots.filter(s =>
        s.type === 'activity' && s.groupId === group.id && s.activityId === act.id &&
        (dayOrder.get(s.dayId) ?? 99) < targetIdx
      ).length
      if (beforeCount < act.prefer_before_day_min) {
        const reason = `Goal: ${act.prefer_before_day_min}× before day ${act.prefer_before_day} — only ${beforeCount}× placed (group: ${group.name}, activity: ${act.name})`
        for (const slot of resultSlots) {
          if (slot.type === 'activity' && slot.groupId === group.id && slot.activityId === act.id) {
            slot.flags = { ...slot.flags, DISTRIBUTION: true, DISTRIBUTION_reason: reason }
          }
        }
      }
    }
  }

  const openCount = resultSlots.filter(s => s.type === 'activity').length
  const filledCount = resultSlots.filter(s => s.type === 'activity' && s.activityId).length
  const unfillableCount = resultSlots.filter(s => s.flags?.UNFILLABLE).length
  const underservedCount = new Set(underserved.map(u => `${u.groupId}|${u.activityId}`)).size
  const totalFlags = resultSlots.reduce((sum, s) =>
    sum + Object.keys(s.flags || {}).filter(k => !k.includes('_')).length, 0)

  return {
    slots: resultSlots,
    stats: { openCount, filledCount, unfillableCount, underservedCount, totalFlags },
  }
}

function buildSchedule(input) {
  const { cohorts, days, activities, campId } = normalizeInput(input)

  // Pass 1: schedule each cohort independently
  // (multi-cohort cross-resource conflict detection is Sub-project 3)
  const allSlots = []
  const allStats = []

  for (let idx = 0; idx < cohorts.length; idx++) {
    const cohortEntry = cohorts[idx]
    const cohortSeed = campId + (cohortEntry.cohort?.id || String(idx))
    const rand = mulberry32(djb2(cohortSeed))
    const { slots, stats } = scheduleCohort({ cohortEntry, days, activities, rand })
    allSlots.push(...slots)
    allStats.push(stats)
  }

  // Combine stats across cohorts
  const combined = allStats.reduce((acc, s) => ({
    openCount: acc.openCount + s.openCount,
    filledCount: acc.filledCount + s.filledCount,
    unfillableCount: acc.unfillableCount + s.unfillableCount,
    underservedCount: acc.underservedCount + s.underservedCount,
    totalFlags: acc.totalFlags + s.totalFlags,
  }), { openCount: 0, filledCount: 0, unfillableCount: 0, underservedCount: 0, totalFlags: 0 })

  return {
    slots: allSlots,
    stats: cohorts.length === 1 ? allStats[0] : { ...combined, per_cohort: allStats },
    conflicts: [], // Sub-project 3: cross-cohort conflict detection
  }
}

export default buildSchedule
