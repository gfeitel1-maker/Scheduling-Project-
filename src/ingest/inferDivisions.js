// Infer age divisions and their group membership from group NAMES (T114).
//
// PURE. No database, no I/O — this proposes, the director confirms in the
// preview, same discipline as activityRules.js and coScheduleRules.js.
//
// THE MODEL (owner, 2026-09-13) — and note it starts from the opposite place
// than an earlier draft of this file did.
//
//   "What camp is not separating out their kids into divisions?"
//
// EVERY GROUP IS IN A DIVISION. That is the premise. The question is never
// "does this group belong to one?" but "which one?" An earlier version of this
// module required repetition to admit a division existed at all, and so
// returned nothing for `CIT`, nothing for `Maccabi`, and nothing for any camp
// whose bunks are plainly named — refusing to answer the ordinary case in the
// name of not guessing. That was the wrong trade: a division per group is the
// honest default, because it is what camps actually do.
//
// HOW NAMES CLUSTER
//
//   Tzofim 1, Tzofim 2, Tzofim 3   -> one division "Tzofim", three groups
//   Kittah Aleph, Kittah Bet       -> one division "Kittah", two groups
//   CIT                            -> its own division, one group
//   Maccabi                        -> its own division, even alone
//
// The index that varies may be a number (1/2/3), a latin letter (A/B/C), or a
// WORD acting as an ordinal — Aleph/Bet/Gimel are the camp's own counting
// words, and treating them as unrelated names was the specific mistake the
// owner corrected. So the rule is structural, not vocabulary-based: names
// sharing a leading token and differing only in a trailing token are one
// division. Nothing here needs to know Hebrew.
//
// WHAT NAMES CANNOT SETTLE, AND WHAT CAN
//
// Names cluster; they do not prove. Two families that share a stem may really
// be separate divisions — the owner's own test for that is behavioural, not
// lexical:
//
//   "if they weren't [the same division] then it would be that Kittah Aleph
//    groups 1, 2, 3 have something shared (like lunch or sports) but Kittah
//    Bet 1, 2, 3 don't share things with any Kittah Aleph group."
//
// That is `refineDivisionsByCoOccurrence` below: groups that never once appear
// in the same slot are evidence of a real boundary, and groups that regularly
// share activities are evidence of a real grouping. Names propose, the grid
// disposes.
//
// AGE IS NEVER ASKED FOR OR STORED. A division is identified by the camp's own
// word for it. Nothing here orders divisions by age, guesses a year, or ranks
// them.

const TOKEN_SPLIT = /[\s\-_#]+/

// A trailing qualifier in brackets — "(girls)", "[session 2]" — is not the
// index. Stripping it BEFORE stemming is what keeps "Tzofim 1 (girls)" /
// "Tzofim 2 (girls)" as one "Tzofim" division. Without this the stem reads as
// "Tzofim 1", every numbered variant becomes unique, and three bunks that are
// plainly one division are proposed as three — a WRONG division, which is
// worse than none because it looks confident.
const TRAILING_QUALIFIER = /\s*[([][^)\]]*[)\]]\s*$/

function strippedName(rawName) {
  return String(rawName ?? '').trim().replace(TRAILING_QUALIFIER, '').trim()
}

function tokensOf(rawName) {
  const name = strippedName(rawName)
  if (!name) return null
  const parts = name.split(TOKEN_SPLIT).filter(Boolean)
  return parts.length ? parts : null
}

const normalize = (s) => String(s).toLowerCase()

/**
 * @param {string[]} groupNames  proposed group names, spelled as extractEntities spells them
 * @returns {Object<string,string>} group name -> division name. EVERY non-empty
 *          group name appears. A group whose name shares no stem with any other
 *          is its own division, named for itself.
 */
