// Infer `max_groups_per_slot` from the grid's own co-occurrence (T114).
//
// PURE. No database, no I/O — same discipline as activityRules.js: this
// proposes, the director confirms in the preview before anything is written.
//
// WHAT IS INFERRED, AND WHY ONLY THIS
//
// A schedule records, directly, how many groups were doing an activity at the
// same moment. `max_groups_per_slot` is a statement about exactly that, so it
// can be read off the grid without guessing. The input is capturePlacements'
// output — {groupName, dayName, blockLabel, activityName} — which ImportScreen
// already computes at parse time for T117.
//
// WHAT IS DELIBERATELY NOT INFERRED, per the owner's ruling on this ticket
// (2026-09-13) and the repo's standing rule against fabricated provenance:
//
//   is_outdoor — a property of the PLACE, not the placement. A cell reading
//     `Archery / Barn` says nothing about whether the Barn is outdoors. Only a
//     locations list could carry that. (Spun off as T147.)
//
// `same_tier_only` IS inferable and IS inferred here, whenever group ->
// division membership is known. An earlier draft of this module refused it
// outright on the grounds that "ingestion has no group -> tier map" — owner
// correction, 2026-09-13: that is a statement about a CURRENT GAP in
// ingestion, not about the domain. If you know which groups are in which
// division, "did only same-division groups share this slot?" is read straight
// off the grid, exactly like the count beside it.
//
// So it is conditional, not impossible. The caller passes `groupTierByName`
// when membership is known — which it is on any re-import into an existing
// camp, where live groups already carry `tier_id`. When it is NOT known the
// key is OMITTED rather than defaulted, because "we could not tell" and "no,
// groups mixed" are different answers and only one of them is honest.
//
//   weather_alternative_id — "what to run instead when it rains" is a plan the
//     director holds, not an observation the grid contains. Two activities
//     never co-occurring is not evidence one substitutes for the other.
//
// THE RULE, as the owner states it (2026-09-13):
//
//   "an activity of any kind can [be] inferred to be co-scheduled based on
//    whether or not it shows up that way during any ingest. whether that
//    co-scheduling is all, some, a few, two, or none is activity dependent."
//
// So: seen sharing a slot even once -> it CAN be co-scheduled. Never seen
// sharing -> it cannot. And the answer includes WHICH groups, not just how
// many:
//
//   Sports, Alufim 1 + Alufim 2 on one Tuesday only
//     -> can share, with those groups. Not every day, not obligatory.
//   Lunch 1, Tzofim 1/2/3 at the same time every day
//     -> co-schedulable for Tzofim 1/2/3, and NOT for any other group on any
//        day. This is a RECURRING activity (some groups, same time, many days).
//   Carpool, all groups every day at the same time
//     -> an ANCHOR. Co-schedulable like everything else, but the engine places
//        anchors FIRST, so the rule barely matters for it.
//
// Placement order the engine works in: anchors/fixed first, recurring second,
// everything else third by priority.
//
// EVERY ACTIVITY GETS ITS OWN RULE, ANCHORS INCLUDED (owner: "the rule is
// applied to an activity not to a group").
//
// An all-camp lunch really can take the whole camp, so `max_groups_per_slot =
// every group` is a TRUE fact about that lunch and belongs on it. Nothing is
// filtered out of this function.
//
// The anchor exclusion the owner asked for lives where it actually matters —
// `refineDivisionsByCoOccurrence` in inferDivisions.js — because there an
// anchor's co-occurrence would wrongly imply that two groups belong to the
// same DIVISION. That is the "never a factor for determining whether ANOTHER
// activity set can be co-scheduled" case. An anchor's own rule is not another
// activity's rule.
//
// If a later source genuinely carries one of those two (a locations list with
// an outdoor column; a stated rainy-day plan), infer it there — not here, and
// not by reading tea leaves in the placements.

function slotKey(dayName, blockLabel) {
  // Day is part of the key on purpose: two groups at 9:00 on DIFFERENT days
  // never actually shared a room, and counting them as concurrent would
  // overstate the capacity the engine then schedules against.
  return `${dayName}${blockLabel}`
}

