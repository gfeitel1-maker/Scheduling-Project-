// Pure function — zero React dependencies, zero Supabase calls.
// Input: { groups, tiers, days, timeBlocks, activities, anchors }
// Output: { slots, stats }

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

function buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId = '', preplacedSlots = [] }) {
  const rand = mulberry32(djb2(campId))
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
  const anchorLookup = new Map() // "groupId|dayId|blockId" → anchor
  for (const anchor of anchors) {
    const groupList = anchor.is_all_groups ? groups.map(g => g.id) : (anchor.group_ids || [])
    for (const gid of groupList) {
      anchorLookup.set(`${gid}|${anchor.day_id}|${anchor.time_block_id}`, anchor)
    }
  }

  const groupMap = new Map(groups.map(g => [g.id, g]))

  const slots = [] // { groupId, dayId, blockId, type, activityId, anchorId, flags }

  const openSlots = [] // slots available for scheduling

  for (const group of groups) {
    for (const day of days) {
      for (const block of timeBlocks) {
        const key = `${group.id}|${day.id}|${block.id}`
        const anchor = anchorLookup.get(key)

        if (anchor) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, type: 'anchor', activityId: null, anchorId: anchor.id, flags: {} })
          continue
        }

        const avail = group.availability
        const pod = block.part_of_day
        if (avail !== 'all' && avail !== pod) {
          slots.push({ groupId: group.id, dayId: day.id, blockId: block.id, type: 'unavailable', activityId: null, anchorId: null, flags: {} })
          continue
        }

        const eligibleActs = activities.filter(a => (eligibility.get(a.id) || new Set()).has(group.id))
        openSlots.push({ groupId: group.id, dayId: day.id, blockId: block.id, eligibleActs })
      }
    }
  }

  // ── Pass 2: place activities ──────────────────────────────────────────────
  const assigned = new Map() // "groupId|dayId|blockId" → activityId
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
    const group = groupMap.get(groupId)
    // max_per_week
    if (getCount(groupId, act.id) >= act.max_per_week) return false

    // location capacity
    if (act.location && act.max_groups_per_slot > 1) {
      const lk = locationKey(act.location, dayId, blockId)
      const occupants = locationUsage.get(lk) || []
      if (occupants.length >= act.max_groups_per_slot) return false

      // same_tier_only
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
    assigned.set(`${groupId}|${dayId}|${blockId}`, act.id)
    incCount(groupId, act.id)
    if (act.location) {
      const lk = locationKey(act.location, dayId, blockId)
      const group = groupMap.get(groupId)
      const list = locationUsage.get(lk) || []
      list.push({ groupId, tierId: group.tier_id })
      locationUsage.set(lk, list)
    }
  }

  // Pre-place locked slots before Pass 2 scoring
  for (const pre of preplacedSlots) {
    const key = `${pre.groupId}|${pre.dayId}|${pre.blockId}`
    if (!assigned.has(key)) {
      const act = activities.find(a => a.id === pre.activityId)
      if (act) place(act, pre.groupId, pre.dayId, pre.blockId)
    }
  }

  // Day index lookup for prefer_before_day
  const dayOrder = new Map(days.map((d, i) => [d.id, i]))

  function scoreForPrefer(act, groupId, dayId) {
    if (act.prefer_before_day == null || act.prefer_before_day_min == null) return 0
    const dayIdx = dayOrder.get(dayId)
    // find the day whose day_of_week matches prefer_before_day
    const targetIdx = days.findIndex(d => d.day_of_week === act.prefer_before_day)
    if (targetIdx < 0) return 0
    const countSoFar = getCount(groupId, act.id)
    if (countSoFar < act.prefer_before_day_min && dayIdx >= targetIdx) return 1 // deprioritize
    return 0
  }

  function runRound(slots, priority) {
    const roundSlots = slots.filter(s => {
      const acts = s.eligibleActs.filter(a => a.priority === priority)
      return acts.some(a => canPlace(a, s.groupId, s.dayId, s.blockId))
    })

    // sort by fewest eligible candidates first (most constrained)
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

      // separate deprioritized (prefer_before_day penalty)
      const normal = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) === 0)
      const deferred = candidates.filter(a => scoreForPrefer(a, slot.groupId, slot.dayId) !== 0)
      const ordered = [...normal, ...deferred]

      // pick lowest usage, break ties randomly
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
    const actId = assigned.get(`${os.groupId}|${os.dayId}|${os.blockId}`) || null
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

    resultSlots.push({ groupId: os.groupId, dayId: os.dayId, blockId: os.blockId, type: 'activity', activityId: actId, anchorId: null, flags })
  }

  // UNDERSERVED: group × activity where min_per_week not met
  const underserved = []
  for (const group of groups) {
    for (const act of activities) {
      if (!(eligibility.get(act.id) || new Set()).has(group.id)) continue
      if (act.min_per_week <= 0) continue
      if (getCount(group.id, act.id) < act.min_per_week) {
        underserved.push({ groupId: group.id, activityId: act.id, got: getCount(group.id, act.id), needed: act.min_per_week })
      }
    }
  }

  // Mark UNDERSERVED on slots (flag the group's slots for that activity)
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

  // DISTRIBUTION: prefer_before_day not met
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

  // Stats
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

export default buildSchedule