export function inferDivisions(groupNames) {
  const names = (Array.isArray(groupNames) ? groupNames : [])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)

  // Cluster by leading token(s). A name's stem is everything but its final
  // token, when that leaves something; otherwise the name itself.
  // normalized stem -> { display, members: [] }
  const families = new Map()

  for (const name of names) {
    const parts = tokensOf(name)
    if (!parts) continue
    // parts is already qualifier-stripped; a single-token name falls back to
    // the stripped spelling, not the raw one, so "CIT (senior)" -> "CIT".
    const stem = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]
    const key = normalize(stem)
    if (!families.has(key)) families.set(key, { display: stem, members: [], solo: strippedName(name) })
    families.get(key).members.push(name)
  }

  const byGroup = {}
  for (const { display, members, solo } of families.values()) {
    // A stem shared by several groups names the division ("Tzofim", "Kittah").
    // A stem belonging to ONE group would name a division after a fragment of
    // that group ("Maccabi" from "Maccabi Gold"), so a lone group is its own
    // division under its FULL name instead — still a division, just its own.
    // A lone group is its own division under its FULL name minus any bracketed
    // qualifier: "CIT (senior)" -> "CIT", but "Maccabi Gold" stays whole. The
    // difference is that a bracket is demonstrably an aside, whereas dropping a
    // real word would name the division after half a bunk.
    const divisionName = members.length > 1 ? display : solo
    for (const member of members) byGroup[member] = divisionName
  }
  return byGroup
}

/**
 * Refine name-derived divisions using what the grid actually shows.
 *
 * The owner's test: groups in one division share activities with each other;
 * groups in different divisions do not. So a name-derived division whose
 * members NEVER co-occur is evidence the names misled us, and it splits.
 *
 * Deliberately conservative in one direction only: this SPLITS a division that
 * the grid contradicts, and never MERGES two divisions the names kept apart.
 * Merging on co-occurrence alone would fold every division that happens to
 * share an all-camp lunch into one, which is the opposite failure.
 *
 * ANCHORS MUST BE EXCLUDED (owner, 2026-09-13). An all-camp lunch puts every
 * group in one slot, so with anchors left in NOTHING would ever split — every
 * group would appear to share a division with every other. The caller passes
 * the anchor activity names; without that exclusion this function is not
 * conservative, it is inert.
 *
 * @param {Object<string,string>} byGroup  inferDivisions(...) output
 * @param {Array<{groupName, dayName, blockLabel, activityName}>} placements
 * @param {Iterable<string>} [anchorActivityNames] all-camp/every-day activities to ignore
 * @returns {Object<string,string>} the same shape, with contradicted divisions split
 */
export function refineDivisionsByCoOccurrence(byGroup, placements, anchorActivityNames) {
  const anchors = new Set([...(anchorActivityNames ?? [])].map((n) => String(n).trim().toLowerCase()))
  const rows = (Array.isArray(placements) ? placements : [])
    .filter((r) => !anchors.has(String(r?.activityName).trim().toLowerCase()))
  if (!rows.length) return { ...byGroup }

  // Which groups ever shared a slot with which.
  const slots = new Map()
  for (const r of rows) {
    if (!r?.groupName || !r?.dayName || !r?.blockLabel || !r?.activityName) continue
    const key = `${r.dayName} ${r.blockLabel} ${r.activityName}`
    if (!slots.has(key)) slots.set(key, new Set())
    slots.get(key).add(r.groupName)
  }
  const shares = new Map()
  const link = (a, b) => {
    if (!shares.has(a)) shares.set(a, new Set())
    shares.get(a).add(b)
  }
  for (const groups of slots.values()) {
    const list = [...groups]
    for (const a of list) for (const b of list) if (a !== b) link(a, b)
  }

  // Per division, split into connected components of "ever shared a slot".
  const members = new Map()
  for (const [group, division] of Object.entries(byGroup)) {
    if (!members.has(division)) members.set(division, [])
    members.get(division).push(group)
  }

  const out = {}
  for (const [division, groups] of members) {
    const unvisited = new Set(groups)
    const components = []
    while (unvisited.size) {
      const seed = unvisited.values().next().value
      unvisited.delete(seed)
      const comp = [seed]
      const queue = [seed]
      while (queue.length) {
        const g = queue.pop()
        for (const n of shares.get(g) ?? []) {
          if (unvisited.has(n)) { unvisited.delete(n); comp.push(n); queue.push(n) }
        }
      }
      components.push(comp.sort())
    }

    if (components.length <= 1) {
      for (const g of groups) out[g] = division
      continue
    }
    // Contradicted: the names said one division, the grid shows islands that
    // never meet. Name each island for its own first member so the director
    // sees a real distinction rather than "Kittah" twice.
    components.sort((a, b) => a[0].localeCompare(b[0]))
    for (const comp of components) {
      for (const g of comp) out[g] = comp[0]
    }
  }
  return out
}