/**
 * @param {Array<{groupName: string, dayName: string, blockLabel: string, activityName: string}>} placements
 *        capturePlacements(...).placements
 * @param {Object<string,string>} [groupTierByName]
 *        group name -> division/tier name, when membership is known. Omit it and
 *        `same_tier_only` is omitted too — never guessed.
 *
 *        NOTE (Red Hat, T114 review): an earlier version of this comment claimed
 *        a re-import "reads it off live groups' tier_id". It does not — the only
 *        caller (ImportScreen) builds this map purely from THIS file's parse
 *        (inferred divisions overlaid with stated units). So a re-import into a
 *        camp whose divisions are already confirmed in the database gets no
 *        benefit from that confirmed structure. The failure mode is a benign one
 *        (same_tier_only degrades to omitted, never to a wrong value), but the
 *        opportunity is real and unclaimed.
 * @returns {Map<string, {max_groups_per_slot: number, same_tier_only?: boolean, _inferred: true, support: object}>}
 *          keyed by activityName, spelled as the placements spell it
 */
export function inferCoScheduleRules(placements, groupTierByName) {
  const rows = Array.isArray(placements) ? placements : []
  const tierOf = groupTierByName
    ? (groupName) => groupTierByName[groupName] ?? null
    : null

  // activityName -> slotKey -> Set(groupName)
  const byActivity = new Map()

  for (const row of rows) {
    const activity = row?.activityName
    const group = row?.groupName
    const day = row?.dayName
    const block = row?.blockLabel
    // A placement missing any coordinate cannot be located in the grid, so it
    // cannot contribute to a co-occurrence count. Skipped rather than
    // defaulted — a guessed coordinate would invent a concurrency that was
    // never observed.
    if (!activity || !group || !day || !block) continue

    if (!byActivity.has(activity)) byActivity.set(activity, new Map())
    const slots = byActivity.get(activity)
    const key = slotKey(day, block)
    if (!slots.has(key)) slots.set(key, { day, block, groups: new Set() })
    slots.get(key).groups.add(group)
  }

  const rules = new Map()
  for (const [activity, slots] of byActivity) {
    let busiest = null
    for (const slot of slots.values()) {
      if (!busiest || slot.groups.size > busiest.groups.size) busiest = slot
    }
    if (!busiest) continue

    // same_tier_only: across EVERY slot this activity appears in, did groups
    // from more than one division ever share one? A single mixed slot settles
    // it as false — one counter-example is enough, and that is the whole
    // meaning of the rule.
    //
    // Requires membership for every group involved. One unknown group means
    // the answer is unknown, not false: a group we cannot place in a division
    // could be the one that breaks it.
    let sameTierOnly
    if (tierOf) {
      let allKnown = true
      let sawMixed = false
      for (const slot of slots.values()) {
        const tiers = new Set()
        for (const g of slot.groups) {
          const t = tierOf(g)
          if (t == null) { allKnown = false; break }
          tiers.add(t)
        }
        if (!allKnown) break
        if (tiers.size > 1) { sawMixed = true; break }
      }
      if (allKnown) sameTierOnly = !sawMixed
    }

    // WHICH groups can share this activity, not merely how many. Lunch 1 seen
    // with Tzofim 1/2/3 every day is co-schedulable FOR THOSE THREE — not for
    // any other group, on any day. The union across every slot is the set the
    // grid actually vouches for.
    const coScheduleGroups = new Set()
    for (const slot of slots.values()) {
      if (slot.groups.size > 1) for (const g of slot.groups) coScheduleGroups.add(g)
    }

    rules.set(activity, {
      max_groups_per_slot: busiest.groups.size,
      // CAN, not must. One observation of two groups sharing a slot is enough
      // to say it is possible; it never obliges the engine to do it again.
      can_co_schedule: busiest.groups.size > 1,
      co_schedule_groups: [...coScheduleGroups].sort(),
      ...(sameTierOnly === undefined ? {} : { same_tier_only: sameTierOnly }),
      _inferred: true,
      // The observation the number came from, so a director asking "why?"
      // after the import session ends can still be told (B4,
      // docs/adr/2026-08-10-ingestion-evidence-persistence.md) — same shape
      // and same purpose as activityRules.js's own `support`.
      support: {
        busiest_slot: { day: busiest.day, block: busiest.block },
        // Sorted so the evidence is stable across runs; a Set's iteration
        // order follows insertion, which follows file order, which would make
        // the recorded evidence differ for the same camp read twice.
        groups_in_busiest_slot: [...busiest.groups].sort(),
        slots_observed: slots.size,
      },
    })
  }

  return rules
}
