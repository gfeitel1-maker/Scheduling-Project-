// Recognise a director's override sitting on top of an all-camp activity (T114).
//
// PURE. No database, no I/O — this proposes a QUESTION, it never writes.
//
// THE PATTERN (owner, 2026-09-13):
//
//   "if there is an activity that missed one group but is for all others, but
//    only happens once a week — that is most likely a director overriding the
//    schedule's preferences and that 1 group either has something they cannot
//    miss (like swim?) or has a trip that precludes them from being there. but
//    when you are actually scheduling, that is a secondary thing you put in,
//    not something you are doing when drafting it. the original schedule
//    probably said all camp activity for all groups on this day."
//
// WHY THIS MATTERS MORE THAN IT LOOKS
//
// The naive reading of "Color War: everyone except Alufim 1" is that Color War
// EXCLUDES Alufim 1 — and writing that down turns a one-off scheduling
// accommodation into a permanent rule the engine will honour forever. The
// director never said that. They said "all camp", and then pulled one group out
// for a trip.
//
// So this does not silently infer either answer. It recognises the shape and
// raises it, because only the director knows whether Alufim 1 had a trip that
// week or genuinely never attends.
//
// TWO SIGNALS TOGETHER, NEITHER ALONE
//
//   near-universal attendance — almost every group, but not quite
//   low frequency          — it happens once, not every day
//
// Both are required. An all-but-one activity that runs EVERY day is not an
// override; that is a standing arrangement, and the missing group really does
// not attend. A half-camp activity is not an override either; that is an
// ordinary restriction. It is the combination — nearly everyone, but rarely —
// that says "someone was pulled out of this."

const MAX_MISSING = 2 // "missed one group" — allow two, for a big camp
// ...but an absolute cap alone is not enough: 2 missing out of 4 groups is HALF
// the camp, which is an ordinary restricted activity, not somebody pulled out.
// "Almost everyone" has to mean almost everyone, so the share attending must
// also be clearly dominant. 3-of-4 (0.75) qualifies; 2-of-4 (0.5) does not.
const NEAR_ALL_RATIO = 0.7
const MAX_OCCURRENCES = 2 // "only happens once a week" — allow twice
const MIN_CAMP_SIZE = 3 // below this, "almost everyone" means nothing

function slotKey(day, block) {
  return `${day} ${block}`
}

/**
 * @param {Array<{groupName, dayName, blockLabel, activityName}>} placements
 * @param {string[]} allGroupNames every group the camp has
 * @returns {Array<{activityName, day, block, missingGroups, attendingCount, totalGroups, occurrences}>}
 *          one entry per probable override, sorted for a stable preview order
 */
export function detectAllCampOverrides(placements, allGroupNames) {
  const rows = Array.isArray(placements) ? placements : []
  const allGroups = Array.isArray(allGroupNames) ? allGroupNames.filter(Boolean) : []
  if (!rows.length || allGroups.length < MIN_CAMP_SIZE) return []

  // activity -> slotKey -> { day, block, groups:Set }
  const byActivity = new Map()
  for (const r of rows) {
    if (!r?.activityName || !r?.groupName || !r?.dayName || !r?.blockLabel) continue
    if (!byActivity.has(r.activityName)) byActivity.set(r.activityName, new Map())
    const slots = byActivity.get(r.activityName)
    const key = slotKey(r.dayName, r.blockLabel)
    if (!slots.has(key)) slots.set(key, { day: r.dayName, block: r.blockLabel, groups: new Set() })
    slots.get(key).groups.add(r.groupName)
  }

  const findings = []
  for (const [activityName, slots] of byActivity) {
    // Low frequency is a property of the ACTIVITY, not of one slot: an activity
    // running every day fails the test even if one particular day is short a
    // group, because that day's gap is then part of a standing pattern rather
    // than a one-off.
    if (slots.size > MAX_OCCURRENCES) continue

    for (const slot of slots.values()) {
      const missing = allGroups.filter((g) => !slot.groups.has(g))
      // Nothing missing: genuinely all-camp, no question to ask.
      // Too much missing: an ordinary restricted activity, also no question.
      if (missing.length === 0 || missing.length > MAX_MISSING) continue
      if (slot.groups.size / allGroups.length < NEAR_ALL_RATIO) continue

      findings.push({
        activityName,
        day: slot.day,
        block: slot.block,
        missingGroups: missing.slice().sort(),
        attendingCount: slot.groups.size,
        totalGroups: allGroups.length,
        occurrences: slots.size,
      })
    }
  }

  // Stable order so the same file asks the same questions in the same sequence.
  return findings.sort((a, b) =>
    a.activityName.localeCompare(b.activityName) ||
    a.day.localeCompare(b.day) ||
    a.block.localeCompare(b.block))
}