/**
 * The `tiers` side: divisions ready to be proposed as age divisions with their
 * groups already assigned, so the Age Divisions screen fills in from the import
 * instead of reading "needed".
 *
 * @param {string[]} groupNames
 * @param {Array} [placements] when supplied, divisions the grid contradicts are split
 * @returns {Array<{name: string, groupNames: string[]}>} sorted for a stable preview
 */
export function inferDivisionEntities(groupNames, placements, anchorActivityNames) {
  let byGroup = inferDivisions(groupNames)
  if (placements) byGroup = refineDivisionsByCoOccurrence(byGroup, placements, anchorActivityNames)

  const byDivision = new Map()
  for (const [group, division] of Object.entries(byGroup)) {
    if (!byDivision.has(division)) byDivision.set(division, [])
    byDivision.get(division).push(group)
  }
  return [...byDivision.entries()]
    .map(([name, groups]) => ({ name, groupNames: groups.slice().sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Per-group provenance for the division assignment (T114 follow-up).
 *
 * Co-schedule rules record why they concluded what they did; divisions did not,
 * so a director shown "Kittah Aleph" and "Kittah Bet" as two separate divisions
 * had no way to find out why they were separated. This answers that.
 *
 * Keyed by GROUP rather than by division on purpose: the question a director
 * asks is "why is Tzofim 1 in Tzofim?", and a split then shows up naturally as
 * two groups whose support says the grid contradicted their shared name.
 *
 * Derived from the SAME two functions that produce the committed assignment, so
 * the explanation cannot drift from the decision it explains.
 *
 * @returns {Object<string,{division, basis, members, stem, qualifier_stripped,
 *          names_proposed?, anchors_excluded}>}
 */
export function divisionSupportByGroup(groupNames, placements, anchorActivityNames) {
  const names = (Array.isArray(groupNames) ? groupNames : [])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)
  if (!names.length) return {}

  const byName = inferDivisions(names)
  const byGroup = placements
    ? refineDivisionsByCoOccurrence(byName, placements, anchorActivityNames)
    : { ...byName }

  // Stem per group, recomputed exactly as inferDivisions computes it, so the
  // quoted reason is the real one rather than a plausible reconstruction.
  const stemOf = {}
  const strippedOf = {}
  for (const name of names) {
    const parts = tokensOf(name)
    stemOf[name] = parts ? (parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]) : name
    strippedOf[name] = strippedName(name) !== name
  }

  const membersOf = new Map()
  for (const [group, division] of Object.entries(byGroup)) {
    if (!membersOf.has(division)) membersOf.set(division, [])
    membersOf.get(division).push(group)
  }

  // Guarded on `placements`, not just on the list being non-empty: with no
  // placements the co-occurrence pass never ran, so nothing was "ignored" and
  // saying so would imply a grid check that did not happen. Not reachable from
  // ImportScreen today (it always supplies placements) — closed here rather
  // than left to caller discipline.
  const anchors = placements ? [...(anchorActivityNames ?? [])].map((n) => String(n)).sort() : []
  const out = {}
  for (const name of names) {
    const division = byGroup[name]
    if (division === undefined) continue
    const members = (membersOf.get(division) ?? [name]).slice().sort()
    // The names proposed one division and the grid broke it apart: the group's
    // name-derived division is not the one it ended up in.
    const split = byName[name] !== division
    out[name] = {
      division,
      basis: split ? 'split_by_co_occurrence' : (members.length > 1 ? 'name_stem' : 'solo'),
      members,
      stem: stemOf[name],
      // Load-bearing, not a footnote: "Tzofim 1 (girls)" clusters with
      // "Tzofim 2 (girls)" ONLY because the bracket came off first. Without
      // this the division looks unexplainable from the raw names.
      qualifier_stripped: strippedOf[name],
      // Also load-bearing: an all-camp lunch puts every group in one slot, so
      // with anchors left in NOTHING would ever split. Which activities were
      // ignored is part of why the answer is what it is.
      anchors_excluded: anchors,
      ...(split ? { names_proposed: byName[name] } : {}),
    }
  }
  return out
}
